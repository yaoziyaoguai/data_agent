import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { exportCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { harness } from './harness.mjs';
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});
const manager=SessionManager.inMemory('/synthetic/data-agent');
const conditions={time_start:'2026-01-01T00:00:00Z',time_end:'2026-02-01T00:00:00Z',timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:['is_test=0'],knowledge_refs:[],notes:''};
let passed=false;let run;const tasks=[];
const invoke=async(tool_name,args)=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name,arguments:args,checkpoint:exportCheckpoint(manager)};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
 const result=await h.internal('/internal/data/tools',input);assert.equal(result.status,200,JSON.stringify(result.value));return result.value.data;
};
try{
 const cid=await h.create();
 for(let i=0;i<26;i++){
  run=await h.capture(cid,i===0?'合成历史长消息'.repeat(1100):'合成订单任务'+i);await h.pauseWorker();
  if(i===0)tasks.push(await invoke('update_analysis_task',{action:'create',goal:'同一消息的第一个独立目标',conditions,options:[]}));
  tasks.push(await invoke('update_analysis_task',{action:'create',task_id:null,expected_version:null,goal:'合成订单任务'+i,conditions,question:null,options:[]}));
  await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text:'已保存'});
  assert.equal((await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:'已保存',checkpoint:exportCheckpoint(manager)})).status,200);
  h.releaseRun(run.run_id);await h.resumeWorker();
 }
 run=await h.capture(cid,'继续先前的订单任务');await h.pauseWorker();
 assert.equal(run.workspace_context.tasks.length,24);
 const omitted=tasks.find(t=>!run.workspace_context.tasks.some(v=>v.id===t.task_id));assert.ok(omitted);
 const history=await invoke('read_conversation',{after_seq:'0'});
 const message=history.events.find(e=>e.payload.task_id===omitted.task_id);assert.ok(message);
 let after='0',ids=[],events=[];
 do{const page=await invoke('read_conversation',{after_seq:after});assert.ok(Buffer.byteLength(JSON.stringify(page.events))<=12000);events.push(...page.events);ids.push(...page.events.map(e=>e.event_seq));if(!page.events.length)break;after=page.next_after_seq;}while(true);
 assert.equal(new Set(ids).size,ids.length);assert.ok(events.length>=26);
 const long=events.find(e=>e.payload.content_page.total_chars>2048);assert.ok(long);
 let complete='',offset=0;do{const page=await invoke('read_conversation',{after_seq:'0',message_id:long.payload.message_id,offset});complete+=page.text;offset=page.content_page.next_offset;}while(offset!==null);
 assert.equal(complete,'合成历史长消息'.repeat(1100));
 const task=await invoke('read_analysis_task' ,{task_id:message.payload.task_id});
 assert.equal(task.id,omitted.task_id);assert.deepEqual(task.conditions,conditions);assert.equal(task.condition_version,'1');
 let taskAfter,all=[];do{const page=await invoke('read_conversation',{after_seq:'0',task_directory:true,...(taskAfter?{task_after:taskAfter}:{})});all.push(...page.tasks);taskAfter=page.next_task_after;}while(taskAfter);
 assert.equal(all.length,27);assert.equal(new Set(all.map(t=>t.id)).size,27);assert.ok(all.some(t=>t.id===tasks[0].task_id));
 const first=await invoke('read_analysis_task',{task_id:tasks[0].task_id});assert.equal(first.goal,'同一消息的第一个独立目标');
 assert.ok(all.every(t=>!('conditions' in t)));passed=true;
 console.log(JSON.stringify({passed,checks:[{name:'超过24任务后，从未撤回历史的宿主task_id找回上下文外的早期任务及当前条件',passed:true}],officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-long-conversation.json',JSON.stringify({passed,taskCount:tasks.length},null,2));await h.close();}
