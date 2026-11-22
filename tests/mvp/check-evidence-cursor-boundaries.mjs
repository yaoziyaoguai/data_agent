import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const query = 'syntheticcursorboundaries';
const collections = Array.from({length: 2}, () => 'data_agent_test_' + randomUUID().replaceAll('-', ''));
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const prepared = new Set(), indexed = new Set(), documentRevisions = new Set(), checks = [], errors = [], searches = [], observations = [];
let h, run, manager, passed = false, documents = [];
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const milvus = async (collection, path) => {
  const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/' + path, {method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken},
    body: JSON.stringify({dbName: 'default', collectionName: collection})});
  const result = await response.json(); assert.equal(result.code, 0); return result.data;
};
const proxy = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const upstream = await fetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const text = await upstream.text(), result = JSON.parse(text);
    if (request.url.endsWith('/upsert') && result.code === 0)
      for (const row of input.data ?? []) {
        indexed.add(row.object_id);
        if (row.target === 'knowledge_entry' && row.kind === 'document') documentRevisions.add(row.object_id + ':' + row.object_version);
      }
    if (request.url.endsWith('/search')) searches.push({collection: input.collectionName, field: input.annsField, code: result.code});
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"code":1}');}
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const begin = async text => {
  if (run) h.releaseRun(run.run_id);
  await h.resumeWorker(); run = await h.capture(await h.create(), text); await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/evidence-cursor-boundaries');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
};
const invoke = async (name, args, expectedError) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: name,
    arguments: args, checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const registration = ok(await h.internal('/internal/data/tool-calls', input));
  const result = await h.internal('/internal/data/tools', input);
  if (expectedError) {
    assert.notEqual(result.status, 200); assert.equal(result.value.code, expectedError, JSON.stringify(result));
    assert.equal(Object.hasOwn(result.value, 'data'), false, '失效游标不能夹带旧正文');
    const rejection = ok(await h.internal('/internal/data/tool-rejections', input));
    assert.equal(rejection.operation_id, registration.operation_id); assert.equal(rejection.data.error, expectedError);
    assert.equal(Object.hasOwn(rejection.data, 'hits'), false);
    assert.deepEqual(ok(await h.internal('/internal/data/tools', input)), rejection, '失效游标重放接原明确拒绝');
    return;
  }
  const receipt = ok(result); assert.equal(receipt.operation_id, registration.operation_id);
  if (name === 'search_knowledge') validateContract('KnowledgeSearchReply', receipt.data);
  return receipt.data;
};
const sourceState = (phase, id, revision) => {
  const jobs = h.sql(`SELECT JSON_OBJECT('target_kind',target_kind,'source_kind',source_kind,'object_id',object_id,'revision',CAST(version AS CHAR),'state',state,'vector_state',vector_state,'target',vector_target,'attempts',vector_attempts,'lease_epoch',CAST(lease_epoch AS CHAR),'lease_until',lease_until,'error',vector_error,'receipt',vector_receipt) FROM knowledge_index_jobs WHERE object_id='${id}' ORDER BY target_kind,version`);
  const head = h.sql(`SELECT JSON_OBJECT('revision',CAST(version AS CHAR),'state',state) FROM knowledge_objects WHERE id='${id}'`)[0];
  return {phase, id, revision, head, observedUpsert: documentRevisions.has(id + ':' + revision), jobs};
};
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd',
    input_limit: 65536, output_limit: 4096, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24,
    toolset: 'data', payload_bytes_limit: 131072};
  h = await harness({capture: true, startWorker: false, profile, env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000',
    DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
    DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collections[0],
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  console.log(JSON.stringify({evidenceDirectory: h.directory}));
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared.add(collections[0]);
  const terms = [];
  for (const label of ['甲', '乙', '丙']) documents.push(ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成游标来源' + label, body: query + ' 合成来源' + label + '：设备登记后才可借出。', related_ids: []})));
  for (const label of ['甲', '乙', '丙']) terms.push(ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: '合成游标目标' + label, body: query + ' 合成有效规则' + label + '。', related_ids: []})));
  await h.resumeWorker(); await until(() => [...documents, ...terms].every(value => indexed.has(value.id))
    && h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE object_id IN (${[...documents, ...terms].map(value => `'${value.id}'`).join(',')}) AND vector_state<>'indexed'`)[0].n === 0,
    '正式消费者完成游标边界材料索引及就绪回执', 120000);
  await begin('核对文档公共游标与当前来源修订。');
  const args = {query, kinds: ['document'], limit: 1};
  const first = await invoke('search_knowledge', args);
  console.log(JSON.stringify({phase: 'document-first', page: first}));
  assert.equal(first.hits.length, 1); assert.equal(first.hits[0].record_kind, 'knowledge_entry');
  assert.equal(typeof first.search_coverage.next, 'string');
  const rest = documents.filter(value => value.id !== first.hits[0].ref.object_id); assert.equal(rest.length, 2);
  const scanCount = searches.length;
  const second = await invoke('search_knowledge', {...args, cursor: first.search_coverage.next});
  assert.equal(second.hits.length, 1); assert.equal(second.hits[0].record_kind, 'knowledge_entry');
  assert.ok(rest.some(value => value.id === second.hits[0].ref.object_id), '续页交付另一份未交来源');
  assert.equal(searches.length, scanCount, '文档未交窗口只重核owner，不重扫公共通道');
  // 本run从未交付第三份来源；换版只影响窗口内未交付候选，不先触发run观察失效。
  const pending = rest.find(value => value.id !== second.hits[0].ref.object_id); assert.ok(pending);
  const changed = ok(await h.request('/knowledge/' + pending.id, {operation_id: randomUUID(), expected_version: pending.version,
    entry_id: 'body', value: query + ' 合成来源新版：必须重新核对修订。'}, 'alice', 'PATCH'));
  assert.notEqual(changed.version, pending.version);
  observations.push(sourceState('edited-before-consumer', pending.id, changed.version));
  // 先让正式消费者完整结算新版目标，再捕获并停住新run；不在索引在途时用停Worker划分边界。
  await h.resumeWorker();
  let ready;
  try {
    await until(() => {
      ready = sourceState('edited-ready', pending.id, changed.version);
      const target = ready.jobs.find(job => job.target_kind === 'knowledge_entry' && job.revision === changed.version);
      return ready.observedUpsert && target?.state === 'indexed' && target.vector_state === 'indexed'
        && ready.jobs.filter(job => job.revision === changed.version).every(job => job.vector_state === 'indexed');
    }, '正式消费者完成修订知识窗口索引及就绪回执', 120000);
  } finally {
    observations.push(ready ?? sourceState('edited-no-poll', pending.id, changed.version));
    console.log(JSON.stringify(observations.at(-1)));
  }
  await h.pauseWorker();
  // 原成功回执已登记旧来源；正式消费者换版结算后，旧公共游标沿窄读取恢复并明确stale。
  await invoke('search_knowledge', {...args, cursor: first.search_coverage.next}, 'stale_cursor');
  checks.push('文档续页不重扫，正式来源换版后旧公共游标明确stale且拒绝重放不重做');

  await begin('核对公共游标不能跨越当前任务来源范围变化。');
  await invoke('search_knowledge', {...args, cursor: first.search_coverage.next}, 'invalid_cursor');
  checks.push('短引用不是跨会话读取凭据，他会原回执不能被定位');
  const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null, group_by: [],
    filters: [], knowledge_refs: [], notes: '', source_limits: {allowed_sources: documents.map(value => ({kind: 'document', id: value.id})), origin_message_ids: [run.message_id]}};
  const task = await invoke('update_analysis_task', {action: 'create', goal: '合成来源范围游标', conditions, options: []});
  const scoped = await invoke('search_knowledge', args); assert.equal(typeof scoped.search_coverage.next, 'string');
  const retainedId = scoped.hits[0].ref.object_id;
  const revised = await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id, expected_version: task.condition_version,
    goal: '', options: [], condition_patch: {set: {source_limits: {allowed_sources: [{kind: 'document', id: retainedId}], origin_message_ids: [run.message_id]}}, unset: []}});
  assert.notEqual(revised.condition_version, task.condition_version);
  await invoke('search_knowledge', {...args, cursor: scoped.search_coverage.next}, 'stale_cursor');
  checks.push('正式收紧活动任务的来源范围后旧游标明确stale，不凭游标继续交范围外文档');

  await begin('核对公共索引真实目标切换后的游标绑定。');
  const termArgs = {query, kinds: ['term'], limit: 1};
  const page = await invoke('search_knowledge', termArgs); assert.equal(typeof page.search_coverage.next, 'string');
  const originalIdentity = (await milvus(collections[0], 'describe')).collectionID;
  h.env.DATA_AGENT_VECTOR_COLLECTION = collections[1]; await h.restartApi();
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared.add(collections[1]);
  const currentIdentity = (await milvus(collections[1], 'describe')).collectionID;
  assert.notEqual(String(currentIdentity), String(originalIdentity), '新目标必须是不同真实Milvus集合');
  await invoke('search_knowledge', {...termArgs, cursor: page.search_coverage.next}, 'stale_cursor');
  assert.equal(String((await milvus(collections[0], 'describe')).collectionID), String(originalIdentity), '切换保留原集合身份');
  checks.push('正式准备并切换不同Milvus目标后旧游标明确stale，原集合不被修改');
  assert.deepEqual(errors, []); h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (h) {
    observations.push(...documents.map(value => sourceState('final', value.id, value.version)));
    await writeFile(h.directory + '/evidence-cursor-boundaries.json', JSON.stringify({passed, checks, errors, searches, observations, officialRequests: 0}, null, 2));
    await h.close();
  }
  for (const collection of prepared) await milvus(collection, 'drop');
  await embedding.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
}
