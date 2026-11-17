import assert from 'node:assert/strict';
import {SessionManager, buildSessionProjection, convertToLlm} from '@earendil-works/pi-coding-agent';
import {workspaceContext} from '../../apps/agent/session/workspace-context.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';

// 控制确认的上下文编辑边界：只在成功结束、无待执行工具且目标确属本轮时替换本轮正文；
// 失败/取消/本轮没有正文时不得回扫改写旧轮答案，成功控制交付仍可编辑并跨检查点生效。
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const control = {text: '本轮控制状态：\n任务「合成任务」：1 条 SQL 已提交，已加入队列。',
  task_refs: [{task_id: 'synthetic-task', condition_version: '1'}],
  facts: [{kind: 'query', task_id: 'synthetic-task', condition_version: '1', query_id: 'synthetic-query',
    execution_state: 'queued', confirmation_state: 'confirmed'}],
  fingerprint: 'synthetic-control-fingerprint'};
const makeWorkspace = () => ({tasks: [], recent_messages: [], selected_skills: [], memories: [],
  query_observations: [], input_task_ids: [], request_clock: {reference_time_utc: '2026-10-31T00:00:00Z', business_timezone: 'Asia/Shanghai'},
  authority_revision: 'synthetic', authority_snapshot: {}, control_delivery: control});
const oldAnswer = '上一轮的正式分析答案：订单金额按结算日聚合。';
const unverifiedBody = '模型本轮未核验的草稿正文，不得进入正式历史。';
const toolCallId = 'control-round-tool';

const settleEvent = (manager, outcome, pending = []) => {
  const projection = buildSessionProjection(manager.getBranch());
  return {type: 'agent_before_settle', entries: [], continue: false,
    context: {contextEntries: projection.entries, contextMessages: projection.messages,
      llmMessages: [], pendingMessages: pending, canContinue: true},
    outcome};
};
const entryId = (manager, index) => manager.getBranch().filter(entry => entry.type === 'message')[index].id;
// 逐消息取文本，不依赖JSON转义形态。
const bodyText = messages => messages.map(message =>
  typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('')
    : '').join('\n');

// 场景一：旧轮有正文，本轮只有工具调用。三种 outcome 都不得返回指向旧轮正文的 context_edit。
{
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  manager.appendMessage({role: 'user', content: '上一轮问题', timestamp: 1});
  manager.appendMessage({role: 'assistant', content: [{type: 'text', text: oldAnswer}], api: 'openai-completions',
    provider: 'local_mock', model: 'task_demo', stopReason: 'stop', usage, timestamp: 2});
  manager.appendMessage({role: 'user', content: '本轮只确认查询状态', timestamp: 3});
  manager.appendMessage({role: 'assistant', content: [{type: 'toolCall', id: toolCallId, name: 'request_query',
    arguments: {task_id: 'synthetic-task'}}], api: 'openai-completions', provider: 'local_mock', model: 'task_demo',
    stopReason: 'toolUse', usage, timestamp: 4});
  manager.appendMessage({role: 'toolResult', toolCallId, toolName: 'request_query',
    content: [{type: 'text', text: JSON.stringify(control)}], isError: false, timestamp: 5});
  const start = manager.getBranch().findLastIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  const projection = workspaceContext(makeWorkspace(), {previousEntryIds: new Set(manager.getBranch().slice(0, start).map(entry => entry.id)), selectText: () => control.text});
  for (const outcome of ['error', 'aborted', 'completed']) {
    const edit = await projection.extension.handlers.get('agent_before_settle')[0](settleEvent(manager, outcome));
    assert.ok(!edit?.entries.some(entry => entry.type === 'context_edit'), `${outcome} 结束且本轮无正文时不得回扫编辑旧轮答案`);
    if (outcome !== 'completed') assert.equal(edit, undefined);
  }
  // 检查点恢复与下一轮输入都保留旧正文，控制短句不冒充旧答案。
  const restored = restoreCheckpoint('/synthetic/data-agent', exportCheckpoint(manager));
  assert.ok(bodyText(restored.buildSessionContext().messages).includes(oldAnswer), '旧轮答案必须原样保留在会话记录');
  const nextRound = await projection.extension.handlers.get('context')[0](
    {messages: [...restored.buildSessionContext().messages, {role: 'user', content: '继续下一个问题', timestamp: 6}]});
  const nextInput = bodyText(convertToLlm(nextRound.messages));
  assert.ok(nextInput.includes(oldAnswer), '下一轮输入仍能看到旧轮答案原文');
  assert.ok(!nextInput.includes(control.text), '控制短句不得替换旧答案进入下一轮输入');
}

