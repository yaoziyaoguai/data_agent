import assert from 'node:assert/strict';
import {getCurrentTools, InMemoryModelsStore} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {createAgentSession, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {resources} from '../../apps/agent/session/resources.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';

const usage = {input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const model = {id: 'synthetic-upgrade', name: 'Synthetic upgrade', api: 'openai-completions', provider: 'synthetic_upgrade', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: usage.cost};
const assistant = (content, stopReason = 'stop', output = 10) => ({role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: {...usage, output}, timestamp: Date.now()});
const runtime = await ModelRuntime.create({credentials: {read: async () => undefined, list: async () => [], modify: async () => {}, delete: async () => {}}, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false});
let requests = [], executions = 0;
runtime.registerProvider(model.provider, {api: model.api, apiKey: 'synthetic-only', baseUrl: 'http://127.0.0.1:1', models: [model], streamSimple(selected, context, options) {
  const summary = getCurrentTools(context.messages).length === 0;
  const request = {summary, context: structuredClone(context)}; requests.push(request);
  return streamSimple(selected, context, {...options, apiKey: 'synthetic-only', maxRetries: 0, fetch: async (_url, init) => {
    request.payload = JSON.parse(init.body);
    const chunks = [{id: 'synthetic-lifecycle', choices: [{index: 0, delta: {role: 'assistant', content: summary ? '合成历史摘要：保持原任务与操作身份。' : '原生恢复后的正常回复。'}, finish_reason: 'stop'}]}, {choices: [], usage: {prompt_tokens: 100, completion_tokens: 10}}];
    return new Response(chunks.map(chunk => 'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  }});
}});
const definition = name => ({name, label: name, description: '合成恢复工具', parameters: Type.Object({}), execute: async () => {executions++; return {content: [{type: 'text', text: '合成工具完成'}]};}});
async function open(manager, definitions) {
  return (await createAgentSession({cwd: '/synthetic/upgrade', modelRuntime: runtime, model: runtime.getModel(model.provider, model.id), sessionManager: manager, thinkingLevel: 'off', settingsManager: SettingsManager.inMemory({defaultTools: [], compaction: {enabled: true, reserveTokens: 2048, keepRecentTokens: 64}, retry: {enabled: false}}), resourceLoader: resources(), customTools: definitions})).session;
}
const checks = [];

// 压缩边界前的工具增减仍决定loadout；从未登记的新工具按1.4注册语义开放。
{
  const manager = SessionManager.inMemory('/synthetic/upgrade');
  const [kept, removed, late, added] = ['synthetic_kept', 'synthetic_removed', 'synthetic_late', 'synthetic_new'].map(definition);
  manager.appendMessage({role: 'system', content: '', toolsAdded: [kept, removed, late].map(({name, description, parameters}) => ({name, description, parameters})), timestamp: 1});
  manager.appendMessage({role: 'user', content: '合成旧输入', timestamp: 1});
  manager.appendMessage(assistant([{type: 'text', text: '已记录旧工具。'}]));
  manager.appendMessage({role: 'system', content: '', toolsRemoved: [{name: removed.name}], timestamp: 2});
  const firstKept = manager.appendMessage({role: 'user', content: '压缩后的输入', timestamp: 3});
  manager.appendCompaction('合成loadout摘要', firstKept, 1000);
  const checkpoint = exportCheckpoint(manager);
  const first = await open(restoreCheckpoint('/synthetic/upgrade', checkpoint), [kept, removed, added]);
  try {assert.deepEqual(first.getActiveToolNames().sort(), [kept.name, added.name].sort());} finally {first.dispose();}
  const second = await open(restoreCheckpoint('/synthetic/upgrade', checkpoint), [kept, removed, late, added]);
  try {
    assert.deepEqual(second.getActiveToolNames().sort(), [kept.name, late.name, added.name].sort());
    requests = []; await second.prompt('恢复登记后才注册的工具。');
    assert.deepEqual(getCurrentTools(requests.find(request => !request.summary).context.messages).map(tool => tool.name).sort(), [kept.name, late.name, added.name].sort());
  } finally {second.dispose();}
  checks.push('压缩前loadout增减、明确移除、登记后注册及全新工具，首个出站请求保持1.4语义');
}

// 旧length半轮已经有成功回执时，原生恢复同时移除两端投影；原始条目与已执行事实保持。
for (const output of [100, 1024]) {
  requests = []; executions = 0;
  const manager = SessionManager.inMemory('/synthetic/upgrade');
  for (let index = 0; index < 6; index++) {
    manager.appendMessage({role: 'user', content: '合成旧背景'.repeat(200), timestamp: 1});
    manager.appendMessage(assistant([{type: 'text', text: '已记录合成背景。'}]));
  }
  const truncated = manager.appendMessage(assistant([{type: 'toolCall', id: 'synthetic-length-call', name: 'synthetic_effect', arguments: {}}], 'length', output));
  const result = manager.appendMessage({role: 'toolResult', toolCallId: 'synthetic-length-call', toolName: 'synthetic_effect', content: [{type: 'text', text: 'ALREADY_COMMITTED_SYNTHETIC_EFFECT'}], details: {operation_id: 'synthetic-original-operation', budget_scope_id: 'synthetic-original-budget'}, isError: false, timestamp: Date.now()});
  const checkpoint = exportCheckpoint(manager), restored = restoreCheckpoint('/synthetic/upgrade', checkpoint);
  const session = await open(restored, [definition('synthetic_effect')]);
  try {
    await session.prompt('接续合成原输入，不重复已成功工具。');
    assert.equal(executions, 0);
    assert.deepEqual(restored.getEntry(truncated), manager.getEntry(truncated));
    assert.deepEqual(restored.getEntry(result), manager.getEntry(result));
    const summaries = requests.filter(request => request.summary);
    if (output < model.maxTokens) {
      assert.ok(summaries.length > 0, '低于原始输出上限的length须走原生压缩恢复');
      for (const request of requests.filter(request => !request.summary)) {
        assert.ok(!JSON.stringify(request.payload).includes('ALREADY_COMMITTED_SYNTHETIC_EFFECT'), 'length助手被隐去时不能留下孤立toolResult');
        const calls = new Set(request.payload.messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id)));
        assert.ok(request.payload.messages.filter(message => message.role === 'tool').every(message => calls.has(message.tool_call_id)), '最终wire中每份toolResult仍有配对调用');
      }
      assert.ok(restored.getEntries().some(entry => entry.type === 'context_edit' && entry.targetId === result && entry.replacement === null));
    } else {
      assert.equal(summaries.length, 0, '达到原始输出上限的length不能冒称适用同一原生恢复修法');
    }
    checks.push({output, originalOutputLimit: model.maxTokens, summaries: summaries.length, requests: requests.length, reexecutedTools: executions});
  } finally {session.dispose();}
}
console.log(JSON.stringify({passed: true, checks, officialRequests: 0, provider: '真实Pi会话/恢复/原生OpenAI序列化，合成fetch SSE'}));
