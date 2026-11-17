import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

// 真实BM25先交付唯一短命中；只余未派dense时，快速失败不能成功重传相同游标。
const query = 'syntheticprogress' + randomUUID().replaceAll('-', '');
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const indexed = new Set(), searches = [], embeddingRequests = [], checks = [], errors = [];
const observations = {};
let h, run, prepared = false, passed = false, phase = 'index';
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const proxy = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const upstream = await fetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const text = await upstream.text(), result = JSON.parse(text);
    if (request.url.endsWith('/upsert') && result.code === 0)
      for (const row of input.data ?? []) indexed.add(row.object_id);
    if (request.url.endsWith('/search')) searches.push({phase, channel: input.annsField,
      raw: input.filter?.includes('kind == "source_excerpt"') ?? false,
      offset: input.offset ?? 0, status: upstream.status, code: result.code, count: result.data?.length ?? 0});
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"code":1}');}
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const manager = SessionManager.inMemory('/synthetic/evidence-search-progress');
const invoke = async (name, args) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const registration = ok(await h.internal('/internal/data/tool-calls', input));
  const started = performance.now();
  const response = await h.internal('/internal/data/tools', input);
  return {input, registration, response, elapsedMs: Math.round(performance.now() - started)};
};
const ledger = operation => h.sql(`SELECT JSON_OBJECT('operation',operation_id,'state',state)
  FROM model_call_attempts WHERE purpose='knowledge_embedding' AND operation_id='${operation}'`);
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
    price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 4096,
    trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072};
  h = await harness({capture: true, startWorker: false, profile,
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2',
      DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  console.log(JSON.stringify({evidenceDirectory: h.directory, phase: 'setup'}));
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  const object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: '合成续页进度条目', body: query + ' 合成定义：设备登记后才可借出。', related_ids: []}));
  await h.resumeWorker();
  await until(() => indexed.has(object.id) && h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs
    WHERE object_id='${object.id}' AND vector_state<>'indexed'`)[0].n === 0, '合成短条目真实索引完成', 120000);
  run = await h.capture(await h.create(), '核对合成短条目及公共游标失败进度。');
  await h.pauseWorker();
  assert.equal(run.tool_contract_version, 2);
  ok((await invoke('update_analysis_task', {action: 'route', task_id: null,
    expected_version: null, goal: '', options: []})).response);
  observations.backgroundIssuedBefore = h.sql("SELECT JSON_OBJECT('operation',operation_id,'scope',budget_scope_id) FROM model_call_attempts WHERE purpose='knowledge_embedding' AND state='issued'");
  embedding.setMode('lost');
  embedding.onRequest(body => {embeddingRequests.push({phase, matchesQuery: body.input.length === 1 && body.input[0] === query});});
  const args = {query, limit: 1};
  phase = 'first';
  const first = await invoke('search_knowledge', args);
  const receipt = ok(first.response), page = receipt.data;
  validateContract('KnowledgeSearchReply', page);
  assert.equal(receipt.operation_id, first.registration.operation_id);
  assert.equal(page.hits.length, 1);
  assert.equal(page.hits[0].ref.object_id, object.id);
  assert.equal(page.hits[0].definition, object.entries[0].effective_value);
  const cursor = page.search_coverage.next;
  const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${first.input.sdk_tool_call_id}'`)[0];
  assert.equal(stored.operation_id, receipt.operation_id);
  assert.equal(cursor, 'rc1:' + stored.operation_id, '公共回执只给本操作短引用');
  const saved = JSON.parse(stored.data.search_coverage.next).window;
  assert.deepEqual(saved.r, [], '首窗唯一命中已交付，不再保留待交付成员');
  assert.equal(saved.a, false, '成功BM25不能启动SQL替代');
  assert.ok(saved.s.c[0].s.every(([, flags]) => flags === 3), '知识BM25已成功见底');
  assert.ok(saved.s.c[2].s.every(([, flags]) => flags === 3), '原文BM25已成功见底');
  for (const channel of [1, 3]) assert.ok(saved.s.c[channel].s.length > 0
    && saved.s.c[channel].s.every(([consumed, flags]) => consumed === 0 && flags === 0), '剩余bookmark仅有未派dense');
  assert.ok(searches.some(value => value.phase === 'first' && value.channel === 'sparse'
    && !value.raw && value.status === 200 && value.code === 0 && value.count === 1));
  assert.ok(searches.some(value => value.phase === 'first' && value.channel === 'sparse'
    && value.raw && value.status === 200 && value.code === 0 && value.count === 0));
  assert.deepEqual(embeddingRequests, [{phase: 'first', matchesQuery: true}]);
  assert.deepEqual(ledger(receipt.operation_id), [{operation: receipt.operation_id, state: 'unknown'}]);
  observations.first = {hits: page.hits.length, elapsedMs: first.elapsedMs,
    pending: saved.r.length, onlyUndispatchedDense: true, ledger: ledger(receipt.operation_id)};
  checks.push('首轮真实BM25交付唯一短命中，快速失败Embedding按原操作unknown收尾，游标仅余未派dense');

  phase = 'resume';
  const resumed = await invoke('search_knowledge', {...args, cursor});
  observations.resume = {status: resumed.response.status, code: resumed.response.value.code ?? null,
    hits: resumed.response.value.data?.hits.length ?? null,
    sameCursor: resumed.response.value.data?.search_coverage.next === cursor,
    elapsedMs: resumed.elapsedMs, ledger: ledger(resumed.registration.operation_id)};
  console.log(JSON.stringify({phase, ...observations.resume}));
  assert.ok(resumed.elapsedMs < 5000, '反例必须是快速失败，不能靠10秒期限守卫通过');
  assert.deepEqual(embeddingRequests, [{phase: 'first', matchesQuery: true}, {phase: 'resume', matchesQuery: true}],
    '每次正式搜索只发送自身一次Embedding，失败不能换身份重试');
  assert.deepEqual(ledger(resumed.registration.operation_id),
    [{operation: resumed.registration.operation_id, state: 'unknown'}], '错误返回前仍按原Embedding操作收尾');
  observations.issuedAfter = h.sql("SELECT JSON_OBJECT('operation',operation_id,'scope',budget_scope_id) FROM model_call_attempts WHERE purpose='knowledge_embedding' AND state='issued'");
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts
    WHERE purpose='knowledge_embedding' AND budget_scope_id='${run.budget_scope_id}' AND state='issued'`)[0].n, 0,
    '两次搜索所在原请求预算不能遗留issued；停Worker时在途的后台索引另记基线');
  assert.equal(searches.filter(value => value.phase === 'resume').length, 0, '续页没有可执行的BM25或dense页');
  assert.equal(resumed.response.value.code, 'unavailable', '无正文、无派发、原bookmark未推进必须明确失败，不能空成功重复游标');
  assert.notEqual(resumed.response.status, 200);
  assert.equal(Object.hasOwn(resumed.response.value, 'data'), false);
  const rejected = ok(await h.internal('/internal/data/tool-rejections', resumed.input));
  assert.equal(rejected.operation_id, resumed.registration.operation_id);
  assert.equal(rejected.data.error, 'unavailable');
  const sends = embeddingRequests.length;
  assert.deepEqual(ok(await h.internal('/internal/data/tools', resumed.input)), rejected, '同操作重放原拒绝回执');
  assert.equal(embeddingRequests.length, sends, '拒绝重放不得再次发送Embedding');
  checks.push('仅余未派dense且Embedding快速失败时明确unavailable，原账本结算及拒绝回放均保留');
  assert.deepEqual(errors, []);
  h.releaseRun(run.run_id);
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (h) {
    await writeFile(h.directory + '/evidence-search-progress.json', JSON.stringify({passed, checks,
      observations, searches, embeddingRequests, errors, officialRequests: 0}, null, 2));
    await h.close();
  }
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken},
      body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close();
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
}