// 场景二：成功结束但仍有待执行工具时不得编辑本轮正文。
{
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  manager.appendMessage({role: 'user', content: '本轮确认状态并留有未完成工具', timestamp: 1});
  manager.appendMessage({role: 'assistant', content: [{type: 'text', text: unverifiedBody}], api: 'openai-completions',
    provider: 'local_mock', model: 'task_demo', stopReason: 'stop', usage, timestamp: 2});
  const start = manager.getBranch().findLastIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  const projection = workspaceContext(makeWorkspace(), {previousEntryIds: new Set(manager.getBranch().slice(0, start).map(entry => entry.id)), selectText: () => control.text});
  const edit = await projection.extension.handlers.get('agent_before_settle')[0](
    settleEvent(manager, 'completed', [{role: 'toolResult', toolCallId: 'unsettled', toolName: 'request_query',
      content: [{type: 'text', text: '{}'}], isError: false, timestamp: 3}]));
  assert.equal(edit, undefined, '仍有待执行工具时不得替换本轮正文');
}

// 场景三：成功结束、无待执行工具且本轮有正文——控制交付正常替换本轮正文并跨检查点生效。
{
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  manager.appendMessage({role: 'user', content: '上一轮问题', timestamp: 1});
  manager.appendMessage({role: 'assistant', content: [{type: 'text', text: oldAnswer}], api: 'openai-completions',
    provider: 'local_mock', model: 'task_demo', stopReason: 'stop', usage, timestamp: 2});
  manager.appendMessage({role: 'user', content: '本轮确认查询状态', timestamp: 3});
  manager.appendMessage({role: 'assistant', content: [{type: 'text', text: unverifiedBody}], api: 'openai-completions',
    provider: 'local_mock', model: 'task_demo', stopReason: 'stop', usage, timestamp: 4});
  const thisRoundId = entryId(manager, 3);
  const start = manager.getBranch().findLastIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  const projection = workspaceContext(makeWorkspace(), {previousEntryIds: new Set(manager.getBranch().slice(0, start).map(entry => entry.id)), selectText: () => control.text});
  const edit = await projection.extension.handlers.get('agent_before_settle')[0](settleEvent(manager, 'completed'));
  assert.ok(edit.entries.some(entry => entry.type === 'context_edit' && entry.targetId === thisRoundId),
    '成功控制交付应编辑本轮正文');
  for (const entry of edit.entries)
    if (entry.type === 'context_edit') manager.appendContextEdit(entry.targetId, entry.replacement);
  const restored = restoreCheckpoint('/synthetic/data-agent', exportCheckpoint(manager));
  const history = bodyText(restored.buildSessionContext().messages);
  assert.ok(history.includes(control.text), '控制正文进入会话历史');
  assert.ok(!history.includes(unverifiedBody), '未核验正文不得留在会话历史');
  assert.ok(history.includes(oldAnswer), '旧轮答案不受本轮控制编辑影响');
  const nextRound = await projection.extension.handlers.get('context')[0](
    {messages: [...restored.buildSessionContext().messages, {role: 'user', content: '继续下一个问题', timestamp: 6}]});
  const nextInput = bodyText(convertToLlm(nextRound.messages));
  assert.ok(nextInput.includes(control.text), '下一轮输入看到控制正文而非未核验草稿');
  assert.ok(nextInput.includes(oldAnswer), '下一轮输入保留旧轮答案原文');
}

