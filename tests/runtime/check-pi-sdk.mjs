import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {findPackageJSON} from 'node:module';
import {Agent} from '@earendil-works/pi-agent-core';
import {normalizeContext} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {serializeConversation, VERSION} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';

const checks = [];
async function check(name, run) {
  try {
    await run();
    checks.push({name, passed: true});
  } catch (error) {
    checks.push({name, passed: false, error: error.message});
  }
}
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const model = {id: 'deepseek-flash', name: 'Synthetic Flash', api: 'openai-completions',
  provider: 'controlled_deepseek', baseUrl: 'http://127.0.0.1:1', reasoning: true,
  input: ['text'], cost: usage.cost, contextWindow: 32768, maxTokens: 1024,
  compat: {thinkingFormat: 'deepseek', supportsStrictMode: false}};
const assistant = content => ({role: 'assistant', content, api: model.api,
  provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: 1});
const user = {role: 'user', content: '合成订单，金额为分，排除测试订单。', timestamp: 1};
const thinking = 'synthetic-private-reasoning-marker';
const history = [user, assistant([{type: 'thinking', thinking: thinking.repeat(300), thinkingSignature: 'reasoning_content'},
  {type: 'text', text: '合成净收入为7000分。'},
  {type: 'toolCall', id: 'synthetic-read', name: 'get_query', arguments: {query_id: 'synthetic-query'}}]),
{role: 'toolResult', toolCallId: 'synthetic-read', toolName: 'get_query',
  content: [{type: 'text', text: '合成查询已完成：7000分。'}], isError: false, timestamp: 1}];
function response(delta, finishReason = 'stop') {
  const chunks = [
    {id: 'synthetic-sdk', choices: [{index: 0, delta, finish_reason: finishReason}]},
    {id: 'synthetic-sdk', choices: [], usage: {prompt_tokens: 20, completion_tokens: 10}},
  ];
  return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
    {headers: {'content-type': 'text/event-stream'}});
}

await check('Pi直接包及SDK内部依赖同版精确锁定', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const versionAt = async entry => JSON.parse(await readFile(new URL('../package.json', entry))).version;
  for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) {
    const packageName = '@earendil-works/' + name;
    assert.equal(manifest.dependencies[packageName], VERSION);
    assert.equal(await versionAt(import.meta.resolve(packageName)), VERSION);
  }
  for (const [parent, dependency] of [['pi-agent-core', 'pi-ai'], ['pi-coding-agent', 'pi-ai'], ['pi-coding-agent', 'pi-agent-core']]) {
    const location = findPackageJSON('@earendil-works/' + dependency, import.meta.resolve('@earendil-works/' + parent));
    assert.equal(JSON.parse(await readFile(location)).version, VERSION);
  }
});

await check('摘要省去思考块且保留用户条件、正文、工具身份及结果', () => {
  const summary = serializeConversation(history);
  assert.ok(!summary.includes(thinking), '摘要不应重复思考内容');
  for (const required of ['金额为分', '排除测试订单', '7000分', 'get_query', 'synthetic-query'])
    assert.ok(summary.includes(required), required);
});

await check('切换模型后实际请求不把旧思考转为正文，同模型思考仍可续接', async () => {
  for (const target of [model, {...model, id: 'deepseek-pro'}]) {
    let payload;
    const stream = streamSimple(target, normalizeContext({messages: history}), {
      apiKey: 'synthetic-unused', maxRetries: 0,
      fetch: async (_input, init) => {
        payload = JSON.parse(init.body);
        return response({role: 'assistant', content: '合成回复。'});
      },
    });
    assert.equal((await stream.result()).stopReason, 'stop');
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(thinking), target.id === model.id);
    for (const required of ['7000分', 'get_query', 'synthetic-query'])
      assert.ok(serialized.includes(required), required);
  }
});

await check('完整响应中的残缺JSON不执行部分参数，模型修正后才执行一次', async () => {
  const invoked = [];
  let requests = 0;
  const agent = new Agent({
    initialState: {model, systemPrompt: '仅使用合成测试工具。', tools: [{
      name: 'synthetic_save', description: '保存一项合成值。',
      parameters: Type.Object({value: Type.String()}),
      execute: async (_id, args) => {
        invoked.push(args.value);
        return {content: [{type: 'text', text: '合成值已保存。'}]};
      },
    }]},
    streamFn: (selected, context, options) => streamSimple(selected, context, {
      ...options, apiKey: 'synthetic-unused', maxRetries: 0,
      fetch: async () => {
        requests++;
        assert.ok(requests <= 3, '合成修正流程必须有界');
        if (requests === 3) return response({role: 'assistant', content: '修正后保存完成。'});
        const args = requests === 1 ? '{"value":"不完整的值","missing":' : '{"value":"完整合成参数"}';
        return response({role: 'assistant', tool_calls: [{index: 0,
          id: requests === 1 ? 'synthetic-invalid' : 'synthetic-corrected', type: 'function',
          function: {name: 'synthetic_save', arguments: args}}]}, 'tool_calls');
      },
    }),
  });
  await agent.prompt('保存一项合成值。');
  assert.deepEqual(invoked, ['完整合成参数']);
  const invalid = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'synthetic-invalid');
  assert.equal(invalid.isError, true);
  assert.ok(JSON.stringify(invalid.content).includes('missing'), '错误须让模型看到残缺原参数以便修正');
  assert.equal(requests, 3);
});

await check('旧1.0.0检查点保留session/leaf/工具身份、原生摘要及未确认分支', async () => {
  const checkpoint = JSON.parse(await readFile(new URL('./fixtures/pi-session-1.0.0.json', import.meta.url)));
  assert.equal(checkpoint.sdk_version, '1.0.0');
  const restored = restoreCheckpoint('/synthetic/data-agent', checkpoint);
  assert.equal(restored.getSessionId(), checkpoint.entries[0].id);
  assert.equal(restored.getLeafId(), checkpoint.leaf_id);
  for (const entry of checkpoint.entries.slice(1))
    assert.deepEqual(restored.getEntry(entry.id), entry);
  const context = JSON.stringify(restored.buildSessionContext());
  assert.ok(context.includes('SQL草稿未执行'));
  assert.ok(context.includes('2026年一月'));
  assert.ok(!context.includes('未由宿主确认的合成尾部分支'));
  assert.ok(!context.includes('沿原会话继续，仍不执行。'));
  const tool = restored.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
    entry.message.content.some(part => part.type === 'toolCall')).message.content.find(part => part.type === 'toolCall');
  assert.equal(tool.id, 'synthetic-legacy-propose');
  assert.equal(tool.arguments.sql, 'SELECT 7000 AS net_revenue_cents');
  const next = restored.appendMessage({role: 'user', content: '沿原会话继续，仍不执行。', timestamp: 2});
  const exported = exportCheckpoint(restored);
  assert.equal(exported.sdk_version, VERSION);
  assert.equal(exported.leaf_id, next);
  assert.equal(exported.storage.session_id, checkpoint.entries[0].id);
});

const passed = checks.every(item => item.passed);
await mkdir('.local/checks', {recursive: true});
await writeFile('.local/checks/pi-sdk.json', JSON.stringify({passed, piSdk: VERSION,
  provider: 'SDK in-memory and synthetic fetch only', officialRequests: 0, checks}, null, 2) + '\n');
console.log(JSON.stringify({passed, piSdk: VERSION, checks, officialRequests: 0}));
assert.ok(passed, 'Pi SDK行为检查未全部通过');
