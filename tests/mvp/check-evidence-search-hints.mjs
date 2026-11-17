import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const query = 'syntheticsofthints';
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const indexed = new Set(), errors = [], checks = [], objects = [];
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
const manager = SessionManager.inMemory('/synthetic/soft-search-hints');
const invoke = async (name, args) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', input));
  const receipt = ok(await h.internal('/internal/data/tools', input));
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
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  for (const label of ['甲', '乙', '丙']) {
    const object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
      name: '合成软排序条目' + label, body: query + ' 合成规则：设备登记后才可借出。', related_ids: []}));
    const domain = '合成独立业务域' + label;
    // 沿既有检索范围夹具：正式接口不提供追加business_domain条目，索引前保存明确人工层。
    object.entries.push({entry_id: 'business_domain', path: 'business_domain', label: '业务域', effective_value: domain,
      source_facts: {complete: false, gap: '合成维护者明确指定'}, suggestion: {},
      human_override: {value: domain, edited_by: 'alice'}, review_state: 'confirmed'});
    const encoded = Buffer.from(JSON.stringify(object)).toString('hex');
    h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${object.id}';UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}' AND version=${object.version};UPDATE retrieval_documents SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}' AND version=${object.version}`);
    objects.push({object, domain});
  }
  await h.resumeWorker(); await until(() => objects.every(({object}) => indexed.has(object.id)), '正式消费者索引软排序合成条目', 120000);
  run = await h.capture(await h.create(), '核对合成排序提示不收窄范围。'); await h.pauseWorker();
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
  const args = {query, kinds: ['term'], limit: 1};
  const baseline = await invoke('search_knowledge', args);
  assert.equal(baseline.hits.length, 1);
  const target = objects.find(({object}) => object.id !== baseline.hits[0].ref.object_id);
  assert.ok(target);
  const related = await invoke('search_knowledge', {...args, hints: {related_object_ids: [target.object.id]}});
  assert.equal(related.hits[0].ref.object_id, target.object.id, '相关对象提示必须在共同RRF后、limit主读取前提升匹配候选');
  assert.equal(related.hits[0].definition, target.object.entries[0].effective_value);
  const domain = await invoke('search_knowledge', {...args, hints: {business_domain: target.domain}});
  assert.equal(domain.hits[0].ref.object_id, target.object.id, '明确人工业务域是软排序线索');
  checks.push('相关对象与明确业务域提示在公共limit前生效');

  const hints = {related_object_ids: [target.object.id], business_domain: target.domain};
  const seen = [], cursors = new Set();
  let cursor;
  for (let page = 0; page < 8; page++) {
    const reply = await invoke('search_knowledge', {...args, hints, ...(cursor ? {cursor} : {})});
    for (const hit of reply.hits) if (hit.ref.path === 'body') {
      assert.equal(seen.includes(hit.ref.object_id), false); seen.push(hit.ref.object_id);
      const saved = objects.find(({object}) => object.id === hit.ref.object_id);
      assert.ok(saved); assert.equal(hit.definition, saved.object.entries[0].effective_value);
    }
    cursor = reply.search_coverage.next;
    if (!cursor) break;
    assert.equal(cursors.has(cursor), false); cursors.add(cursor);
    assert.ok(page < 7, '提示排序仍须有界终止');
  }
  assert.equal(seen[0], target.object.id);
  assert.deepEqual(seen.slice().sort(), objects.map(({object}) => object.id).sort(), '提示不匹配对象仍可沿原公共游标交付');
  checks.push('首次与恢复窗口排序一致，未匹配候选仍逐项交齐');
  assert.deepEqual(errors, []); h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (h) {await writeFile(h.directory + '/evidence-search-hints.json', JSON.stringify({passed, checks, errors, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
}
