import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const checks = [];
let h, run, prepared = false, passed = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const manager = SessionManager.inMemory('/synthetic/evidence-search');
const invoke = async (name, args, expectedError) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const operation = ok(await h.internal('/internal/data/tool-calls', input));
  const response = await h.internal('/internal/data/tools', input);
  if (expectedError) {
    assert.equal(response.value.code, expectedError, JSON.stringify(response));
    assert.notEqual(response.status, 200);
    assert.equal(Object.hasOwn(response.value, 'data'), false, '拒绝不能夹带搜索正文');
    const rejected = ok(await h.internal('/internal/data/tool-rejections', input));
    assert.equal(rejected.operation_id, operation.operation_id);
    assert.equal(rejected.data.error, expectedError);
    return rejected.data;
  }
  const receipt = ok(response);
  validateContract('DataToolOutcome', receipt);
  assert.equal(receipt.operation_id, operation.operation_id);
  if (name === 'search_knowledge') validateContract('KnowledgeSearchReply', receipt.data);
  return receipt.data;
};
try {
  h = await harness({capture: true, startWorker: false,
    env: { DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2',
      DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  await h.resumeWorker(); run = await h.capture(await h.create(), '按当前合成任务核对资料，不隐式切换任务。');
  await h.pauseWorker(); assert.equal(run.tool_contract_version, 2);

  // 目录入口同样核对任务；它不依赖索引命中，能独立暴露任务绑定被忽略。
  await invoke('search_knowledge', {query: '*', task_ref: {task_id: 'synthetic-inactive', condition_version: '1'}}, 'task_context_required');
  const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
    group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null};
  const task = await invoke('update_analysis_task', {action: 'create', goal: '合成搜索任务', conditions, options: []});
  const taskRef = {task_id: task.task_id, condition_version: task.condition_version};
  const explicit = await invoke('search_knowledge', {query: '*', task_ref: taskRef});
  assert.deepEqual(explicit.hits, []);
  assert.equal(explicit.search_coverage.channels.find(channel => channel.channel === 'exact')?.state,
    'not_configured', '资产目录不冒称已执行公共候选精确匹配');
  await invoke('search_knowledge', {query: '*', task_ref: {...taskRef, task_id: 'synthetic-other-task'}}, 'task_context_required');
  await invoke('search_knowledge', {query: '*', task_ref: {...taskRef, condition_version: '999'}}, 'version_conflict');
  const revised = await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id,
    expected_version: task.condition_version, goal: '', condition_patch: {set: {notes: '合成条件已正式更新'}, unset: []}, options: []});
  assert.notEqual(revised.condition_version, task.condition_version);
  await invoke('search_knowledge', {query: '*', task_ref: taskRef}, 'version_conflict');
  const inherited = await invoke('search_knowledge', {query: '*'});
  assert.deepEqual(inherited.hits, []);
  const current = await invoke('read_analysis_task', {task_id: task.task_id});
  assert.equal(current.condition_version, revised.condition_version);
  assert.equal(current.conditions.notes, '合成条件已正式更新');
  checks.push('搜索显式任务必须匹配当前活动任务和条件，省略继承当前绑定且不隐式切任务');

  h.env.DATA_AGENT_TEST_RETRIEVAL_DELAY_MS = '2000';
  await h.restartApi();
  const logStart = h.logs.length;
  const delayed = invoke('search_knowledge', {query: '*', task_ref: {
    task_id: task.task_id, condition_version: revised.condition_version}}, 'version_conflict');
  delayed.catch(() => {});
  await until(() => h.logs.slice(logStart - 1).some(log =>
    log.output.includes('test_retrieval_stage_ready run=' + run.run_id)), '搜索完成锁外阶段');
  const changed = await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id,
    expected_version: revised.condition_version, goal: '', condition_patch: {set: {notes: '合成检索期间条件更新'}, unset: []}, options: []});
  assert.notEqual(changed.condition_version, revised.condition_version);
  await delayed;
  delete h.env.DATA_AGENT_TEST_RETRIEVAL_DELAY_MS;
  await h.restartApi();
  checks.push('锁外检索完成后条件真实更新，提交前再次拒绝原task_ref且不交付旧结果');
  assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts")[0].n, 0);
  h.releaseRun(run.run_id);
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (h) {await writeFile(h.directory + '/evidence-search.json', JSON.stringify({passed, checks, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken},
      body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
}
