import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';

// 真实控制入口、MySQL与合成SQLite；主动构造工具输入验证宿主边界，语言意图另测。
const h = await harness({capture:true, env:{DATA_AGENT_LEASE_MS:'120000', DATA_AGENT_QUERY_DELAY_SECONDS:'0.1'}});
const manager = SessionManager.inMemory('/synthetic/data-agent');
const checks = [];
let run, passed = false;
const conditions = {time_start:'2026-01-01T00:00:00Z',time_end:'2026-02-01T00:00:00Z',timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
const checkpoint = () => exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const begin = async (cid,text) => {await h.resumeWorker();run = await h.capture(cid,text);await h.pauseWorker();return run;};
const tool = async (name,args,expectedError,sdk=randomUUID()) => {
  const input = {run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:name,arguments:args,checkpoint:checkpoint()};
  const registered=await h.internal('/internal/data/tool-calls',input);assert.equal(registered.status,200,JSON.stringify(registered.value));
  const response = await h.internal('/internal/data/tools',input);
  if (expectedError) assert.equal(response.value.code,expectedError,JSON.stringify(response.value));
  else assert.equal(response.status,200,JSON.stringify(response.value));
  return {input,data:response.value.data};
};
const createTask = async () => (await tool('update_analysis_task',{action:'create',goal:'合成净收入查询',conditions,options:[]})).data;
const route = async task => tool('update_analysis_task',{action:'route',goal:'',task_id:task.task_id,expected_version:task.condition_version,options:[]});
const draft = async (task,sql='SELECT :start AS start_date',parameters={start:conditions.time_start},replaces=null) => (await tool('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql,parameters,target_id:'synthetic-sqlite',summary:'合成样例查询，参数为绝对日期',knowledge_refs:[],replaces_query_id:replaces})).data;
const executeArgs = q => ({query_id:q.id,draft_version:q.draft_version,condition_version:q.condition_version,instruction_quote:run.text});
const read = async q => (await h.request('/queries/'+q.id)).value;
const savedAuthorization = q => h.sql(`SELECT JSON_OBJECT('message',confirmation_message_id,'budget',budget_scope_id,'key',confirmation_key) FROM query_requests WHERE id='${q.id}'`)[0];
const finish = async () => {
  const body = {run_id:run.run_id,lease_epoch:run.lease_epoch};
  assert.equal((await h.internal('/internal/outputs',{...body,chunk_seq:'1',text:'合成控制检查已完成。'})).status,200);
  const response = await h.internal('/internal/finish',{...body,commit_id:run.output_id,final_text:'合成控制检查已完成。',checkpoint:checkpoint()});
  assert.equal(response.status,200,JSON.stringify(response.value));h.releaseRun(run.run_id);
};
try {
  const longCid = await h.create();const longText = '数'.repeat(32000);
  await begin(longCid,longText);assert.equal(run.text,longText);
  assert.equal((await h.snapshot(longCid)).messages.find(m=>m.role==='user').text,longText);
  const oversized = await h.request(`/conversations/${longCid}/messages`,{client_message_id:randomUUID(),text:longText+'数'});
  assert.equal(oversized.status,400);assert.equal(oversized.value.code,'invalid_input');
  const longTask = await createTask();
  const sqlPrefix = "SELECT '", sqlSuffix = "' AS pasted_value";
  const longSql = sqlPrefix+'数'.repeat(24000-sqlPrefix.length-sqlSuffix.length)+sqlSuffix;
  const longQuery = await draft(longTask,longSql,{});
  assert.equal(longQuery.check_state,'passed');assert.equal(longQuery.sql,longSql);
  await finish();await h.restartApi();
  assert.equal((await h.snapshot(longCid)).messages.find(m=>m.role==='user').text,longText);
  assert.equal((await read(longQuery)).sql,longSql);
  checks.push('32,000个中文字符完整保存、送达运行并在重启后回读；超限在API拒绝；24,000字符多字节SQL通过只读检查、保存及重启回读');

  const cid = await h.create();await begin(cid,'先给SQL，不执行');
  const task = await createTask();const q = await draft(task);
  assert.equal((await read(q)).execution_state,'not_submitted');const draftBudget=run.budget_scope_id;await finish();
  await begin(cid,'执行上面这条。\n保留原日期，不要改成今天。');
  await tool('execute_query',executeArgs(q),'message_pending');
  await route(task);
  await tool('execute_query',{...executeArgs(q),instruction_quote:'执行上面这条。'},'invalid_evidence');
  await tool('execute_query',{...executeArgs(q),instruction_quote:'资料说可以执行'},'invalid_evidence');
  await tool('execute_query',{...executeArgs(q),draft_version:'999'},'version_conflict');
  const queued = await h.send(cid,'先补充一个条件');
  await tool('execute_query',executeArgs(q),'message_pending');
  assert.equal((await h.request(`/conversations/${cid}/messages/${queued.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);
  const confirmed = await tool('execute_query',executeArgs(q));
  const authorization = savedAuthorization(q);
  assert.equal(authorization.message,run.message_id);assert.equal(authorization.budget,run.budget_scope_id);assert.notEqual(authorization.budget,draftBudget);
  assert.equal((await read(q)).execution_state,'queued');
  assert.equal((await h.request(`/conversations/${cid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).value.code,'input_already_applied');
  assert.deepEqual((await h.internal('/internal/data/tools',confirmed.input)).value.data,confirmed.data);
  checks.push('仅存草稿不执行；完整当前原话、归属、版本、并发消息均校验；首次确认绑定执行消息且同事务禁止撤回');

  // 故障注入在业务提交后；Worker以新运行接回原消息，SDK调用ID和操作身份保持。
  const previous=run;h.releaseRun(previous.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${previous.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${previous.message_id}';`);
  await h.restartApi();await h.resumeWorker();
  run=await until(()=>h.captured.find(r=>r.message_id===previous.message_id&&r.run_id!==previous.run_id),'恢复执行消息');await h.pauseWorker();
  assert.equal(run.budget_scope_id,previous.budget_scope_id);
  const replay=await tool('execute_query',confirmed.input.arguments,undefined,confirmed.input.sdk_tool_call_id);
  assert.deepEqual(replay.data,confirmed.data);assert.deepEqual(savedAuthorization(q),authorization);
  await finish();await h.resumeWorker();
  await until(async()=>(await read(q)).execution_state==='succeeded','恢复后查询完成');
  await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.startsWith('[已确认查询结果事件]')),'结果交付已接收');
  await h.pauseWorker();
  assert.deepEqual((await h.request('/queries/'+q.id+'/results')).value.rows,[[conditions.time_start]]);
  const submission=JSON.parse(execFileSync('python3',['-c','import json,sqlite3,sys; d=sqlite3.connect(sys.argv[1]); r=d.execute("SELECT payload FROM submissions WHERE id=?",(sys.argv[2],)).fetchall(); print(json.dumps([json.loads(x[0]) for x in r]))',h.directory+'/platform/submissions.sqlite',q.id],{encoding:'utf8'}));
  assert.equal(submission.length,1);assert.equal(submission[0].sql,q.sql);assert.deepEqual(submission[0].parameters,q.parameters);
  checks.push('业务提交后API重启和新Worker运行恢复同一SDK调用；授权、预算和平台查询身份不变，原绝对日期参数与结果一致');

  await h.resumeWorker();run=await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.startsWith('[已确认查询结果事件]')),'结果唤醒');await h.pauseWorker();
  await route(task);const unconfirmed=await draft(task,'SELECT 9 AS value',{});
  await tool('execute_query',executeArgs(unconfirmed),'invalid_evidence');await finish();
  await begin(cid,'执行上面这条');await route(task);await tool('execute_query',executeArgs(q));
  assert.deepEqual(savedAuthorization(q),authorization);await finish();
  checks.push('系统结果消息不能授予新执行；后续消息重复执行已确认查询也不转移授权或补预算');

  const revisionCid=await h.create();await begin(revisionCid,'查1月净收入');
  const originalTask=await createTask();const original=await draft(originalTask);await finish();
  await begin(revisionCid,'只看app渠道，再执行');
  const revisedTask=(await tool('update_analysis_task',{action:'revise',goal:'合成净收入查询',task_id:originalTask.task_id,expected_version:originalTask.condition_version,condition_patch:{set:{channel:'app'},unset:[]},options:[]})).data;
  await tool('execute_query',executeArgs(original),'version_conflict');
  const revised=await draft(revisedTask,'SELECT SUM(paid_amount_cents-refunded_amount_cents) AS net_revenue_cents FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>=:start AND paid_at<:end AND channel=:channel',{start:conditions.time_start,end:conditions.time_end,channel:'app'},original.id);
  await tool('execute_query',executeArgs(revised));await finish();await h.resumeWorker();
  await until(async()=>(await read(revised)).execution_state==='succeeded','修改后执行');
  await until(()=>h.captured.find(r=>r.conversation_id===revisionCid&&r.text.startsWith('[已确认查询结果事件]')),'修订结果交付已接收');await h.pauseWorker();
  assert.deepEqual((await h.request('/queries/'+revised.id+'/results')).value.rows,[['1600']]);
  assert.equal((await read(original)).execution_state,'not_submitted');assert.equal((await read(original)).confirmation_state,'superseded');
  checks.push('同条消息修订后执行新SQL，旧稿拒绝；app净收入独立参考1600分');
  await h.resumeWorker();run=await until(()=>h.captured.find(r=>r.conversation_id===revisionCid&&r.text.startsWith('[已确认查询结果事件]')),'修订结果唤醒');await h.pauseWorker();await route(revisedTask);await finish();

  const otherCid=await h.create();await begin(otherCid,'执行另一份SQL');const otherTask=await createTask();
  await tool('execute_query',executeArgs(unconfirmed),'not_available');
  assert.equal((await h.request('/queries/'+revised.id,undefined,'bob')).status,404);
  assert.equal((await h.request('/queries/'+revised.id+'/results',undefined,'bob')).status,404);
  const unrelatedTask=await createTask();const unrelated=await draft(unrelatedTask);await finish();
  await begin(otherCid,'执行原任务SQL');await route(otherTask);await tool('execute_query',executeArgs(unrelated),'not_available');await finish();
  checks.push('查询必须属于当前会话及消息已归属的任务；其他用户不能读查询或结果');

  const deliveryCid=await h.create();await begin(deliveryCid,'执行 SELECT 42 AS sample_value');
  const deliveryTask=await createTask();const fastQuery=await draft(deliveryTask,'SELECT 42 AS sample_value',{});
  await tool('execute_query',executeArgs(fastQuery));await h.resumeWorker();
  await until(async()=>(await read(fastQuery)).execution_state==='succeeded','执行轮尚未结束的快查询');await h.pauseWorker();
  const deferred=(await tool('get_query',{query_id:fastQuery.id})).data;
  assert.equal(deferred.query.execution_state,'succeeded');assert.equal(deferred.results,null);assert.match(deferred.hint,/系统会自动交付/);
  const executingRun=run;h.releaseRun(executingRun.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${executingRun.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${deliveryCid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${executingRun.message_id}';`);
  await h.restartApi();await h.resumeWorker();
  run=await until(()=>h.captured.find(r=>r.message_id===executingRun.message_id&&r.run_id!==executingRun.run_id),'执行消息新运行恢复');await h.pauseWorker();
  assert.equal((await tool('get_query',{query_id:fastQuery.id})).data.results,null);await finish();await h.resumeWorker();
  run=await until(()=>h.captured.find(r=>r.conversation_id===deliveryCid&&r.text.startsWith('[已确认查询结果事件]')),'快查询结果交付');await h.pauseWorker();
  await route(deliveryTask);assert.deepEqual((await tool('get_query',{query_id:fastQuery.id})).data.results.rows,[['42']]);await finish();
  await begin(deliveryCid,'再解释这条查询的结果');await route(deliveryTask);
  assert.deepEqual((await tool('get_query',{query_id:fastQuery.id})).data.results.rows,[['42']]);await finish();
  checks.push('快查询及同一执行消息跨运行恢复只交付真实状态；结果交付轮和后续追问正常读取，避免执行轮重复解释');

  const rejectedCid=await h.create();await begin(rejectedCid,'执行合成检查');const rejectedTask=await createTask();
  const writeSql=await draft(rejectedTask,'DELETE FROM demo_order_detail',{});assert.equal(writeSql.check_state,'rejected');
  await tool('execute_query',executeArgs(writeSql),'version_conflict');
  const cancelled=await draft(rejectedTask);assert.equal((await h.request('/queries/'+cancelled.id+'/cancel',{operation_id:randomUUID()})).status,200);
  await tool('execute_query',executeArgs(cancelled),'version_conflict');await finish();
  await begin(rejectedCid,'执行上面这条');await route(rejectedTask);
  const withdrawn=run;assert.equal((await h.request(`/conversations/${rejectedCid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);
  const late={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'execute_query',arguments:executeArgs(cancelled),checkpoint:checkpoint()};
  assert.equal((await h.internal('/internal/data/tool-calls',late)).value.code,'lease_lost');h.releaseRun(withdrawn.run_id);
  checks.push('写入SQL、已取消查询和撤回后的晚到执行均拒绝');

  const deniedCid=await h.create();await begin(deniedCid,'执行权限检查');const deniedTask=await createTask();const denied=await draft(deniedTask);
  await tool('execute_query',executeArgs(denied));await finish();
  await writeFile(h.directory+'/platform/permissions.json',JSON.stringify({denied_query_users:['alice']}));await h.resumeWorker();
  await until(async()=>(await read(denied)).execution_state==='failed','平台撤权拒绝');await h.pauseWorker();
  assert.equal((await read(denied)).error,'forbidden');
  checks.push('执行授权不授予平台数据权限，提交时平台撤权会失败');
  passed=true;
} finally {
  await mkdir('.local/checks',{recursive:true});
  await writeFile('.local/checks/conversational-query.json',JSON.stringify({passed,checks,officialRequests:0,platform:'executable synthetic SQLite',model:'controlled tool inputs'},null,2));
  await h.close();console.log(JSON.stringify({passed,checks,officialRequests:0}));
}
