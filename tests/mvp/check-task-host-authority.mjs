import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';
import {assetInput,select} from './skill-fixtures.mjs';
const h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_LEASE_MS:'120000'}});
let run,manager,lastInput,passed=false;const checks=[];
// 验证本人私有任务与独立资料的读权限，停用后不能用旧SDK回执取回原资料。
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.value;};
const cp=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const begin=async(cid,text)=>{await h.resumeWorker();run=await h.capture(cid,text);await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');};
const invoke=async(name,args)=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),
  tool_name:name,arguments:args,checkpoint:cp()};
 lastInput=input;
 ok(await h.internal('/internal/data/tool-calls',input));
 return h.internal('/internal/data/tools',input);
};
const tool=async(name,args)=>ok(await invoke(name,args)).data;
const finish=async()=>{
 const text='本轮合成检查已记录。';
 ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text}));
 ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,
  commit_id:run.output_id,final_text:text,checkpoint:cp()}));
 h.releaseRun(run.run_id);
};
const base={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
try{
 for(const kind of ['knowledge','memory','source','skill']){
  const marker='SYNTHETIC_UNATTRIBUTED_'+kind.toUpperCase();
  const publicSource=kind==='knowledge'||kind==='source';
  const source=publicSource
   ?ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'独立合成来源',body:marker,related_ids:[]}))
   :ok(await h.request('/assets',assetInput({kind,name:'独立合成'+kind,body:marker})));
  const ref={object_id:source.id,version:source.version,path:'body'};
  const read=kind==='knowledge'
   ?['read_knowledge',{items:[{kind:'knowledge',ref}]}]
   :kind==='source'
    ?['read_source',{citation:{source:{kind:'document',id:source.id},revision:source.version,
      locator:{offset:0,length:[...marker].length}}}]
    :kind==='memory'
     ?['read_knowledge',{items:[{kind:'memory',asset_ref:{id:source.id,version:source.version},part:'body'}]}]
     :['read',{path:`/skills/${source.id}/${source.version}/SKILL.md`}];
  const cid=await h.create();
  if(kind==='skill')ok(await select(h,cid,source));
  const userText='请调查可读取的资料，明确还需核对的条件。';
  await begin(cid,userText);
  const received=await tool(...read);
  const originalRead=lastInput;
  assert.ok(JSON.stringify(received).includes(marker),'先确认资料实际交付');
  const original=await tool('update_analysis_task',{action:'create',goal:userText,
   conditions:{...base,notes:'本人合成笔记',knowledge_refs:publicSource?[ref]:[]},
   question:'适用哪种口径？',options:['第一种','第二种']});
  assert.ok(JSON.stringify(ok(await h.internal('/internal/data/tools',originalRead)).data).includes(marker));

  const foreign=await h.request(`/conversations/${cid}/snapshot`,undefined,'bob');
  assert.equal(foreign.status,404);
  if(!publicSource)assert.ok(!ok(await h.request('/assets',undefined,'bob')).assets.some(asset=>asset.id===source.id));
  ok(await h.request(`${publicSource?'/knowledge':'/assets'}/${source.id}/disable`,
   {operation_id:randomUUID(),expected_version:source.version}));
  const replay=await h.internal('/internal/data/tools',originalRead);
  assert.equal(JSON.stringify(replay.value).includes(marker),false,'原SDK回执不能回送已撤资料');
  ok(await h.request(`/conversations/${cid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()}));
  h.releaseRun(run.run_id);
  await begin(cid,'继续核对当前任务。');
  assert.equal(JSON.stringify(run.workspace_context).includes(marker),false,'新一轮不能注入已撤资料正文');
  const current=await tool('read_analysis_task',{task_id:original.task_id});
  assert.equal(current.goal,userText);
  assert.equal(current.conditions.notes,'本人合成笔记');
  assert.equal(current.phase,'waiting_clarification');
  assert.deepEqual(current.open_clarifications.map(value=>value.id),[original.opened_clarification.id]);
  const denied=await invoke(...read);
  assert.equal(JSON.stringify(denied.value).includes(marker),false,'按原版本补读也不能回送已撤资料');
  if(denied.status===200)assert.ok(['stale','not_available'].includes(denied.value.data.items?.[0]?.state),
   JSON.stringify(denied.value));
  const revised=await tool('update_analysis_task',{action:'revise',task_id:original.task_id,
   expected_version:current.condition_version,goal:'',condition_patch:{set:{channel:'app'},unset:[]},options:[]});
  assert.equal(revised.condition_version,String(Number(current.condition_version)+1));
  const historical=await tool('read_analysis_task',{task_id:original.task_id,condition_version:original.condition_version});
  assert.equal(historical.conditions.notes,'本人合成笔记');
  assert.deepEqual(historical.current_open_clarification_ids,[original.opened_clarification.id]);
  await finish();
  checks.push({kind,deliveredDependency:true,foreignDenied:true,disabledReadHidden:true,
   replayHidden:true,originalUserTextPreserved:true,historicalConditionsPreserved:true,unansweredQuestionRemains:true});
 }
 passed=true;
}finally{await writeFile('.local/checks/task-host-authority.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}
console.log(JSON.stringify({passed,checks,officialRequests:0}));
