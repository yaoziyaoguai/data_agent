import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

// 派生正文和结果在读取点检查当前来源权限。
const h = await harness({capture: true, startWorker: false,
  env: {DATA_AGENT_LEASE_MS: '120000'}});
const checks = [];
let run, manager, passed = false;
const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const binding = () => ({run_id: run.run_id, lease_epoch: run.lease_epoch});
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const begin = async (cid, text) => {
  await h.resumeWorker();
  run = await h.capture(cid, text);
  await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/data-agent');
};
const invoke = async (tool_name, args) => {
  const input = {...binding(), sdk_tool_call_id: randomUUID(), tool_name,
    arguments: args, checkpoint: checkpoint()};
  ok(await h.internal('/internal/data/tool-calls', input));
  return ok(await h.internal('/internal/data/tools', input)).data;
};
const finish = async () => {
  const text = '已保存合成任务。';
  ok(await h.internal('/internal/outputs', {...binding(), chunk_seq: '1', text}));
  ok(await h.internal('/internal/finish', {...binding(), commit_id: run.output_id,
    final_text: text, checkpoint: checkpoint()}));
  h.releaseRun(run.run_id);
};
const issue = () => h.internal('/internal/model/issue', {...binding(),
  call_attempt_id: randomUUID()});
const sourceWindow = document => ({citation: {source: {kind: 'document', id: document.id},
  revision: document.version, locator: {offset: 0, length: [...document.entries[0].effective_value].length}}});

