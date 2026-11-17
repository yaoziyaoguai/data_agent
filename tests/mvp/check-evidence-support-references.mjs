import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const text = '合成必要条件🧪：只采用已登记设备。'.repeat(500);
const characters = [...text], parts = [], checks = [], errors = [];
let h, object, run, reference, calls = 0, runCalls = 0, prepared = false, passed = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).endsWith('/internal/data/tools') && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    if (value.tool_name === 'read_knowledge') {
      assert.ok(value.response_budget);
      value.response_budget = {...value.response_budget,
        max_bytes: Math.min(5000, value.response_budget.max_bytes),
        estimated_tokens: Math.min(1250, value.response_budget.estimated_tokens)};
      init = {...init, body: JSON.stringify(value)};
    }
  }
  return originalFetch(input, init);
};
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); calls++; runCalls++;
    assert.ok(runCalls <= 12, '单次引用续读在原24次预算内推进');
    const statement = object.entries[0].human_override.statements[0];
    const item = {kind: 'knowledge', ref: {object_id: object.id, version: object.version, path: 'body'},
      statement_id: statement.statement_id, limit: 0};
    const message = input.messages.findLast(value => value.role === 'tool');
    let delta;
    if (!message) {
      // §6.1：route回执裁决来源并刷新投影前，正文读取工具不可见，route单独成轮。
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'reference-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', options: []})}},
      ]};
    } else if (message.tool_call_id === 'reference-route') {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'reference-page-0', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [item]})}},
      ]};
    } else {
      const reply = JSON.parse(message.content);
      assert.equal(reply.error, undefined, message.content);
      validateContract('KnowledgeReadReply', reply);
      const encoded = JSON.stringify(reply);
      assert.ok(Buffer.byteLength(encoded) <= 5000); assert.ok(Math.ceil(encoded.length / 4) <= 1250);
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${message.tool_call_id}'`)[0];
      assert.deepEqual(reply, stored.data, '实际provider接收Rust原冻结正文和游标');
      assert.equal(reply.items.length, 1);
      const result = reply.items[0];
      assert.equal(result.state, 'ok'); assert.equal(result.content, '');
      assert.equal(result.continuation.content_next_offset, 0, '只续支持不推进陈述正文');
      assert.equal(result.supports_complete, true); assert.equal(result.support_state, 'partial');
      assert.equal(result.supports.length, 1);
      const support = result.supports[0], offset = parts.reduce((sum, part) => sum + [...part].length, 0);
      assert.deepEqual(support.reference, reference); assert.equal(support.support_id, statement.supports[0].support_id);
      assert.ok(support.content?.length > 0); assert.equal(Object.hasOwn(support, 'delivered_in'), false);
      const end = offset + [...support.content].length;
      assert.equal(support.content, characters.slice(offset, end).join(''), '引用正文按原Unicode范围逐字衔接');
      assert.deepEqual(support.content_page, {offset, total_chars: characters.length, complete: false, next_offset: end < characters.length ? end : null});
      parts.push(support.content);
      if (end === characters.length) {
        assert.equal(result.continuation.supports_next_cursor, null);
        delta = {role: 'assistant', content: '已逐页核对原引用范围内的合成必要条件。'};
      } else {
        assert.equal(typeof result.continuation.supports_next_cursor, 'string');
        delta = {role: 'assistant', tool_calls: [{index: 0, id: 'reference-page-' + parts.length, type: 'function',
          function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{...item, supports_cursor: result.continuation.supports_next_cursor}]})}}]};
      }
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'synthetic-support-reference', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {type: 'invalid_request_error', message: 'synthetic_support_reference_assertion_failed'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previous = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd',
    input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24,
    toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  const knowledge = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成长引用正文', body: text, related_ids: []}));
  const prefix = '合成范围之前，不能夹带。', suffix = '合成范围之后，不能越界。';
  const source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成有界引用来源', body: prefix + text + suffix, related_ids: []}));
  object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成引用支持规则', body: '初始化', related_ids: []}));
  for (reference of [
    {kind: 'knowledge', ref: {object_id: knowledge.id, version: knowledge.version, path: 'body'}},
    {kind: 'source', citation: {source: {kind: 'document', id: source.id}, revision: source.version,
      locator: {offset: [...prefix].length, length: characters.length}}},
  ]) {
    parts.length = 0; runCalls = 0;
    const rule = '合成规则只采用满足必要条件的设备。';
    object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: rule,
      statements: [{key: 'reference-only-rule', target: {object_id: object.id, version: object.version, path: 'body'}, text: rule, scope_text: '', citations: [], supports_complete: true,
        supports: [{key: 'reference-only-condition', role: 'prerequisite', reference, content: null, embedded_in: null}]}]}, 'alice', 'PATCH'));
    assert.equal(object.entries[0].human_override.statements[0].supports[0].content, null, '保存入口不补正文掩盖引用续读');
    await h.resumeWorker(); run = await h.capture(await h.create(), '沿原引用范围读取合成长条件，不夹带范围外正文。'); await h.pauseWorker();
    try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
    catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
    assert.equal(parts.join(''), text); assert.ok(parts.length > 1);
    checks.push({reference: reference.kind, pages: parts.length, calls: runCalls, characters: characters.length});
    h.releaseRun(run.run_id);
  }
  assert.deepEqual(errors, []); passed = true;
  console.log(JSON.stringify({passed, checks, calls, officialRequests: 0}));
} finally {
  globalThis.fetch = originalFetch;
  if (previous === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previous;
  if (h) {await writeFile(h.directory + '/evidence-support-references.json', JSON.stringify({passed, checks, errors, calls, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await originalFetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
