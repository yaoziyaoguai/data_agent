import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

// 本人任务文本、历史条件、显式来源限制和未完成调用恢复。
const h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_LEASE_MS:'120000'}});
let run,manager,lastInvocation;
const checks=[];
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.value;};
const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const begin=async(cid,text)=>{await h.resumeWorker();run=await h.capture(cid,text);await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');};
const tool=async(name,args)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:checkpoint()};lastInvocation=input;ok(await h.internal('/internal/data/tool-calls',input));return h.internal('/internal/data/tools',input);};
const finish=async()=>{const text='本轮合成验证完成。';ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text}));ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:text,checkpoint:checkpoint()}));h.releaseRun(run.run_id);};
const conditions={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
const marker='SYNTHETIC_OWNER_TASK_TEXT';
const retainLegacyTaskText=()=>manager.appendMessage({role:'assistant',content:[{type:'text',text:JSON.stringify({goal:marker+'旧目标',clarification:{question:marker+'旧问题',options:[marker+'旧选项']}})}],api:'openai-completions',provider:'synthetic',model:'synthetic',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
try {
  const doc=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'问题来源的合成资料',body:marker,related_ids:[]}));
  const cid=await h.create();await begin(cid,'先建立没有资料依赖的任务。');
  const original=ok(await tool('update_analysis_task',{action:'create',goal:'最初目标',conditions,options:[]})).data;
  const cited=ok(await tool('update_analysis_task',{action:'clarify',task_id:original.task_id,expected_version:original.condition_version,goal:marker+'目标',condition_patch:{set:{knowledge_refs:[{object_id:doc.id,version:doc.version,path:'body'}]},unset:[]},question:marker+'采用哪个口径？',options:[marker+'口径A','口径B']})).data;
  const citedInvocation=lastInvocation;
  const beforeIdentityDirectory=ok(await tool('read_analysis_task',{task_id:original.task_id})).data;
  assert.equal(beforeIdentityDirectory.goal,marker+'目标','旧活动任务范围中有效的派生目标仍可正常读取');
  const sourceFree=ok(await tool('update_analysis_task',{action:'create',goal:run.text,conditions,options:[]})).data;
  ok(await tool('update_analysis_task',{action:'route',task_id:original.task_id,expected_version:cited.condition_version,goal:'',options:[]}));
  const directory=ok(await tool('read_conversation',{after_seq:'0',task_directory:true})).data;
  const byIdentity=id=>directory.tasks.find(task=>task.id===id);
  assert.equal(byIdentity(original.task_id).goal,marker+'目标');
  assert.equal(byIdentity(sourceFree.task_id).goal,run.text);
  for(const task of directory.tasks){
    assert.equal(typeof task.id,'string');assert.equal(typeof task.condition_version,'string');
    assert.equal(typeof task.lifecycle,'string');assert.equal(typeof task.phase,'string');
    assert.equal(Object.hasOwn(task,'conditions'),false);
  }
  assert.equal(Object.hasOwn(directory,'next_task_after'),true);
  const foreign=await h.request('/conversations/'+cid+'/snapshot',undefined,'bob');
  assert.equal(foreign.status,404);
  ok(await h.request(`/knowledge/${doc.id}/disable`,{operation_id:randomUUID(),expected_version:doc.version}));
  const replay=ok(await h.internal('/internal/data/tools',citedInvocation)).data;
  assert.equal(replay.condition_version,cited.condition_version);
  assert.equal(h.sql(`SELECT JSON_OBJECT('version',condition_version) FROM analysis_tasks WHERE id='${original.task_id}'`)[0].version,Number(cited.condition_version),'重放不能再次推进任务版本');
  await finish();
  await begin(cid,'读取最初的条件。');
  const current=ok(await tool('read_analysis_task',{task_id:original.task_id})).data;
  assert.equal(current.goal,marker+'目标');
  assert.equal(current.open_clarifications[0].question,marker+'采用哪个口径？');
  assert.equal(current.conditions.timezone,'UTC');
  const historical=ok(await tool('read_analysis_task',{task_id:original.task_id,condition_version:original.condition_version})).data;
  assert.deepEqual(historical.conditions,conditions);
  assert.equal(historical.current_condition_version,cited.condition_version);
  assert.equal(historical.goal,undefined);assert.equal(historical.clarification,undefined);assert.equal(historical.open_clarifications,undefined);
  assert.deepEqual(historical.current_open_clarification_ids,[cited.opened_clarification.id]);
  assert.equal(run.workspace_context.tasks.find(task=>task.id===original.task_id).goal,marker+'目标');
  checks.push('停用资料后本人保留任务文字与未答问题，历史条件按原版本读取，外部用户仍不可读，本轮回执重放不重复写入');
  const recovered=ok(await tool('update_analysis_task',{action:'revise',task_id:original.task_id,expected_version:cited.condition_version,goal:'旧记录重新调查后的目标',condition_patch:{set:{knowledge_refs:[]},unset:[]},options:[]})).data;
  // 模拟无法按当前依赖格式解释的旧检查点，保留完整旧调用与失败原因检查。
  retainLegacyTaskText();
  await finish();
  assert.ok(JSON.stringify(h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)).includes(marker));
  h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_SET(checkpoint,'$.authority_snapshot.dependency_schema',4,'$.authority_snapshot.knowledge',JSON_ARRAY()) WHERE recovery_chain_id='${run.recovery_chain_id}'`);
  await begin(cid,'升级后继续当前任务。');
  assert.equal(run.checkpoint,null,'旧schema4无法按当前依赖格式验证，新消息从合法任务状态接续');
  assert.equal(run.workspace_context.authority_snapshot.dependency_schema,6);
  const continueTask=ok(await tool('read_analysis_task',{task_id:original.task_id})).data;
  assert.equal(continueTask.goal,'旧记录重新调查后的目标');
  ok(await tool('update_analysis_task',{action:'route',task_id:original.task_id,expected_version:recovered.condition_version,goal:'',options:[]}));
  await finish();
  checks.push('旧schema4的新输入可从合法任务状态继续，旧持久条件仍可读取');

  await begin(cid,'模拟旧格式的未完成输入。');
  retainLegacyTaskText();
  const unresolved={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'update_analysis_task',arguments:{action:'revise',task_id:original.task_id,expected_version:recovered.condition_version,goal:'',condition_patch:{set:{notes:'尚未执行的更新'},unset:[]},options:[]},checkpoint:checkpoint()};
  const operation=ok(await h.internal('/internal/data/tool-calls',unresolved)).operation_id;
  const pending=run;
  h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_SET(checkpoint,'$.authority_snapshot.dependency_schema',4,'$.authority_snapshot.knowledge',JSON_ARRAY()) WHERE recovery_chain_id='${pending.recovery_chain_id}';UPDATE agent_runs SET state='interrupted' WHERE id='${pending.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${pending.message_id}'`);
  h.releaseRun(pending.run_id);await h.restartApi();const capturedBefore=h.captured.length;await h.resumeWorker();
  await until(()=>h.sql(`SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE message_id='${pending.message_id}'`).some(job=>job.state==='failed'),'旧格式原输入恢复按stale_context停止',40000);
  await h.pauseWorker();
  assert.ok(h.logs.some(log=>log.output.includes('delivery_rejected')&&log.output.includes('stale_context')));
  const failedEvent=(await h.snapshot(cid)).events.find(event=>event.type==='run_failed'&&event.payload.message_id===pending.message_id);
  assert.equal(failedEvent?.payload.code,'stale_context','持久失败原因应保留实际安全终止原因，不能伪装成重试耗尽');
  assert.equal(h.captured.slice(capturedBefore).some(value=>value.message_id===pending.message_id),false);
  assert.deepEqual(h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt,'origin',origin_run_id) FROM tool_calls WHERE operation_id='${operation}'`)[0],{state:'registered',receipt:null,origin:pending.run_id});
  assert.equal(h.sql(`SELECT JSON_OBJECT('version',condition_version) FROM analysis_tasks WHERE id='${original.task_id}'`)[0].version,Number(recovered.condition_version));
  checks.push('旧schema4未完成输入拒绝恢复，未进入Pi；原registered未知工具身份/空回执与任务版本保持，不能换ID重做');
  const exhaustedCid=await h.create();await begin(exhaustedCid,'验证实际交付重试耗尽。');
  const exhausted=run;
  // 隔离夹具固定已用尽的交付尝试；与上面的首次安全拒绝分别核对持久原因。
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${exhausted.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${exhaustedCid}';UPDATE background_jobs SET state='queued',attempts=4,lease_owner=NULL,lease_until=NULL WHERE message_id='${exhausted.message_id}'`);
  h.releaseRun(exhausted.run_id);await h.resumeWorker();
  const exhaustedSnapshot=await until(async()=>{const snapshot=await h.snapshot(exhaustedCid);return snapshot.events.some(event=>event.type==='run_failed')?snapshot:false;},'实际重试耗尽保留原因',40000);
  await h.pauseWorker();
  assert.equal(exhaustedSnapshot.events.find(event=>event.type==='run_failed').payload.code,'retry_exhausted');
  checks.push('真实交付尝试耗尽仍记录retry_exhausted，与首次权限/上下文拒绝区分');

  // 04切片1：source_limits/time_roles/semantic_resolution的条件修订语义。
  // set替换、unset清空、省略继承；旧任务缺新字段不被压成显式null。
  const sliceCid=await h.create();
  const limitMessage='只用文档A，观察截点为2026-10-01，口径采用我说的这条。';
  await begin(sliceCid,limitMessage);
  const limitDoc=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'来源限制合成资料',body:'文档A正文',related_ids:[]}));
  const limitedTask=ok(await tool('update_analysis_task',{action:'create',goal:'带来源限制的统计任务',conditions,options:[]})).data;
  const sliceMessage=run.message_id;
  const limited=ok(await tool('update_analysis_task',{action:'revise',task_id:limitedTask.task_id,expected_version:limitedTask.condition_version,goal:'',condition_patch:{set:{
    source_limits:{allowed_sources:[{kind:'document',id:limitDoc.id}],origin_message_ids:[sliceMessage]},
    time_roles:[{role:'observation_cutoff',description:'数据观察截点',field_ref:null,value:'2026-10-01T00:00:00+08:00',evidence_refs:[]}],
    semantic_resolution:{interpretation:'按用户明确的口径统计',basis:'explicit_user',user_quote:limitMessage,evidence_refs:[],adoption_message_id:sliceMessage},
  },unset:[]},options:[]})).data;
  assert.equal(Number(limited.condition_version),Number(limitedTask.condition_version)+1);
  // “改十月”只改统计区间：其余字段省略继承，来源限制/时间角色/口径决策全保留。
  const october=ok(await tool('update_analysis_task',{action:'revise',task_id:limitedTask.task_id,expected_version:limited.condition_version,goal:'',condition_patch:{set:{time_start:'2026-10-01T00:00:00Z',time_end:'2026-11-01T00:00:00Z'},unset:[]},options:[]})).data;
  const afterChange=ok(await tool('read_analysis_task',{task_id:limitedTask.task_id})).data;
  assert.equal(afterChange.conditions.time_start,'2026-10-01T00:00:00Z');
  assert.deepEqual(afterChange.conditions.source_limits,{allowed_sources:[{kind:'document',id:limitDoc.id}],origin_message_ids:[sliceMessage]},'来源限制省略继承，改区间不撤限制');
  assert.equal(afterChange.conditions.time_roles[0].value,'2026-10-01T00:00:00+08:00','观察截点带时区保留');
  assert.equal(afterChange.conditions.semantic_resolution.adoption_message_id,sliceMessage,'口径决策与采纳身份保留');
  assert.equal(Number(afterChange.condition_version),Number(limited.condition_version)+1,'普通修订推进条件版本');
  checks.push('“只用文档A→改十月”只改统计区间；来源限制、时间角色与口径决策省略继承');
  // 显式unset才撤限制：撤后为显式null，未unset字段不受影响。
  const lifted=ok(await tool('update_analysis_task',{action:'revise',task_id:limitedTask.task_id,expected_version:october.condition_version,goal:'',condition_patch:{set:{},unset:['source_limits']},options:[]})).data;
  const afterLift=ok(await tool('read_analysis_task',{task_id:limitedTask.task_id})).data;
  assert.equal(afterLift.conditions.source_limits,null,'显式unset后为null：本题明确未限制');
  assert.equal(afterLift.conditions.time_roles.length,1,'未unset的时间角色保留');
  assert.equal(afterLift.conditions.semantic_resolution.adoption_message_id,sliceMessage,'未unset的口径决策保留');
  checks.push('显式unset才撤销来源限制；未unset字段不受影响');
  await finish();

  // 旧channel任务续接：channel保留解码，新字段缺失与显式null区分不混同。
  const legacyCid=await h.create();await begin(legacyCid,'旧格式任务只带channel。');
  const legacyTask=ok(await tool('update_analysis_task',{action:'create',goal:'旧channel任务',conditions,options:[]})).data;
  // 真实旧持久形状没有新字段；新版本create已明确保存null，不能用新记录冒充旧记录。
  h.sql(`UPDATE condition_revisions SET body=JSON_SET(JSON_REMOVE(body,'$.source_limits'),'$.channel','web'),decision_state_version=1 WHERE task_id='${legacyTask.task_id}'`);
  const legacyRevised=ok(await tool('update_analysis_task',{action:'revise',task_id:legacyTask.task_id,expected_version:legacyTask.condition_version,goal:'',condition_patch:{set:{time_start:'2026-09-01T00:00:00Z'},unset:[]},options:[]})).data;
  const legacyView=ok(await tool('read_analysis_task',{task_id:legacyTask.task_id})).data;
  assert.equal(legacyView.conditions.channel,'web','旧channel保留解码');
  assert.equal(legacyView.conditions.source_limits,undefined,'旧任务缺失新字段不被压成显式null');
  assert.equal(legacyView.conditions.time_roles,undefined);
  assert.equal(legacyView.conditions.semantic_resolution,undefined);
  assert.equal(Number(h.sql(`SELECT JSON_OBJECT('has_limits',JSON_CONTAINS_PATH(body,'one','$.source_limits'),'has_roles',JSON_CONTAINS_PATH(body,'one','$.time_roles')) FROM condition_revisions WHERE task_id='${legacyTask.task_id}' AND version=${legacyRevised.condition_version}`)[0].has_limits),0,'存储层保留缺失与显式null的区别');
  checks.push('旧channel任务续接：channel保留解码，字段缺失不冒充显式null');
  await finish();
  const result={passed:true,checks,officialRequests:0};
  await writeFile('.local/checks/task-text-authority.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {await h.close();}
