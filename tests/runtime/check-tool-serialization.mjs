import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAssistantMessageEventStream, InMemoryModelsStore} from '@earendil-works/pi-ai';
import {createAgentSession, ModelRuntime, SessionManager, SettingsManager, VERSION} from '@earendil-works/pi-coding-agent';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {taskTool} from '../../apps/agent/tools/update-analysis-task.ts';
import {resources} from '../../apps/agent/session/resources.ts';

const checks = [];
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const calls = ['rows', 'statistics'].map(view => ({type: 'toolCall', id: 'read-' + view,
  name: 'get_query', arguments: {query_id: 'synthetic-query', view}}));
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkAttempts++; throw new Error('network forbidden in SDK scheduling check'); };

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout: ' + label)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function withSession(execute, run, {batch = calls, basic = false} = {}) {
  const manager = SessionManager.inMemory('/synthetic/tool-serialization');
  const transport = {run: {}, binding() { throw new Error('unexpected host transport'); },
    async post() { throw new Error('unexpected host transport'); }};
  // 仅替换边界的execute；真实名称、参数契约和executionMode经过SDK的customTools包装。
  const hostTools = basic ? [taskTool(transport, manager, '').definition] : dataTools(transport, manager, '').tools;
  const definitions = hostTools.map(definition => ({...definition,
    execute: async (id, args, signal) => execute(id, args, signal, definition.name),
  }));
  const runtime = await ModelRuntime.create({
    credentials: {read: async () => undefined, list: async () => [],
      modify: async () => { throw new Error('credentials disabled'); },
      delete: async () => { throw new Error('credentials disabled'); }},
    modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false,
  });
  let requests = 0;
  runtime.registerProvider('synthetic_tool_scheduling', {
    api: 'openai-completions', apiKey: 'synthetic-unused', baseUrl: 'http://127.0.0.1:1',
    streamSimple: model => {
      requests++;
      assert.ok(requests <= 2, 'single batch and final response only');
      const message = {role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: requests === 1 ? batch : [{type: 'text', text: '合成工具批次结束。'}],
        stopReason: requests === 1 ? 'toolUse' : 'stop', usage, timestamp: Date.now()};
      const stream = createAssistantMessageEventStream();
      stream.push({type: 'start', partial: message});
      stream.push({type: 'done', reason: message.stopReason, message});
      stream.end();
      return stream;
    },
    models: [{id: 'synthetic-reader', name: 'Synthetic reader', api: 'openai-completions',
      reasoning: false, input: ['text'], cost: usage.cost, contextWindow: 65536, maxTokens: 1024}],
  });
  const {session} = await createAgentSession({
    cwd: '/synthetic/tool-serialization', modelRuntime: runtime,
    model: runtime.getModel('synthetic_tool_scheduling', 'synthetic-reader'), thinkingLevel: 'off',
    settingsManager: SettingsManager.inMemory({defaultTools: [], compaction: {enabled: false}, retry: {enabled: false}}),
    sessionManager: manager, resourceLoader: resources(true),
    tools: definitions.map(definition => definition.name), customTools: definitions,
  });
  try { return await run(session, () => requests); }
  finally { try { await bounded(session.abort(), 'session cleanup'); } finally { session.dispose(); } }
}

async function check(name, test) {
  const evidence = {name, passed: false, events: []};
  try { await test(evidence); evidence.passed = true; }
  catch (error) { evidence.error = error.message; }
  checks.push(evidence);
}

