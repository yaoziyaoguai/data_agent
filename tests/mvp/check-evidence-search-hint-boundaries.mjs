import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const scenario = process.argv[2] ?? 'raw';
assert.ok(['raw', 'exact'].includes(scenario));
const query = 'synthetichintboundary' + randomUUID().replaceAll('-', '');
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const indexed = new Set(), errors = [], checks = [], observations = {}, objects = [];
let h, run, prepared = false, passed = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const proxy = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const upstream = await fetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const text = await upstream.text();
    if (request.url.endsWith('/upsert') && JSON.parse(text).code === 0)
      for (const row of input.data ?? []) indexed.add(row.object_id);
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"code":1}');}
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const manager = SessionManager.inMemory('/synthetic/search-hint-boundaries');
const invoke = async (name, args) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const operation = ok(await h.internal('/internal/data/tool-calls', input));
  const receipt = ok(await h.internal('/internal/data/tools', input));
  assert.equal(receipt.operation_id, operation.operation_id);
  const stored = h.sql(`SELECT receipt FROM tool_calls WHERE operation_id='${receipt.operation_id}'`)[0];
  const publicNext = receipt.data?.search_coverage?.next;
  if (typeof publicNext === 'string')
    assert.equal(publicNext, 'rc1:' + stored.operation_id, '公开游标是本操作短引用，完整窗口只在存储回执');
  assert.deepEqual(publicNext == null ? stored
    : {...stored, data: {...stored.data, search_coverage: {...stored.data.search_coverage, next: publicNext}}}, receipt,
    '检查的是正式冻结最终回执');
  if (name === 'search_knowledge') validateContract('KnowledgeSearchReply', receipt.data);
  return receipt.data;
};
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
    price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 4096,
    trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072};
  h = await harness({capture: true, startWorker: false, profile,
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2',
      DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  console.log(JSON.stringify({evidenceDirectory: h.directory, scenario}));
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  for (const [index, label] of ['甲', '乙'].entries()) objects.push(ok(await h.request('/knowledge', {
    operation_id: randomUUID(), kind: scenario === 'raw' ? 'document' : 'term',
    name: scenario === 'exact' && index === 0 ? query : '合成提示边界条目' + label,
    body: query + ' 合成规则' + label + '：设备登记后才可借出。', related_ids: []})));
  await h.resumeWorker();
  await until(() => objects.every(value => indexed.has(value.id))
    && h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs
      WHERE object_id IN (${objects.map(value => `'${value.id}'`).join(',')}) AND vector_state<>'indexed'`)[0].n === 0,
    '两个合成条目正式知识及原文索引完成', 120000);
  run = await h.capture(await h.create(), '核对合成公共排序提示边界。'); await h.pauseWorker();
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
  const args = {query, kinds: [scenario === 'raw' ? 'document' : 'term'], limit: 1};
  const baseline = await invoke('search_knowledge', args);
  assert.equal(baseline.hits.length, 1);
  if (scenario === 'raw') {
    assert.equal(baseline.hits[0].record_kind, 'source_excerpt');
    const target = objects.find(value => value.id !== baseline.hits[0].citation.source.id);
    const hinted = await invoke('search_knowledge', {...args, hints: {related_object_ids: [target.id]}});
    observations.baseline = baseline.hits.map(hit => hit.citation.source.id);
    observations.hinted = hinted.hits.map(hit => hit.citation.source.id);
    observations.target = target.id;
    console.log(JSON.stringify({scenario, ...observations}));
    assert.equal(hinted.hits[0].citation.source.id, target.id, 'raw-only文档也必须在limit主读取前应用相关对象软提示');
    const seen = new Set(hinted.hits.map(hit => hit.citation.source.id));
    let cursor = hinted.search_coverage.next;
    for (let page = 0; cursor && page < 4; page++) {
      const next = await invoke('search_knowledge', {...args, hints: {related_object_ids: [target.id]}, cursor});
      for (const hit of next.hits) {
        assert.equal(hit.record_kind, 'source_excerpt');
        assert.equal(seen.has(hit.citation.source.id), false); seen.add(hit.citation.source.id);
      }
      assert.notEqual(next.search_coverage.next, cursor); cursor = next.search_coverage.next;
    }
    assert.equal(cursor, null); assert.deepEqual([...seen].sort(), objects.map(value => value.id).sort());
    checks.push('raw-only相关提示在首次及恢复窗口生效，未匹配文档仍完整交付且无硬过滤');
  } else {
    assert.equal(baseline.hits[0].record_kind, 'knowledge_entry');
    assert.equal(baseline.hits[0].ref.object_id, objects[0].id, '精确名称基线应优先');
    const hinted = await invoke('search_knowledge', {...args, hints: {related_object_ids: [objects[1].id]}});
    observations.exact = objects[0].id; observations.hinted = hinted.hits.map(hit => hit.ref.object_id);
    console.log(JSON.stringify({scenario, ...observations}));
    assert.equal(hinted.hits[0].ref.object_id, objects[0].id, '软提示不能把非精确候选抬过原精确名称/ID优先级');
    const idMatch = await invoke('search_knowledge', {...args, query: objects[0].id,
      hints: {related_object_ids: [objects[1].id]}});
    assert.equal(idMatch.hits[0].ref.object_id, objects[0].id, '精确ID同样优先于软提示');
    checks.push('精确名称和ID保持原优先级，提示只提升同优先级的候选');
  }
  assert.deepEqual(errors, []); h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, scenario, checks, officialRequests: 0}));
} finally {
  if (h) {await writeFile(h.directory + '/evidence-search-hint-boundaries.json',
    JSON.stringify({passed, scenario, checks, observations, errors, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken},
      body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
}
