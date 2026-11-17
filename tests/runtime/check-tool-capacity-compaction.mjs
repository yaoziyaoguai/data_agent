import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
import {InMemoryModelsStore, getCurrentTools} from '@earendil-works/pi-ai';
import {createAgentSession, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {guardedModelStream} from '../../apps/agent/provider/controlled.ts';
import {resources} from '../../apps/agent/session/resources.ts';
import {toolResponseCapacity} from '../../apps/agent/session/capacity.ts';

const requests = [], errors = [], checks = [];
let scenario;
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const summary = !input.tools?.length;
    requests.push({scenario, summary});
    if (scenario === 'summary_failed' && summary) {
      response.writeHead(503, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_summary_failed', type: 'server_error'}}));
      return;
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    const delta = {role: 'assistant', content: summary ? '合成历史压缩：保持原任务与工具身份。' : '合成容量恢复后已完成。'};
    response.write('data: ' + JSON.stringify({id: 'synthetic-capacity-compaction', choices: [{index: 0, delta, finish_reason: 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 500, completion_tokens: 30, total_tokens: 530}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {errors.push(error.message); response.writeHead(500).end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', input_limit: 65536, output_limit: 2048,
  payload_bytes_limit: 131072, toolset: 'data', thinking_level: 'off'};
const tool = {name: 'read_source', label: '合成原文', description: '合成原文补读', parameters: {type: 'object', properties: {}},
  execute: async () => {throw new Error('不得重做已完成的原读取');}};
const usage = {input: 500, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 530,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
function assistant(text, content) {
  return {role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
    content: content ?? [{type: 'text', text}], usage, stopReason: content ? 'toolUse' : 'stop', timestamp: Date.now() - 10000};
}
async function probe(name) {
  scenario = name;
  const manager = SessionManager.inMemory('/synthetic/tool-capacity-compaction');
  for (let index = 0; index < 10; index++) {
    manager.appendMessage({role: 'user', content: '合成旧任务' + index + '。'.repeat(1000), timestamp: Date.now() - 20000});
    manager.appendMessage(assistant('合成旧结论🧪。'.repeat(180)));
  }
  manager.appendMessage({role: 'user', content: '继续原合成调查', timestamp: Date.now() - 10000});
  manager.appendMessage(assistant('', [{type: 'toolCall', id: 'capacity-restored', name: 'read_source', arguments: {}}]));
  manager.appendMessage({role: 'toolResult', toolCallId: 'capacity-restored', toolName: 'read_source', isError: true,
    content: [{type: 'text', text: JSON.stringify({error: 'tool_response_capacity'})}], timestamp: Date.now() - 9000});
  let session;
  const capacity = toolResponseCapacity(profile, manager, () => ({systemPrompt: session?.systemPrompt ?? '', tools: [tool], references: [], usageTokens: session?.getContextUsage()?.tokens}));
  const posts = [], events = [];
  const transport = {run: {}, binding: () => ({run_id: 'synthetic', lease_epoch: '1'}),
    async post(path, _contract, input) {
      posts.push({path, input});
      return {state: path.endsWith('/finalize') ? (input.usage ? 'settled' : 'unknown') : path.endsWith('/send') ? 'issued' : 'reserved', send_allowed: path.endsWith('/send')};
    }};
  const runtime = await ModelRuntime.create({credentials: {read: async () => undefined, list: async () => [],
    modify: async () => {throw new Error('disabled');}, delete: async () => {throw new Error('disabled');}},
    modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false});
  runtime.registerProvider('deepseek', {api: 'openai-completions', apiKey: 'synthetic-only', baseUrl,
    streamSimple: guardedModelStream(transport, profile, {api: 'openai-completions', apiKey: 'synthetic-only', baseUrl, protocolTest: true},
      new AbortController().signal, context => capacity.check(getCurrentTools(context.messages).length > 0)),
    models: [{id: 'deepseek-flash', name: 'Synthetic capacity compaction', api: 'openai-completions', reasoning: false, input: ['text'],
      contextWindow: 65536, maxTokens: 2048, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]});
  ({session} = await createAgentSession({cwd: '/synthetic/tool-capacity-compaction', modelRuntime: runtime,
    model: runtime.getModel('deepseek', 'deepseek-flash'), thinkingLevel: 'off', sessionManager: manager,
    settingsManager: SettingsManager.inMemory({defaultTools: [], compaction: {enabled: true, reserveTokens: 2048, keepRecentTokens: 512}, retry: {enabled: false}}),
    resourceLoader: resources(true, [], [capacity.extension]), customTools: [tool], tools: [tool.name]}));
  session.subscribe(event => events.push({type: event.type, reason: event.reason, error: event.errorMessage}));
  try {
    await session.prompt('沿原输入继续。');
    const actual = requests.filter(request => request.scenario === name);
    assert.ok(actual.some(request => request.summary), '恢复的容量错误必须进入真实Pi摘要');
    if (name === 'success') {
      assert.equal(actual.filter(request => !request.summary).length, 1);
      assert.ok(events.some(event => event.type === 'compaction_end' && event.reason === 'overflow' && !event.error));
      assert.equal(session.messages.at(-1).content[0].text, '合成容量恢复后已完成。');
      assert.doesNotThrow(() => capacity.check(true));
      checks.push('恢复容量错误在许可前触发Pi原生overflow，真实摘要成功后沿原会话续答');
    } else {
      assert.equal(actual.some(request => !request.summary), false, '摘要失败后不能发送未压缩普通请求');
      assert.throws(() => capacity.check(true), /request_too_large: model_input_limit/);
      assert.ok(events.some(event => event.type === 'compaction_end' && event.error));
      checks.push('真实摘要503失败保留待压缩状态，不发普通请求或重做业务');
    }
    assert.equal(posts.filter(post => post.path.endsWith('/send')).length, actual.length,
      '被容量挡下的普通请求不领取发送许可');
    assert.equal(manager.getSessionId(), session.sessionId);
  } finally {session.dispose();}
}
let passed = false;
try {
  await probe('success');
  await probe('summary_failed');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const report = {passed, checks, requests, errors, officialRequests: 0,
    boundary: '真实Pi原生压缩与受控provider、本地HTTP；模型许可由测试接缝提供，无MySQL或真实分词证明'};
  await mkdir('.local/checks', {recursive: true});
  await writeFile('.local/checks/tool-capacity-compaction.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
