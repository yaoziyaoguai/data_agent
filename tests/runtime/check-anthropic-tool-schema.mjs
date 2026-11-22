import assert from 'node:assert/strict';
import {normalizeContext} from '@earendil-works/pi-ai';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {guardedModelStream} from '../../apps/agent/provider/controlled.ts';
import {modelProtocolFixture} from './model-protocol-fixture.mjs';
import schema from '../../packages/contracts/schema.json' with {type: 'json'};

const provider = await modelProtocolFixture();
const checks = [];
try {
  for (const api of ['anthropic-messages', 'openai-completions']) {
    const definitions = dataTools({run: {tool_contract_version: 2}}, null, '').tools;
    const definition = definitions.find(tool => tool.name === 'update_analysis_task');
    const answerName = 'prepare_analysis_answer';
    const answer = definitions.find(tool => tool.name === answerName);
    const search = definitions.find(tool => tool.name === 'search_knowledge');
    const original = JSON.stringify(definition.parameters);
    const profile = {provider_id: 'compatible', model_id: 'synthetic/schema', trial_id: 'synthetic', price_version: 'configured:schema:1', input_limit: 128000, output_limit: 8000, payload_bytes_limit: 262144, toolset: 'data', thinking_level: 'off', configured_model: {id: 'model', version: '1', service_id: 'service', service_version: '1', api, input_rate: '0', output_rate: '0'}};
    const model = {id: profile.model_id, name: 'Synthetic schema', api, provider: 'compatible', baseUrl: provider.url + (api === 'anthropic-messages' ? '/gateway' : '/gateway/v1'), input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 8000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}, compat: {supportsStrictMode: false, supportsStrictTools: false}};
    const transport = {run: {run_id: 'synthetic-schema'}, binding: () => ({run_id: 'synthetic-schema', lease_epoch: '1'}), post: async (path, _contract, input) => ({state: path.endsWith('/finalize') ? (input.usage ? 'settled' : 'unknown') : path.endsWith('/send') ? 'issued' : 'reserved', send_allowed: path.endsWith('/send')})};
    const context = normalizeContext({tools: [definition, answer, search], messages: [{role: 'user', content: '登记合成任务', timestamp: 1}]});
    const stream = guardedModelStream(transport, profile, {api, apiKey: 'synthetic-only', baseUrl: model.baseUrl, protocolTest: true}, new AbortController().signal)(model, context);
    const result = await stream.result();
    assert.ok(['stop', 'toolUse'].includes(result.stopReason), JSON.stringify(result));
    const tool = provider.requests.at(-1).body.tools.find(tool => (tool.name ?? tool.function?.name) === 'update_analysis_task');
    if (api === 'anthropic-messages') {
      const projected = tool.input_schema;
      for (const name of ['action', 'conditions', 'condition_patch', 'task_id', 'expected_version']) assert.ok(projected.properties[name], `${name}必须进入实际Anthropic HTTP`);
      assert.deepEqual(projected.required, ['action']);
      for (const name of ['conditions', 'condition_patch', 'clarifications', 'resolved_clarification_ids']) {
        assert.equal(projected.properties[name].description, schema.$defs.AnalysisUpdateFields.properties[name].description);
      }
      const answerTool = provider.requests.at(-1).body.tools.find(tool => tool.name === answerName);
      assert.match(answerTool.description, /唯一小写name/);
      assert.match(answerTool.description, /observation_cutoff\/data_batch/);
      assert.match(answerTool.description, /同名角色用field_ref对齐/);
      assert.ok(JSON.stringify(projected).includes(schema.$defs.SourceKey.description), '独立工具须带来源键解释');
      const searchTool = provider.requests.at(-1).body.tools.find(tool => tool.name === 'search_knowledge');
      assert.ok(searchTool.input_schema.properties.source_selection, '非strict投影必须保留精确原文选择入口');
      assert.match(searchTool.description, /version取object_version/);
      assert.match(searchTool.description, /不扩许可/);
      assert.ok(!projected.required.includes('conditions'), 'create分支required不能提升为无条件required');
      assert.ok(!projected.required.includes('task_id'), 'route分支required不能提升为无条件required');
    } else {
      assert.deepEqual(tool.function.parameters, definition.parameters, 'OpenAI保留完整原约束，不追加重复字段树');
    }
    assert.equal(JSON.stringify(definition.parameters), original, '协议投影不能修改Node权威工具合同');
    checks.push({api, properties: Object.keys(tool.input_schema?.properties ?? {}), required: tool.input_schema?.required ?? []});
  }
  assert.deepEqual(provider.errors, []);
  console.log(JSON.stringify({passed: true, checks, officialRequests: 0, limitation: 'Anthropic非strict仍不表达根if/then组合约束；Node/Rust原Schema继续执行权威校验。'}));
} finally {
  await provider.close();
}
