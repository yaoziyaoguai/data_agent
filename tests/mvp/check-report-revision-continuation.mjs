import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { exportCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { deliver } from '../../apps/agent/session/deliver.ts';
import { modelProtocolFixture } from '../runtime/model-protocol-fixture.mjs';
import { harness } from './harness.mjs';

const profile = {
  provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
  price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 2048,
  trial_call_limit: 100, trial_cost_micros: '300000', request_call_limit: 24,
  toolset: 'data', payload_bytes_limit: 131072,
};
const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const lastText = body => {
  const content = body.messages.at(-1).content;
  return Array.isArray(content) ? content.map(part => part.text).join('') : content;
};
let nextReply;
const provider = await modelProtocolFixture({ completionsReply: body => nextReply(body) });
const providerEnv = {DEEPSEEK_API_KEY: 'synthetic-protocol-key', DEEPSEEK_BASE_URL: provider.url, DATA_AGENT_PROVIDER_TEST: '1'};
const previous = Object.fromEntries(Object.keys(providerEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, providerEnv);
let h;
try {
  h = await harness({capture: true, profile, protocolProviderUrl: provider.url,
    env: {DATA_AGENT_LEASE_MS: '120000'}});
  const document = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '语音轮次合成定义', body: '每个语音轮次单独计数。', related_ids: []}));
  const ref = {object_id: document.id, version: document.version, path: 'body'};
  const cid = await h.create();
  const initial = await h.capture(cid, '保存按语音轮次计数的报告。');
  await h.pauseWorker();
  const binding = {run_id: initial.run_id, lease_epoch: initial.lease_epoch};
  const checkpoint = exportCheckpoint(SessionManager.inMemory('/synthetic/data-agent'));
  const evidenceArgs = condition_version => ({task_id: task.task_id, condition_version,
    data_range: '合成资料定义，不含平台查询结果。', findings: [{text: '每个语音轮次单独计数。',
      calculation: '采用正式定义。', limitations: [], query_refs: [], knowledge_refs: [ref], figures: []}]});
  const invoke = async (tool_name, args) => {
    const input = {...binding, checkpoint, sdk_tool_call_id: randomUUID(), tool_name, arguments: args};
    ok(await h.internal('/internal/data/tool-calls', input));
    return ok(await h.internal('/internal/data/tools', input)).data;
  };
  const task = await invoke('update_analysis_task', {action: 'create', goal: '语音轮次报告',
    conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [ref], notes: '', source_limits: null}, options: []});
  const original = await invoke('save_analysis_evidence', evidenceArgs(task.condition_version));
  const reportPath = `/conversations/${cid}/tasks/${task.task_id}/report`;
  const reportArgs = (condition_version, expected_version, evidence_id) => ({task_id: task.task_id,
    condition_version, expected_version, title: '语音轮次报告', evidence_ids: [evidence_id], charts: []});
  const oldReport = ok(await h.request(reportPath, {operation_id: randomUUID(),
    ...reportArgs(task.condition_version, null, original.evidence_id)}));
  ok(await h.internal('/internal/outputs', {...binding, chunk_seq: '1', text: '已经保存报告。'}));
  ok(await h.internal('/internal/finish', {...binding, commit_id: initial.output_id,
    final_text: '已经保存报告。', checkpoint}));
  h.releaseRun(initial.run_id);

  const steps = [
    () => ({name: 'read_analysis_report', args: {task_id: task.task_id}}),
    () => ({name: 'update_analysis_task', args: {action: 'revise', task_id: task.task_id,
      expected_version: task.condition_version, goal: '', options: [],
      condition_patch: {set: {notes: '按新说明修订报告。'}, unset: []}}}),
    () => ({text: '已修改分析条件。'}),
    body => {
      assert.match(lastText(body), /当前条件已到 2[\s\S]*save_analysis_report[\s\S]*expected_version[\s\S]*1/);
      return {name: 'save_analysis_evidence', args: evidenceArgs('2')};
    },
    body => ({name: 'save_analysis_report', args: reportArgs('2', oldReport.version,
      JSON.parse(lastText(body)).evidence_id)}),
    () => ({text: '已保存条件版本 2 的语音轮次报告。'}),
  ];
  let requests = 0;
  nextReply = body => steps[requests++](body);
  await h.resumeWorker();
  const revised = await h.capture(cid, '修订条件并按新条件更新刚才那份报告。');
  await h.pauseWorker();
  await deliver(revised, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
  h.releaseRun(revised.run_id);
  assert.deepEqual(provider.errors, []);
  const current = ok(await h.request(reportPath));
  assert.equal(current.reference.condition_version, '2');
  assert.equal(current.reference.version, '2');
  assert.equal(requests, 6);
  const summary = await h.snapshot(cid);
  assert.equal(summary.messages.findLast(message => message.role === 'assistant' && message.committed).text,
    '已保存条件版本 2 的语音轮次报告。');
  const sqlOnlySteps = [
    () => ({name: 'read_analysis_report', args: {task_id: task.task_id}}),
    () => ({name: 'update_analysis_task', args: {action: 'revise', task_id: task.task_id,
      expected_version: '2', goal: '', options: [], condition_patch: {set: {notes: '只看新的 SQL。'}, unset: []}}}),
    () => ({name: 'request_query', args: {task_id: task.task_id, condition_version: '3',
      target_id: 'synthetic-sqlite', sql: 'SELECT 1 AS voice_turns', parameters: {},
      summary: '合成 SQL 示例', knowledge_refs: [], replaces_query_id: null}}),
    () => ({text: '只保存了待确认 SQL。'}),
  ];
  let sqlOnlyRequests = 0;
  nextReply = body => sqlOnlySteps[sqlOnlyRequests++](body);
  await h.resumeWorker();
  const sqlOnly = await h.capture(cid, '参考刚才保存的报告，只改条件并给我 SQL，先保留现有报告。');
  await h.pauseWorker();
  await deliver(sqlOnly, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
  h.releaseRun(sqlOnly.run_id);
  assert.deepEqual(provider.errors, []);
  assert.equal(sqlOnlyRequests, 4);
  assert.deepEqual(ok(await h.request(reportPath)).reference, current.reference);
  console.log(JSON.stringify({passed: true, requests, sqlOnlyRequests, reportCondition: current.reference.condition_version,
    reportVersion: current.reference.version, officialRequests: 0}));
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (h) await h.close();
  await provider.close();
}