try {
  await check('同批结果与统计读取沿调用顺序观察最新authority，无并发stale_context', async evidence => {
    let authority = 0, inFlight = 0, maxInFlight = 0;
    const rowsCommitted = Promise.withResolvers();
    await withSession(async (_id, args) => {
      const snapshot = authority;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      evidence.events.push({event: 'start', view: args.view, snapshot, inFlight});
      try {
        if (args.view === 'rows') {
          // 明确让出一个微任务：并行批次会在提交前进入statistics，无需依靠sleep碰运气。
          await Promise.resolve();
          authority++;
          evidence.events.push({event: 'commit', view: args.view, authority});
          rowsCommitted.resolve();
        } else {
          await bounded(rowsCommitted.promise, 'rows committed');
          if (snapshot !== authority) throw new Error('stale_context');
          evidence.events.push({event: 'read', view: args.view, authority});
        }
        return {content: [{type: 'text', text: JSON.stringify({view: args.view, authority})}]};
      } finally { inFlight--; evidence.events.push({event: 'end', view: args.view, inFlight}); }
    }, async (session, requests) => {
      await bounded(session.prompt('读取同一个合成查询的行和统计。'), 'two tool calls');
      evidence.requests = requests(); evidence.maxInFlight = maxInFlight;
      evidence.results = session.messages.filter(message => message.role === 'toolResult');
      assert.equal(evidence.requests, 2);
      assert.equal(evidence.results.length, 2);
      assert.ok(evidence.results.every(result => !result.isError), '工具结果不得包含stale_context或其他错误');
      assert.equal(maxInFlight, 1, '共享run authority的宿主工具不得同时执行');
      assert.deepEqual(evidence.events.filter(event => ['commit', 'read'].includes(event.event)).map(event => event.view), ['rows', 'statistics']);
      assert.deepEqual(evidence.results.map(result => result.toolCallId), ['read-rows', 'read-statistics']);
    });
  });

  await check('结果读取与任务写入混批时，写操作等待读取提交并且仅执行一次', async evidence => {
    let authority = 0, inFlight = 0, maxInFlight = 0, writeCalls = 0, writes = 0;
    const readCommitted = Promise.withResolvers();
    const batch = [calls[0], {type: 'toolCall', id: 'route-task', name: 'update_analysis_task',
      arguments: {action: 'route', task_id: 'synthetic-task', expected_version: '1', options: []}}];
    await withSession(async (_id, _args, _signal, name) => {
      const snapshot = authority;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      evidence.events.push({event: 'start', name, snapshot, inFlight});
      try {
        if (name === 'get_query') {
          await Promise.resolve(); authority++;
          evidence.events.push({event: 'commit', name, authority}); readCommitted.resolve();
        } else {
          assert.equal(name, 'update_analysis_task'); writeCalls++;
          await bounded(readCommitted.promise, 'read committed before write');
          if (snapshot !== authority) throw new Error('stale_context');
          writes++; evidence.events.push({event: 'commit', name, authority});
        }
        return {content: [{type: 'text', text: JSON.stringify({name, authority})}]};
      } finally { inFlight--; }
    }, async (session, requests) => {
      await bounded(session.prompt('读取合成结果，并登记到已有任务。'), 'mixed tool batch');
      evidence.requests = requests(); evidence.maxInFlight = maxInFlight;
      evidence.writeCalls = writeCalls; evidence.writes = writes;
      evidence.results = session.messages.filter(message => message.role === 'toolResult');
      assert.equal(evidence.results.length, 2);
      assert.ok(evidence.results.every(result => !result.isError), '读取成功后写操作不能因旧authority失败');
      assert.equal(maxInFlight, 1); assert.equal(writeCalls, 1); assert.equal(writes, 1);
      assert.deepEqual(evidence.events.filter(event => event.event === 'commit').map(event => event.name), ['get_query', 'update_analysis_task']);
      assert.equal(evidence.requests, 2);
    }, {batch});
  });

  await check('基础任务工具同批调用保持宿主提交顺序，每项仅执行一次', async evidence => {
    let inFlight = 0, maxInFlight = 0;
    const committed = [], invoked = [];
    const batch = ['first-task', 'second-task'].map(id => ({type: 'toolCall', id,
      name: 'update_analysis_task', arguments: {action: 'create_task', goal: id}}));
    await withSession(async (id, _args, _signal, name) => {
      assert.equal(name, 'update_analysis_task'); invoked.push(id);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      evidence.events.push({event: 'start', id, inFlight});
      try {
        if (id === 'first-task') await Promise.resolve();
        else assert.deepEqual(committed, ['first-task'], '第二项必须等第一项宿主提交');
        committed.push(id); evidence.events.push({event: 'commit', id});
        return {content: [{type: 'text', text: id}]};
      } finally { inFlight--; }
    }, async (session, requests) => {
      await bounded(session.prompt('依次建立两个合成任务。'), 'basic task tool batch');
      evidence.requests = requests(); evidence.maxInFlight = maxInFlight;
      evidence.invoked = invoked; evidence.committed = committed;
      evidence.results = session.messages.filter(message => message.role === 'toolResult');
      assert.equal(evidence.results.length, 2);
      assert.ok(evidence.results.every(result => !result.isError));
      assert.deepEqual(invoked, ['first-task', 'second-task']);
      assert.deepEqual(committed, ['first-task', 'second-task']);
      assert.equal(maxInFlight, 1); assert.equal(evidence.requests, 2);
    }, {batch, basic: true});
  });

  await check('取消正在执行的首个工具后，同批后续工具不进入、不提交', async evidence => {
    const firstStarted = Promise.withResolvers();
    let aborted = false, commits = 0;
    await withSession(async (_id, args, signal) => {
      evidence.events.push({event: 'start', view: args.view});
      if (args.view !== 'rows') { commits++; throw new Error('queued tool entered before first finished'); }
      assert.ok(signal);
      firstStarted.resolve();
      await new Promise((_, reject) => {
        const abort = () => { aborted = true; evidence.events.push({event: 'abort', view: args.view}); reject(new Error('Operation aborted')); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true});
      });
      throw new Error('cancelled tool must not continue');
    }, async (session, requests) => {
      const prompt = session.prompt('读取合成结果后立刻取消。');
      await bounded(firstStarted.promise, 'first tool started');
      await bounded(session.abort(), 'native session abort');
      await bounded(prompt, 'cancelled prompt settled');
      evidence.requests = requests(); evidence.commits = commits; evidence.aborted = aborted;
      evidence.results = session.messages.filter(message => message.role === 'toolResult');
      assert.equal(aborted, true);
      assert.equal(commits, 0);
      assert.deepEqual(evidence.events.filter(event => event.event === 'start').map(event => event.view), ['rows']);
      assert.equal(evidence.requests, 1, '取消不新增模型响应');
      assert.ok(evidence.results.some(result => result.toolCallId === 'read-rows' && result.isError));
    });
  });
} finally { globalThis.fetch = originalFetch; }

const sourceHashes = {};
for (const path of ['tests/runtime/check-tool-serialization.mjs', 'apps/agent/tools/data-tools.ts', 'apps/agent/tools/update-analysis-task.ts'])
  sourceHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
const passed = checks.every(check => check.passed) && networkAttempts === 0;
await mkdir('.local/checks', {recursive: true});
await writeFile('.local/checks/tool-serialization.json', JSON.stringify({passed, piSdk: VERSION,
  provider: 'real createAgentSession/customTools, controlled in-memory stream and tool boundary',
  officialRequests: 0, networkAttempts, sourceHashes, checks}, null, 2) + '\n');
console.log(JSON.stringify({passed, checks, officialRequests: 0, networkAttempts}));
assert.ok(passed, '宿主工具串行与取消行为检查未全部通过');
