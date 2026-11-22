import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const structure = {kind: 'table', grain: '每行一个合成设备', unique_keys: [['order_id', 'line_id']],
  time_columns: [{column: 'paid_at', role: '支付时间'}], default_filters: [], constraints: ['金额使用分']};
const errors = [], checks = [];
let h, object, table, run, calls = 0, prepared = false, passed = false;
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    calls++;
    const reference = {object_id: object.id, version: object.version, path: 'body'};
    const tableRef = {object_id: table.id, version: table.version, path: 'description'};
    let delta;
    if (calls === 1) {
      // §6.1：route回执裁决来源并刷新投影前，正文读取工具不可见，route单独成轮。
      assert.ok(!input.tools.some(tool => tool.function?.name === 'read_knowledge'), '未route前read_knowledge不可见');
      assert.ok(input.tools.some(tool => tool.function?.name === 'update_analysis_task'), '控制工具route始终可见');
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'statement-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 2) {
      const tool = input.tools.find(tool => tool.function?.name === 'read_knowledge');
      assert.ok(tool, 'route裁决并刷新后read_knowledge恢复可见');
      assert.ok(JSON.stringify(tool.function.parameters).includes('statement_id'));
      assert.ok(JSON.stringify(tool.function.parameters).includes('structure_only'));
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'statement-batch', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [
          {kind: 'knowledge', ref: reference, statement_id: 'synthetic-second', offset: 1, limit: 3},
          {kind: 'knowledge', ref: reference, statement_id: 'synthetic-hidden'},
          {kind: 'knowledge', ref: reference, statement_id: 'synthetic-second', offset: 8, limit: 100},
          {kind: 'knowledge', ref: reference, statement_id: 'synthetic-unknown'},
          {kind: 'knowledge', ref: reference, statement_id: 'synthetic-incomplete'},
          {kind: 'knowledge', ref: tableRef, structure_only: true, offset: 0, limit: 6},
          {kind: 'knowledge', ref: tableRef, structure_only: true, offset: 6, limit: 65536},
          {kind: 'knowledge', ref: tableRef, structure_only: true},
        ]})}},
      ]};
    } else {
      assert.equal(calls, 3);
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'statement-batch');
      assert.ok(message);
      assert.match(message.content, /^\s*\{/, '批量陈述/结构必须返回结构化回执：' + message.content);
      const result = JSON.parse(message.content);
      assert.equal(result.error, undefined, JSON.stringify(result));
      validateContract('KnowledgeReadReply', result);
      const items = result.items;
      assert.deepEqual(items.map(item => item.state), ['ok', 'not_available', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      assert.equal(items[0].statement_id, 'synthetic-second');
      assert.equal(items[0].content, '🧪é');
      assert.deepEqual(items[0].content_page, {offset: 1, total_chars: 12, complete: false, next_offset: 4});
      assert.equal(items[0].supports_complete, true);
      assert.equal(items[0].support_state, 'delivered', '明确完整且无必要支持时才可交齐');
      assert.equal(items[2].content, '‍🔬合成');
      assert.equal(items[2].content_state, 'complete');
      assert.equal(items[2].content_page.complete, false, '尾页不冒充从零读过整段');
      assert.equal(items[2].continuation.content_next_offset, null);
      assert.equal(items[3].supports_complete, null);
      assert.equal(items[3].support_state, 'unknown');
      assert.equal(items[4].supports_complete, false);
      assert.equal(items[4].support_state, 'unknown');
      assert.equal(items[5].effective_structure, null);
      assert.equal(items[6].effective_structure, null, '尾部JSON片段不能作为完整结构采用');
      assert.equal(items[5].structure_text.length, 6);
      assert.equal(items[5].structure_page.next_offset, 6);
      assert.equal(items[6].structure_page.next_offset, null);
      assert.deepEqual(JSON.parse(items[5].structure_text + items[6].structure_text), structure);
      assert.deepEqual(items[7].effective_structure, structure);
      assert.deepEqual(JSON.parse(items[7].structure_text), structure);
      assert.equal(items[7].structure_page.complete, true);
      assert.equal(items[7].structure_coverage.state, 'complete');
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='statement-batch'`)[0];
      assert.deepEqual(result, stored.data, '陈述与结构分页从原保存回执无损进入provider');
      assert.ok(!message.content.includes('不得采用的旧建议'));
      checks.push('显式非首陈述、Unicode尾页及保存完整性三态', '结构独立分页与完整JSON采用', '正式Rust回执到provider无损');
      delta = {role: 'assistant', content: '已核对指定合成陈述与当前结构，未知的支持范围仍保留未知。'};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'evidence-statements', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_statement_assertion_failed', type: 'invalid_request_error'}}));
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
  object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成陈述分页', body: '初始化', related_ids: []}));
  // 从零构造已保存陈述夹具；工具仍走正式登记、owner和最终回执。
  const statement = (id, text, scope, declaration) => ({statement_id: id,
    object_ref: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: scope,
    origin: 'human', citations: [], supports: [], ...(declaration === undefined ? {} : {supports_complete: declaration})});
  const statements = [statement('synthetic-first', '非首陈述前的大正文。'.repeat(10000), '', true),
    statement('synthetic-second', '甲🧪é乙', '仅👩‍🔬合成', true),
    statement('synthetic-unknown', '历史陈述没有覆盖声明。', '', undefined),
    statement('synthetic-incomplete', '明确尚未完成支持提取。', '', false)];
  const selected = object.entries[0];
  selected.human_override.statements = statements;
  selected.human_override.value = selected.effective_value = statements.map(item => item.text + (item.scope_text ? '\n' + item.scope_text : '')).join('\n\n');
  selected.suggestion = {value: '不得采用的旧建议', statements: [statement('synthetic-hidden', '不得采用的旧建议', '', true)]};
  const encoded = Buffer.from(JSON.stringify(object)).toString('hex');
  h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${object.id}';
    UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}';
    DELETE FROM knowledge_statements WHERE object_id='${object.id}';
    INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
      SELECT '${object.id}',1,JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.statement_id')),'demo','body','human_override',s.value
      FROM knowledge_objects k,JSON_TABLE(k.body,'$.entries[0].human_override.statements[*]' COLUMNS(value JSON PATH '$')) s WHERE k.id='${object.id}'`);
  table = ok(await h.request('/knowledge/table-demo_order_detail'));
  table = ok(await h.request('/knowledge/' + table.id, {operation_id: randomUUID(), expected_version: table.version,
    entry_id: 'description', value: '合成设备明细规则', structured_value: structure}, 'alice', 'PATCH'));
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对指定的第二条合成陈述，以及当前表规则的结构分页。');
  await h.pauseWorker(); assert.equal(run.tool_contract_version, 2);
  try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(calls, 3);
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, officialRequests: 0}));
} finally {
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) {await writeFile(h.directory + '/evidence-statements.json', JSON.stringify({passed, errors, checks, calls, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
