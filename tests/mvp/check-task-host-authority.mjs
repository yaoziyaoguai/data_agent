import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';
import {assetInput,select} from './skill-fixtures.mjs';
const h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_LEASE_MS:'120000'}});
let run,manager,lastInput,passed=false;const checks=[];
// 从零合成资料，经实际协议交付后验证持久正文来源；不调用付费模型。
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.value;};
const cp=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const begin=async(cid,text)=>{await h.resumeWorker();run=await h.capture(cid,text);await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');};
const tool=async(name,args)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:cp()};lastInput=input;ok(await h.internal('/internal/data/tool-calls',input));return ok(await h.internal('/internal/data/tools',input)).data;};
const finish=async()=>{const text='本轮合成检查已记录。';ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text}));ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:text,checkpoint:cp()}));h.releaseRun(run.run_id);};
const base={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
try{
 for(const kind of ['knowledge','memory','source','skill']){
  const marker='SYNTHETIC_UNATTRIBUTED_'+kind.toUpperCase();
  const source=(kind==='knowledge'||kind==='source')?ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'独立合成来源',body:marker,related_ids:[]})):ok(await h.request('/assets',assetInput({kind:kind==='memory'?'memory':'skill',name:'独立合成'+kind,body:marker})));
  const cid=await h.create();if(kind==='skill')ok(await select(h,cid,source));
  const userText='请调查可读取的资料，明确还需核对的条件。';assert.equal(userText.includes(marker),false);await begin(cid,userText);
  const received=kind==='knowledge'?await tool('read_knowledge',{object_id:source.id}):kind==='source'?await tool('read_source',{source_id:'document-'+source.id,version:source.version}):kind==='skill'?await tool('read',{path:`/skills/${source.id}/${source.version}/SKILL.md`}):run.workspace_context.memories;
  assert.ok(JSON.stringify(received).includes(marker),'先确认来源真实交付');
  const userTask=await tool('update_analysis_task',{action:'create',goal:userText,conditions:base,options:[]});
  const goal='根据'+marker+'开展分析';const oldNotes='来源说明'+marker;
  const derived=await tool('update_analysis_task',{action:'create',goal,conditions:{...base,notes:oldNotes,metric:marker+'指标',filters:[marker+'筛选']},question:marker+'的适用口径？',options:[marker+'解释','其他解释']});
  const originalInput=lastInput;const initialVersion=derived.condition_version;
  const authority=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  const bucket=kind==='knowledge'?'knowledge':kind==='source'?'sources':kind==='skill'?'skills':'memories';const sourceKey=kind==='source'?'document-'+source.id:source.id;
  assert.ok(authority[bucket].some(pair=>pair[0]===sourceKey),'宿主已记录相应来源类型');
  ok(await h.request(`${kind==='knowledge'||kind==='source'?'/knowledge':'/assets'}/${source.id}/disable`,{operation_id:randomUUID(),expected_version:source.version}));
  const hidden=(value,label)=>assert.equal(JSON.stringify(value).includes(marker),false,label+'不得返回已失效来源正文');
  const replay=await h.internal('/internal/data/tools',originalInput);assert.equal(replay.status,200,JSON.stringify(replay));hidden(replay.value,'成功旧回执');
  await finish();await begin(cid,'继续核对当前任务。');assert.equal(run.checkpoint,null);
  hidden(run.workspace_context,'重建工作区');
  hidden((await h.snapshot(cid)).tasks,'HTTP当前任务目录');
  let current=await tool('read_analysis_task',{task_id:derived.task_id});hidden(current,'当前任务');
  assert.equal(current.phase,'waiting_clarification');assert.ok(current.unavailable_condition_fields.includes('notes'));assert.ok(current.unavailable_condition_fields.includes('metric'));assert.ok(current.unavailable_condition_fields.includes('filters'));
  assert.deepEqual(current.unavailable_clarification_ids,[derived.opened_clarification.id]);
  const historical=await tool('read_analysis_task',{task_id:derived.task_id,condition_version:initialVersion});hidden(historical,'历史条件');
  const original=await tool('read_analysis_task',{task_id:userTask.task_id});assert.equal(original.goal,userText,'逐字真实用户原文目标仍合法');
  let version=current.condition_version;
  const revise=async(set,goalValue='',unset=[])=>{const value=await tool('update_analysis_task',{action:'revise',task_id:derived.task_id,expected_version:version,goal:goalValue,condition_patch:{set,unset},options:[]});version=value.condition_version;return value;};
  hidden(await revise({knowledge_refs:[]}), '清refs回执');
  hidden(await tool('read_analysis_task',{task_id:derived.task_id}),'清refs之后');
  hidden(await revise({channel:'app'}),'只改无关字段');
  current=await tool('read_analysis_task',{task_id:derived.task_id});hidden(current,'改无关字段之后');assert.equal(current.conditions.channel,'app');
  hidden(await revise({notes:oldNotes},goal),'同文重传');
  hidden(await tool('read_analysis_task',{task_id:derived.task_id}),'同文重传之后');
  const safeNotes='新的独立合法说明';hidden(await revise({notes:safeNotes}),'真正改写notes');
  current=await tool('read_analysis_task',{task_id:derived.task_id});hidden(current,'改写notes之后');assert.equal(current.conditions.notes,safeNotes);assert.equal(current.goal,undefined);assert.equal(current.phase,'waiting_clarification');assert.equal(current.unavailable_condition_fields.includes('notes'),false);assert.ok(current.unavailable_condition_fields.includes('metric'));
  hidden(await revise({},'新的独立合法目标',['metric','filters']),'重写goal并清除条件');current=await tool('read_analysis_task',{task_id:derived.task_id});hidden(current,'最终当前任务');assert.equal(current.goal,'新的独立合法目标');assert.equal(current.conditions.notes,safeNotes);assert.equal(current.conditions.metric,null);assert.deepEqual(current.conditions.filters,[]);assert.equal(current.phase,'waiting_clarification');
  hidden(await tool('read_analysis_task',{task_id:derived.task_id,condition_version:initialVersion}),'改写不能洗掉历史条件来源');
  await finish();await begin(cid,'下一轮继续未完成的澄清。');hidden(run.workspace_context,'跨重建两轮工作区');
  current=await tool('read_analysis_task',{task_id:derived.task_id});hidden(current,'下一轮当前任务');assert.equal(current.conditions.notes,safeNotes);assert.equal(current.goal,'新的独立合法目标');
  await tool('update_analysis_task',{action:'route',task_id:derived.task_id,expected_version:version,goal:'',options:[]});await finish();
  checks.push({kind,deliveredDependency:true,hiddenAcrossRebuild:true,historicalHidden:true,replayHidden:true,clearingRefsCannotLaunder:true,unrelatedRevisionCannotLaunder:true,sameTextCannotLaunder:true,actualRewriteRecovers:true,originalUserTextPreserved:true,unansweredQuestionRemains:true});
 }
 // 宿主合成消息即使正文逐字一致也不能获得真实用户原文豁免。
 const syntheticMarker='SYNTHETIC_HOST_MESSAGE_SOURCE';
 const syntheticDoc=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成通知来源',body:syntheticMarker,related_ids:[]}));
 const syntheticCid=await h.create();await begin(syntheticCid,'结果通知包含'+syntheticMarker);
 h.sql(`UPDATE conversation_messages SET client_key='server:synthetic-notice:${run.message_id}' WHERE id='${run.message_id}'`);
 await tool('read_knowledge',{object_id:syntheticDoc.id});
 const synthetic=await tool('update_analysis_task',{action:'create',goal:run.text,conditions:base,options:[]});
 await finish();ok(await h.request(`/knowledge/${syntheticDoc.id}/disable`,{operation_id:randomUUID(),expected_version:syntheticDoc.version}));
 await begin(syntheticCid,'新消息检查合成通知形成的任务。');
 const syntheticRead=await tool('read_analysis_task',{task_id:synthetic.task_id});
 assert.equal(syntheticRead.goal,undefined);assert.equal(JSON.stringify(syntheticRead).includes(syntheticMarker),false);
 await tool('update_analysis_task',{action:'route',task_id:synthetic.task_id,expected_version:synthetic.condition_version,goal:'',options:[]});await finish();
 checks.push({syntheticMessageExactTextCannotBypass:true});

 // 升级前没有完整来源的条件持续不可用；局部修订不能把其它旧字段洗成可信。
 const legacyCid=await h.create();await begin(legacyCid,'建立无完整来源的旧任务夹具。');
 const legacy=await tool('update_analysis_task',{action:'create',goal:'旧目标',conditions:{...base,notes:'旧来源未知说明',metric:'旧来源未知指标'},options:[]});
 h.sql(`UPDATE condition_revisions SET field_authorities=NULL WHERE task_id='${legacy.task_id}'`);
 let legacyRead=await tool('read_analysis_task',{task_id:legacy.task_id});
 assert.equal(legacyRead.context_complete,false);assert.equal(legacyRead.conditions.notes,undefined);assert.equal(legacyRead.conditions.metric,undefined);
 let legacyRevision=await tool('update_analysis_task',{action:'revise',task_id:legacy.task_id,expected_version:legacy.condition_version,goal:'',condition_patch:{set:{channel:'app',notes:'旧来源未知说明'},unset:[]},options:[]});
 assert.equal(legacyRevision.conditions.notes,undefined);assert.equal(legacyRevision.conditions.metric,undefined);assert.equal(legacyRevision.conditions.channel,'app');
 legacyRevision=await tool('update_analysis_task',{action:'revise',task_id:legacy.task_id,expected_version:legacyRevision.condition_version,goal:'',condition_patch:{set:{notes:'重新调查后的说明'},unset:['metric']},options:[]});
 assert.equal(legacyRevision.conditions.notes,'重新调查后的说明');assert.equal(legacyRevision.conditions.metric,null);
 const legacyHistory=await tool('read_analysis_task',{task_id:legacy.task_id,condition_version:legacy.condition_version});
 assert.equal(legacyHistory.conditions.notes,undefined);assert.equal(legacyHistory.conditions.metric,undefined);
 await finish();checks.push({legacyUnknownFieldsRemainHidden:true,unchangedFieldsCannotLaunder:true,explicitRewriteAndUnsetRecover:true,historicalUnknownStillHidden:true});
 passed=true;
}finally{await writeFile('.local/checks/task-host-authority.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}
console.log(JSON.stringify({passed,checks,officialRequests:0}));
