import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

// 旧条件缺字段代表未知：先查原条件，不得静默解除用户的来源限制。
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

try {
  const doc = name => h.request('/knowledge', {operation_id: randomUUID(),
    kind: 'document', name, body: `${name}的合成语音说明。`, related_ids: []}).then(ok);
  const allowed = await doc('允许的文档');
  const outside = await doc('范围外文档');
  const cid = await h.create();
  await begin(cid, '只使用允许的文档。');
  let task = await invoke('update_analysis_task', {action: 'create', goal: '限定来源回答',
    options: [], conditions: {time_start: null, time_end: null, timezone: 'UTC',
      metric: null, channel: null, group_by: [], filters: [], knowledge_refs: [], notes: '',
      source_limits: {allowed_sources: [{kind: 'document', id: allowed.id}],
        origin_message_ids: [run.message_id]}}});
  task = await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id,
    expected_version: task.condition_version, goal: '', options: [],
    condition_patch: {set: {notes: '补充展示要求'}, unset: []}});
  // 模拟旧版本持久记录漏带扩展字段；原条件修订仍可核实声明。
  h.sql(`UPDATE condition_revisions SET body=JSON_REMOVE(body,'$.source_limits')
    WHERE task_id='${task.task_id}' AND version=${task.condition_version}`);
  const read = async id => {
    const args = {object_id: id};
    const input = {...binding(), sdk_tool_call_id: randomUUID(), tool_name: 'read_knowledge',
      arguments: args, checkpoint: checkpoint()};
    ok(await h.internal('/internal/data/tool-calls', input));
    const reply = await h.internal('/internal/data/tools', input);
    if (reply.status !== 200) ok(await h.internal('/internal/data/tool-rejections', input));
    return reply;
  };
  assert.equal((await read(outside.id)).value.code, 'source_not_allowed',
    '旧条件字段缺失时必须沿原修订继承限制，不能默认为无限制');
  assert.equal((await read(allowed.id)).status, 200);
  checks.push('旧记录缺字段时从同任务原修订恢复限制');

  h.sql(`UPDATE condition_revisions SET body=JSON_REMOVE(body,'$.source_limits')
    WHERE task_id='${task.task_id}'`);
  assert.equal((await read(outside.id)).value.code, 'task_context_required',
    '所有原条件均未知时应先核实任务范围，不能猜无限制');
  // 仍可读取任务及真实用户消息，供Pi理解原限制并修订，随后继续同一输入。
  assert.equal((await invoke('read_analysis_task', {task_id: task.task_id})).id, task.task_id);
  const original = await invoke('read_conversation', {message_id: run.message_id, after_seq: '0'});
  assert.equal(original.text, '只使用允许的文档。');
  task = await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id,
    expected_version: task.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: {allowed_sources: [{kind: 'document', id: allowed.id}],
      origin_message_ids: ['forged-message-id']}}, unset: []}});
  const restored = await invoke('read_analysis_task', {task_id: task.task_id});
  assert.deepEqual(restored.conditions.source_limits.origin_message_ids, [run.message_id],
    '限制采纳记录由宿主绑定真实消息，不接受模型自报来源身份');
  assert.equal((await read(outside.id)).value.code, 'source_not_allowed');
  assert.equal((await read(allowed.id)).status, 200);
  await finish();
  await begin(cid, '继续按照原范围。');
  assert.equal((await read(outside.id)).value.code, 'source_not_allowed');
  await invoke('update_analysis_task', {action: 'route', task_id: null,
    expected_version: null, goal: '', options: []});
  await finish();
  checks.push('未知限制可读原用户输入重新确认，宿主绑定来源身份且跨轮保持');
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  await writeFile('.local/checks/legacy-source-limits.json',
    JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
  if (run) h.releaseRun(run.run_id);
  await h.close();
}
