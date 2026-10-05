import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});
let run,manager,passed=false;const checks=[];
const conditions={time_start:null,time_end:null,timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
const tool=async(name,args)=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
 const result=await h.internal('/internal/data/tools',input);assert.equal(result.status,200,JSON.stringify(result.value));return result.value.data;
};
try{
 for(const legacy of [false,true])for(const cancelledIndex of [0,1]){
  await h.resumeWorker();const cid=await h.create();run=await h.capture(cid,'分别解释合成表的金额和时间，两项独立目标。');await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');
  const tasks=[];for(const goal of ['合成金额解释','合成时间解释'])tasks.push(await tool('update_analysis_task',{action:'create',goal,conditions,options:[]}));
  if(legacy){
   h.sql(`DELETE FROM conversation_message_tasks WHERE message_id='${run.message_id}';INSERT INTO conversation_message_tasks(message_id,task_id) VALUES('${run.message_id}','${tasks[1].task_id}')`);
   const migration=await readFile('migrations/202610050006_message_task_receipt_backfill.sql','utf8');
   h.sql('\n'+migration);h.sql('\n'+migration);
   assert.deepEqual(new Set(h.sql(`SELECT JSON_OBJECT('task_id',task_id) FROM conversation_message_tasks WHERE message_id='${run.message_id}'`).map(v=>v.task_id)),new Set(tasks.map(v=>v.task_id)));
  }
  const original=run,keep=tasks[1-cancelledIndex],cancel=tasks[cancelledIndex];
  const cancelInput={operation_id:randomUUID(),expected_version:cancel.condition_version};
  assert.equal((await h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()})).status,200);
  const cancelled=await h.request(`/conversations/${cid}/tasks/${cancel.task_id}/cancel`,cancelInput);assert.equal(cancelled.status,200);
  assert.equal(h.sql(`SELECT JSON_OBJECT('state',state) FROM agent_runs WHERE id='${original.run_id}'`)[0].state,'cancelled');
  assert.equal(h.sql(`SELECT JSON_OBJECT('state',disposition) FROM conversation_messages WHERE id='${original.message_id}'`)[0].state,'pending');
  assert.equal((await h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()})).status,409);
  h.releaseRun(original.run_id);await h.resumeWorker();
  run=await until(()=>h.captured.find(v=>v.message_id===original.message_id&&v.run_id!==original.run_id),'混合输入在原链继续');await h.pauseWorker();
  assert.equal(run.budget_scope_id,original.budget_scope_id);assert.equal(run.recovery_chain_id,original.recovery_chain_id);assert.equal(run.request_id,original.request_id);
  assert.deepEqual(new Set(run.workspace_context.input_task_ids),new Set(tasks.map(v=>v.task_id)));
  const continuationState=()=>h.sql(`SELECT JSON_OBJECT('run_state',r.state,'lease_epoch',r.lease_epoch,'job_state',j.state,'job_epoch',j.lease_epoch,'attempts',j.attempts,'issued_calls',b.issued_calls,'event_seq',c.event_seq) FROM agent_runs r JOIN background_jobs j ON j.id=r.job_id JOIN budget_scopes b ON b.id=r.budget_scope_id JOIN conversations c ON c.id=r.conversation_id WHERE r.id='${run.run_id}'`)[0];
  const beforeRepeat=continuationState();
  for(let i=0;i<4;i++)assert.deepEqual(await h.request(`/conversations/${cid}/tasks/${cancel.task_id}/cancel`,cancelInput),cancelled);
  const differentTask=await h.request(`/conversations/${cid}/tasks/${keep.task_id}/cancel`,cancelInput);assert.equal(differentTask.status,409);assert.equal(differentTask.value.code,'idempotency_conflict');
  const differentVersion=await h.request(`/conversations/${cid}/tasks/${cancel.task_id}/cancel`,{...cancelInput,expected_version:'2'});assert.equal(differentVersion.status,409);assert.equal(differentVersion.value.code,'idempotency_conflict');
  assert.equal((await h.request(`/conversations/${cid}/tasks/${cancel.task_id}/cancel`,{operation_id:randomUUID(),expected_version:cancel.condition_version})).status,200);
  assert.deepEqual(continuationState(),beforeRepeat);
  const states=(await h.snapshot(cid)).tasks;assert.equal(states.find(v=>v.id===cancel.task_id).lifecycle,'cancelled');assert.equal(states.find(v=>v.id===keep.task_id).lifecycle,'active');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_tasks WHERE conversation_id='${cid}'`)[0].n,2);
  await tool('update_analysis_task',{action:'route',task_id:keep.task_id,expected_version:keep.condition_version,goal:'',options:[]});
  const text='剩余目标的合成解释已提交';await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text});
  assert.equal((await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:randomUUID(),final_text:text,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)})).status,200);
  h.releaseRun(run.run_id);
  assert.equal((await h.snapshot(cid)).tasks.find(v=>v.id===keep.task_id).phase,'answered');
  assert.equal(h.sql(`SELECT JSON_OBJECT('calls',issued_calls) FROM budget_scopes WHERE id='${original.budget_scope_id}'`)[0].calls,1);
  checks.push({name:`${legacy?'旧会话回执幂等回填后':'新会话'}同消息两目标取消第${cancelledIndex+1}个，剩余任务在原输入/链/账本续接，无重复任务，旧运行失权`,passed:true});
 }

 for(const claimWindow of [false,true])for(const priorFailures of [0,2]){
  await h.resumeWorker();const cid=await h.create();run=await h.capture(cid,'五个独立合成目标，允许分别取消。');await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');
  const original=run,tasks=[];for(let i=0;i<5;i++)tasks.push(await tool('update_analysis_task',{action:'create',goal:'合成解释目标'+i,conditions,options:[]}));
  if(priorFailures)h.sql(`UPDATE background_jobs SET attempts=${1+priorFailures} WHERE message_id='${run.message_id}'`);
  // 模拟旧运行失败后新job代次已领取、尚未创建新run的真实两事务窗口。
  if(claimWindow)h.sql(`UPDATE background_jobs SET lease_epoch=lease_epoch+1 WHERE message_id='${run.message_id}'`);
  const preservedFailures=priorFailures+(claimWindow?1:0);
  for(let i=0;i<4;i++){
   const previous=run;
   assert.equal((await h.request(`/conversations/${cid}/tasks/${tasks[i].task_id}/cancel`,{operation_id:randomUUID(),expected_version:tasks[i].condition_version})).status,200);
   assert.equal(h.sql(`SELECT JSON_OBJECT('attempts',attempts) FROM background_jobs WHERE message_id='${run.message_id}'`)[0].attempts,preservedFailures);
   h.releaseRun(previous.run_id);await h.resumeWorker();
   run=await until(()=>h.captured.find(v=>v.message_id===original.message_id&&v.lease_epoch!==previous.lease_epoch&&BigInt(v.lease_epoch)>BigInt(previous.lease_epoch)),'多次用户取消后剩余目标继续');await h.pauseWorker();
   assert.equal(run.budget_scope_id,original.budget_scope_id);assert.equal(run.recovery_chain_id,original.recovery_chain_id);assert.equal(run.request_id,original.request_id);
   assert.equal(h.sql(`SELECT JSON_OBJECT('attempts',attempts) FROM background_jobs WHERE message_id='${run.message_id}'`)[0].attempts,1+preservedFailures);
  }
  const keep=tasks[4];await tool('update_analysis_task',{action:'route',task_id:keep.task_id,expected_version:keep.condition_version,goal:'',options:[]});
  const text='最后一个合成目标已完成';await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text});
  assert.equal((await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:randomUUID(),final_text:text,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)})).status,200);h.releaseRun(run.run_id);
  assert.equal((await h.snapshot(cid)).tasks.find(t=>t.id===keep.task_id).phase,'answered');
  checks.push({name:`${claimWindow?'新job已领旧run未更新窗口；':''}五目标连续取消四个，剩余目标在原账本提交；保留${preservedFailures}次既有失败`,passed:true});
 }
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-mixed-task-cancellation.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}
