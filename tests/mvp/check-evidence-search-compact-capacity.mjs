import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const mode = process.argv[2] ?? 'milvus';
assert.ok(['milvus', 'sql-unconfigured', 'sql-fallback'].includes(mode), '模式须为milvus、sql-unconfigured或sql-fallback');
const sqlMode = mode !== 'milvus', vectorConfigured = mode !== 'sql-unconfigured';
const query = 'syntheticcompact' + randomUUID().replaceAll('-', '');
const maxBytes = 5000, maxTokens = 1250, windowCount = 24, stride = 280, windowLength = 360;
const text = Array.from({length: windowCount}, (_, index) =>
  ('window-' + String(index).padStart(2, '0') + ' ' + query + ' synthetic registered devices only. ').padEnd(stride, 'x')).join('');
assert.equal([...text].length, windowCount * stride);
const expectedOffsets = Array.from({length: windowCount}, (_, index) => index * stride);
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = vectorConfigured ? (await readFile('.local/infra/milvus-root-password', 'utf8')).trim() : null;
const embedding = await embeddingProvider();
const indexed = new Map(), searches = [], sqlScans = [], pages = [], checks = [], errors = [], invocations = [];
const delivered = new Set(), seenCursors = new Set(), observations = {};
let h, run, object, statement, calls = 0, chatCalls = 0, summaryCalls = 0, searchCalls = 1;
let prepared = false, passed = false, publicCursor, firstPageSearches, firstPageSqlScans, pendingSdkId = 'compact-page-1';
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  let searchInput;
  if ((url.endsWith('/internal/data/tools') || url.endsWith('/internal/data/tool-calls')) && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    if (value.tool_name === 'search_knowledge') {
      if (url.endsWith('/internal/data/tools')) assert.ok(value.response_budget, 'Pi执行搜索前实际分配宿主容量');
      if (value.response_budget) value.response_budget = {...value.response_budget,
        max_bytes: Math.min(maxBytes, value.response_budget.max_bytes),
        estimated_tokens: Math.min(maxTokens, value.response_budget.estimated_tokens)};
      if (url.endsWith('/internal/data/tools')) {
        invocations.push(value); searchInput = value;
        (observations.budgets ??= []).push({sdkId: value.sdk_tool_call_id, ...value.response_budget});
      }
      init = {...init, body: JSON.stringify(value)};
    }
  }
  const result = await originalFetch(input, init);
  if (searchInput) {
    const receipt = await result.clone().json();
    (observations.toolResponses ??= []).push({status: result.status, code: receipt.code ?? null,
      sdkId: searchInput.sdk_tool_call_id, hits: receipt.data?.hits?.length ?? null});
  }
  return result;
};
const proxy = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (mode === 'sql-fallback' && request.url.endsWith('/search')) {
      const lexical = input.annsField === 'sparse';
      assert.ok(lexical || input.annsField === 'vector');
      searches.push({channel: input.annsField, offset: input.offset ?? 0,
        status: lexical ? 503 : 200, code: lexical ? 1 : 0, count: 0, injected: true});
      response.writeHead(lexical ? 503 : 200, {'content-type': 'application/json'})
        .end(lexical ? '{"code":1}' : '{"code":0,"data":[]}');
      return;
    }
    const upstream = await originalFetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const body = await upstream.text(), result = JSON.parse(body);
    if (request.url.endsWith('/upsert') && result.code === 0)
      for (const row of input.data ?? []) indexed.set(row.id, row);
    if (request.url.endsWith('/search')) searches.push({channel: input.annsField, offset: input.offset ?? 0,
      status: upstream.status, code: result.code, count: result.data?.length ?? 0});
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(body);
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"code":1}');}
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
// 沿已有通道故障验收的透明协议观察，只计真实SQL候选execute，不保存SQL、参数或认证帧。
const sqlSockets = new Set();
let closingDatabase = false, sqlPhase = 'setup';
const sqlProxy = sqlMode ? net.createServer(socket => {
  const upstream = net.connect(13306, '127.0.0.1');
  for (const connection of [socket, upstream]) {
    sqlSockets.add(connection);
    connection.on('error', error => {
      (observations.sqlConnectionErrors ??= []).push({phase: sqlPhase, side: connection === socket ? 'client' : 'upstream', code: error.code});
      // pause_worker窗口内SIGTERM拆除worker连接池：代理侧按拆除瞬间是否有在途写入
      // 分别呈现ECONNRESET（收到RST）或EPIPE（对端已关后写入），同属停机噪声；
      // setup/deliver阶段或upstream侧的任何连接错误仍按故障处理。
      const stoppedWorker = sqlPhase === 'pause_worker' && connection === socket
        && ['ECONNRESET', 'EPIPE'].includes(error.code);
      if (!closingDatabase && !stoppedWorker) errors.push('SQL observation connection: ' + error.code);
    });
    connection.on('close', () => sqlSockets.delete(connection));
  }
  socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  const packets = observe => {
    let pending = Buffer.alloc(0);
    return chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUIntLE(0, 3);
        if (pending.length < length + 4) break;
        observe(pending.subarray(4, length + 4), pending[3]); pending = pending.subarray(length + 4);
      }
    };
  };
  const classify = sql => !/\bWITH\s+query_terms\s+AS\b/i.test(sql) ? null
    : sql.includes('FROM knowledge_objects AS k FORCE INDEX') ? 'knowledge'
    : sql.includes('FROM retrieval_documents AS r FORCE INDEX') ? 'retrieval' : null;
  const statements = new Map();
  let preparing, authenticated = false, clientHello = false;
  const clientPackets = packets(payload => {
    if (!authenticated) {clientHello = true; return;}
    if (payload[0] === 0x16) {preparing = {owner: classify(payload.subarray(1).toString('utf8'))}; return;}
    if (payload[0] === 0x19 && payload.length >= 5) {statements.delete(payload.readUInt32LE(1)); return;}
    const owner = payload[0] === 0x03 ? classify(payload.subarray(1).toString('utf8'))
      : payload[0] === 0x17 && payload.length >= 5 ? statements.get(payload.readUInt32LE(1)) : null;
    if (owner) sqlScans.push({owner, at: Date.now()});
  });
  const serverPackets = packets((payload, sequence) => {
    if (!authenticated) {if (clientHello && payload[0] === 0) authenticated = true; return;}
    if (preparing && sequence === 1) {
      if (payload[0] === 0 && payload.length >= 5) statements.set(payload.readUInt32LE(1), preparing.owner);
      preparing = undefined;
    }
  });
  socket.on('data', chunk => {clientPackets(chunk); upstream.write(chunk);});
  upstream.on('data', chunk => {serverPackets(chunk); socket.write(chunk);});
}) : null;
if (sqlProxy) await new Promise(resolve => sqlProxy.listen(0, '127.0.0.1', resolve));
const args = () => ({query, kinds: ['term'], limit: 3, ...(publicCursor ? {cursor: publicCursor} : {})});
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); calls++;
    const summary = !input.tools?.length;
    (observations.providerRequests ??= []).push({summary, bytes: Buffer.byteLength(raw), pendingSdkId});
    assert.ok(Buffer.byteLength(raw) <= 131072, '原协议载荷上限保持131072');
    assert.ok(calls <= 14, '含Pi原生摘要仍为原请求24次总模型预算留出搜索Embedding额度');
    if (summary) summaryCalls++; else chatCalls++;
    let delta;
    if (summary) {
      delta = {role: 'assistant', content: '合成历史摘要：正在交付同一条目的24个规范位置，已完成的工具保持原身份与冻结回执。'
        + '已交付offset=' + JSON.stringify([...delivered]) + '。当前等待工具=' + pendingSdkId
        + '。最新工具若容量不足，沿此原公共cursor继续未交位置：' + (publicCursor ?? '无，等待首页结果')};
    } else if (chatCalls === 1) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'compact-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', options: []})}},
        {index: 1, id: 'compact-page-1', type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify(args())}},
      ]};
    } else {
      const sdkId = pendingSdkId;
      const message = input.messages.find(value => value.role === 'tool' && value.tool_call_id === sdkId);
      assert.ok(message);
      const reply = JSON.parse(message.content);
      observations.lastProviderReply = {error: reply.error ?? null, bytes: Buffer.byteLength(JSON.stringify(reply)), searches: searches.length};
      if (reply.error === 'tool_response_capacity') {
        assert.ok(summaryCalls > 0, '真实宿主余量不足后应先经过Pi原生摘要');
        const invocation = invocations.find(value => value.sdk_tool_call_id === sdkId);
        assert.ok(invocation.response_budget.max_bytes < maxBytes || invocation.response_budget.estimated_tokens < maxTokens,
          '5000B充分余量下的规范pending仍必须成功，不能让编码容量错误冒充历史不足');
        const rejected = ok(await h.internal('/internal/data/tool-rejections', invocation));
        assert.deepEqual(reply, rejected.data, '摘要后保留原操作冻结拒绝');
        const searchesBefore = searches.length, sqlBefore = sqlScans.length;
        assert.deepEqual(ok(await h.internal('/internal/data/tools', invocation)), rejected, '同操作接原拒绝，不发新扫描');
        assert.equal(searches.length, searchesBefore);
        if (sqlMode) assert.equal(sqlScans.length, sqlBefore, '原拒绝重放不重发SQL候选扫描');
        assert.equal(invocation.arguments.cursor, publicCursor, '容量拒绝不能推进或丢弃原pending窗口');
        pendingSdkId = 'compact-page-' + (++searchCalls);
        delta = {role: 'assistant', tool_calls: [{index: 0, id: pendingSdkId, type: 'function',
          function: {name: 'search_knowledge', arguments: JSON.stringify(args())}}]};
      } else {
        assert.equal(reply.error, undefined, '规范pending窗口可分页时不能以整次容量错误代替：' + message.content);
        const saved = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${sdkId}'`)[0];
        if (typeof reply.search_coverage.next === 'string')
          assert.equal(reply.search_coverage.next, 'rc1:' + saved.operation_id, 'provider只见本操作短引用');
        assert.deepEqual(reply, {...saved.data, search_coverage: {...saved.data.search_coverage, next: reply.search_coverage.next}},
          'provider每页逐字段等于Rust首次冻结回执的公开投影');
        validateContract('KnowledgeSearchReply', reply);
        const json = JSON.stringify(reply);
        assert.ok(Buffer.byteLength(json) <= maxBytes, '最终命中、coverage及外层公共游标共同满足5000B');
        assert.ok(Math.ceil(json.length / 4) <= maxTokens, '最终JSON共同满足1250估算token');
        assert.ok(reply.hits.length > 0 && reply.hits.length <= 3, '每次成功续页交付原规范位置');
        assert.deepEqual(reply.personal_memories, []); assert.deepEqual(reply.selected_skills, []);
        if (pages.length === 0) {
          firstPageSearches = searches.length;
          if (!sqlMode) {
            assert.ok(searches.some(value => value.channel === 'sparse' && value.code === 0 && value.count === windowCount),
              '真实BM25首页取回全部24个规范位置');
          } else {
            firstPageSqlScans = sqlScans.length;
            assert.deepEqual(sqlScans.map(value => value.owner).sort(), ['knowledge', 'retrieval'], '首页实际执行两个SQL owner各一次');
            const scan = JSON.parse(saved.data.search_coverage.next).window;
            assert.equal(scan.a, true, 'SQL只作为一条替代词法输入');
            assert.deepEqual(scan.q, [[windowCount, true, true], [windowCount, true, true]], '两owner真实各24行成功且已穷尽');
            if (mode === 'sql-unconfigured') {
              assert.equal(searches.length, 0); assert.equal(indexed.size, 0);
              assert.equal(embedding.requests.length, 0, '无vector配置不发送查询或索引Embedding');
              assert.equal(scan.s.i.target, null);
              // R12已确认语义：无vector配置但SQL替代真实成功供词法正文时，
              // bm25按词法能力可用如实报告；dense保持not_configured。
              assert.deepEqual(reply.search_coverage.channels, [
                {channel: 'exact', state: 'available'},
                {channel: 'bm25', state: 'available'}, {channel: 'dense', state: 'not_configured'}]);
            } else {
              const lexical = searches.filter(value => value.channel === 'sparse');
              const dense = searches.filter(value => value.channel === 'vector');
              assert.ok(lexical.length > 0 && lexical.every(value => value.status === 503 && value.injected), '整条BM25实际503才触发SQL后备');
              assert.ok(dense.length > 0 && dense.every(value => value.status === 200 && value.code === 0 && value.count === 0 && value.injected),
                'dense成功空不提供额外候选或第三票');
              assert.equal(typeof scan.s.i.target, 'string');
            }
            observations.sqlFirstWindow = {positionsPerOwner: scan.q.map(value => value[0]), target: scan.s.i.target};
          }
          const invocation = invocations.find(value => value.sdk_tool_call_id === sdkId);
          const smaller = {...invocation, response_budget: {...invocation.response_budget, max_bytes: 1, estimated_tokens: 1}};
          assert.equal(ok(await h.internal('/internal/data/tool-calls', smaller)).operation_id, saved.operation_id);
          assert.deepEqual(ok(await h.internal('/internal/data/tools', smaller)), {...saved,
            data: {...saved.data, search_coverage: {...saved.data.search_coverage, next: reply.search_coverage.next}}},
            '较小余量重放接原回执，不重新裁掉位置');
          assert.equal(searches.length, firstPageSearches);
          if (sqlMode) assert.equal(sqlScans.length, firstPageSqlScans, '较小预算接原回执不重发SQL候选扫描');
        } else {
          assert.equal(searches.length, firstPageSearches, '原窗口尚有pending时只核owner和窄读，不重新派发公共扫描');
          if (sqlMode) assert.equal(sqlScans.length, firstPageSqlScans, 'SQL窗口pending期间不重发两个owner候选扫描');
        }
        const offsets = [];
        for (const hit of reply.hits) {
          assert.equal(hit.record_kind, 'knowledge_entry'); assert.equal(hit.ref.object_id, object.id);
          assert.equal(hit.ref.version, object.version); assert.equal(hit.ref.path, 'body');
          assert.equal(hit.statement_id, statement.statement_id);
          const visible = [...hit.definition];
          const offset = (hit.continuation.content_next_offset ?? [...text].length) - visible.length;
          assert.ok(expectedOffsets.includes(offset), '公开statement续读位置必须对应原规范窗口起点');
          assert.equal(delivered.has(offset), false, '同owner不同规范位置分别交付，每个位置只交付一次');
          assert.equal(hit.definition, [...text].slice(offset, offset + Math.min(windowLength, visible.length)).join(''));
          assert.ok(visible.length <= Math.min(windowLength, [...text].length - offset));
          assert.equal(hit.scope_text, ''); assert.deepEqual(hit.supports, []);
          assert.equal(hit.supports_complete, true); assert.equal(hit.support_state, 'delivered');
          delivered.add(offset); offsets.push(offset);
        }
        publicCursor = reply.search_coverage.next;
        if (publicCursor !== null) {
          assert.equal(typeof publicCursor, 'string'); assert.ok(Buffer.byteLength(publicCursor) <= 65536);
          assert.equal(seenCursors.has(publicCursor), false, '成功公共续页不能重传相同cursor');
          assert.equal(publicCursor.includes('window-00'), false, 'cursor不携带正文');
          assert.equal(publicCursor.includes(object.name), false, 'cursor不携带名称');
          seenCursors.add(publicCursor);
        }
        pages.push({bytes: Buffer.byteLength(json), estimatedTokens: Math.ceil(json.length / 4), offsets,
          cursorBytes: publicCursor === null ? 0 : Buffer.byteLength(publicCursor), searches: searches.length,
          ...(sqlMode ? {sqlScans: sqlScans.length} : {})});
        if (publicCursor !== null) {
          pendingSdkId = 'compact-page-' + (++searchCalls);
          delta = {role: 'assistant', tool_calls: [{index: 0, id: pendingSdkId,
            type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify(args())}}]};
        } else {
          assert.deepEqual([...delivered].sort((a, b) => a - b), expectedOffsets, '真实终止前全部原pending位置不漏不重');
          delta = {role: 'assistant', content: '同一合成条目的24个规范位置已沿公共游标完整交付。'};
        }
      }
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'synthetic-compact-capacity', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {
      type: 'invalid_request_error', message: 'synthetic_compact_capacity_assertion_failed'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previous = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd',
    input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24,
    toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  const vectorEnv = vectorConfigured ? {
    DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password',
  } : {DATA_AGENT_VECTOR_URL: '', DATA_AGENT_VECTOR_COLLECTION: '', DATA_AGENT_VECTOR_TOKEN_FILE: ''};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    ...(sqlProxy ? {onDatabaseUrl(value) {
      const url = new URL(value); url.port = String(sqlProxy.address().port);
      url.searchParams.set('ssl-mode', 'DISABLED'); return url.toString();
    }} : {}),
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      ...vectorEnv}});
  console.log(JSON.stringify({mode, evidenceDirectory: h.directory, expectedWindows: windowCount}));
  if (vectorConfigured) {
    ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  } else assert.equal(h.env.DATA_AGENT_VECTOR_URL, '');
  object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成容量位置条目', body: '初始化', related_ids: []}));
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version,
    entry_id: 'body', value: text, statements: [{key: 'compact-rule', target: {object_id: object.id, version: object.version, path: 'body'},
      text, scope_text: '', citations: [], supports: [], supports_complete: true}]}, 'alice', 'PATCH'));
  statement = object.entries[0].human_override.statements[0];
  await h.resumeWorker();
  if (vectorConfigured) {
    await until(() => [...indexed.values()].filter(row => row.object_id === object.id && String(row.object_version) === object.version).length === windowCount
      && h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry'
        AND object_id='${object.id}' AND version=${object.version} AND vector_state<>'indexed'`)[0].n === 0,
      '正式消费者完成同owner的24个规范窗口', 120000);
    const rows = [...indexed.values()].filter(row => row.object_id === object.id && String(row.object_version) === object.version);
    assert.deepEqual(rows.map(row => row.char_offset).sort((a, b) => a - b), expectedOffsets);
    observations.indexedWindows = rows.length;
    observations.indexedPositions = rows.map(row => ({offset: row.char_offset, length: row.char_length})).sort((a, b) => a.offset - b.offset);
  } else {
    await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM retrieval_documents r JOIN knowledge_index_jobs j
      ON j.target_kind='knowledge_entry' AND j.object_id=r.object_id AND j.version=r.version
      WHERE r.object_id='${object.id}' AND r.version=${object.version} AND j.state='indexed'`)[0].n === 1,
      '真实Worker完成当前version SQL检索投影', 120000);
    observations.sqlProjectionVersion = object.version;
  }
  run = await h.capture(await h.create(), '沿公共游标读取同一合成条目的全部规范位置，每页使用小回执。');
  sqlPhase = 'pause_worker';
  await h.pauseWorker();
  await new Promise(resolve => setTimeout(resolve, 100));
  sqlPhase = 'deliver';
  assert.equal(run.tool_contract_version, 2, '显式工具合同选择与vector是否配置独立');
  assert.equal(h.sql(`SELECT JSON_OBJECT('version',tool_contract_version) FROM agent_runs WHERE id='${run.run_id}'`)[0].version, 2);
  observations.explicitToolContractVersion = 2;
  sqlScans.length = 0;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.equal(observations.toolResponses?.find(value => value.code !== null)?.code, undefined,
      '真实24候选已返回，最小命中与原pending位置在5000B内必须可分页，不能tool_response_capacity');
    throw error;
  }
  assert.deepEqual(errors, []); assert.deepEqual([...delivered].sort((a, b) => a - b), expectedOffsets);
  assert.equal(publicCursor, null); assert.ok(pages.length > 1); assert.equal(searches.length, firstPageSearches);
  if (sqlMode) assert.equal(sqlScans.length, firstPageSqlScans, '24位置交齐前后两SQL owner均未重扫');
  const attempts = h.sql(`SELECT JSON_OBJECT('state',state,'purpose',purpose) FROM model_call_attempts WHERE budget_scope_id='${run.budget_scope_id}'`);
  observations.modelAttempts = attempts;
  assert.ok(attempts.length <= 24, '沿用原请求24次模型调用总预算');
  assert.equal(attempts.filter(value => value.state === 'issued').length, 0, '返回前原模型账本均已收尾');
  h.releaseRun(run.run_id);
  checks.push('24个同owner规范位置在5000B/1250估算token内由真实provider完整交付，不漏不重');
  checks.push('provider每页等Rust冻结data，较小预算重放仍接原回执，pending恢复无新公共扫描');
  if (sqlMode) checks.push('真实两SQL owner各24位置合成一条词法路，pending和回执重放均不重扫');
  passed = true;
  console.log(JSON.stringify({mode, passed, checks, calls, pages, searches: searches.length,
    ...(sqlMode ? {sqlScans: sqlScans.length} : {}), officialRequests: 0}));
} finally {
  globalThis.fetch = originalFetch;
  if (previous === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previous;
  if (h) {
    await writeFile(h.directory + '/evidence-search-compact-capacity.json', JSON.stringify({mode, passed, checks, calls, pages,
      observations, searches, ...(sqlMode ? {sqlScans} : {}), errors, officialRequests: 0}, null, 2));
    closingDatabase = true;
    await h.close();
  }
  if (sqlProxy) {
    closingDatabase = true;
    for (const socket of sqlSockets) socket.destroy();
    await new Promise(resolve => sqlProxy.close(resolve));
  }
  if (prepared) {
    const response = await originalFetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken},
      body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close();
  for (const server of [provider, proxy]) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}
