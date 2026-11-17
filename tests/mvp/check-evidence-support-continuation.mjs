import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const body = '合成规则。\n适用条件保留。', supportText = '合成支持🧪。';
const errors = [], checks = [], pages = [];
let h, object, source, run, calls = 0, prepared = false, passed = false;
let bounded = false, boundedCalls = 0;
const boundedIds = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (bounded && url.endsWith('/internal/data/tools') && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    if (value.tool_name === 'read_knowledge') {
      assert.ok(value.response_budget, '实际Pi读取执行前必须分配宿主容量');
      value.response_budget = {...value.response_budget, max_bytes: 5000, estimated_tokens: 1250};
      init = {...init, body: JSON.stringify(value)};
    }
  }
  return originalFetch(input, init);
};
const reference = () => ({object_id: object.id, version: object.version, path: 'body'});
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    calls++;
    let delta;
    if (bounded) {
      boundedCalls++;
      assert.ok(boundedCalls <= 20, '每页须推进，不能用无限模型调用掩盖同页');
      if (boundedCalls === 1) {
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'bounded-pages-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
        ]};
      } else if (boundedCalls === 2) {
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'bounded-page-1', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference(), statement_id: 'synthetic-paged-rule', limit: 0}]})}},
        ]};
      } else {
        const sdkId = 'bounded-page-' + (boundedCalls - 2);
        const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === sdkId);
        assert.ok(message);
        const result = JSON.parse(message.content);
        assert.equal(result.error, undefined, '支持可以分页时须交付完整项，不能只报容量错误');
        validateContract('KnowledgeReadReply', result);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 5000);
        assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= 1250);
        const item = result.items[0];
        assert.equal(item.content, '');
        assert.equal(item.continuation.content_next_offset, 0);
        assert.equal(item.support_state, 'partial');
        assert.ok(item.supports.length > 0, '支持续页必须实际交付并推进');
        assert.ok(item.supports.length < 50, '小预算须在完整支持项边界停止');
        for (const support of item.supports) {
          assert.equal(support.content, supportText);
          assert.equal(boundedIds.includes(support.support_id), false, '不能重传前页或跳过未交付项');
          assert.equal(support.support_id, 'synthetic-support-' + String(boundedIds.length).padStart(2, '0'));
          boundedIds.push(support.support_id);
        }
        assert.deepEqual(result, h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${sdkId}'`)[0].data);
        if (boundedIds.length < 51) {
          assert.equal(typeof item.continuation.supports_next_cursor, 'string');
          delta = {role: 'assistant', tool_calls: [{index: 0, id: 'bounded-page-' + (boundedCalls - 1), type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference(), statement_id: 'synthetic-paged-rule', supports_cursor: item.continuation.supports_next_cursor, limit: 0}]})}}]};
        } else {
          assert.equal(boundedIds.length, 51);
          assert.equal(item.continuation.supports_next_cursor, null);
          checks.push('小预算逐完整支持分页，首个未交付位置保留，51项无丢失或重复且正文进度独立');
          delta = {role: 'assistant', content: '合成支持目录已按小容量完整续读。'};
        }
      }
    } else if (calls === 1) {
      // §6.1：route回执裁决来源并刷新投影前，正文读取工具不可见，route单独成轮。
      assert.ok(!input.tools.some(tool => tool.function?.name === 'read_knowledge'), '未route前read_knowledge不可见');
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'support-pages-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 2) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'support-pages-first', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference(), statement_id: 'synthetic-paged-rule'}]})}},
      ]};
    } else {
      assert.ok(calls <= 4);
      const sdkId = calls === 3 ? 'support-pages-first' : 'support-pages-next';
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === sdkId);
      assert.ok(message);
      const result = JSON.parse(message.content);
      assert.equal(result.error, undefined, message.content);
      validateContract('KnowledgeReadReply', result);
      const item = result.items[0];
      assert.equal(item.state, 'ok');
      assert.equal(item.supports_complete, true);
      assert.equal(item.supports_total, 51, '支持按稳定ID去重，不把重复记录算作新依据');
      assert.equal(item.support_state, 'partial', '分开交付的支持页不能在目录末页冒称本回执全部delivered');
      assert.ok(item.supports.every(support => support.content === supportText));
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='${sdkId}'`)[0];
      assert.deepEqual(result, stored.data, '支持游标和正文以Rust原保存回执进入实际provider');
      pages.push(item);
      if (calls === 3) {
        assert.equal(item.content, body);
        assert.equal(item.content_state, 'complete');
        assert.equal(item.supports.length, 50);
        assert.equal(item.supports[0].support_id, 'synthetic-support-00');
        assert.equal(item.supports[49].support_id, 'synthetic-support-49');
        assert.equal(typeof item.continuation.supports_next_cursor, 'string', '第51项必须有独立支持续读位置');
        assert.ok(item.continuation.supports_next_cursor.length > 0);
        assert.equal(item.continuation.content_next_offset, null);
        delta = {role: 'assistant', tool_calls: [{index: 0, id: 'support-pages-next', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference(), statement_id: 'synthetic-paged-rule', supports_cursor: item.continuation.supports_next_cursor, limit: 0}]})}}]};
      } else {
        assert.equal(item.content, '', '支持续读limit=0不重传原正文');
        assert.equal(item.content_state, 'partial');
        assert.equal(item.supports.length, 1);
        assert.equal(item.supports[0].support_id, 'synthetic-support-50');
        assert.equal(item.continuation.supports_next_cursor, null, '有界支持目录真实结束');
        assert.equal(item.continuation.content_next_offset, 0, '正文进度独立，不能用支持末页代替');
        assert.equal(new Set(pages.flatMap(page => page.supports.map(support => support.support_id))).size, 51);
        checks.push('51个唯一支持分两页实际交付', 'limit=0独立续读且不重传正文', '末页仍partial且provider等原回执');
        delta = {role: 'assistant', content: '合成规则的支持分两页取得，目录结束不表示本回执同时交齐。'};
      }
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'support-continuation', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_support_continuation_assertion_failed', type: 'invalid_request_error'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成分页支持来源', body: supportText, related_ids: []}));
  object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成支持独立续读', body, related_ids: []}));
  // 旧保存格式允许超过单回执上限的支持；只构造合成持久资料，读取仍走真实owner和Pi。
  const supports = Array.from({length: 51}, (_, index) => ({support_id: 'synthetic-support-' + String(index).padStart(2, '0'), role: 'prerequisite',
    reference: {kind: 'source', citation: {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...supportText].length}}}, content: supportText, embedded_in: null}));
  supports.push({...supports[0]});
  object.entries[0].human_override.statements = [{statement_id: 'synthetic-paged-rule', object_ref: reference(), text: '合成规则。', scope_text: '适用条件保留。', origin: 'human', citations: [], supports, supports_complete: true}];
  validateContract('KnowledgeObject', object);
  const encoded = Buffer.from(JSON.stringify(object)).toString('hex');
  h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${object.id}';
    UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}';
    INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
      SELECT '${object.id}',1,'synthetic-paged-rule','demo','body','human_override',s.value
      FROM knowledge_objects k,JSON_TABLE(k.body,'$.entries[0].human_override.statements[*]' COLUMNS(value JSON PATH '$')) s WHERE k.id='${object.id}'`);
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对合成规则并独立翻完必要支持目录。');
  await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(calls, 4);

  await h.resumeWorker(); run = await h.capture(await h.create(), '核对合成支持游标的参数和版本边界。');
  await h.pauseWorker();
  const manager = SessionManager.inMemory('/synthetic/support-cursor-boundaries');
  // 直调读取受正文准入门约束：先按本消息route，再进入游标边界矩阵。
  const routeInput = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: 'update_analysis_task',
    arguments: {action: 'route', task_id: null, expected_version: null, goal: '', options: []},
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', routeInput));
  ok(await h.internal('/internal/data/tools', routeInput));
  const invoke = async (args, expectedError, maxBytes) => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: 'read_knowledge', arguments: args,
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls', input));
    const result = await h.internal('/internal/data/tools', maxBytes ? {...input,
      response_budget: {max_bytes: maxBytes, estimated_tokens: Math.ceil(maxBytes / 4), projection_fingerprint: 'a'.repeat(64)}} : input);
    if (!expectedError) return ok(result).data;
    assert.notEqual(result.status, 200); assert.equal(result.value.code, expectedError, JSON.stringify(result.value));
    const rejected = ok(await h.internal('/internal/data/tool-rejections', input));
    assert.equal(rejected.data.error, expectedError);
    assert.equal(Object.hasOwn(rejected.data, 'items'), false);
  };
  // 同一窗口三条短支持被容量分为三个回执；目录耗尽也不表示末回执含先前两条。
  const shortObject = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成三短支持', body: '初始化', related_ids: []}));
  const shortPatched = ok(await h.request('/knowledge/' + shortObject.id, {operation_id: randomUUID(), expected_version: shortObject.version,
    entry_id: 'body', value: '合成短支持规则。', statements: [{key: 'receipt-supports', target: {object_id: shortObject.id, version: shortObject.version, path: 'body'},
      text: '合成短支持规则。', scope_text: '', citations: [], supports_complete: true,
      supports: Array.from({length: 3}, (_, index) => ({key: 'short-' + index, role: 'prerequisite',
        reference: {kind: 'source', citation: {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...supportText].length}}},
        content: `条件${index}：` + '合成限定内容'.repeat(90), embedded_in: null}))}]}, 'alice', 'PATCH'));
  const shortItem = {kind: 'knowledge', ref: {object_id: shortObject.id, version: shortPatched.version, path: 'body'},
    statement_id: shortPatched.entries[0].human_override.statements[0].statement_id, limit: 0};
  const shortPages = [];
  let shortCursor;
  for (let index = 0; index < 3; index++) {
    const page = (await invoke({items: [{...shortItem, ...(shortCursor ? {supports_cursor: shortCursor} : {})}]}, undefined, 3800)).items[0];
    assert.equal(page.supports.length, 1);
    assert.ok(page.supports.every(support => !support.content_page || support.content_page.complete));
    shortPages.push(page);
    shortCursor = page.continuation.supports_next_cursor;
  }
  assert.equal(shortCursor, null);
  assert.equal(new Set(shortPages.flatMap(page => page.supports.map(support => support.support_id))).size, 3);
  assert.deepEqual(shortPages.map(page => page.support_state), ['partial', 'partial', 'partial'], '每份回执只含三条支持中的一条，末回执也应partial');
  const allShort = (await invoke({items: [shortItem]})).items[0];
  assert.equal(allShort.supports.length, 3);
  assert.equal(allShort.support_state, 'delivered', '同回执交齐三条支持才是delivered');
  checks.push('三短支持分三回执均partial，末页耗尽；同回执交齐为delivered');

  const item = {kind: 'knowledge', ref: reference(), statement_id: 'synthetic-paged-rule', limit: 0};
  const first = (await invoke({items: [item]})).items[0];
  const cursor = first.continuation.supports_next_cursor;
  assert.equal(typeof cursor, 'string');
  await invoke({items: [{...item, supports_cursor: 'not-a-valid-support-cursor'}]}, 'invalid_cursor');
  await invoke({items: [{...item, statement_id: 'different-statement', supports_cursor: cursor}]}, 'invalid_cursor');
  await invoke({items: [{...item, ref: {...reference(), path: 'different-path'}, supports_cursor: cursor}]}, 'invalid_cursor');
  await invoke({items: [{...item, ref: {...reference(), version: '999'}, supports_cursor: cursor}]}, 'stale_cursor');
  checks.push('损坏、参数和修订游标明确拒绝并持久化原拒绝');
  const shared = await invoke({items: [item, item]});
  validateContract('KnowledgeReadReply', shared);
  assert.equal(shared.items.length, 2);
  assert.ok(shared.items.reduce((sum, entry) => sum + entry.supports.length, 0) <= 50, '一批多个items共享整份50支持上限');
  assert.equal(shared.items[0].supports.length, 50);
  assert.equal(shared.items[1].supports.length, 0);
  assert.equal(shared.items[1].support_state, 'partial');
  assert.equal(typeof shared.items[1].continuation.supports_next_cursor, 'string', '未交任何支持的item仍保留位置0');
  const untouched = (await invoke({items: [{...item, supports_cursor: shared.items[1].continuation.supports_next_cursor}]})).items[0];
  assert.equal(untouched.supports[0].support_id, 'synthetic-support-00', '共同容量裁掉的支持从首个未交ID补读，不能跳到目录末尾');
  assert.equal(untouched.content, '');
  assert.equal(untouched.continuation.content_next_offset, 0);
  checks.push('多items共享50支持，完全未交项保留独立位置0并可实际补读');

  // R11：旧v1游标中途偏移按旧语义续读原成员；新v2游标绑定当前修订内容指纹。
  const allocLong = '支持分配🧪：先交短例外。'.repeat(700);
  const allocShortA = '短例外甲：停用即排除。', allocShortB = '短例外乙：未登记即排除。';
  const allocObject = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成支持分配次序', body: '初始化', related_ids: []}));
  const patched = ok(await h.request('/knowledge/' + allocObject.id, {operation_id: randomUUID(), expected_version: allocObject.version, entry_id: 'body', value: '分配次序规则。',
    statements: [{key: 'allocation-order-rule', target: {object_id: allocObject.id, version: allocObject.version, path: 'body'}, text: '分配次序规则。', scope_text: '', citations: [], supports_complete: true,
      supports: [
        {key: 'long-first', role: 'prerequisite', reference: {kind: 'source', citation: {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...supportText].length}}}, content: allocLong, embedded_in: null},
        {key: 'short-a', role: 'exception', reference: {kind: 'source', citation: {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...supportText].length}}}, content: allocShortA, embedded_in: null},
        {key: 'short-b', role: 'exception', reference: {kind: 'source', citation: {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...supportText].length}}}, content: allocShortB, embedded_in: null},
      ]}]}, 'alice', 'PATCH'));
  const allocSid = patched.entries[0].human_override.statements[0].statement_id;
  const allocItem = {kind: 'knowledge', ref: {object_id: allocObject.id, version: patched.version, path: 'body'}, statement_id: allocSid, limit: 0};
  const allocFirst = (await invoke({items: [allocItem]})).items[0];
  const allocCursor = JSON.parse(allocFirst.continuation.supports_next_cursor);
  assert.equal(allocCursor.schema, 2, '支持游标升级为携带窗口与内容绑定的v2格式');
  assert.equal(allocCursor.fingerprint, h.sql(`SELECT JSON_OBJECT('fingerprint',fingerprint) FROM knowledge_revisions WHERE object_id='${allocObject.id}' AND version=${Number(patched.version)}`)[0].fingerprint,
    'v2游标绑定当前修订指纹，同版支持重整后旧游标不得串项');
  assert.deepEqual(allocCursor.consumed, [2, 3], '已完整交付的短例外记原目录位置');
  assert.equal(allocCursor.resume_position, 1, '未完长条件按原目录位置续读');
  const legacy = JSON.stringify({schema: 1, binding: allocCursor.binding, revision: String(patched.version),
    condition_version: null, next: 0, content_offset: 4000});
  const legacyRead = (await invoke({items: [{...allocItem, supports_cursor: legacy}]})).items[0];
  assert.equal(legacyRead.supports.length, 3, '旧v1游标薄转换后短例外仍先完整交付');
  assert.equal(legacyRead.supports[0].content, allocShortA);
  assert.equal(legacyRead.supports[1].content, allocShortB);
  assert.equal(legacyRead.supports[2].content_page.offset, 4000, '旧游标的中途偏移套在原长条件成员上，不能换成员');
  assert.equal(legacyRead.supports[2].content, [...allocLong].slice(4000, 4000 + [...legacyRead.supports[2].content].length).join(''));
  await invoke({items: [{...allocItem, supports_cursor: JSON.stringify({...allocCursor, schema: 3})}]}, 'invalid_cursor');
  checks.push('旧v1中途偏移游标按原成员续读；v2游标带窗口位置与修订指纹');
  h.releaseRun(run.run_id);
  await h.resumeWorker(); run = await h.capture(await h.create(), '按小容量独立翻完合成必要支持目录，不重传正文。');
  await h.pauseWorker();
  bounded = true;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []);
  assert.equal(boundedIds.length, 51);
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, officialRequests: 0}));
} finally {
  globalThis.fetch = originalFetch;
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) {await writeFile(h.directory + '/evidence-support-continuation.json', JSON.stringify({passed, errors, checks, calls, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
