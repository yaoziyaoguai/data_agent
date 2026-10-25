import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {appendFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryModelsStore} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {createAgentSession, ModelRuntime, SessionManager, SettingsManager, VERSION} from '@earendil-works/pi-coding-agent';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {resources} from '../../apps/agent/session/resources.ts';
import {outputStream} from '../../apps/agent/session/output-stream.ts';

// 只核对现有SDK事件、完整消息和输出队列接入；不实现答案定稿或提前增加route参数。
const checks = [], providerErrors = [];
let current, externalRequests = 0, requests = 0;
const route = {id: 'synthetic-route', name: 'update_analysis_task', arguments: {
  action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: [],
}};
const read = {id: 'synthetic-read', name: 'read_analysis_task', arguments: {task_id: 'synthetic-task'}};
const answer = '合成语义说明：首次返回与最终完成属于不同观察边界。🪴\n'.repeat(110);
const finalAnswer = '合成后续任务已完成。';
const server = createServer(async (request, response) => {
  try {
    assert.ok(current);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    assert.equal(request.url, '/v1/chat/completions');
    requests++;
    current.requests++;
    assert.ok(current.requests <= 2, '探针只允许工具响应与最终响应各一次');
    const first = current.requests === 1;
    const text = first ? answer : finalAnswer;
    const calls = first ? current.calls : [];
    response.writeHead(200, {'content-type': 'text/event-stream'});
    const emit = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({
      id: 'synthetic-sdk-order', object: 'chat.completion.chunk', created: 1, model: payload.model,
      choices: [{index: 0, delta, finish_reason}],
    }) + '\n\n');
    emit({role: 'assistant'});
    // 独立增量经过真实OpenAI协议解析，涵盖Unicode和跨2048字符的输出分片。
    for (let offset = 0; offset < text.length; offset += 71) emit({content: text.slice(offset, offset + 71)});
    if (calls.length) emit({tool_calls: calls.map((call, index) => ({index, id: call.id, type: 'function',
      function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))});
    emit({}, first ? current.finishReason : 'stop');
    response.write('data: ' + JSON.stringify({id: 'synthetic-sdk-order', choices: [],
      usage: {prompt_tokens: 100, completion_tokens: 1500, total_tokens: 1600}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerErrors.push(error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
const directory = await mkdtemp(join(tmpdir(), 'data-agent-sdk-order-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href !== baseUrl + '/chat/completions') {
    externalRequests++;
    throw new Error('探针禁止调用非本地协议端点');
  }
  return originalFetch(input, init);
};

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout: ' + label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function probe(name, {calls = [route], finishReason = 'tool_calls', failWrite = false} = {}) {
  const evidence = {name, passed: false, requests: 0, events: [], routeCalls: 0};
  current = {...evidence, calls, finishReason};
  const state = current;
  const path = join(directory, String(checks.length) + '.jsonl');
  await writeFile(path, '');
  const releaseWrite = Promise.withResolvers();
  const manager = SessionManager.inMemory('/synthetic/sdk-event-order');
  let completed, messageStart = 1, messageIndex = -1;
  const record = (event, details = {}) => state.events.push({event, ...details});
  const output = outputStream(async (sequence, text) => {
    record('write_start', {sequence});
    await releaseWrite.promise;
    if (failWrite) throw new Error('synthetic_output_receipt_lost');
    await appendFile(path, JSON.stringify({sequence, text}) + '\n');
    record('write_committed', {sequence});
  });
  const persisted = async () => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const transport = {run: {}, binding() {throw new Error('unexpected host binding');},
    async post() {throw new Error('unexpected host request');}};
  const definitions = dataTools(transport, manager, '').tools
    .filter(tool => ['update_analysis_task', 'read_analysis_task'].includes(tool.name))
    .map(tool => ({...tool, execute: async (sdkId, args) => {
      record('execute', {name: tool.name, sdkId});
      assert.ok(completed, '工具执行前必须收到完整assistant message_end');
      const entry = manager.getBranch().findLast(entry => entry.type === 'message'
        && entry.message.role === 'assistant' && entry.message.content.some(part => part.type === 'toolCall' && part.id === sdkId));
      assert.ok(entry, '工具边界能从SDK journal找到本调用所属的完整助手条目');
      assert.deepEqual(entry.message, completed);
      const text = completed.content.filter(part => part.type === 'text').map(part => part.text).join('');
      assert.equal(text, answer);
      assert.equal(completed.stopReason, 'toolUse');
      if (tool.name === 'update_analysis_task') {
        state.routeCalls++;
        assert.equal(args.action, 'route');
        const siblings = completed.content.filter(part => part.type === 'toolCall');
        state.routeMessage = {entryId: entry.id, stopReason: completed.stopReason, siblings: siblings.map(part => part.name),
          start: messageStart, textLength: text.length, beforeDrainCount: (await persisted()).length};
        assert.equal(state.routeMessage.beforeDrainCount, 0, 'message_end本身不能证明异步写入已经持久化');
        let settled = false;
        const draining = output.drain().then(() => {settled = true; record('drain_resolved');});
        // 用显式闸门证明drain等候存储确认，避免以sleep时长猜测顺序。
        await Promise.resolve(); await Promise.resolve();
        assert.equal(settled, false);
        record('write_released'); releaseWrite.resolve();
        if (failWrite) {
          await assert.rejects(draining, /synthetic_output_receipt_lost/);
          record('drain_rejected');
          assert.equal((await persisted()).length, 0);
          throw new Error('synthetic_output_receipt_lost');
        }
        await draining;
        const chunks = await persisted();
        const own = chunks.filter(chunk => Number(chunk.sequence) >= messageStart);
        assert.equal(own.map(chunk => chunk.text).join(''), text);
        assert.ok(own.length >= 2, '完整正文必须覆盖多个真实outputStream片段');
        state.routeMessage.end = Number(own.at(-1).sequence);
        assert.deepEqual(own.map(chunk => Number(chunk.sequence)), Array.from({length: own.length}, (_, index) => messageStart + index));
        record('route_boundary_ready', {entryId: entry.id});
      }
      return {content: [{type: 'text', text: JSON.stringify({synthetic: true, action: args.action ?? 'read'})}]};
    }}));
  const runtime = await ModelRuntime.create({
    credentials: {read: async () => undefined, list: async () => [], modify: async () => {throw new Error('disabled');},
      delete: async () => {throw new Error('disabled');}},
    modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false,
  });
  runtime.registerProvider('synthetic_event_order', {
    api: 'openai-completions', apiKey: 'synthetic-only', baseUrl,
    streamSimple: (model, context, options) => streamSimple(model, context, {...options, apiKey: 'synthetic-only', maxRetries: 0}),
    models: [{id: 'synthetic-event-order', name: 'Synthetic event order', api: 'openai-completions',
      reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 4096,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
  });
  const {session} = await createAgentSession({cwd: '/synthetic/sdk-event-order', modelRuntime: runtime,
    model: runtime.getModel('synthetic_event_order', 'synthetic-event-order'), thinkingLevel: 'off',
    settingsManager: SettingsManager.inMemory({defaultTools: [], compaction: {enabled: false}, retry: {enabled: false}}),
    sessionManager: manager, resourceLoader: resources(true), tools: definitions.map(tool => tool.name), customTools: definitions});
  session.subscribe(event => {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      messageIndex++; messageStart = output.startMessage(); record('assistant_start', {messageIndex, messageStart});
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') output.append(event.assistantMessageEvent.delta);
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      completed = event.message; record('assistant_end', {messageIndex, stopReason: event.message.stopReason});
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') record(event.type, {sdkId: event.toolCallId});
  });
  try {
    await bounded(session.prompt('解释合成语义，再继续下一任务。'), name);
    releaseWrite.resolve();
    if (failWrite) {
      await assert.rejects(output.drain(), /synthetic_output_receipt_lost/);
      assert.equal(session.messages.find(message => message.role === 'toolResult' && message.toolCallId === route.id)?.isError, true);
      assert.equal(state.events.some(item => item.event === 'route_boundary_ready'), false);
    } else {
      await bounded(output.drain(), 'output queue');
      assert.equal((await persisted()).map(chunk => chunk.text).join(''), answer + finalAnswer);
    }
    if (finishReason === 'length') {
      assert.equal(state.routeCalls, 0, '被截断的助手工具调用不能执行');
      assert.equal(state.events.find(item => item.event === 'assistant_end').stopReason, 'length');
      assert.equal(session.messages.find(message => message.role === 'toolResult' && message.toolCallId === route.id)?.isError, true);
    } else {
      assert.equal(state.routeCalls, 1);
      assert.deepEqual(state.routeMessage.siblings, calls.map(call => call.name));
      const end = state.events.findIndex(item => item.event === 'assistant_end');
      const tool = state.events.findIndex(item => item.event === 'tool_execution_start');
      const execute = state.events.findIndex(item => item.event === 'execute');
      assert.ok(end >= 0 && tool > end && execute > tool, '完整message_end先于工具开始与execute');
    }
    assert.equal(state.requests, 2);
    state.passed = true;
  } catch (error) {state.error = error.message;}
  finally {
    releaseWrite.resolve(); await output.close(); await session.abort(); session.dispose();
    const {calls: _calls, finishReason: _finishReason, ...result} = state;
    checks.push(result);
  }
}

try {
  await probe('完整助手条目先于单独route执行；drain等待持久确认并给出连续、完整的输出片段范围');
  await probe('混批工具在route边界仍可识别同一助手消息全部调用，不能误判为单独控制调用', {calls: [read, route]});
  await probe('length结束的助手消息保持截断标记，Pi不执行其route调用', {finishReason: 'length'});
  await probe('输出回执失败时drain拒绝、route工具返回错误，不形成可用正文范围', {failWrite: true});
} finally {
  globalThis.fetch = originalFetch;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, {recursive: true, force: true});
}
const sourceHashes = {};
for (const path of ['tests/runtime/check-sdk-event-order.mjs', 'apps/agent/session/output-stream.ts', 'apps/agent/tools/data-tools.ts'])
  sourceHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
const passed = checks.every(check => check.passed) && providerErrors.length === 0 && externalRequests === 0;
const report = {passed, piSdk: VERSION, requests, externalRequests, officialRequests: 0, sourceHashes, checks, providerErrors,
  limits: ['真实Pi SDK和本地HTTP协议；输出持久边界使用临时文件适配器，无MySQL。',
    '只证明后续定稿能绑定SDK条目并等待原输出队列；未实现finalize_current_answer或证明Rust业务提交。']};
await mkdir('.local/checks', {recursive: true});
await writeFile('.local/checks/sdk-event-order.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
assert.ok(passed, 'SDK事件与输出边界检查未全部通过');
