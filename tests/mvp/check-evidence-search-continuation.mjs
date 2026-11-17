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

const query = 'syntheticcursorneedle';
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const checks = [], errors = [], indexed = new Set(), delivered = new Set(), cursors = new Set(), searches = [];
const objects = [];
let h, run, prepared = false, passed = false, calls = 0, firstPageSearches;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const proxy = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const upstream = await fetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const text = await upstream.text();
    if (request.url.endsWith('/search')) searches.push({field: input.annsField, filter: input.filter, code: JSON.parse(text).code});
    if (request.url.endsWith('/upsert') && JSON.parse(text).code === 0)
      for (const row of input.data ?? []) indexed.add(row.object_id);
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"code":1}');}
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); calls++;
    assert.ok(calls <= 7, '三个短命中必须有界交付，不能永远重传同页');
    let delta;
    if (calls === 1) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'cursor-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', options: []})}},
        {index: 1, id: 'cursor-page-1', type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify({query, kinds: ['term'], limit: 1})}},
      ]};
    } else {
      const sdkId = 'cursor-page-' + (calls - 1);
      const message = input.messages.find(value => value.role === 'tool' && value.tool_call_id === sdkId);
      assert.ok(message);
      const result = JSON.parse(message.content);
      assert.equal(result.error, undefined, message.content);
      validateContract('KnowledgeSearchReply', result);
      assert.ok(result.hits.length <= 1);
      if (calls === 2) firstPageSearches = searches.length;
      else assert.equal(searches.length, firstPageSearches, '未交付窗口恢复只核当前owner，不重新派发公共扫描');
      for (const hit of result.hits) {
        assert.equal(hit.record_kind, 'knowledge_entry');
        const object = objects.find(value => value.id === hit.ref.object_id);
        assert.ok(object, '每项都来自独立合成输入');
        assert.equal(hit.definition, object.entries[0].effective_value);
        assert.equal(delivered.has(object.id), false, '公共续页不能重传已交付内容身份');
        delivered.add(object.id);
      }
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${sdkId}'`)[0];
      const next = result.search_coverage.next;
      if (next !== null) {
        assert.equal(typeof next, 'string');
        assert.ok(Buffer.byteLength(next) > 0 && Buffer.byteLength(next) <= 96, '公共回执只给短不透明引用');
        assert.match(next, /^rc1:[A-Za-z0-9_-]+$/, '短引用由宿主产生且不是自包含大游标');
        assert.equal(next, 'rc1:' + stored.operation_id, '短引用指向本页原成功工具操作');
        const frozen = stored.data;
        assert.ok(typeof frozen.search_coverage.next === 'string' && !frozen.search_coverage.next.startsWith('rc1:'),
          '完整候选窗口只留在宿主持久回执，公开投影不回写');
        assert.equal(frozen.search_coverage.next.includes(objects[0].entries[0].effective_value), false, '宿主窗口不含正文');
        assert.deepEqual(result, {...frozen, search_coverage: {...frozen.search_coverage, next}},
          'provider只得到冻结回执的确定短投影');
        for (const object of objects) assert.equal(next.includes(object.entries[0].effective_value), false, '游标不含正文');
        assert.equal(cursors.has(next), false, '未推进的相同公共游标不能成功返回');
        cursors.add(next);
        delta = {role: 'assistant', tool_calls: [{index: 0, id: 'cursor-page-' + calls, type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify({query, kinds: ['term'], limit: 1, cursor: next})}}]};
      } else {
        assert.deepEqual([...delivered].sort(), objects.map(value => value.id).sort(), '真实终止前必须交付全部三个已索引短命中');
        delta = {role: 'assistant', content: '三项合成依据已沿公共游标完整交付。'};
      }
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'synthetic-search-cursor', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {errors.push(error.message); response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {type: 'invalid_request_error', message: 'synthetic_search_cursor_assertion_failed'}}));}
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
  for (const label of ['甲', '乙', '丙']) objects.push(ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: '合成游标条目' + label, body: query + ' 合成定义' + label + '🌏：只采用经确认的记录。', related_ids: []})));
  await h.resumeWorker();
  await until(() => objects.every(value => indexed.has(value.id)), '正式消费者索引三个合成条目', 120000);
  run = await h.capture(await h.create(), '逐项读取三条合成依据，公共续页不重传。'); await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(delivered.size, 3); assert.ok(cursors.size >= 2);
  checks.push('同一正式driver按原通道排名续读三项，最终provider逐页等Rust回执且不重复、不漏项');

  await h.resumeWorker(); const cidB = await h.create();
  run = await h.capture(cidB, '核对合成公共游标参数与条件绑定。'); await h.pauseWorker();
  const manager = SessionManager.inMemory('/synthetic/search-cursor-boundaries');
  const invoke = async (name, args, expectedError, sdkToolCallId) => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: sdkToolCallId ?? randomUUID(), tool_name: name, arguments: args,
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls', input));
    const response = await h.internal('/internal/data/tools', input);
    if (!expectedError) return ok(response).data;
    assert.equal(response.value.code, expectedError, JSON.stringify(response)); assert.notEqual(response.status, 200);
    const rejection = ok(await h.internal('/internal/data/tool-rejections', input));
    assert.equal(rejection.data.error, expectedError); assert.equal(Object.hasOwn(rejection.data, 'hits'), false);
  };
  const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null, group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null};
  const task = await invoke('update_analysis_task', {action: 'create', goal: '合成游标绑定', conditions, options: []});
  const args = {query, kinds: ['term'], limit: 1};
  const firstSdk = randomUUID();
  const first = await invoke('search_knowledge', args, undefined, firstSdk);
  const firstStored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${firstSdk}'`)[0];
  const cursor = first.search_coverage.next;
  assert.equal(typeof cursor, 'string');
  assert.equal(cursor, 'rc1:' + firstStored.operation_id, '边界直调同样只发布短引用');
  const searchesBeforeReplay = searches.length;
  const replay = await invoke('search_knowledge', args, undefined, firstSdk);
  assert.equal(searches.length, searchesBeforeReplay, '同操作重放不重新派发检索');
  assert.equal(replay.search_coverage.next, cursor, '同操作重放返回同一短引用');
  assert.deepEqual(h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${firstSdk}'`)[0], firstStored,
    '重放只读不改写冻结回执');
  checks.push('同操作重放返回同一短引用，不重新检索也不改写冻结回执');
  await invoke('search_knowledge', {...args, view:'source_identity', cursor}, 'invalid_cursor');
  checks.push('真实正常取证游标不能用于来源身份视图，不借伪造字符串作对照');
  await invoke('search_knowledge', {...args, cursor: 'not-a-cursor'}, 'invalid_cursor');
  await invoke('search_knowledge', {...args, query: query + 'changed', cursor}, 'invalid_cursor');
  await invoke('search_knowledge', {...args, kinds: ['document'], cursor}, 'invalid_cursor');
  await invoke('search_knowledge', {...args, hints: {business_domain: '合成排序域'}, cursor}, 'invalid_cursor');
  // 组4接缝：短引用只绑会话不绑恢复链；同会话下一条消息（新run、新chain）继续翻页。
  ok(await h.internal('/internal/outputs', {run_id: run.run_id, lease_epoch: run.lease_epoch, chunk_seq: '1', text: '公共游标边界核对完成。'}));
  ok(await h.internal('/internal/finish', {run_id: run.run_id, lease_epoch: run.lease_epoch, commit_id: run.output_id,
    final_text: '公共游标边界核对完成。', checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)}));
  h.releaseRun(run.run_id);
  await h.resumeWorker(); run = await h.capture(cidB, '继续读取下一页合成依据。'); await h.pauseWorker();
  // 新消息按现有合同route接回同一原任务（原task_id/condition_version/来源范围），
  // 使本run获得任务上下文；这不改变短引用只绑会话不绑恢复链的要求。
  await invoke('update_analysis_task', {action: 'route', task_id: task.task_id, expected_version: task.condition_version, options: []});
  const crossPage = await invoke('search_knowledge', {...args, cursor});
  assert.ok(crossPage.hits.length >= 1, '同会话下一条消息必须能用短引用续页');
  assert.notEqual(crossPage.hits[0].ref.object_id, first.hits[0].ref.object_id, '跨消息续页返回下一页而非重放首页');
  checks.push('同会话下一条消息用短引用续页：短引用只绑会话，不绑恢复链');
  const revised = await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id, expected_version: task.condition_version,
    goal: '', condition_patch: {set: {notes: '合成条件已改变'}, unset: []}, options: []});
  assert.notEqual(revised.condition_version, task.condition_version);
  await invoke('search_knowledge', {...args, cursor}, 'stale_cursor');
  checks.push('损坏游标与查询/kinds/hints变化明确invalid，当前任务条件变化明确stale并保存原拒绝');

  const versionPage = await invoke('search_knowledge', args);
  const versionCursor = versionPage.search_coverage.next;
  assert.equal(typeof versionCursor, 'string');
  const pending = objects.find(value => value.id !== versionPage.hits[0].ref.object_id);
  const edited = ok(await h.request('/knowledge/' + pending.id, {operation_id: randomUUID(), expected_version: pending.version,
    entry_id: pending.entries[0].entry_id, value: pending.entries[0].effective_value + ' 合成新版。'}, 'alice', 'PATCH'));
  assert.notEqual(edited.version, pending.version);
  await invoke('search_knowledge', {...args, cursor: versionCursor}, 'stale_cursor');
  checks.push('公共窗口中未交知识真实换版后stale，不静默跳过旧候选');

  const scopePage = await invoke('search_knowledge', args);
  const scopeCursor = scopePage.search_coverage.next;
  assert.equal(typeof scopeCursor, 'string');
  const scoped = objects.find(value => value.id !== scopePage.hits[0].ref.object_id && value.id !== pending.id);
  assert.ok(scoped);
  const disabled = ok(await h.request('/knowledge/' + scoped.id + '/disable', {operation_id: randomUUID(), expected_version: scoped.version}));
  assert.equal(disabled.state, 'disabled');
  await invoke('search_knowledge', {...args, cursor: scopeCursor}, 'stale_cursor');
  checks.push('正式停用改变当前允许范围，原公共游标不能恢复被停用内容');
  h.releaseRun(run.run_id);
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, pages: delivered.size, officialRequests: 0}));
} finally {
  if (previous === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previous;
  if (h) {await writeFile(h.directory + '/evidence-search-continuation.json', JSON.stringify({passed, checks, errors, calls, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close();
  for (const server of [provider, proxy]) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}
