import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness,until} from './harness.mjs';

const directory='.local/checks/model-selection';await mkdir(directory,{recursive:true});
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:100,trial_cost_micros:'9999999',request_call_limit:12,toolset:'data',payload_bytes_limit:131072,thinking_level:'off'};
const flash=level=>({model_id:'deepseek-flash',thinking_level:level});
const pro=level=>({model_id:'deepseek-v4-pro',thinking_level:level});
const bodies=[],checks=[],errors=[];let passed=false,closed=false,hold=false,recoveryHold=false,release;
const content=message=>typeof message.content==='string'?message.content:(message.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('');
const provider=createServer(async(req,res)=>{
 try {
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);bodies.push(body);
  if(hold){hold=false;await new Promise(r=>release=r);}
  const userIndex=body.messages.findLastIndex(m=>m.role==='user'),text=content(body.messages[userIndex]);
  const tools=body.messages.slice(userIndex+1).filter(m=>m.role==='tool');
  if(recoveryHold&&text==='恢复模型配置测试'&&tools.length===1){recoveryHold=false;await new Promise(r=>release=r);}
  let name,args;
  if(!body.tools?.length){ /* Pi原生压缩调用只需要文本摘要。 */ }
  else if(text==='执行合成慢查询') {
   if(tools.length===0){name='update_analysis_task';args={action:'create',goal:'合成模型切换慢查询',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},options:[]};}
   if(tools.length===1){const task=JSON.parse(content(tools[0]));name='request_query';args={task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT 7 AS sample_value',parameters:{},target_id:'synthetic-sqlite',summary:'合成模型切换慢查询',knowledge_refs:[],replaces_query_id:null};}
   if(tools.length===2){const q=JSON.parse(content(tools[1]));name='execute_query';args={query_id:q.id,draft_version:q.draft_version,condition_version:q.condition_version,instruction_quote:text};}
  } else if(tools.length===0) {name='update_analysis_task';args={action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]};}
  const delta={role:'assistant',...(body.thinking.type==='enabled'?{reasoning_content:'Synthetic reasoning for protocol verification.'}:{}),...(name?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:body.tools?.length?'合成回复：'+text.slice(0,50):'合成历史摘要：曾记录口令teal，并验证模型档位。继续原消息。'})};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const chunk of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:name?'tool_calls':'stop'}]},{choices:[],usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}}])res.write('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',created:1,model:body.model,...chunk})+'\n\n');
  res.end('data: [DONE]\n\n');
 }catch(error){errors.push(error.message);res.writeHead(500);res.end();}
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const h=await harness({web:true,startWorker:false,profile,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port,env:{DATA_AGENT_QUERY_DELAY_SECONDS:'3600'}});
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
const path=cid=>'/conversations/'+cid+'/model-selection';
const settings=async cid=>ok(await h.request(path(cid)));
const save=async(cid,selection,version)=>(await h.request(path(cid),{selection,expected_version:version??(await settings(cid)).version}));
const send=async(cid,text,selection,key=randomUUID())=>h.request('/conversations/'+cid+'/messages',{client_message_id:key,text,...(selection?{model_selection:selection}:{})});
const budget=mid=>h.sql(`SELECT JSON_OBJECT('profile',model_profile,'scope',id) FROM budget_scopes WHERE message_id='${mid}'`)[0];
try {
 const catalog=ok(await h.request('/models'));assert.deepEqual(catalog.models.map(m=>m.id),['deepseek-flash','deepseek-v4-pro']);
 assert.deepEqual(catalog.models[0].thinking_options.map(o=>o.value),['off','low','high','max']);assert.deepEqual(catalog.models[1].thinking_options.map(o=>o.value),['off','high','max']);
 const cid=await h.create();assert.deepEqual(await settings(cid),{selection:null,version:'0'});
 const key=randomUUID(),a=ok(await send(cid,'记住合成口令 teal',flash('low'),key));assert.deepEqual((await settings(cid)).selection,flash('low'));
 const setting=ok(await save(cid,pro('max')));const b=ok(await send(cid,'继续前面的合成口令'));
 assert.deepEqual(ok(await send(cid,'记住合成口令 teal',flash('low'),key)),a);
 assert.equal((await send(cid,'记住合成口令 teal',pro('max'),key)).status,409);
 assert.equal(budget(a.message_id).profile.model_id,'deepseek-flash');assert.equal(budget(a.message_id).profile.thinking_level,'low');
 assert.equal(budget(b.message_id).profile.model_id,'deepseek-v4-pro');assert.equal(budget(b.message_id).profile.thinking_level,'max');
 assert.equal(budget(b.message_id).profile.price_version,'2026-10-05-pro-peak-usd');assert.equal(budget(b.message_id).profile.trial_id,profile.trial_id);
 assert.equal(budget(b.message_id).profile.trial_call_limit,profile.trial_call_limit);
 assert.equal((await save(cid,pro('low'))).status,400);assert.equal((await h.request(path(cid),undefined,'bob')).status,404);assert.equal((await h.request(path(cid),{selection:flash('off'),expected_version:'2'},'bob')).status,404);
 assert.equal((await h.request(path(cid),{selection:{...pro('high'),api_key:'synthetic-forbidden'},expected_version:'2'})).status,400);
 const rival=await Promise.all([save(cid,flash('high'),setting.version),save(cid,pro('high'),setting.version)]);assert.deepEqual(rival.map(r=>r.status).sort(),[200,409]);
 const winner=rival.find(r=>r.status===200).value;assert.deepEqual(ok(await save(cid,winner.selection,setting.version)),winner);
 assert.equal((await save(cid,pro('max'),'0')).status,409);
 await h.restartApi();assert.deepEqual(await settings(cid),winner);assert.equal(budget(a.message_id).profile.thinking_level,'low');
 checks.push('对话选择按用户隔离与版本保存；非法档位/额外权限参数拒绝，并发冲突与同操作重放正确；消息冻结原模型、价格、试验和限额，重启不改变');
 await h.resumeWorker();await h.finished(cid,2);
 const first=bodies.find(body=>body.messages.some(m=>m.role==='user'&&content(m)==='记住合成口令 teal'));
 assert.equal(first.model,'deepseek-flash');assert.equal(first.reasoning_effort,'low');
 const second=bodies.find(body=>content(body.messages.findLast(m=>m.role==='user'))==='继续前面的合成口令');
 assert.equal(second.model,'deepseek-v4-pro');assert.equal(second.reasoning_effort,'max');assert.ok(second.messages.some(m=>content(m)==='记住合成口令 teal'));
 // Pi原生跨模型转换会将非加密思考转为文本；同模型工具续调必须保留reasoning_content。
 assert.ok(second.messages.some(m=>m.role==='assistant'&&content(m).includes('Synthetic reasoning')));
 const sessions=h.sql(`SELECT JSON_OBJECT('session',JSON_UNQUOTE(COALESCE(JSON_EXTRACT(checkpoint,'$.storage.session_id'),JSON_EXTRACT(checkpoint,'$.entries[0].id')))) FROM pi_checkpoints WHERE recovery_chain_id IN (SELECT recovery_chain_id FROM agent_runs WHERE conversation_id='${cid}')`);assert.equal(sessions.length,2);assert.ok(sessions.every(r=>typeof r.session==='string'&&r.session.length));assert.equal(new Set(sessions.map(r=>r.session)).size,1);
 let count=2;
 for(const [index,choice] of [flash('off'),flash('low'),flash('high'),flash('max'),pro('off'),pro('high'),pro('max')].entries()){
  const text='档位协议验证 '+index,start=bodies.length;ok(await send(cid,text,choice));await h.finished(cid,++count);
  const calls=bodies.slice(start);assert.ok(calls.length>=2);assert.ok(calls.every(b=>b.model===choice.model_id));
  assert.ok(calls.every(b=>b.thinking.type===(choice.thinking_level==='off'?'disabled':'enabled')));
  if(choice.thinking_level!=='off'){
   assert.ok(calls.every(b=>b.reasoning_effort===choice.thinking_level));
   assert.ok(calls.slice(1).every(b=>b.messages.slice(b.messages.findLastIndex(m=>m.role==='user')+1).some(m=>m.role==='assistant'&&m.reasoning_content)));
  }
 }
 checks.push('实际Pi SDK同会话切换Flash/Pro保留历史与原生会话身份；7种允许组合的真实HTTP参数、思考历史与工具续调均正确');
 const concurrent=await Promise.all([save(cid,pro('max')),send(cid,'发送与设置并发核对',flash('low'))]);
 concurrent.forEach(ok);await h.finished(cid,++count);
 assert.deepEqual((await settings(cid)).selection,pro('max'));
 assert.equal(budget(concurrent[1].value.message_id).profile.model_id,'deepseek-flash');
 assert.equal(budget(concurrent[1].value.message_id).profile.thinking_level,'low');
 checks.push('并发保存Pro与发送显式Flash，设置保存Pro而该消息仍固定为Flash');
 // 请求仍在运行时切换，实际发出的所有子调用保持原配置。
 hold=true;const slowStart=bodies.length;ok(await send(cid,'等待参数核对',flash('low')));await until(()=>release,'协议请求已挂起');
 ok(await save(cid,pro('high')));release();release=null;await h.finished(cid,++count);
 assert.ok(bodies.slice(slowStart).every(b=>b.model==='deepseek-flash'&&b.reasoning_effort==='low'));
 ok(await send(cid,'执行合成慢查询',flash('off')));await h.finished(cid,++count);
 const q=await until(async()=>{const qs=ok(await h.request('/conversations/'+cid+'/queries')).queries;return qs.find(q=>q.execution_state==='running');},'后台SQL正在执行');
 ok(await save(cid,pro('max')));ok(await send(cid,'后台运行时继续聊',pro('max')));await h.finished(cid,++count);assert.equal(ok(await h.request('/queries/'+q.id)).execution_state,'running');
 const queryProfile=h.sql(`SELECT JSON_OBJECT('profile',b.model_profile) FROM query_requests q JOIN budget_scopes b ON b.id=q.budget_scope_id WHERE q.id='${q.id}'`)[0].profile;
 assert.equal(queryProfile.model_id,'deepseek-flash');assert.equal(queryProfile.thinking_level,'off');
 const noticesBefore=(await h.snapshot(cid)).runs.length;
 ok(await h.request('/queries/'+q.id+'/cancel',{operation_id:randomUUID()}));await h.finished(cid,noticesBefore+1);
 const notice=bodies.findLast(b=>content(b.messages.findLast(m=>m.role==='user')).startsWith('[已确认查询结果事件]'));
 assert.equal(notice.model,'deepseek-flash');assert.equal(notice.thinking.type,'disabled');
 assert.equal(ok(await h.request('/queries/'+q.id)).execution_state,'cancelled');
 checks.push('生成中切换只影响后续消息；SQL后台运行时可切模型继续聊，原SQL停止后的结果解释仍使用原Flash配置');

 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
 await page.getByLabel('模型',{exact:true}).waitFor();await page.getByLabel('模型',{exact:true}).selectOption('deepseek-v4-pro');
 await page.getByLabel('思考强度',{exact:true}).selectOption('high');
 await page.getByLabel('你的数据问题').fill('界面模型选择合成测试');await page.getByRole('button',{name:'发送 ↑',exact:true}).click();
 const uiCid=await until(()=>page.evaluate(()=>localStorage.getItem('data-agent.conversation.alice')),'页面会话建立');await h.finished(uiCid);
 await until(async()=>await page.getByLabel('模型',{exact:true}).inputValue()==='deepseek-v4-pro'&&!await page.getByLabel('模型',{exact:true}).isDisabled(),'首条保存后选项恢复');
 assert.deepEqual((await settings(uiCid)).selection,pro('high'));
 await page.getByLabel('你的数据问题').fill('保留未发送的补充');await page.getByLabel('模型',{exact:true}).selectOption('deepseek-flash');
 await until(async()=>(await settings(uiCid)).selection.model_id==='deepseek-flash','切换模型已保存');
 await until(async()=>!await page.getByLabel('思考强度',{exact:true}).isDisabled(),'档位可操作');await page.getByLabel('思考强度',{exact:true}).selectOption('low');
 await until(async()=>(await settings(uiCid)).selection.thinking_level==='low','思考已保存');await page.reload();
 await page.getByLabel('模型',{exact:true}).waitFor();assert.equal(await page.getByLabel('模型',{exact:true}).inputValue(),'deepseek-flash');assert.equal(await page.getByLabel('思考强度',{exact:true}).inputValue(),'low');assert.equal(await page.getByLabel('你的数据问题').inputValue(),'保留未发送的补充');
 await page.getByLabel('模型',{exact:true}).selectOption('deepseek-v4-pro');await until(async()=>(await settings(uiCid)).selection.model_id==='deepseek-v4-pro','换至Pro已保存');
 await until(async()=>!await page.getByLabel('思考强度',{exact:true}).isDisabled(),'Pro可操作');assert.equal(await page.getByLabel('思考强度',{exact:true}).inputValue(),'off');
 assert.equal(await page.getByLabel('思考强度',{exact:true}).locator('option[value="low"]').count(),0);
 await page.screenshot({path:directory+'/desktop.png',fullPage:true});
 await page.route('**/api/conversations/*/model-selection',async route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable',message:'unavailable',request_id:'synthetic-error',retryable:true})}):route.continue());
 await page.getByLabel('模型',{exact:true}).selectOption('deepseek-flash');await page.getByText('模型设置未确认保存，请检查当前选择后重试。',{exact:false}).waitFor();assert.equal(await page.getByLabel('模型',{exact:true}).inputValue(),'deepseek-v4-pro');
 await page.unroute('**/api/conversations/*/model-selection');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:directory+'/mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.equal(await page.getByLabel('你的数据问题').inputValue(),'保留未发送的补充');
 checks.push('真实浏览器首次选择随消息保存、现有对话即时保存、刷新和草稿保留；不支持档位回到关闭；保存失败恢复真实设置，桌面窄屏不溢出');
 assert.deepEqual(errors,[]);
 await h.close();closed=true;
 await verifyRecovery();
 passed=true;
}finally{
 release?.();if(!passed)await page.screenshot({path:directory+'/failure.png',fullPage:true}).catch(()=>{});
 await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,providerRequests:bodies.length,officialRequests:0,environment:'Pi SDK + local HTTP provider fixture + isolated MySQL + executable synthetic SQLite'},null,2));
 await writeFile(directory+'/protocol-summary.json',JSON.stringify(bodies.map(b=>({model:b.model,thinking:b.thinking,reasoning:b.reasoning_effort,bytes:Buffer.byteLength(JSON.stringify(b)),tools:b.tools?.length??0,user:content(b.messages.findLast(m=>m.role==='user')).slice(0,100)})),null,2));
 await browser.close();if(!closed)await h.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));console.log(JSON.stringify({passed,checks,errors,providerRequests:bodies.length,officialRequests:0}));
}

