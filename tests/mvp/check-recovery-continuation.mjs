import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { SessionManager, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import { deliver } from '../../apps/agent/session/deliver.ts';
import { exportCheckpoint, restoreCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { RustTransport } from '../../apps/agent/transport/client.ts';
import { harness, until } from './harness.mjs';

const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});
const originalPost=RustTransport.prototype.post, originalRegister=ModelRuntime.prototype.registerProvider;
const originalCompaction=SessionManager.prototype.appendCompaction;
const usage={input:100,output:5,cacheRead:0,cacheWrite:0,totalTokens:105,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=content=>({role:'assistant',api:'openai-completions',provider:'local_mock',model:'task_demo',content,stopReason:'toolUse',usage,timestamp:Date.now()});
let passed=false,run,interrupt=false,interruptAfterFirst=false,overflow=false,chats=0,summaries=0,summariesAtOverflow,compactions=0,compactionsAtOverflow,overflowFailures=0;
SessionManager.prototype.appendCompaction=function(...args){compactions++;return originalCompaction.apply(this,args);};
const checks=[];
ModelRuntime.prototype.registerProvider=function(name,config){
  return originalRegister.call(this,name,{...config,streamSimple(model,context){
    const out=createAssistantMessageEventStream();
    const summary=getCurrentTools(context.messages).length===0;
    if(summary)summaries++;else chats++;
    const fail=!summary&&overflow&&chats===1;
    if(fail){summariesAtOverflow=summaries;compactionsAtOverflow=compactions;overflowFailures++;}
    const message={...assistant(fail?[]:[{type:'text',text:summary?'合成历史摘要；工具执行身份保持原值。':'原输入已继续处理。'}]),api:model.api,provider:model.provider,model:model.id,stopReason:fail?'error':'stop',...(fail?{errorMessage:'request_too_large: model_input_limit'}:{})};
    out.push({type:'start',partial:message});
    if(fail)out.push({type:'error',reason:'error',error:message});
    else {out.push({type:'text_delta',contentIndex:0,delta:message.content[0].text,partial:message});out.push({type:'done',reason:'stop',message});}
    return out;
  }});
};
RustTransport.prototype.post=async function(path,name,input){
  if(interrupt&&path==='/internal/data/tools'&&input.sdk_tool_call_id==='second-call')throw new Error('synthetic_process_interruption');
  const result=await originalPost.call(this,path,name,input);
  if(interruptAfterFirst&&path==='/internal/data/tools'&&input.sdk_tool_call_id==='first-call')throw new Error('synthetic_process_interruption');
  return result;
};
const checkpoint=manager=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const seed=async(cid,second,withHistory=false)=>{
  await h.resumeWorker();run=await h.capture(cid,'继续原合成输入');await h.pauseWorker();
  const manager=SessionManager.inMemory('/synthetic/data-agent');
  if(withHistory)for(let i=0;i<20;i++){
    manager.appendMessage({role:'user',content:'合成历史资料'.repeat(300),timestamp:Date.now()});
    manager.appendMessage({...assistant([{type:'text',text:'已记录。'}]),stopReason:'stop'});
  }
  manager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});
  manager.appendMessage(assistant([
    {type:'toolCall',id:'first-call',name:'update_analysis_task',arguments:{action:'create',task_id:null,expected_version:null,goal:'仅创建一次的合成任务',conditions:{time_start:'2026-01-01T00:00:00Z',time_end:'2026-02-01T00:00:00Z',timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},question:null,options:[]}},
    {type:'toolCall',id:'second-call',...second},
  ]));
  run={...run,resume_same_input:true,checkpoint:checkpoint(manager)};
};
const retry=async(simulateInterruption=true)=>{
  const previous=run;
  const capturedCount=h.captured.length;
  h.releaseRun(previous.run_id);
  // 在可控故障点模拟进程失去租约；新授权仍由真正的Worker生成。
  if(simulateInterruption)h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${previous.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${previous.conversation_id}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${previous.message_id}';`);
  await h.resumeWorker();run=await until(()=>h.captured.slice(capturedCount).find(v=>v.message_id===previous.message_id),'Worker恢复原输入');await h.pauseWorker();
  assert.equal(run.resume_same_input,true);assert.equal(run.budget_scope_id,previous.budget_scope_id);assert.equal(run.recovery_chain_id,previous.recovery_chain_id);assert.notEqual(run.lease_epoch,previous.lease_epoch);
  return previous;
};
try{
  const cid=await h.create();await seed(cid,{name:'search_knowledge',arguments:{query:'没有命中的合成关键词'}});
  interrupt=true;await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''),/synthetic_process_interruption/);
  const before=h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'operation',operation_id,'origin',origin_run_id,'state',state) FROM tool_calls WHERE conversation_id='${cid}' ORDER BY sdk_tool_call_id`);
  assert.deepEqual(before.map(v=>v.state),['succeeded','registered']);
  const stored=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];assert.equal(restoreCheckpoint('/synthetic/data-agent',stored).getBranch().filter(v=>v.type==='message').at(-1).message.role,'toolResult');
  await retry();interrupt=false;await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
  const after=h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'operation',operation_id,'origin',origin_run_id,'state',state) FROM tool_calls WHERE conversation_id='${cid}' ORDER BY sdk_tool_call_id`);
  assert.deepEqual(after.map(({state,...v})=>v),before.map(({state,...v})=>v));assert.ok(after.every(v=>v.state==='succeeded'));
  assert.equal((await h.snapshot(cid)).tasks.length,1);assert.equal((await h.snapshot(cid)).tasks[0].phase,'answered');assert.equal((await h.snapshot(cid)).runs.filter(v=>v.state==='finished').length,1);
  checks.push({id:'IA04',name:'双工具恢复在第二工具登记后再次中断；真实MySQL账本与新Worker运行接回原调用，只创建一次任务',passed:true});

  const rejected=await h.create();await seed(rejected,{name:'read_knowledge',arguments:{object_id:'synthetic-missing-object'}});
  interrupt=true;await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''),/synthetic_process_interruption/);
  const rejectedOperation=h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id) FROM tool_calls WHERE conversation_id='${rejected}' AND sdk_tool_call_id='second-call'`)[0];
  await retry();interrupt=false;await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
  assert.equal(h.sql(`SELECT JSON_OBJECT('state',state) FROM tool_calls WHERE conversation_id='${rejected}' AND sdk_tool_call_id='second-call'`)[0].state,'rejected');
  assert.deepEqual(h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id) FROM tool_calls WHERE conversation_id='${rejected}' AND sdk_tool_call_id='second-call'`)[0],rejectedOperation);
  const saved=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
  assert.ok(restoreCheckpoint('/synthetic/data-agent',saved).getBranch().some(v=>v.type==='message'&&v.message.role==='toolResult'&&v.message.toolCallId==='second-call'&&v.message.isError));
  assert.equal((await h.snapshot(rejected)).tasks.length,1);
  assert.equal((await h.snapshot(rejected)).runs.length,2);
  checks.push({id:'IA04',name:'首次明确拒绝即读回持久错误回执交给Pi继续，同次恢复完成且不新增运行或改变操作身份',passed:true});

  const malformed=await h.create();await seed(malformed,{name:'request_query',arguments:{sql:'SELECT 1'}});
  interruptAfterFirst=true;await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''),/synthetic_process_interruption/);
  await retry();interruptAfterFirst=false;await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
  const corrected=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
  assert.ok(restoreCheckpoint('/synthetic/data-agent',corrected).getBranch().some(v=>v.type==='message'&&v.message.role==='toolResult'&&v.message.toolCallId==='second-call'&&v.message.isError));
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${malformed}'`)[0].n,1);
  assert.equal((await h.snapshot(malformed)).tasks.length,1);
  checks.push({id:'IA04',name:'成功工具后中断，恢复遇到未登记的坏参数时返回错误结果供Pi继续，合法副作用只发生一次',passed:true});

  const mixed=await h.create();await h.resumeWorker();run=await h.capture(mixed,'分别处理金额目标A和时间目标B');await h.pauseWorker();
  const mixedManager=SessionManager.inMemory('/synthetic/data-agent');mixedManager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});
  const mixedTasks=[];
  for(const goal of ['金额目标A','时间目标B']){
    const call={type:'toolCall',id:randomUUID(),name:'update_analysis_task',arguments:{action:'create',goal,conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},options:[]}};
    mixedManager.appendMessage(assistant([call]));
    const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:call.id,tool_name:call.name,arguments:call.arguments,checkpoint:checkpoint(mixedManager)};
    assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
    const receipt=await h.internal('/internal/data/tools',input);assert.equal(receipt.status,200);mixedTasks.push(receipt.value.data);
    mixedManager.appendMessage({role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:JSON.stringify(receipt.value.data)}],details:receipt.value,isError:false,timestamp:Date.now()});
  }
  const [cancelA,continueB]=mixedTasks;
  const pendingCall={type:'toolCall',id:'second-call',name:'update_analysis_task',arguments:{action:'route',task_id:cancelA.task_id,expected_version:cancelA.condition_version,goal:'',options:[]}};
  mixedManager.appendMessage(assistant([pendingCall]));
  const pendingInput={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:pendingCall.id,tool_name:pendingCall.name,arguments:pendingCall.arguments,checkpoint:checkpoint(mixedManager)};
  assert.equal((await h.internal('/internal/data/tool-calls',pendingInput)).status,200);
  run={...run,resume_same_input:true,checkpoint:checkpoint(mixedManager)};
  interrupt=true;
  for(let attempt=0;attempt<3;attempt++){
    await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''),/synthetic_process_interruption/);
    await retry();
  }
  assert.equal(h.sql(`SELECT JSON_OBJECT('attempts',attempts) FROM background_jobs WHERE message_id='${run.message_id}'`)[0].attempts,4);
  const pendingIdentity=h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id) FROM tool_calls WHERE conversation_id='${mixed}' AND sdk_tool_call_id='second-call'`)[0];
  assert.equal((await h.request(`/conversations/${mixed}/tasks/${cancelA.task_id}/cancel`,{operation_id:randomUUID(),expected_version:cancelA.condition_version})).status,200);
  assert.equal(h.sql(`SELECT JSON_OBJECT('attempts',attempts) FROM background_jobs WHERE message_id='${run.message_id}'`)[0].attempts,3);
  const cancelledRunId=run.run_id;
  assert.equal((await h.internal('/internal/data/tool-rejections',{...pendingInput,run_id:run.run_id,lease_epoch:run.lease_epoch})).value.code,'lease_lost');
  await retry(false);interrupt=false;const mixedRun=run.run_id;
  await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
  const mixedCompleted=await h.snapshot(mixed);
  assert.equal(mixedCompleted.tasks.length,2);assert.equal(mixedCompleted.tasks.find(t=>t.id===cancelA.task_id).lifecycle,'cancelled');assert.equal(mixedCompleted.tasks.find(t=>t.id===continueB.task_id).phase,'answered');
  assert.equal(mixedCompleted.runs.filter(r=>r.state==='finished').length,1);assert.equal(mixedCompleted.runs.find(r=>r.state==='finished').run_id,mixedRun);
  assert.equal(mixedCompleted.runs.find(r=>r.run_id===cancelledRunId).state,'cancelled');
  assert.equal(h.sql(`SELECT JSON_OBJECT('attempts',attempts,'state',state) FROM background_jobs WHERE message_id='${run.message_id}'`)[0].attempts,4);
  assert.equal(h.sql(`SELECT JSON_OBJECT('state',state) FROM tool_calls WHERE conversation_id='${mixed}' AND sdk_tool_call_id='second-call'`)[0].state,'rejected');
  assert.deepEqual(h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id) FROM tool_calls WHERE conversation_id='${mixed}' AND sdk_tool_call_id='second-call'`)[0],pendingIdentity);
  const rejectedSnapshot=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
  assert.ok(restoreCheckpoint('/synthetic/data-agent',rejectedSnapshot).getBranch().some(v=>v.type==='message'&&v.message.role==='toolResult'&&v.message.toolCallId==='second-call'&&v.message.isError));
  checks.push({id:'IA04',name:'保留三次历史交付失败后取消A，最后一次合法恢复接回A工具首次拒绝并完成B；不增加失败额度或改变原链/操作',passed:true});

  const long=await h.create();await seed(long,{name:'search_knowledge',arguments:{query:'无命中'}},true);
  overflow=true;chats=0;summaries=0;await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
  assert.equal(overflowFailures,1);assert.equal(chats,2);assert.equal(compactions,compactionsAtOverflow+1);assert.equal(summaries,summariesAtOverflow+2);
  const compacted=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];assert.ok(restoreCheckpoint('/synthetic/data-agent',compacted).getBranch().some(v=>v.type==='compaction'&&v.summary.includes('**Turn Context (split turn):**')));
  const completed=await h.snapshot(long);assert.equal(completed.tasks.length,1);assert.equal(completed.tasks[0].phase,'answered');assert.equal(completed.runs.filter(v=>v.state==='finished').length,1);assert.equal(completed.runs.find(v=>v.state==='finished').run_id,run.run_id);
  checks.push({id:'IA05',name:'恢复原输入后模型报告上下文溢出，由Pi原生摘要和继续生成完成；宿主未另写压缩器',passed:true});
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{
  RustTransport.prototype.post=originalPost;ModelRuntime.prototype.registerProvider=originalRegister;SessionManager.prototype.appendCompaction=originalCompaction;
  await writeFile('.local/checks/mvp-recovery-continuation.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();
}
