import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'0'}});
const conditions={time_start:null,time_end:null,timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
let run,manager,passed=false;const checks=[];
const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const attach=r=>{run=r;manager=SessionManager.inMemory('/synthetic/data-agent');};
const start=async cid=>{await h.resumeWorker();attach(await h.capture(cid,'继续解释合成资料'));await h.pauseWorker();};
const tool=async(name,args)=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:checkpoint()};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
 const response=await h.internal('/internal/data/tools',input);assert.equal(response.status,200,JSON.stringify(response.value));return response.value.data;
};
const create=(question=null)=>tool('update_analysis_task',{action:question?'clarify':'create',goal:'合成解释任务',conditions,question,options:question?['按订单','按金额']:[]});
const route=task=>tool('update_analysis_task',{action:'route',task_id:task.task_id,expected_version:task.condition_version,goal:'',options:[]});
const draft=task=>tool('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT 1 AS value',parameters:{},target_id:'synthetic-sqlite',summary:'合成阶段查询',knowledge_refs:[]});
const finish=async(task)=>{
 await route(task);const text='合成说明已完整提交';
 assert.equal((await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text})).status,200);
 const result=await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:randomUUID(),final_text:text,checkpoint:checkpoint()});
 assert.equal(result.status,200,JSON.stringify(result.value));h.releaseRun(run.run_id);
};
const phase=async(cid,task)=>(await h.snapshot(cid)).tasks.find(t=>t.id===task.task_id).phase;
const confirm=q=>h.request('/queries/'+q.id+'/confirm',{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version});
const resultRun=async(q)=>{
 const count=h.captured.length;await h.resumeWorker();
 await until(async()=>(await h.request('/queries/'+q.id)).value.execution_state==='succeeded','查询终态');
 attach(await until(()=>h.captured.slice(count).find(r=>r.text.includes('query_id='+q.id)),'结果解释运行'));
 await h.pauseWorker();
};
try{
 const semantic=await h.create();await start(semantic);const task=await create();
 assert.equal(await phase(semantic,task),'investigating');await finish(task);
 assert.equal(await phase(semantic,task),'answered');
 checks.push('正式语义说明提交后才显示已回答');

 const clarify=await h.create();await start(clarify);const waiting=await create('退款比例用哪个分母？');await finish(waiting);
 assert.equal(await phase(clarify,waiting),'waiting_clarification');
 await start(clarify);const receipt=await route(waiting);assert.equal(receipt.condition_version,waiting.condition_version);await finish(waiting);
 assert.equal(await phase(clarify,waiting),'waiting_clarification');
 checks.push('开放澄清时允许追问原任务，正式解释不吞掉澄清');

 const query=await h.create();await start(query);const queryTask=await create();const q=await draft(queryTask);await finish(queryTask);
 assert.equal(await phase(query,queryTask),'waiting_confirmation');assert.equal((await confirm(q)).status,200);
 await resultRun(q);assert.equal(await phase(query,queryTask),'investigating');
 // 结果已返回但没有finish，模拟模型无法交付；该任务不能提前显示已回答。
 assert.equal((await h.snapshot(query)).runs.find(r=>r.run_id===run.run_id).state,'running');
 await finish(queryTask);assert.equal(await phase(query,queryTask),'answered');
 checks.push('查询终态先等解释，正式结果解释提交才显示已回答');

 const multiple=await h.create();await start(multiple);const multiTask=await create();const first=await draft(multiTask),second=await draft(multiTask);await finish(multiTask);
 assert.equal((await confirm(first)).status,200);
 await resultRun(first);assert.equal(await phase(multiple,multiTask),'waiting_confirmation');
 await finish(multiTask);assert.equal(await phase(multiple,multiTask),'waiting_confirmation');
 // 已通过真实草稿/确认入口，固定另一份提交中的状态作为交付竞争边界。
 assert.equal((await confirm(second)).status,200);await start(multiple);
 for(const state of ['queued','submitting','running','submission_unknown']){
  h.sql(`UPDATE query_requests SET execution_state='${state}',lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)) WHERE id='${second.id}';UPDATE analysis_tasks SET phase='investigating' WHERE id='${multiTask.task_id}';`);
  await finish(multiTask);assert.equal(await phase(multiple,multiTask),'waiting_query');
  if(state!=='submission_unknown')await start(multiple);
 }
 checks.push('同版本另一份待确认或四种运行状态不能被首份结果/解释覆盖');

 const old=await h.create();await start(old);const oldTask=await create();const oldQuery=await draft(oldTask);await finish(oldTask);assert.equal((await confirm(oldQuery)).status,200);
 await start(old);
 const revised=await tool('update_analysis_task',{action:'revise',task_id:oldTask.task_id,expected_version:oldTask.condition_version,goal:'更新渠道后的任务',condition_patch:{set:{channel:'app'},unset:[]},options:[]});
 const currentQuery=await draft(revised);await finish(revised);assert.equal(await phase(old,revised),'waiting_confirmation');
 const pending=h.captured.find(r=>r.text.includes('query_id='+oldQuery.id)&&r.run_id!==run.run_id);
 if(pending)attach(pending);else await resultRun(oldQuery);
 await finish(revised);assert.equal(await phase(old,revised),'waiting_confirmation');
 assert.equal((await h.request('/queries/'+currentQuery.id)).value.execution_state,'not_submitted');
 checks.push('旧条件结果与正式解释不能推进新条件任务');
 const noDraft=await h.create();await start(noDraft);const original=await create();const prior=await draft(original);await finish(original);assert.equal((await confirm(prior)).status,200);
 await resultRun(prior);
 const freshVersion=await tool('update_analysis_task',{action:'revise',task_id:original.task_id,expected_version:original.condition_version,goal:'新的条件仍需调查',condition_patch:{set:{channel:'web'},unset:[]},options:[]});
 assert.equal(await phase(noDraft,freshVersion),'investigating');await finish(freshVersion);
 assert.equal(await phase(noDraft,freshVersion),'investigating');
 checks.push('旧结果运行即使route到当前版本，无新草稿的新条件仍未回答');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-answer-phase.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}
