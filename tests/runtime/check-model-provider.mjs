import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {modelHarness,trialProfile,until} from './model-harness.mjs';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {guardedDeepSeekStream,connectionFromEnvironment} from '../../apps/agent/provider/deepseek.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {normalizeContext} from '@earendil-works/pi-ai';

const checks=[];const key='synthetic-secret-must-never-appear-in-output';
process.env.DEEPSEEK_API_KEY=key;process.env.DATA_AGENT_PROVIDER_TEST='1';process.env.DATA_AGENT_MODEL_TIMEOUT_MS='500';
let mode='tool',network=0;const bodies=[];const slowConnections=[];let nodeErrors='';
const stderrWrite=process.stderr.write;process.stderr.write=function(chunk,...args){nodeErrors+=String(chunk);return stderrWrite.call(this,chunk,...args);};
const provider=createServer(async(req,res)=>{
 network++;let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;const body=JSON.parse(raw);bodies.push(body);
 assert.equal(req.url,'/chat/completions');assert.equal(body.model,'deepseek-flash');assert.equal(body.max_tokens,1024);assert.deepEqual(body.thinking,{type:'disabled'});assert.ok(Buffer.byteLength(raw)<=2048);
 if(['401','429','500'].includes(mode)){res.writeHead(Number(mode),{'content-type':'application/json','retry-after':'0'}).end(JSON.stringify({error:{message:key,type:'synthetic'}}));return;}
 if(mode==='slow'){const connection={closedAt:null};slowConnections.push(connection);res.on('close',()=>connection.closedAt=Date.now());return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const chunk=(delta,finish_reason=null)=>({id:'synthetic-response',object:'chat.completion.chunk',model:'deepseek-flash',choices:[{index:0,delta,finish_reason}]});
 const send=x=>res.write('data: '+JSON.stringify(x)+'\n\n');
 const followup=body.messages.some(m=>m.role==='tool');
 if(mode==='tool'&&!followup){send(chunk({role:'assistant',tool_calls:[{index:0,id:'sdk-synthetic-call',type:'function',function:{name:'update_analysis_task',arguments:JSON.stringify({action:'create_task',goal:'分析虚构订单的退款'})}}]}));send(chunk({},'tool_calls'));}
 else{send(chunk({role:'assistant',content:'合成任务已建立。'}));send(chunk({},'stop'));}
 if(mode!=='no_usage')send({id:'synthetic-response',choices:[],usage:{prompt_tokens:300,completion_tokens:40,prompt_cache_hit_tokens:100,prompt_cache_miss_tokens:200}});
 res.end('data: [DONE]\n\n');
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+provider.address().port;
const h=await modelHarness(trialProfile(randomUUID()));
const cost=u=>Math.ceil((u.input_tokens*3+u.output_tokens*12)/10);
const attempts=()=>h.query("SELECT JSON_OBJECT('state',state,'reserved',reserved_micros,'actual',actual_micros,'usage',usage_json) FROM model_call_attempts ORDER BY id");
try{
 const success=await h.run('请建立一个虚构订单退款分析任务，并说明保存结果。',deliver);assert.deepEqual(await success.result,{ok:true});
 const s=await h.snapshot(success.cid);assert.equal(s.tasks.length,1);assert.equal(s.runs[0].state,'finished');assert.equal(network,2);assert.equal(attempts().length,2);assert.ok(attempts().every(a=>a.state==='settled'&&a.actual===cost(a.usage)&&a.usage.input_tokens===300));
 checks.push({name:'Pi真实SDK工具→Rust回执→回答，缓存输入完整计费，逐次许可',network:2,passed:true});
 for(const failure of ['401','429','500','no_usage','slow']){
  await h.setProfile(trialProfile(randomUUID()));mode=failure;const before=network;
  const result=await h.run('验证合成模型失败。',deliver);assert.deepEqual(await result.result,{ok:false});assert.equal(network-before,1,'SDK不能隐式重试');
  const row=h.query(`SELECT JSON_OBJECT('state',m.state,'reserved',m.reserved_micros) FROM model_call_attempts m WHERE run_id='${result.run.run_id}'`)[0];assert.equal(row.state,'unknown');assert.ok(row.reserved>0);
  assert.equal((await h.snapshot(result.cid)).runs[0].state,'running');assert.equal((await h.request('/conversations/'+result.cid+'/cancel-run',{run_id:result.run.run_id,lease_epoch:result.run.lease_epoch})).status,200);
  checks.push({name:'协议 '+failure+' 保留未知预算、无隐式重试、不提交成功',network:1,passed:true});
 }
 await h.setProfile(trialProfile(randomUUID()));mode='slow';process.env.DATA_AGENT_MODEL_TIMEOUT_MS='30000';
 const beforeCancel=network;const cancel=await h.run('验证取消合成请求。',deliver);await until(()=>network>beforeCancel,'request issued');const connection=slowConnections.at(-1);let completedAt;void cancel.result.then(()=>completedAt=Date.now());let cancelRequestedAt;
 const input={run_id:cancel.run.run_id,lease_epoch:cancel.run.lease_epoch};
 assert.equal((await h.request('/conversations/'+cancel.cid+'/cancel-run',input,{user:'bob'})).status,404);
 assert.equal((await h.request('/conversations/'+cancel.cid+'/cancel-run',{...input,lease_epoch:'0'})).status,409);
 const web=await h.web();const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.addInitScript(cid=>localStorage.setItem('data-agent.conversation.alice',cid),cancel.cid);
  await page.goto(web.url);await page.getByLabel('演示登录凭据').fill(web.alice);await page.getByRole('button',{name:'进入工作台 →'}).click();
  await page.locator('.badge').getByText('DeepSeek Flash',{exact:true}).waitFor();cancelRequestedAt=Date.now();await page.getByRole('button',{name:'停止生成'}).click();
  await until(()=>completedAt&&connection.closedAt,'cancel aborts provider connection',1500);assert.ok(completedAt-cancelRequestedAt<1500);assert.ok(connection.closedAt-cancelRequestedAt<1500);
  await page.getByText('本次生成已停止，已保存的任务仍可查看。',{exact:true}).waitFor();await page.reload();await page.getByText('本次生成已停止，已保存的任务仍可查看。',{exact:true}).waitFor();
 }finally{await browser.close();}
 const cancelled=await h.request('/conversations/'+cancel.cid+'/cancel-run',input);assert.equal(cancelled.value.state,'cancelled');assert.deepEqual(await cancel.result,{ok:false});
 assert.deepEqual((await h.request('/conversations/'+cancel.cid+'/cancel-run',input)).value,cancelled.value);
 assert.equal((await h.snapshot(cancel.cid)).events.filter(e=>e.type==='run_cancelled').length,1);
 assert.equal(h.query(`SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE message_id='${cancel.run.message_id}'`)[0].state,'cancelled');
 const unknown=h.query(`SELECT JSON_OBJECT('state',state) FROM model_call_attempts WHERE run_id='${cancel.run.run_id}'`)[0];assert.equal(unknown.state,'unknown');
 const late=await h.request('/internal/outputs',{run_id:input.run_id,lease_epoch:input.lease_epoch,chunk_seq:'1',text:'晚到输出'},{internal:true});assert.equal(late.status,409);
 mode='tool';const other=await h.run('建立第二个合成任务。',deliver);assert.deepEqual(await other.result,{ok:true});assert.equal((await h.snapshot(other.cid)).runs[0].state,'finished');
 checks.push({cancellationMs:completedAt-cancelRequestedAt,socketCloseMs:connection.closedAt-cancelRequestedAt,name:'React读取模型标签、停止生成并刷新保留；幂等终态、用户/代次隔离，其他会话继续',passed:true});
 // 不可靠usage不能被SDK默认的零用量冒充；错误响应不能反射秘密。
 const checkpoints=h.query("SELECT JSON_OBJECT('checkpoint',checkpoint) FROM pi_checkpoints");assert.ok(checkpoints.length>0);
 for(const result of [h.getLogs(),nodeErrors,JSON.stringify(checkpoints),JSON.stringify(await h.snapshot(cancel.cid)),JSON.stringify(await h.snapshot(success.cid))])assert.ok(!result.includes(key));
 checks.push({name:'凭据未进入日志、检查点、业务快照或模型请求正文',passed:true});assert.ok(!JSON.stringify(bodies).includes(key));assert.ok(!JSON.stringify(bodies).includes(process.cwd()));
 const call=(path,b)=>h.request('/internal/model/'+path,b,{internal:true});
 await h.setProfile(trialProfile(randomUUID()));
 // 使用新profile的新运行，不能给原运行换试验补额。
 const budgetRun=(await h.run('最后额度并发竞争。')).run;
 const binding=id=>({run_id:budgetRun.run_id,lease_epoch:budgetRun.lease_epoch,call_attempt_id:id,parameters_fingerprint:'b'.repeat(64)});
 const reserved=[];
 for(let i=0;i<5;i++){const b=binding(randomUUID());assert.equal((await call('reserve',{...b,input_tokens_upper:4096,output_tokens_max:1024})).status,200);reserved.push(b);}
 const rival=(await h.run('另一个会话争抢试验最后额度。')).run;
 const competing=[binding(randomUUID()),{...binding(randomUUID()),run_id:rival.run_id,lease_epoch:rival.lease_epoch}];const results=await Promise.all(competing.map(b=>call('reserve',{...b,input_tokens_upper:4096,output_tokens_max:1024})));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const b=reserved[0];assert.equal((await call('reserve',{...b,input_tokens_upper:4096,output_tokens_max:1024})).status,200);
 assert.equal((await call('send',b)).value.send_allowed,true);assert.equal((await call('send',b)).value.send_allowed,false);assert.equal((await call('send',{...b,parameters_fingerprint:'c'.repeat(64)})).status,409);
 assert.equal((await call('finalize',{...b,usage:null})).value.state,'unknown');const beforeUsage=h.query(`SELECT JSON_OBJECT('allocated',allocated_calls,'reserved',reserved_micros,'spent',spent_micros) FROM model_trials WHERE id='${budgetRun.model_profile.trial_id}'`)[0];assert.equal(beforeUsage.allocated,6);assert.equal(beforeUsage.reserved,6*2458);
 await h.request('/conversations/'+budgetRun.conversation_id+'/cancel-run',{run_id:budgetRun.run_id,lease_epoch:budgetRun.lease_epoch});assert.equal((await call('send',reserved[1])).status,409);
 const settled={...b,usage:{input_tokens:300,output_tokens:40,elapsed_ms:100}};assert.equal((await call('finalize',settled)).value.state,'settled');assert.equal((await call('finalize',settled)).status,200);assert.equal((await call('finalize',{...settled,usage:{...settled.usage,output_tokens:41}})).status,409);
 await h.setProfile(budgetRun.model_profile);const later=(await h.run('恢复不能补试验额度。')).run;assert.equal((await call('reserve',{...binding(randomUUID()),run_id:later.run_id,lease_epoch:later.lease_epoch,input_tokens_upper:4096,output_tokens_max:1024})).status,409);
 assert.equal((await h.request('/internal/model/issue',{call_attempt_id:randomUUID(),run_id:later.run_id,lease_epoch:later.lease_epoch},{internal:true})).status,404);
 checks.push({name:'最后额度并发竞争、重复许可、未知预留、取消后原调用结算、重启不补额及mock入口拒绝',passed:true});
 await h.setProfile(trialProfile(randomUUID()));const exceed=(await h.run('用量超限熔断。')).run;const x={...binding(randomUUID()),run_id:exceed.run_id,lease_epoch:exceed.lease_epoch};await call('reserve',{...x,input_tokens_upper:4096,output_tokens_max:1024});await call('send',x);await call('finalize',{...x,usage:{input_tokens:4097,output_tokens:10,elapsed_ms:1}});
 assert.equal((await call('reserve',{...x,call_attempt_id:randomUUID(),input_tokens_upper:4096,output_tokens_max:1024})).status,409);
 checks.push({name:'可靠usage超出预留立即熔断，不能继续发请求',passed:true});
 await h.setProfile(trialProfile(randomUUID()));const money=(await h.run('独立费用上限。')).run;const m={...binding(randomUUID()),run_id:money.run_id,lease_epoch:money.lease_epoch};
 h.query(`UPDATE model_trials SET spent_micros=49000 WHERE id='${money.model_profile.trial_id}'`);
 assert.equal((await call('reserve',{...m,input_tokens_upper:4096,output_tokens_max:1024})).status,409);
 h.query(`UPDATE model_trials SET spent_micros=0 WHERE id='${money.model_profile.trial_id}'`);
 await call('reserve',{...m,input_tokens_upper:4096,output_tokens_max:1024});
 h.query(`UPDATE model_call_attempts SET permit_expires_at=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id='${m.call_attempt_id}'`);
 assert.equal((await call('send',m)).status,409);
 h.query(`UPDATE model_trials SET expires_at=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id='${money.model_profile.trial_id}'`);
 await h.setProfile(money.model_profile);
 assert.equal((await call('reserve',{...m,call_attempt_id:randomUUID(),input_tokens_upper:4096,output_tokens_max:1024})).status,409);
 checks.push({name:'费用单独耗尽、发送许可到期、API重启不延长试验',passed:true});
 assert.equal((await call('reserve',{...m,call_attempt_id:randomUUID(),input_tokens_upper:1,output_tokens_max:1024})).status,400);
 await h.setProfile(trialProfile(randomUUID()));mode='tool';
 const nativeFetch=globalThis.fetch;let lost=false;const settlements=[];
 globalThis.fetch=async(input,init)=>{
  const response=await nativeFetch(input,init);
  const url=input instanceof Request?input.url:String(input);
  if(url===h.env.DATA_AGENT_API_URL+'/internal/model/finalize'){
   settlements.push(JSON.parse(init.body));
   if(!lost&&response.ok){lost=true;await response.text();throw new Error('synthetic lost committed receipt');}
  }
  return response;
 };
 try{
  const recovered=await h.run('结算回执丢失仍完成合成目标。',deliver);assert.deepEqual(await recovered.result,{ok:true});
  assert.ok(lost);assert.deepEqual(settlements[0],settlements[1]);assert.equal((await h.snapshot(recovered.cid)).runs[0].state,'finished');
 }finally{globalThis.fetch=nativeFetch;}
 checks.push({name:'已提交结算丢HTTP回执，重送完全相同payload且回答仍成功；拒绝低报预留',passed:true});
 await h.setProfile(trialProfile(randomUUID()));mode='401';const errorEvents=[];
 const errorCase=await h.run('检查合成错误事件。',async(run,url,token,_fault,signal)=>{
  const connection=connectionFromEnvironment();const model={id:'deepseek-flash',name:'DeepSeek Flash',api:'openai-completions',provider:'controlled_deepseek',baseUrl:connection.baseUrl,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024,compat:{supportsStrictMode:false,maxTokensField:'max_tokens',thinkingFormat:'deepseek'}};
  const context=normalizeContext({systemPrompt:'合成协议测试。',messages:[{role:'user',content:run.text,timestamp:Date.now()}],tools:[{name:'update_analysis_task',description:'合成工具',parameters:{type:'object',properties:{},additionalProperties:false}}]});
  for await(const event of guardedDeepSeekStream(new RustTransport(run,url,token),run.model_profile,connection,signal)(model,context))errorEvents.push(event);
 });await errorCase.result;const errorEvent=errorEvents.find(e=>e.type==='error');assert.ok(errorEvent);assert.equal(errorEvent.error.errorMessage,'model_auth_failed');
 assert.ok(!JSON.stringify(errorEvents).includes(key));assert.ok(!nodeErrors.includes(key));
 checks.push({name:'SDK原始错误事件替换固定代码，Node stderr及真实Pi检查点不含凭据',passed:true});



 await mkdir('.local/checks',{recursive:true});await writeFile('.local/checks/model-provider.json',JSON.stringify({passed:true,provider:'loopback protocol fixture',piSdk:'1.0.0',mysql:'real local MySQL',officialRequests:0,network,checks},null,2)+'\n');console.log(JSON.stringify({passed:true,network,checks}));
}finally{process.stderr.write=stderrWrite;await h.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