// 压缩保留本轮assistant却移出user，仍用原条目归属替换；不能把缺user当作本轮无正文。
{
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  manager.appendMessage({role: 'user', content: '本轮确认查询', timestamp: 1});
  const target = manager.appendMessage({role: 'assistant', content: [{type: 'text', text: unverifiedBody}],
    api: 'openai-completions', provider: 'local_mock', model: 'task_demo', stopReason: 'stop', usage, timestamp: 2});
  manager.appendCompaction('合成确认输入摘要。', target, 1000);
  const projection = workspaceContext(makeWorkspace(), {previousEntryIds: new Set(), selectText: () => control.text});
  assert.deepEqual(manager.buildSessionContext().messages.map(message => message.role), ['compactionSummary', 'assistant']);
  const edit = await projection.extension.handlers.get('agent_before_settle')[0](settleEvent(manager, 'completed'));
  assert.ok(edit?.entries.some(entry => entry.type === 'context_edit' && entry.targetId === target),
    '压缩后无user仍须消除本轮未核验正文');
}

// 与最终提交同一选择：合法grounded优先，且SDK排队续接/宿主结果义务不被提前编辑。
{
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  manager.appendMessage({role: 'user', content: '解释真实合成结果', timestamp: 1});
  const grounded = '已核验结果为99。';
  const target = manager.appendMessage({role: 'assistant', content: [{type: 'text', text: '模型额外末条。'}],
    api: 'openai-completions', provider: 'local_mock', model: 'task_demo', stopReason: 'stop', usage, timestamp: 2});
  const projection = workspaceContext(makeWorkspace(), {previousEntryIds: new Set(), selectText: () => grounded});
  const event = settleEvent(manager, 'completed');
  assert.equal(await projection.extension.handlers.get('agent_before_settle')[0]({...event, continue: true}), undefined);
  const edit = await projection.extension.handlers.get('agent_before_settle')[0](event);
  assert.equal(edit?.entries.find(entry => entry.type === 'context_edit' && entry.targetId === target)?.replacement.content,
    grounded, '已有核验正文不能被旧control覆盖');
}

// 普通完整final被选择时不生成替换编辑；持久投影和下一轮使用同一正文。
{
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  manager.appendMessage({role:'user',content:'解释缺测并保留SQL待确认。',timestamp:1});
  const explanation = '缺测延迟保持NULL，真实零须有覆盖依据。SQL仍等待确认。';
  manager.appendMessage({role:'assistant',content:[{type:'text',text:explanation}],api:'openai-completions',
    provider:'local_mock',model:'task_demo',stopReason:'stop',usage,timestamp:2});
  const projection = workspaceContext(makeWorkspace(),{previousEntryIds:new Set(),selectText:()=>explanation});
  assert.equal(await projection.extension.handlers.get('agent_before_settle')[0](settleEvent(manager,'completed')),undefined,
    '同一正常正文不应被旧waiting控制投影替换');
  const restored = restoreCheckpoint('/synthetic/data-agent',exportCheckpoint(manager));
  const next = await projection.extension.handlers.get('context')[0]({messages:[...restored.buildSessionContext().messages,
    {role:'user',content:'继续解释原任务。',timestamp:3}]});
  const input = bodyText(convertToLlm(next.messages));
  assert.ok(input.includes(explanation),'正常完整final进入后续Pi投影');
  assert.ok(!input.includes(control.text),'未被选择的控制摘要不能替换原正文');
}

console.log(JSON.stringify({passed: true, checks: [
  '失败/取消/无正文轮不得回扫编辑旧轮答案',
  '待执行工具未清空时不编辑本轮正文',
  '成功控制交付只替换本轮正文并跨检查点/下一轮输入生效',
  '压缩后无user仍按原entry身份消除本轮草稿',
  '核验正文优先，continue及pendingMessages保留原续接义务',
  '普通完整final与持久检查点及下一轮Pi上下文一致',
], officialRequests: 0}));
