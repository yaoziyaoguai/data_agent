import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';
import {assetInput, select} from './skill-fixtures.mjs';

const query = 'syntheticsharedcapacity';
const maxBytes = 5000, maxTokens = 1250;
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const errors = [], checks = [], pages = [], objects = [], assets = [], invocations = [];
const indexed = new Set(), delivered = new Set(), deliveredAssets = new Set(), seenCursors = new Set();
const prerequisite = '必要条件：只计入已确认的合成记录。';
const scope = '例外：停用的合成设备必须排除。';
let h, run, source, calls = 0, prepared = false, passed = false, publicCursor, assetAfter, assetsComplete = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if ((url.endsWith('/internal/data/tools') || url.endsWith('/internal/data/tool-calls')) && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    if (value.tool_name === 'search_knowledge' || value.tool_name === 'read_knowledge') {
      if (url.endsWith('/internal/data/tools')) assert.ok(value.response_budget, '实际Pi读取执行前必须分配宿主容量');
      if (value.response_budget) value.response_budget = {...value.response_budget, max_bytes: Math.min(maxBytes, value.response_budget.max_bytes),
        estimated_tokens: Math.min(maxTokens, value.response_budget.estimated_tokens)};
      if (url.endsWith('/internal/data/tools')) invocations.push(value);
      init = {...init, body: JSON.stringify(value)};
    }
  }
  return originalFetch(input, init);
};
const proxy = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const upstream = await originalFetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const text = await upstream.text();
    if (request.url.endsWith('/upsert') && JSON.parse(text).code === 0)
      for (const row of input.data ?? []) indexed.add(row.object_id);
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"code":1}');}
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const nextSearch = () => ({query, kinds: ['term'], limit: 3,
  ...(publicCursor ? {cursor: publicCursor} : {}), ...(assetAfter ? {asset_after: assetAfter} : {})});
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); calls++;
    assert.ok(calls <= 12, '四项公共命中和三项资产必须在原预算内有界推进');
    let delta;
    if (calls === 1) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'capacity-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', options: []})}},
        {index: 1, id: 'capacity-search-1', type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify(nextSearch())}},
      ]};
    } else {
      const sdkId = 'capacity-search-' + (calls - 1);
      const message = input.messages.find(value => value.role === 'tool' && value.tool_call_id === sdkId);
      assert.ok(message);
      const reply = JSON.parse(message.content);
      assert.equal(reply.error, undefined, '可分页的公共命中和资产不能被整次容量错误代替：' + message.content);
      validateContract('KnowledgeSearchReply', reply);
      assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= maxBytes, '搜索最终JSON、支持、公共和资产游标共同受5000字节限制');
      assert.ok(Math.ceil(JSON.stringify(reply).length / 4) <= maxTokens);
      const saved = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${sdkId}'`)[0];
      if (typeof reply.search_coverage.next === 'string')
        assert.equal(reply.search_coverage.next, 'rc1:' + saved.operation_id, 'provider只见本操作短引用');
      assert.deepEqual(reply, {...saved.data, search_coverage: {...saved.data.search_coverage, next: reply.search_coverage.next}},
        'provider逐字段等Rust首次冻结回执的公开投影');
      if (pages.length === 0) {
        const invocation = invocations.find(value => value.sdk_tool_call_id === sdkId);
        const smaller = {...invocation, response_budget: {...invocation.response_budget, max_bytes: 1, estimated_tokens: 1}};
        assert.equal(ok(await h.internal('/internal/data/tool-calls', smaller)).operation_id, saved.operation_id);
        assert.deepEqual(ok(await h.internal('/internal/data/tools', smaller)), {...saved,
          data: {...saved.data, search_coverage: {...saved.data.search_coverage, next: reply.search_coverage.next}}},
          '搜索正文及四类位置首次保存后，较小预算只能接回原回执的公开投影');
      }
      const supportCount = reply.hits.reduce((sum, hit) => sum + (hit.supports?.length ?? 0), 0);
      assert.ok(supportCount <= 50, '50项上限属于整份搜索回执');
      for (const hit of reply.hits) {
        assert.equal(hit.record_kind, 'knowledge_entry');
        const object = objects.find(value => value.id === hit.ref.object_id);
        assert.ok(object);
        assert.equal(delivered.has(object.id), false, '整项未交付身份保留在公共cursor，已交项不能重传');
        delivered.add(object.id);
        const statement = object.entries[0].human_override.statements[0];
        assert.equal(hit.definition, [...statement.text].slice(0, [...hit.definition].length).join(''));
        assert.equal(hit.scope_text, [...scope].slice(0, [...hit.scope_text].length).join(''));
        assert.equal(hit.supports_complete, true);
        for (const [index, support] of hit.supports.entries()) {
          assert.equal(support.support_id, statement.supports[index].support_id, '支持从首个未交付稳定ID开始');
          if (support.delivered_in) {
            const pointer = support.delivered_in;
            const text = pointer.path.split('/').slice(1).reduce((value, key) => value[key], reply);
            assert.equal([...text].slice(pointer.locator.offset, pointer.locator.offset + pointer.locator.length).join(''), statement.supports[index].content,
              'delivered_in始终指向本回执保留的完整支持');
          } else if (support.content !== null) assert.equal(support.content, statement.supports[index].content);
        }
        if (hit.supports.length < statement.supports.length) {
          assert.equal(hit.support_state, 'partial');
          assert.equal(typeof hit.continuation.supports_next_cursor, 'string');
        }
        if (hit.content_state === 'partial') assert.equal(typeof hit.continuation.content_next_offset, 'number');
      }
      const visibleAssets = [...reply.personal_memories, ...reply.selected_skills];
      for (const asset of visibleAssets) {
        assert.ok(assets.some(value => value.id === asset.id));
        assert.equal(deliveredAssets.has(asset.id), false, '资产页不能重传或跳过未交项');
        deliveredAssets.add(asset.id);
      }
      const beforePublic = publicCursor, beforeAsset = assetAfter;
      publicCursor = reply.search_coverage.next;
      if (reply.next_asset_after !== null) assetAfter = reply.next_asset_after;
      else {
        assetsComplete = true;
        const directory = assets.slice().sort((left, right) => left.id.localeCompare(right.id));
        assetAfter = directory.at(-1).id;
      }
      assert.equal(reply.asset_cursor_invalid, false);
      if (publicCursor) {
        assert.ok(Buffer.byteLength(publicCursor) <= 65536);
        assert.equal(seenCursors.has(publicCursor), false, '每次公共续页必须实际推进');
        for (const object of objects) assert.equal(publicCursor.includes(object.entries[0].effective_value), false);
        seenCursors.add(publicCursor);
      }
      assert.ok(reply.hits.length > 0 || reply.personal_memories.length > 0 || reply.selected_skills.length > 0
        || publicCursor !== beforePublic || assetAfter !== beforeAsset, '成功续页不能空返回相同四类进度');
      pages.push(reply);
      if (publicCursor || !assetsComplete) {
        // 公共结束而资产尚未交齐时，query=*沿原目录入口继续，不重新搜索公共内容。
        const args = publicCursor ? nextSearch() : {query: '*', limit: 3, ...(assetAfter ? {asset_after: assetAfter} : {})};
        delta = {role: 'assistant', tool_calls: [{index: 0, id: 'capacity-search-' + calls, type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify(args)}}]};
      } else {
        assert.deepEqual([...delivered].sort(), objects.map(value => value.id).sort());
        assert.deepEqual([...deliveredAssets].sort(), assets.map(value => value.id).sort());
        delta = {role: 'assistant', content: '合成公共依据与本人资产已按共同容量交付，可分别补读必要内容。'};
      }
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'synthetic-search-capacity', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {errors.push(error.message); response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {type: 'invalid_request_error', message: 'synthetic_shared_capacity_assertion_failed'}}));}
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previous = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192,
    trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成共同容量支持来源', body: prerequisite + '\n' + scope, related_ids: []}));
  for (const label of ['甲', '乙', '丙', '丁']) {
    const name = ('合成容量条目' + label).repeat(20);
    const text = query + ' 合成规则' + label + '🌏：只采用经确认记录。'.repeat(20);
    let object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name, body: '初始化', related_ids: []}));
    const citation = (offset, length) => ({source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset, length}});
    const supports = Array.from({length: 25}, (_, index) => ({key: 'prerequisite-' + index, role: 'prerequisite',
      reference: {kind: 'source', citation: citation(0, [...prerequisite].length)}, content: prerequisite, embedded_in: null}));
    supports.push({key: 'exception', role: 'exception', reference: {kind: 'source', citation: citation([...prerequisite].length + 1, [...scope].length)},
      content: scope, embedded_in: {field: 'scope_text', locator: {offset: 0, length: [...scope].length}}});
    object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: text + '\n' + scope,
      statements: [{key: 'capacity-rule', target: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: scope, citations: [], supports_complete: true, supports}]}, 'alice', 'PATCH'));
    objects.push(object);
  }
  for (const label of ['甲', '乙']) assets.push(ok(await h.request('/assets', assetInput({kind: 'memory', name: query + ' 合成记忆' + label,
    body: '合成记忆正文' + label + '。'.repeat(160), scope: '合成范围' + label + '。'.repeat(160)}))));
  const skill = ok(await h.request('/assets', assetInput({name: query + ' 合成已选方法', scope: '合成选择范围。'.repeat(30)})));
  assets.push(skill);
  const cid = await h.create(); ok(await select(h, cid, skill));
  await h.resumeWorker();
  await until(() => objects.every(value => indexed.has(value.id)), '正式消费者完成四个合成条目索引', 120000);
  run = await h.capture(cid, '在共同小回执内查看合成公共规则、完整必要条件和本人资产，分别沿各自游标续读。'); await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.deepEqual(errors, []);
  // 公开短引用省出的预算让首页可交齐资产目录（limit与排名不变）；四类进度不再被迫同页共现。
  // 分类核验不变：公共游标在正文/支持续读存在时仍推进，资产齐全且不重传由交付集合等式证明。
  assert.ok(pages.some(page => page.search_coverage.next
    && page.hits.some(hit => hit.continuation?.supports_next_cursor && hit.continuation.content_next_offset !== null)),
    '同一小容量回执必须保留公共、支持与正文独立进度');
  assert.deepEqual([...deliveredAssets].sort(), assets.map(value => value.id).sort(), '资产目录交齐且不重传');
  checks.push('公共命中、必要支持与本人资产共同满足5000B/1250估算token，四类进度不跳项');
  h.releaseRun(run.run_id);

  await h.resumeWorker(); run = await h.capture(await h.create(), '核对搜索留下的独立支持续读位置。'); await h.pauseWorker();
  const manager = SessionManager.inMemory('/synthetic/shared-search-capacity');
  // 与其他直调测试一致：read_knowledge受正文准入门约束，先按原消息route再补读。
  const route = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: 'update_analysis_task',
    arguments: {action: 'route', task_id: null, expected_version: null, goal: '', options: []},
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', route));
  ok(await h.internal('/internal/data/tools', route));
  const hit = pages.flatMap(page => page.hits).find(value => value.continuation?.supports_next_cursor);
  assert.ok(hit);
  const object = objects.find(value => value.id === hit.ref.object_id);
  const statement = object.entries[0].human_override.statements[0];
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: 'read_knowledge',
    arguments: {items: [{kind: 'knowledge', ref: hit.ref, statement_id: hit.statement_id, limit: 0, supports_cursor: hit.continuation.supports_next_cursor}]},
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot),
    response_budget: {max_bytes: maxBytes, estimated_tokens: maxTokens, projection_fingerprint: '0'.repeat(64)}};
  ok(await h.internal('/internal/data/tool-calls', input));
  const receipt = ok(await h.internal('/internal/data/tools', input));
  const item = receipt.data.items[0];
  assert.equal(item.state, 'ok'); assert.equal(item.content, ''); assert.equal(item.continuation.content_next_offset, 0);
  assert.ok(item.supports.length > 0);
  assert.equal(item.supports[0].support_id, statement.supports[hit.supports.length].support_id, '搜索支持游标停在首个未交项，可直接交原补读入口');
  const first = invocations.find(value => value.tool_name === 'search_knowledge');
  h.releaseRun(run.run_id);
  checks.push('搜索支持游标可limit=0补读首个未交项，正文位置保持独立');
  assert.ok(first);
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, pages: pages.length, officialRequests: 0}));
} finally {
  globalThis.fetch = originalFetch;
  if (previous === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previous;
  if (h) {await writeFile(h.directory + '/evidence-search-capacity.json', JSON.stringify({passed, checks, errors, calls, pages: pages.map(page => ({bytes: Buffer.byteLength(JSON.stringify(page)), hits: page.hits.map(hit => ({kind: hit.record_kind, contentState: hit.content_state, supports: hit.supports?.length, continuation: hit.continuation})), publicNext: page.search_coverage.next !== null, assets: page.personal_memories.length + page.selected_skills.length, assetNext: page.next_asset_after !== null})), officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await originalFetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close();
  for (const server of [provider, proxy]) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}
