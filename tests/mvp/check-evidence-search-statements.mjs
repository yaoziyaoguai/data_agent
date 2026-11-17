import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const query = 'syntheticstatementcoordinates';
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider(), indexed = new Set(), checks = [], errors = [];
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
const manager = SessionManager.inMemory('/synthetic/search-statement-coordinates');
const invoke = async (name, args) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', input));
  const receipt = ok(await h.internal('/internal/data/tools', input));
  if (name === 'search_knowledge') validateContract('KnowledgeSearchReply', receipt.data);
  if (name === 'read_knowledge') validateContract('KnowledgeReadReply', receipt.data);
  return receipt.data;
};
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
    price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 4096,
    trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072};
  h = await harness({capture: true, startWorker: false, profile,
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PROVIDER_TEST: '1',
      DATA_AGENT_PREFILL_PROFILE: '', DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port,
      DATA_AGENT_VECTOR_COLLECTION: collection, DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  let object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: '合成陈述坐标核验', body: '初始化', related_ids: []}));
  const contents = [query + ' 首条短规则完整交付。',
    query + ' 第二条规则🧪。' + '合成后续正文。'.repeat(100), query + ' 末条短规则。'];
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version,
    entry_id: 'body', value: contents.join('\n\n'), statements: contents.map((text, index) => ({key: 'coordinate-' + index,
      target: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: '', citations: [], supports_complete: true, supports: []}))}, 'alice', 'PATCH'));
  const statements = object.entries[0].human_override.statements;
  await h.resumeWorker(); await until(() => indexed.has(object.id), '正式消费者索引多陈述合成条目', 120000);
  run = await h.capture(await h.create(), '核对多陈述搜索与指定陈述补读的坐标。'); await h.pauseWorker();
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
  const reply = await invoke('search_knowledge', {query, kinds: ['term'], limit: 30});
  const first = reply.hits.find(hit => hit.statement_id === statements[0].statement_id);
  assert.ok(first); assert.equal(first.definition, contents[0]); assert.equal(first.content_state, 'complete');
  assert.equal(first.continuation.content_next_offset, null, '首陈述已完整时不能因entry还有其他陈述给伪续读位置');
  checks.push('完整非末陈述真实终止，不用整个条目长度生成陈述游标');
  const partial = reply.hits.find(hit => hit.statement_id === statements[1].statement_id && hit.definition.startsWith(query));
  assert.ok(partial); assert.equal(partial.content_state, 'partial');
  const expected = [...partial.definition].length;
  assert.equal(partial.continuation.content_next_offset, expected, '非首陈述补读offset必须以指定陈述为原点');
  const tail = (await invoke('read_knowledge', {items: [{kind: 'knowledge', ref: partial.ref, statement_id: partial.statement_id,
    offset: partial.continuation.content_next_offset, limit: 65536}]})).items[0];
  assert.equal(tail.state, 'ok');
  assert.equal(tail.content, [...contents[1]].slice(expected).join(''));
  assert.equal(partial.definition + tail.content, contents[1], '搜索后沿返回位置补读能拼回原陈述，不跳字不混入后续陈述');
  checks.push('非首长陈述搜索位置可直接补读，正文逐字衔接且无entry基址偏移');
  assert.deepEqual(errors, []); h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (h) {await writeFile(h.directory + '/evidence-search-statements.json', JSON.stringify({passed, checks, errors, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
}