try {
  const document = ok(await h.request('/knowledge', {operation_id: randomUUID(),
    kind: 'document', name: '合成显示规则', body: '语音轮次按会话分组展示。', related_ids: []}));
  const other = ok(await h.request('/knowledge', {operation_id: randomUUID(),
    kind: 'document', name: '范围外显示规则', body: '只按设备分组。', related_ids: []}));
  const otherCid = await h.create();
  await begin(otherCid, '先读取资料，然后限制到会话规则。');
  assert.equal((await invoke('read_source', sourceWindow(other))).text, '只按设备分组。');
  const otherTask = await invoke('update_analysis_task', {action: 'create',
    goal: '按范围外资料仅展示设备分组', options: [], conditions: {
      time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null,
    }});
  await invoke('update_analysis_task', {action: 'revise', task_id: otherTask.task_id,
    expected_version: otherTask.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: {allowed_sources: [{kind: 'document', id: document.id}],
      origin_message_ids: [run.message_id]}}, unset: []}});
  await finish();
  // 合法旧格式没有活动任务字段，但其已有来源仍须按当前任务范围重核。
  h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_REMOVE(
    JSON_SET(checkpoint,'$.authority_snapshot.dependency_schema',5),
    '$.authority_snapshot.historical_analyses','$.authority_snapshot.active_task')
    WHERE recovery_chain_id='${run.recovery_chain_id}'`);
  await begin(otherCid, '继续只用会话规则。');
  assert.equal(run.checkpoint, null, '旧格式缺活动任务字段不能免除范围核验，应按新输入重建');
  const scopedTask = await invoke('read_analysis_task', {task_id: otherTask.task_id});
  assert.equal(scopedTask.goal, '按范围外资料仅展示设备分组', '本人已保存目标可读取');
  assert.ok(!JSON.stringify(run.workspace_context).includes('只按设备分组。'));
  const deniedSource = {...binding(), sdk_tool_call_id: randomUUID(), tool_name: 'read_source',
    arguments: sourceWindow(other), checkpoint: checkpoint()};
  ok(await h.internal('/internal/data/tool-calls', deniedSource));
  assert.equal((await h.internal('/internal/data/tools', deniedSource)).value.code, 'source_not_allowed');
  ok(await h.internal('/internal/data/tool-rejections', deniedSource));
  assert.equal((await invoke('read_source', sourceWindow(document))).text, '语音轮次按会话分组展示。');
  assert.equal((await issue()).status, 200, '只交付允许的实际资料后可继续调查');
  await invoke('update_analysis_task', {action: 'route', task_id: otherTask.task_id,
    expected_version: scopedTask.condition_version, goal: '', options: []});
  await finish();
  checks.push('旧检查点中的来源B正文在只允许A时不进入启动和原文补读，本人仍可查看已保存目标');
  const legacyCid = await h.create();
  await begin(legacyCid, '创建可自由调查的语音任务。');
  assert.equal((await invoke('read_source', sourceWindow(other))).text, '只按设备分组。');
  const legacyTask = await invoke('update_analysis_task', {action: 'create',
    goal: '旧会话语音调查', options: [], conditions: {
      time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null,
    }});
  await finish();
  h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_REMOVE(
    JSON_SET(checkpoint,'$.authority_snapshot.dependency_schema',5),
    '$.authority_snapshot.historical_analyses','$.authority_snapshot.active_task')
    WHERE recovery_chain_id='${run.recovery_chain_id}'`);
  await begin(legacyCid, '继续调查。');
  assert.equal(run.checkpoint, null, '当前无限制不代表旧范围已核实；缺活动基线的旧正文需重新投影');
  await invoke('update_analysis_task', {action: 'route', task_id: legacyTask.task_id,
    expected_version: legacyTask.condition_version, goal: '', options: []});
  await finish();
  checks.push('旧快照缺活动范围证明时先重投影；当前明确无限制仍可继续');

  // 迁移旧会话没有活动任务绑定；未知任务正文只能在明确归属后读取。
  h.sql(`UPDATE conversations SET active_task_id=NULL,active_task_condition_version=NULL WHERE id='${legacyCid}';
    UPDATE condition_revisions SET body=JSON_REMOVE(body,'$.source_limits') WHERE task_id='${legacyTask.task_id}'`);
  await begin(legacyCid, '继续之前的任务。');
  assert.ok(!JSON.stringify(run.workspace_context.tasks).includes('旧会话语音调查'),
    '尚未确定任务范围时启动只交付控制目录，不能先注入旧正文');
  const readInput = {...binding(), sdk_tool_call_id: randomUUID(), tool_name: 'read_source',
    arguments: sourceWindow(other), checkpoint: checkpoint()};
  ok(await h.internal('/internal/data/tool-calls', readInput));
  assert.equal((await h.internal('/internal/data/tools', readInput)).value.code, 'task_context_required');
  ok(await h.internal('/internal/data/tool-rejections', readInput));
  await invoke('update_analysis_task', {action: 'route', task_id: legacyTask.task_id,
    expected_version: legacyTask.condition_version, goal: '', options: []});
  await finish();
  checks.push('未归属旧会话不默认无限制；目录保留任务身份，取证先明确归属和范围');

  const memory = ok(await h.request('/assets', {operation_id: randomUUID(), id: null,
    expected_version: null, kind: 'memory', name: '合成显示偏好', body: '优先展示会话分组',
    scope: '合成语音分析', verified: false, source_text: '本人录入',
    dependencies: [{object_id: document.id, version: document.version, path: 'body'}]}));
  const cid = await h.create();
  await begin(cid, '按显示规则建立任务，下一轮只用这份规则。');
  const memoryRead = await invoke('read_knowledge', {items: [{kind: 'memory',
    asset_ref: {id: memory.id, version: memory.version}, part: 'body'}]});
  assert.equal(memoryRead.items[0].asset.body, '优先展示会话分组');
  const task = await invoke('update_analysis_task', {action: 'create',
    goal: '按偏好展示会话分组', options: [], conditions: {
      time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null,
    }});
  await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id,
    expected_version: task.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: {allowed_sources: [{kind: 'document', id: document.id}],
      origin_message_ids: [run.message_id]}}, unset: []}});
  await finish();

  await begin(cid, '继续只用这份规则。');
  assert.ok(run.workspace_context.memories.some(v => v.id === memory.id),
    '受限启动投影保留同源记忆（R08）');
  const text = await invoke('read_analysis_task', {task_id: task.task_id});
  assert.equal(text.goal, '按偏好展示会话分组');
  const delivered = await invoke('read_knowledge', {items: [{kind: 'memory',
    asset_ref: {id: memory.id, version: memory.version}, part: 'body'}]});
  assert.equal(delivered.items[0].asset.body, '优先展示会话分组');
  const allowed = await issue();
  assert.equal(allowed.status, 200,
    '来源仍可用的派生正文允许派发:' + JSON.stringify(allowed.value));
  ok(await h.request(`/assets/${memory.id}/disable`, {operation_id: randomUUID(),
    expected_version: memory.version}));
  const disabled = await invoke('read_knowledge', {items: [{kind: 'memory',
    asset_ref: {id: memory.id, version: memory.version}, part: 'body'}]});
  assert.equal(disabled.items[0].state, 'not_available');
  assert.ok(!JSON.stringify(disabled).includes('优先展示会话分组'));
  assert.equal((await issue()).status, 200);
  checks.push('受限任务可精读同源记忆，撤回后读取点拒绝交付，保留运行调用额度');
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  await writeFile('.local/checks/derived-source-dispatch.json',
    JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
  if (run) h.releaseRun(run.run_id);
  await h.close();
}
