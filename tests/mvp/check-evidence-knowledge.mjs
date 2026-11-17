import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';

const body = '合成导言。甲🌏é乙丙丁。结尾保留。';
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const errors = [], delivered = [];
let h, knowledge, run, calls = 0, prepared = false, passed = false;
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    calls++;
    const reference = {object_id: knowledge.id, version: knowledge.version, path: 'body'};
    let delta;
    if (calls === 1) {
      // §6.1：route回执裁决来源并刷新投影前，正文读取工具不可见，route单独成轮。
      assert.ok(!input.tools.some(tool => tool.function?.name === 'read_knowledge'), '未route前read_knowledge不可见');
      assert.ok(input.tools.some(tool => tool.function?.name === 'update_analysis_task'), '控制工具route始终可见');
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'knowledge-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 2) {
      const tool = input.tools.find(tool => tool.function?.name === 'read_knowledge');
      assert.ok(tool, 'route裁决并刷新后read_knowledge恢复可见');
      assert.ok(tool.function.parameters.properties.items, '合同2必须发布批量知识参数');
      assert.equal(Object.hasOwn(tool.function.parameters.properties, 'object_id'), false);
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'knowledge-batch', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [
          {kind: 'knowledge', ref: {...reference, object_id: 'synthetic-unavailable'}},
          {kind: 'knowledge', ref: reference, offset: 5, limit: 3},
          {kind: 'knowledge', ref: {...reference, version: '0'}},
          {kind: 'knowledge', ref: {...reference, path: 'synthetic-absent-path'}},
          {kind: 'knowledge', ref: reference, offset: 8, limit: 100},
        ]})}},
      ]};
    } else {
      assert.equal(calls, 3, 'route、一批调查与一次续答不添加多余模型调用');
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'knowledge-batch');
      assert.ok(message);
      const result = JSON.parse(message.content);
      validateContract('KnowledgeReadReply', result);
      assert.equal(result.items.length, 5);
      assert.deepEqual(result.items.map(item => item.state), ['not_available', 'ok', 'stale', 'not_available', 'ok']);
      assert.deepEqual(result.items[1].ref, reference);
      assert.equal(result.items[1].content, '甲🌏e');
      assert.deepEqual(result.items[1].content_page, {offset: 5, total_chars: 18, complete: false, next_offset: 8});
      assert.equal(result.items[1].content_state, 'partial');
      assert.equal(result.items[1].continuation.content_next_offset, 8);
      assert.equal(result.items[1].supports_complete, null);
      assert.equal(result.items[1].support_state, 'unknown');
      assert.equal(result.items[4].content, '́乙丙丁。结尾保留。');
      assert.equal(result.items[4].content_state, 'complete');
      assert.equal(result.items[4].continuation.content_next_offset, null);
      for (const index of [0, 2, 3]) assert.deepEqual(Object.keys(result.items[index]).sort(), ['kind', 'ref', 'state']);
      const receipt = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='knowledge-batch'`)[0];
      assert.deepEqual(result, receipt.data, 'Pi到provider无损保留Rust保存的逐项结果');
      const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
      assert.ok(authority.knowledge.some(reference => reference[0] === knowledge.id && reference[1] === knowledge.version));
      assert.ok(!authority.knowledge.some(reference => reference[0] === 'synthetic-unavailable' || reference[1] === '0'), '未交付项不能污染当前依赖');
      assert.ok(authority.evidence_reads.some(read => read.category === 'object' && read.object_kind === 'knowledge' && read.id === knowledge.id));
      delivered.push(result);
      delta = {role: 'assistant', content: '已读取合成条目；不可用及旧版本项均保留明确状态。'};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'evidence-knowledge', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_knowledge_assertion_failed', type: 'invalid_request_error'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  const rebuild = await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()});
  assert.equal(rebuild.status, 200, JSON.stringify(rebuild.value)); prepared = true;
  const saved = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成批量知识', body, related_ids: []});
  assert.equal(saved.status, 200, JSON.stringify(saved.value)); knowledge = saved.value;
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对指定合成条目的短窗口，并区分旧版本和不存在的项。');
  await h.pauseWorker(); assert.equal(run.tool_contract_version, 2);
  try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
  catch (error) { assert.deepEqual(errors, [], JSON.stringify(errors)); throw error; }
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(calls, 3); assert.equal(delivered.length, 1);
  passed = true;
  console.log(JSON.stringify({passed, checks: ['批量保序和逐项不可用/旧版本', 'Unicode窄补读与独立续页', 'Rust回执到实际provider无损', '仅成功内容登记当前依赖'], calls, officialRequests: 0}));
} finally {
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) { await writeFile(h.directory + '/evidence-knowledge.json', JSON.stringify({passed, errors, calls, officialRequests: 0}, null, 2)); await h.close(); }
  if (prepared) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
