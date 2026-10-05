import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint,restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness} from './harness.mjs';
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:24,trial_cost_micros:'300000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
const h=await harness({capture:true,profile,env:{DATA_AGENT_LEASE_MS:'120000'}});
const manager=SessionManager.inMemory('/synthetic/data-agent');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
for(let i=0;i<24;i++){manager.appendMessage({role:'user',content:[{type:'text',text:'合成语义说明'.repeat(167)}],timestamp:Date.now()});manager.appendMessage({role:'assistant',content:[{type:'text',text:'已记录。'}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'stop',usage,timestamp:Date.now()});}
let run,mode,calls=0,compactions=0,checkpoint=exportCheckpoint(manager),passed=false;const payloadBytes=[];
const provider=createServer(async(req,res)=>{let raw='';req.setEncoding('utf8');for await(const c of req)raw+=c;payloadBytes.push(Buffer.byteLength(raw));assert.ok(Buffer.byteLength(raw)<=65536);calls++;const body=JSON.parse(raw);
 const summary=!body.tools?.length;if(summary)compactions++;
 let delta;if(summary)delta={role:'assistant',content:'合成历史摘要：同一会话有多个订单分析问题。通过read_conversation找回原文，read_analysis_task补查条件。'};
 else if(mode==='route'){mode='answer';delta={role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'update_analysis_task',arguments:JSON.stringify({action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]})}}]};}
 else delta={role:'assistant',content:'可以继续这个对话。'};
 const tool=!!delta.tool_calls;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'synthetic',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\n');res.write('data: '+JSON.stringify({id:'synthetic',choices:[],usage:{prompt_tokens:Math.ceil(Buffer.byteLength(raw)/3),completion_tokens:50}})+'\n\n');res.end('data: [DONE]\n\n');});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const before={DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY,DEEPSEEK_BASE_URL:process.env.DEEPSEEK_BASE_URL,DATA_AGENT_PROVIDER_TEST:process.env.DATA_AGENT_PROVIDER_TEST};Object.assign(process.env,{DEEPSEEK_API_KEY:'synthetic-protocol-key',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+provider.address().port,DATA_AGENT_PROVIDER_TEST:'1'});
try{
 const cid=await h.create();
 for(let i=0;i<6;i++){
  run=await h.capture(cid,'继续第'+i+'轮：'+ '合成中文业务补充'.repeat(100));await h.pauseWorker();
  if(i===0){
   const sdk=randomUUID(),args={object_id:'table-demo_order_detail',entry_id:'description'};
   manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name:'read_knowledge',arguments:args}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
   const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:'read_knowledge',arguments:args,checkpoint:exportCheckpoint(manager)};
   assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);const result=await h.internal('/internal/data/tools',input);assert.equal(result.status,200);
   manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:'read_knowledge',content:[{type:'text',text:JSON.stringify(result.value.data)}],isError:false,timestamp:Date.now()});checkpoint=exportCheckpoint(manager);
  }
  run.checkpoint=checkpoint;run.workspace_context.tasks=[{id:'large-context-task',goal:'合成宿主任务'.repeat(1000)}];mode='route';await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');
  checkpoint=h.sql(`SELECT JSON_OBJECT('checkpoint',checkpoint) FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0].checkpoint;
  h.releaseRun(run.run_id);await h.resumeWorker();
 }
 const restored=restoreCheckpoint('/synthetic/data-agent',checkpoint);assert.ok(compactions>=1);assert.ok(restored.getBranch().some(e=>e.type==='compaction'));assert.equal(restored.getHeader().id,manager.getHeader().id);
 assert.ok(checkpoint.authority_snapshot.knowledge.some(v=>v[0]==='table-demo_order_detail'));
 run=await h.capture(cid,'压缩后继续调查');await h.pauseWorker();
 const consumed=(await h.request('/knowledge/table-demo_order_detail')).value;
 assert.equal((await h.request('/knowledge/'+consumed.id+'/disable',{operation_id:randomUUID(),expected_version:consumed.version})).status,200);
 assert.equal((await h.internal('/internal/model/reserve',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID(),parameters_fingerprint:'a'.repeat(64),input_tokens_upper:profile.input_limit,output_tokens_max:profile.output_limit})).value.code,'stale_context');
 assert.equal((await h.request('/conversations/'+cid+'/messages/'+run.message_id+'/withdraw',{operation_id:randomUUID()})).status,200);h.releaseRun(run.run_id);await h.resumeWorker();
 const short=SessionManager.inMemory('/synthetic/data-agent');for(let i=0;i<140;i++){short.appendMessage({role:'user',content:[{type:'text',text:'好'}],timestamp:Date.now()});short.appendMessage({role:'assistant',content:[{type:'text',text:'好的'}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'stop',usage,timestamp:Date.now()});}
 const shortCid=await h.create();run=await h.capture(shortCid,'继续这个短消息对话');await h.pauseWorker();run.checkpoint=exportCheckpoint(short);mode='route';await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
 assert.equal((await h.snapshot(shortCid)).runs.filter(r=>r.state==='finished').length,1);
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];assert.equal(ledger.calls,calls);assert.equal(ledger.reserved,0);assert.equal((await h.snapshot(cid)).runs.filter(r=>r.state==='finished').length,6);passed=true;
 console.log(JSON.stringify({passed,checks:[{name:'恢复24轮中文历史后，Pi原生压缩衔接近16KB宿主上下文和64KB门槛；继续6轮且保持同SDK会话，压缩请求计原预算；早期工具资料依赖保留，压缩后撤回仍在发送前拒绝',passed:true}],calls,compactions,payloadBytes,shortHistoryMessages:280,officialRequests:0}));
}finally{for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-native-compaction.json',JSON.stringify({passed,calls,compactions,payloadBytes,shortHistoryMessages:280,officialRequests:0},null,2));}