async function verifyRecovery(){
 const previous=Object.fromEntries(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST'].map(k=>[k,process.env[k]]));
 const recovery=await harness({capture:true,profile,env:{DATA_AGENT_LEASE_MS:'120000'}});
 const abort=new AbortController();let pending;
 try{
  process.env.DEEPSEEK_API_KEY='synthetic-protocol-key';process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+provider.address().port;process.env.DATA_AGENT_PROVIDER_TEST='1';
  const cid=await recovery.create();
  ok(await recovery.request(path(cid),{selection:flash('low'),expected_version:'0'}));
  const original=await recovery.capture(cid,'恢复模型配置测试');await recovery.pauseWorker();
  recoveryHold=true;const start=bodies.length;
  pending=deliver(original,recovery.env.DATA_AGENT_API_URL,recovery.env.DATA_AGENT_INTERNAL_TOKEN,'',abort.signal).then(()=>null,e=>e);
  await until(()=>release,'已持久工具检查点后中断');
  assert.equal(recovery.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM pi_checkpoints WHERE recovery_chain_id='${original.recovery_chain_id}'`)[0].n,1);
  ok(await recovery.request(path(cid),{selection:pro('max'),expected_version:'1'}));
  abort.abort();assert.equal((await pending).code,'run_cancelled');release();release=null;
  recovery.releaseRun(original.run_id);
  // 模拟进程丢失运行权；恢复身份仍由真实Worker生成。
  recovery.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${original.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${original.message_id}';`);
  await recovery.resumeWorker();
  const resumed=await until(()=>recovery.captured.find(r=>r.message_id===original.message_id&&r.run_id!==original.run_id),'原请求恢复');await recovery.pauseWorker();
  assert.equal(resumed.resume_same_input,true);
  for(const key of ['message_id','budget_scope_id','recovery_chain_id'])assert.equal(resumed[key],original[key]);
  assert.deepEqual(resumed.model_profile,original.model_profile);
  await deliver(resumed,recovery.env.DATA_AGENT_API_URL,recovery.env.DATA_AGENT_INTERNAL_TOKEN,'');recovery.releaseRun(resumed.run_id);
  assert.ok(bodies.slice(start).every(b=>b.model==='deepseek-flash'&&b.reasoning_effort==='low'));
  assert.equal((await recovery.snapshot(cid)).runs.filter(r=>r.state==='finished').length,1);
  assert.deepEqual(ok(await recovery.request(path(cid))).selection,pro('max'));
  const attempts=recovery.sql(`SELECT JSON_OBJECT('scope',budget_scope_id,'state',state) FROM model_call_attempts WHERE budget_scope_id='${original.budget_scope_id}'`);
  assert.ok(attempts.length>2);assert.equal(attempts.filter(a=>a.state==='unknown').length,1);
  checks.push('已开始的Flash请求中断后，设置即使改为Pro仍以原消息、恢复链、预算和Flash档位继续，未知调用保留原预算');
 }finally{
  abort.abort();release?.();release=null;await pending;await recovery.close();
  for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
}
