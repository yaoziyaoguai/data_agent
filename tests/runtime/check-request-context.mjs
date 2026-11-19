import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {InMemoryModelsStore} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {streamSimple as streamAnthropic} from '@earendil-works/pi-ai/api/anthropic-messages';
import {createAgentSession, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {resources} from '../../apps/agent/session/resources.ts';
import {workspaceContext} from '../../apps/agent/session/workspace-context.ts';
import {taskProjection} from '../../apps/agent/session/task-projection.ts';
import {selectedSkillResources} from '../../apps/agent/session/skills.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {RECOVERY_NOTICE, exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {decodeContract} from '../../packages/contracts/validate.ts';
import schema from '../../packages/contracts/schema.json' with {type: 'json'};
import {deriveCapacityPlan} from '../../packages/contracts/capacity.ts';
import {sessionCapacity} from '../../apps/agent/session/capacity.ts';

// 宿主flag在传输接缝按共享契约输入；真实Pi循环/序列化，fetch只接本地SSE，无Rust生产者结论。
const checks = [], failures = [];
let providerRequests = 0, networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {networkAttempts++; throw new Error('network_forbidden');};
const markers = {
  tool: '合成甲来源工具正文哨兵', assistant: '合成甲来源助手复述哨兵', summary: '合成甲来源压缩摘要哨兵',
  memory: '合成甲来源记忆正文哨兵', skill: '合成甲来源Skill正文哨兵', directory: '合成甲方法目录哨兵',
  task: '合成甲旧任务正文哨兵', query: '合成甲旧查询正文哨兵',
};
const currentText = '只使用合成乙资料回答。\n保留否定和换行，不执行查询。';
const sourceA = {kind: 'document', id: 'synthetic-source-a'};
const sourceB = {kind: 'document', id: 'synthetic-source-b'};
const taskA = {task_id: 'synthetic-task-a', condition_version: '1'};
const taskB = {task_id: 'synthetic-task-b', condition_version: '1'};
const identity = {record_kind: 'source_identity', name: '合成乙资料', kind: 'document',
  object_id: 'synthetic-document-b', object_version: '1', source_keys: [sourceB], roots_complete: true};
const usage = {input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const assistant = content => ({role: 'assistant', content, api: 'openai-completions',
  provider: 'source_consumer_mock', model: 'source-consumer', stopReason: 'stop', usage, timestamp: 1});
const call = (id, name, args) => ({tool_calls: [{index: 0, id, type: 'function',
  function: {name, arguments: JSON.stringify(args)}}]});
const asset = (kind, id, body, name = id) => ({kind, id, body, name, version: '1', scope: name,
  source_text: body, selected: kind === 'skill', state: 'enabled', verified: true, dependencies: [],
  ...(kind === 'skill' ? {native_path: `/skills/${id}/1/SKILL.md`} : {})});
function makeWorkspace(ready) {
  return decodeContract('WorkspaceContext', {
    ...(ready === undefined ? {} : {source_context_ready: ready}),
    active_task_ref: taskA, input_task_ids: [], tasks: [{id: taskA.task_id, condition_version: '1',
      goal: markers.task, lifecycle: 'active', phase: 'investigating', conditions: {
        notes: markers.task, source_limits: {allowed_sources: [sourceA], origin_message_ids: ['old-message']}}}],
    query_observations: [{id: 'old-query', task_id: taskA.task_id, condition_version: '1',
      execution_state: 'succeeded', sql: markers.query}],
    memories: [asset('memory', 'synthetic-memory', markers.memory)],
    selected_skills: [asset('skill', 'synthetic-skill', markers.skill, markers.directory)], recent_messages: [],
    request_clock: {reference_time_utc: '2026-01-01T00:00:00.000Z', business_timezone: 'UTC'},
    authority_revision: 'synthetic-authority', authority_snapshot: {active_task: taskA, private: '宿主私有快照哨兵'},
  });
}
async function fixture({ready = false, resume = false, compacted = false, projectedInput = false, reasoning = false, api = 'openai-completions', text = currentText, reply, toolReply, refresh, capacityPlan, fixedOverhead = () => 0, retainedText = currentText, afterReplace = () => {}} = {}) {
  const manager = SessionManager.inMemory('/synthetic/source-consumer');
  // 前一完整轮提供Pi合法摘要切点；最近工具组由SDK决定保留，不能假定它必在摘要里。
  manager.appendMessage({role: 'user', content: '先核对合成甲资料。', timestamp: 0});
  manager.appendMessage(assistant([{type: 'text', text: markers.tool}]));
  // 旧输入刻意与本条原话相同，不能凭文本把旧轮工具当成本轮回执。
  const oldUser = manager.appendMessage({role: 'user', content: retainedText, timestamp: 1});
  manager.appendMessage(assistant([{type: 'toolCall', id: 'old-read', name: 'read_source', arguments: {}}]));
  manager.appendMessage({role: 'toolResult', toolCallId: 'old-read', toolName: 'read_source',
    content: [{type: 'text', text: markers.tool}], isError: false, timestamp: 2});
  manager.appendMessage({role: 'toolResult', toolCallId: 'old-skill', toolName: 'read',
    content: [{type: 'text', text: markers.skill}], isError: false, timestamp: 2});
  manager.appendMessage(assistant([{type: 'text', text: markers.assistant}]));
  const oldIdentity = {operation_id: 'old-identity-operation', tool_name: 'search_knowledge', tool_contract_version: 2,
    source_context_ready: false, data: {hits: [{...identity, name: '旧轮身份不应混入本轮', object_id: 'old-object'}]}};
  manager.appendMessage({role: 'toolResult', toolCallId: 'old-identity', toolName: 'search_knowledge',
    content: [{type: 'text', text: JSON.stringify(oldIdentity.data)}], details: oldIdentity, isError: false, timestamp: 2});
  if (compacted) manager.appendCompaction(markers.summary, oldUser, 100, {}, true);
  if (resume && !projectedInput) manager.appendMessage({role: 'user', content: text, timestamp: 3});
  if (projectedInput) {
    manager.appendCompaction(markers.summary, null, 100, {}, true);
    manager.appendCustomMessageEntry('data_agent_current_input', '继续处理原用户输入：' + text,
      false, {message_id: 'current-message'});
  }
  const originalEntries = manager.getBranch().map(entry => entry.id);
  const sessionId = manager.getHeader().id;
  const run = {run_id: 'synthetic-run', message_id: 'current-message', text,
    tool_contract_version: 2, workspace_context: makeWorkspace(ready), resume_same_input: resume};
  const payloads = [], receiptCalls = [], errors = [], transforms = [];
  let providerFailure;
  const workspace = workspaceContext(run.workspace_context);
  let projection;
  const transport = {run, binding: () => ({run_id: run.run_id, lease_epoch: '1'}),
    async post(path, _contract, input) {
      if (path === '/internal/context/refresh') return decodeContract('WorkspaceContext',
        refresh ? await refresh(input) : {...makeWorkspace(true), active_task_ref: taskB, memories: [], selected_skills: []});
      if (path === '/internal/data/tool-calls') return decodeContract('OperationReceipt',
        {operation_id: 'operation-' + input.sdk_tool_call_id, tool_contract_version: 2});
      assert.equal(path, '/internal/data/tools');
      receiptCalls.push(input);
      return decodeContract('DataToolOutcome', {operation_id: 'operation-' + input.sdk_tool_call_id,
        tool_name: input.tool_name, tool_contract_version: 2, ...(await toolReply?.(input) ?? {data: {}})});
    }};
  const capacity = capacityPlan ? sessionCapacity(capacityPlan, manager, fixedOverhead) : null;
  projection = taskProjection(transport, manager, value => {workspace.replace(value); afterReplace();});
  const data = dataTools(transport, manager, '', (receipt, sdk) => {
    workspace.acceptReceipt(receipt); projection.acceptReceipt(receipt, sdk);
  });
  // 直接记录投影前后leaf，区分临时投影和既有范围刷新产生的正式边界。
  const transform = projection.extension.handlers.get('context_with_system')[0];
  projection.extension.handlers.set('context_with_system', [async event => {
    const leaf = manager.getLeafId(), count = manager.getEntries().length;
    const result = await transform(event);
    transforms.push({leaf, after: manager.getLeafId(), count, afterCount: manager.getEntries().length});
    return result;
  }]);
  const runtime = await ModelRuntime.create({modelsPath: null, modelsStore: new InMemoryModelsStore(),
    credentials: {read: async () => undefined, list: async () => [], modify: async () => {}, delete: async () => {}},
    refreshOnCreate: false, allowModelNetwork: false});
  const nativeStream = api === 'anthropic-messages' ? streamAnthropic : streamSimple;
  runtime.registerProvider('source_consumer_mock', {api, apiKey: 'synthetic-offline',
    baseUrl: 'https://source-consumer.invalid/v1',
    streamSimple: (model, context, options) => {
      capacity?.check();
      return nativeStream(model, context, {...options,
      apiKey: 'synthetic-offline', maxRetries: 0, fetch: async (request, init) => {
        try {
          const payload = JSON.parse(typeof init?.body === 'string' ? init.body : await request.text());
          payloads.push(payload); providerRequests++;
          const delta = {...await reply?.(payload, payloads.length) ?? {content: '合成回答。'}, role: 'assistant'};
          if (api === 'anthropic-messages') {
            const events = [{type: 'message_start', message: {id: 'synthetic-response', type: 'message',
              role: 'assistant', model: 'source-consumer', content: [], stop_reason: null, stop_sequence: null,
              usage: {input_tokens: 20, output_tokens: 0}}}];
            let index = 0;
            if (delta.reasoning_content !== undefined) {
              events.push({type: 'content_block_start', index, content_block: {type: 'thinking', thinking: '', signature: ''}},
                {type: 'content_block_delta', index, delta: {type: 'thinking_delta', thinking: delta.reasoning_content}},
                {type: 'content_block_delta', index, delta: {type: 'signature_delta', signature: delta.thinking_signature}},
                {type: 'content_block_stop', index});
              index++;
            }
            for (const tool of delta.tool_calls ?? []) {
              events.push({type: 'content_block_start', index, content_block: {type: 'tool_use', id: tool.id, name: tool.function.name, input: {}}},
                {type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: tool.function.arguments}},
                {type: 'content_block_stop', index});
              index++;
            }
            if (delta.content !== undefined) events.push(
              {type: 'content_block_start', index, content_block: {type: 'text', text: ''}},
              {type: 'content_block_delta', index, delta: {type: 'text_delta', text: delta.content}},
              {type: 'content_block_stop', index});
            events.push({type: 'message_delta', delta: {stop_reason: delta.tool_calls ? 'tool_use' : 'end_turn', stop_sequence: null}, usage: {output_tokens: 10}},
              {type: 'message_stop'});
            return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''),
              {headers: {'content-type': 'text/event-stream'}});
          }
          const sse = 'data: ' + JSON.stringify({id: 'synthetic-response', choices: [{index: 0, delta,
            finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n' +
            'data: ' + JSON.stringify({id: 'synthetic-response', choices: [], usage: {prompt_tokens: 20, completion_tokens: 10}}) + '\n\n' +
            'data: [DONE]\n\n';
          return new Response(sse, {headers: {'content-type': 'text/event-stream'}});
        } catch (error) {providerFailure ??= error; throw error;}
      }});
    },
    models: [{id: 'source-consumer', name: '合成消费者模型', api, reasoning,
      input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 131072, maxTokens: 2048,
      ...(reasoning && api === 'openai-completions'
        ? {compat: {thinkingFormat: 'deepseek', supportsStrictMode: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true}}
        : {})}],
  });
  const {session} = await createAgentSession({cwd: '/synthetic/source-consumer', modelRuntime: runtime,
    model: runtime.getModel('source_consumer_mock', 'source-consumer'), thinkingLevel: reasoning ? 'high' : 'off', sessionManager: manager,
    settingsManager: SettingsManager.inMemory({defaultTools: [], compaction: {enabled: false,
      reserveTokens: capacityPlan?.historyReserve ?? 2048, keepRecentTokens: capacityPlan?.keepRecent ?? 64}, retry: {enabled: false}}),
    resourceLoader: resources(true, selectedSkillResources(run.workspace_context.selected_skills),
      [projection.extension, workspace.extension, ...(capacity ? [capacity.extension] : [])]),
    tools: data.tools.map(tool => tool.name), customTools: data.tools});
  projection.attachToolGate(names => session.setActiveToolsByName(names), data.tools.map(tool => tool.name));
  const unbind = await session.bindExtensions({onError: error => errors.push(error)});
  const prompt = async () => {
    await session.prompt(resume ? RECOVERY_NOTICE + ' 继续处理原输入。' : text, {expandPromptTemplates: false});
    if (providerFailure) throw providerFailure;
    assert.deepEqual(errors, [], 'Pi不能吞下投影异常后继续带原上下文');
    assert.equal(manager.getHeader().id, sessionId);
    for (const id of originalEntries) assert.ok(manager.getBranch().some(entry => entry.id === id), '完整原历史仍在原分支');
    assert.ok(transforms.every(item => item.leaf === item.after && item.count === item.afterCount), '临时投影不改leaf或历史条目');
    assert.ok(!JSON.stringify(payloads).includes('宿主私有快照哨兵'));
  };
  return {manager, session, sessionId, run, workspace, projection, data, transport, payloads, receiptCalls, prompt,
    close: () => {if (typeof unbind === 'function') unbind(); session.dispose();}};
}
const raw = payload => JSON.stringify(payload);
// 从实际provider payload取指定工具调用的模型可见正文；正文必须按原SDK身份可定位。
const toolBody = (payload, id) => {
  const message = payload.messages.find(item => item.role === 'tool' && item.tool_call_id === id);
  assert.ok(message, '工具回执应进入实际payload：' + id);
  const text = typeof message.content === 'string' ? message.content
    : (message.content ?? []).map(part => part.text ?? '').join('');
  return JSON.parse(text);
};
function hidden(payload, text = currentText) {
  for (const marker of Object.values(markers)) assert.ok(!raw(payload).includes(marker), '未裁决payload泄漏：' + marker);
  assert.ok(raw(payload).includes(JSON.stringify(text).slice(1, -1)), '模型须收到本条完整原话');
  assert.ok(!raw(payload).includes('旧轮身份不应混入本轮'), '重句不能混入前轮身份回执');
  assert.ok(payload.tools.length > 0, '临时投影保留Pi原生工具声明');
  if (payload.tools.some(tool => tool.type === 'function')) {
    const update = payload.tools.find(tool => tool.function?.name === 'update_analysis_task');
    assert.ok(JSON.stringify(update).includes(schema.$defs.SourceKey.description),
      '来源尚未裁决时，实际Flash协议请求中的任务工具须保留来源身份说明');
  }
  // 未决期提示必须给真实状态与合法下一动作：已选Skill未被取消，不得引导重新选用。
  assert.ok(raw(payload).includes('保持原选择和版本'), '未决期提示必须说明已选Skill保持原选择和版本');
  assert.ok(raw(payload).includes('不需要重新选用'), '未决期提示必须明确不需要重新选用');
}
function assertSourceSearch(payload, ready) {
  const search = payload.tools.find(tool => tool.function?.name === 'search_knowledge')?.function;
  assert.ok(search, '身份目录在声明范围前和就绪后均须可见');
  const properties = search.parameters.properties;
  assert.ok(properties.view.enum.includes('source_identity'));
  assert.equal(properties.cursor.type, 'string');
  assert.deepEqual([...properties.source_selection.items.required].sort(), ['object_id', 'version']);
  assert.match(search.description, /空白分词任一匹配.*稳定ID分页/);
  assert.match(search.description, /完整字段名、表名或文档名窄查.*kinds.*省略kinds/);
  assert.match(search.description, /source_keys区分同名目录与正式定义.*roots_complete/);
  assert.match(search.description, /bounded.*next.*目标仍缺.*窄查或续页.*conditions\.source_limits/);
  assert.match(search.description, /object_version.*source_selection.*citation.*read_source/);
  assert.match(search.description, /不扩许可/);
  const read = payload.tools.find(tool => tool.function?.name === 'read_source')?.function;
  assert.equal(Boolean(read), ready);
  if (read) assert.ok(read.parameters.properties.citation, '就绪后可按实际citation补读');
  return search;
}
async function check(name, test) {
  try {await test(); checks.push(name);} catch (error) {failures.push({name, error: error.stack});}
}
try {
  await check('修订回执撤下实际失效的草稿观察，保留其他查询及原历史', async () => {
    const pending = {id: 'old-month-draft', task_id: taskA.task_id, condition_version: '1',
      draft_version: '1', execution_state: 'not_submitted', confirmation_state: 'awaiting_confirmation'};
    const historical = {...pending, id: 'completed-history', execution_state: 'succeeded', confirmation_state: 'confirmed'};
    const unrelated = {...pending, id: 'other-task-draft', task_id: taskB.task_id};
    const f = await fixture({ready: true, reply(payload, index) {
      const message = payload.messages.map(message => typeof message.content === 'string' ? message.content
        : (message.content ?? []).map(part => part.text ?? '').join('')).find(text => text.startsWith('当前宿主事实：'));
      const facts = JSON.parse(message.slice(message.indexOf('\n') + 1));
      if (index === 1) {
        assert.equal(facts.query_observations.find(query => query.id === pending.id).confirmation_state, 'awaiting_confirmation');
        return call('revise-month', 'update_analysis_task', {action: 'revise', task_id: taskA.task_id,
          expected_version: '1', condition_patch: {set: {time_start: '2026-02-01T00:00:00Z', time_end: '2026-03-01T00:00:00Z'}}});
      }
      assert.deepEqual(facts.query_observations, [historical, unrelated], '旧稿不再作为当前观察重新注入，历史成功和别的任务不受影响');
      assert.deepEqual(toolBody(payload, 'revise-month').superseded_query_ids, [pending.id], '模型可从原回执查明哪份草稿已失效');
      return {content: '旧稿已经失效，继续处理当前月份。'};
    }, toolReply: () => ({source_context_ready: true, superseded_query_ids: [pending.id], data: {...taskA, condition_version: '2'}})});
    f.run.workspace_context.query_observations = [pending, historical, unrelated];
    f.workspace.replace(f.run.workspace_context);
    try {await f.prompt(); assert.equal(f.payloads.length, 2);}
    finally {f.close();}
  });
  await check('未裁决首个实际payload隐藏旧工具/助手/摘要/记忆/Skill及工作区正文，历史与session保留', async () => {
    for (const compacted of [false, true]) {
      const positive = await fixture({ready: true, compacted});
      const negative = await fixture({compacted});
      try {
        await positive.prompt();
        for (const marker of Object.values(markers).filter(value => compacted || value !== markers.summary))
          assert.ok(raw(positive.payloads[0]).includes(marker), '反例正控必须真正携带：' + marker);
        for (const marker of Object.values(markers)) assert.ok(!negative.workspace.contents().join('\n').includes(marker),
          'workspace参考也不能保留正文：' + marker);
        await negative.prompt(); hidden(negative.payloads[0]);
        assert.ok(negative.manager.getBranch().some(entry => entry.type === 'message'
          && entry.message.role === 'toolResult' && JSON.stringify(entry.message).includes(markers.tool)));
        const prefix = payload => payload.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
        assert.ok(prefix(negative.payloads[0]).includes(resources(true).getSystemPrompt()), '保留固定系统协议前缀');
      } finally {positive.close(); negative.close();}
    }
  });
  await check('身份结果可选稳定细源，范围改变先刷新再读正文，后续来源门负控仍拒绝', async () => {
    let f, refreshes = 0;
    const citation = source => ({source, revision: '1', locator: {offset: 0, length: 12}});
    const directory = {hits: [identity], search_coverage: {state: 'bounded', next: 'synthetic-identity-next',
      reasons: ['candidate_limit'], channels: [{channel: 'exact', state: 'available'}]}};
    f = await fixture({reply(payload, index) {
      if (index <= 2) hidden(payload);
      assertSourceSearch(payload, index > 2);
      assert.ok(!raw(payload).includes(markers.tool));
      if (index === 1) return call('identity-b', 'search_knowledge', {query: '合成乙资料', view: 'source_identity'});
      if (index === 2) {
        const texts = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
          : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text));
        const control = texts.find(text => text.startsWith('{"sdk_tool_call_id":"identity-b"'));
        assert.ok(control, '未声明时按原SDK调用身份交付目录控制');
        assert.deepEqual(JSON.parse(control).data, directory, '实际请求保留整个bounded身份回执及next');
        return call('scope-b', 'update_analysis_task', {action: 'route', task_id: taskB.task_id, expected_version: '1', options: []});
      }
      assert.equal(refreshes, 1, 'ready回执有context_reset时先完成宿主刷新');
      if (index === 3) return call('read-b', 'read_source', {citation: citation(sourceB)});
      if (index === 4) {assert.ok(raw(payload).includes('合成乙已允许正文')); return call('read-a', 'read_source', {citation: citation(sourceA)});}
      assert.ok(raw(payload).includes('source_not_allowed')); return {content: '仅采用合成乙资料，甲资料读取被拒绝。'};
    }, toolReply(input) {
      if (input.tool_name === 'search_knowledge') return {source_context_ready: false, data: directory};
      if (input.tool_name === 'update_analysis_task') return {source_context_ready: true, context_reset: taskB, data: {...taskB}};
      if (input.arguments.citation.source.id === sourceA.id) return {source_context_ready: true, data: {error: 'source_not_allowed'}};
      return {source_context_ready: true, data: {text: '合成乙已允许正文'}};
    }, refresh() {
      refreshes++; assert.equal(f.run.workspace_context.source_context_ready, false);
      return {...makeWorkspace(true), active_task_ref: taskB, memories: [], selected_skills: [], tasks: [], query_observations: []};
    }});
    try {await f.prompt(); assert.equal(f.payloads.length, 5); assert.equal(f.run.workspace_context.source_context_ready, true);}
    finally {f.close();}
  });
  await check('生产活动工具门区分SDK未知工具与Rust拒绝，安全指导进入payload，刷新就绪后实际读取并执行', async () => {
    const text = '执行刚才保存的合成乙SQL，保留原条件。';
    const hint = '先用update_analysis_task（action=route）登记，等待必要刷新并确认source_context_ready=true，再继续原请求；执行已有SQL先get_query再execute_query。';
    const safeTask = {...taskB, lifecycle: 'active', phase: 'awaiting_confirmation',
      open_clarification_ids: ['synthetic-question'], has_more_clarifications: false};
    const safeQuery = {query_id: 'synthetic-current-query', task_id: taskB.task_id, condition_version: '1',
      draft_version: '1', confirmation_state: 'awaiting_confirmation', execution_state: 'not_submitted', cancel_state: 'none'};
    const privateText = '拒绝恢复结构中的条件SQL问题正文哨兵';
    const controls = [];
    let f, refreshes = 0;
    f = await fixture({text, reply(payload, index) {
      const names = payload.tools.map(tool => tool.function.name);
      if (index <= 3) {
        hidden(payload, text);
        for (const name of ['get_query', 'read_analysis_task', 'execute_query', 'read_source']) assert.ok(!names.includes(name));
      }
      assert.ok(!raw(payload).includes(privateText));
      if (index === 1) return call('sdk-hidden-read', 'get_query', {query_id: safeQuery.query_id});
      if (index <= 3) {
        const sdk = index === 2 ? 'sdk-hidden-read' : 'rust-blocked-read';
        const texts = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
          : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text));
        const controlText = texts.find(value => value.startsWith('{"sdk_tool_call_id":"' + sdk + '"'));
        assert.ok(controlText, '失败调用须以原SDK身份进入实际payload');
        const control = JSON.parse(controlText); controls.push(control);
        assert.equal(control.isError, true);
        assert.equal(f.run.workspace_context.source_context_ready, false);
        if (index === 2) {
          assert.equal(f.receiptCalls.length, 0, '隐藏工具由Pi拒绝，不能派发到Rust');
          assert.deepEqual(control.data, {}, 'SDK未知工具不伪造Rust回执或恢复身份');
          assert.equal(control.operation_id, undefined);
          assert.match(raw(payload), /update_analysis_task/);
          assert.match(raw(payload), /source_context_ready/);
          return call('rust-blocked-read', 'read_conversation', {after_seq: '0'});
        }
        assert.equal(control.data.error, 'task_context_required');
        assert.equal(control.data.outcome, 'rejected');
        assert.equal(control.data.new_execution_authorized, false);
        assert.equal(control.data.hint, hint, '可信固定指导必须进入真实provider payload');
        assert.deepEqual(control.data.recovery, {task: safeTask, query: safeQuery}, '仅保留恢复身份、版本、状态和问题ID');
        return call('route-after-rejection', 'update_analysis_task', {action: 'route', task_id: taskB.task_id,
          expected_version: taskB.condition_version, options: []});
      }
      assert.equal(refreshes, 1);
      assert.equal(f.run.workspace_context.source_context_ready, true);
      assert.ok(!raw(payload).includes(markers.tool));
      assert.ok(names.includes('get_query') && names.includes('execute_query'));
      if (index === 4) {
        // 范围重置回执被宿主边界整体移出wire；其正文按回执时刻有效状态进入会话记录，
        // 不把Rust原true显示成已可读，重置目标与等待刷新事实显式给出。
        const persisted = f.manager.getBranch().find(entry => entry.type === 'message'
          && entry.message.role === 'toolResult' && entry.message.toolCallId === 'route-after-rejection')?.message;
        assert.ok(persisted, '重置回执保留在会话树中');
        const resetBody = JSON.parse(persisted.content[0].text);
        assert.equal(resetBody.source_context_ready, false, '重置回执正文不得显示Rust原true为已可读');
        assert.deepEqual(resetBody.context_reset, taskB, '重置目标随正文给出');
        assert.equal(resetBody.pending_context_refresh, true, '正文必须标明等待宿主刷新');
        assert.equal(resetBody.task_id, taskB.task_id);
        return call('admitted-query', 'get_query', {query_id: safeQuery.query_id});
      }
      if (index === 5) {
        assert.ok(raw(payload).includes('SELECT 17 AS sample_value'));
        const admitted = toolBody(payload, 'admitted-query');
        assert.equal(admitted.source_context_ready, true, '刷新完成后回执正文携带真实就绪状态');
        assert.equal(admitted.execution_tools_ready, true);
        assert.equal(admitted.control_note, undefined, '成功核稿保留事实，不重复要求从get_query开始');
        assert.deepEqual(admitted.query, {...safeQuery, id: safeQuery.query_id, sql: 'SELECT 17 AS sample_value', parameters: {}});
        assert.equal(admitted.results, null);
        assert.match(admitted.status_note, /未提交/);
        return call('admitted-execution', 'execute_query', {query_id: safeQuery.query_id,
          draft_version: '1', condition_version: '1', instruction_quote: text});
      }
      assert.ok(raw(payload).includes('queued'));
      return {content: '已提交合成查询。'};
    }, toolReply(input) {
      if (input.tool_name === 'read_conversation') return {source_context_ready: false, data: {
        error: 'task_context_required', outcome: 'rejected', new_execution_authorized: false, hint,
        recovery: {task: {...safeTask, goal: privateText, conditions: {notes: privateText},
          read_tool: {name: 'read_analysis_task', arguments: {task_id: taskB.task_id}}, question: privateText},
          query: {...safeQuery, sql: privateText, parameters: {secret: privateText},
            read_tool: {name: 'get_query', arguments: {query_id: safeQuery.query_id}}}}, detail: privateText}};
      if (input.tool_name === 'update_analysis_task') return {source_context_ready: true, context_reset: taskB, data: {...taskB}};
      if (input.tool_name === 'get_query') return {source_context_ready: true, data: {
        query: {...safeQuery, id: safeQuery.query_id, sql: 'SELECT 17 AS sample_value', parameters: {}}, results: null}};
      assert.equal(input.tool_name, 'execute_query');
      assert.equal(input.arguments.instruction_quote, text);
      return {source_context_ready: true, data: {id: safeQuery.query_id, execution_state: 'queued'}};
    }, refresh() {
      refreshes++; assert.equal(f.run.workspace_context.source_context_ready, false);
      return {...makeWorkspace(true), active_task_ref: taskB, tasks: [], query_observations: [], memories: [], selected_skills: []};
    }});
    try {
      await f.prompt(); assert.equal(f.payloads.length, 6);
      assert.deepEqual(f.receiptCalls.map(input => input.tool_name), ['read_conversation', 'update_analysis_task', 'get_query', 'execute_query']);
      assert.ok(f.receiptCalls.every(input => input.run_id === f.run.run_id));
      await mkdir('.local/checks/interaction-continuation-20261110', {recursive: true});
      await writeFile('.local/checks/interaction-continuation-20261110/consumer-control-payloads.json',
        JSON.stringify({controls, payloads: f.payloads, rustDispatches: f.receiptCalls.map(input => ({sdk: input.sdk_tool_call_id, tool: input.tool_name})),
          sessionId: f.sessionId, messageId: f.run.message_id, refreshes, officialRequests: 0}, null, 2) + '\n');
    } finally {f.close();}
  });
  await check('无重置route回执正文携带有效就绪事实，参考消息与回执同源不再自称启动快照', async () => {
    // 镜像真实失败形状：无context_reset的route回执，就绪只出现在信封级，
    // 模型可见正文必须同源携带有效状态，否则"回执优先"的指导永不可满足。
    let f;
    f = await fixture({reply(payload, index) {
      if (index === 1) {
        hidden(payload);
        return call('plain-route', 'update_analysis_task',
          {action: 'route', task_id: taskA.task_id, expected_version: '1', options: []});
      }
      const names = payload.tools.map(tool => tool.function.name);
      assert.ok(names.includes('get_query') && names.includes('execute_query'), '无重置route回执即恢复全集工具');
      const body = toolBody(payload, 'plain-route');
      assert.equal(body.source_context_ready, true, 'route回执正文必须携带有效就绪状态');
      assert.equal(body.execution_tools_ready, true, 'route解锁后须显式声明执行工具已就绪');
      assert.ok(typeof body.control_note === 'string' && body.control_note.includes('execute_query'));
      assert.equal(body.task_id, taskA.task_id);
      assert.equal(body.condition_version, '1');
      assert.equal(body.routed, true);
      const reference = payload.messages.map(message => typeof message.content === 'string' ? message.content
        : (message.content ?? []).map(part => part?.text ?? '').join(''))
        .find(text => text.startsWith('当前宿主事实：'));
      assert.ok(reference, '宿主事实参考消息在场');
      assert.ok(reference.includes('"source_context_ready":true'), '参考消息携带当前就绪事实');
      assert.ok(!reference.includes('本轮启动快照，后续工具回执优先'), '参考消息不得再自称启动快照并让位于回执');
      assert.ok(!raw(payload).includes('已核验的启动快照'), '系统说明不得再把参考消息描述为启动快照');
      assert.equal(f.run.workspace_context.source_context_ready, true);
      return {content: '已确认来源就绪，继续执行原请求。'};
    }, toolReply(input) {
      assert.equal(input.tool_name, 'update_analysis_task');
      return {source_context_ready: true, data: {task_id: taskA.task_id, condition_version: '1', routed: true}};
    }});
    try {await f.prompt(); assert.equal(f.payloads.length, 2);}
    finally {f.close();}
  });
  await check('同轮route解锁后DeepSeek完整回放原reasoning_content及配对工具回合', async () => {
    // https://api-docs.deepseek.com/guides/thinking_mode/ 要求携tools时完整回传reasoning_content。
    const staleThought = '合成route前暂缺get_query和execute_query的旧思考哨兵';
    const f = await fixture({reasoning: true, reply(payload, index) {
      if (index === 1) {
        hidden(payload);
        return {reasoning_content: staleThought, ...call('route-before-exec', 'update_analysis_task',
          {action: 'route', task_id: taskA.task_id, expected_version: '1', options: []})};
      }
      const names = payload.tools.map(tool => tool.function.name);
      assert.ok(names.includes('get_query') && names.includes('execute_query'));
      const priorAssistant = payload.messages.find(message => message.role === 'assistant'
        && Array.isArray(message.tool_calls) && message.tool_calls.some(tc => tc.id === 'route-before-exec'));
      assert.ok(priorAssistant, '保留route tool_calls历史');
      assert.equal(priorAssistant.reasoning_content, staleThought, '同轮解锁不能改写provider已产生的reasoning_content');
      assert.deepEqual(priorAssistant.tool_calls.map(tool => tool.id), ['route-before-exec']);
      assert.equal(toolBody(payload, 'route-before-exec').source_context_ready, true);
      if (index === 2) {
        return {reasoning_content: '合成解锁后核对SQL的新思考', ...call('after-unlock-get', 'get_query', {query_id: 'q1'})};
      }
      assert.ok(raw(payload).includes('合成解锁后核对SQL的新思考'), 'unlock之后的本轮thinking保持完整');
      return {content: '已核对并执行。'};
    }, toolReply(input) {
      if (input.tool_name === 'update_analysis_task') {
        return {source_context_ready: true, data: {task_id: taskA.task_id, condition_version: '1', routed: true}};
      }
      return {source_context_ready: true, data: {query: {id: 'q1'}, results: null}};
    }});
    try {
      await f.prompt();
      assert.equal(f.payloads.length, 3);
      assert.ok(JSON.stringify(f.manager.getEntries()).includes(staleThought), '原thinking保留在SessionManager持久分支');
    } finally {
      await mkdir('.local/checks/source-authority-repair', {recursive: true});
      await writeFile('.local/checks/source-authority-repair/deepseek-replay-payloads.json', JSON.stringify(f.payloads, null, 2) + '\n');
      f.close();
    }
  });
  await check('同轮route解锁后Anthropic原生序列化完整回放thinking及signature并匹配tool_result', async () => {
    // https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows 要求原块与签名不变。
    const thinking = '合成来源确认前的思考', signature = 'synthetic-original-thinking-signature';
    const f = await fixture({api: 'anthropic-messages', reasoning: true, reply(payload, index) {
      if (index === 1) {
        hidden(payload);
        assert.ok(!payload.tools.some(tool => tool.name === 'get_query'));
        return {reasoning_content: thinking, thinking_signature: signature,
          ...call('anthropic-route', 'update_analysis_task', {action: 'route', task_id: taskA.task_id, expected_version: '1', options: []})};
      }
      assert.ok(payload.tools.some(tool => tool.name === 'get_query'), '实际SDK的Anthropic工具集合在ready后恢复');
      const prior = payload.messages.find(message => message.role === 'assistant'
        && message.content.some(part => part.type === 'tool_use' && part.id === 'anthropic-route'));
      assert.ok(prior, '原生Anthropic请求保留原tool_use');
      assert.deepEqual(prior.content.find(part => part.type === 'thinking'), {type: 'thinking', thinking, signature},
        '解锁不能删除或改写原thinking/signature');
      const result = payload.messages.flatMap(message => message.role === 'user' && Array.isArray(message.content) ? message.content : [])
        .find(part => part.type === 'tool_result' && part.tool_use_id === 'anthropic-route');
      assert.ok(result, 'tool_result对应原tool_use_id');
      const body = JSON.parse(typeof result.content === 'string' ? result.content
        : result.content.map(part => part.text ?? '').join(''));
      assert.equal(body.source_context_ready, true);
      assert.equal(body.task_id, taskA.task_id);
      return {content: '来源已确认，继续原请求。'};
    }, toolReply: () => ({source_context_ready: true, data: {...taskA, routed: true}})});
    try {await f.prompt(); assert.equal(f.payloads.length, 2);}
    finally {
      await mkdir('.local/checks/source-authority-repair', {recursive: true});
      await writeFile('.local/checks/source-authority-repair/anthropic-replay-payloads.json', JSON.stringify(f.payloads, null, 2) + '\n');
      f.close();
    }
  });
  await check('成功route但刷新来源仍未知及错误ready回执均不解锁，当前安全错误族不透传自由正文', async () => {
    let f, refreshes = 0;
    const privateText = 'stale_knowledge拼接外部详情不可投影';
    f = await fixture({reply(payload, index) {
      hidden(payload);
      const names = payload.tools.map(tool => tool.function.name);
      assert.ok(!names.includes('get_query') && !names.includes('execute_query'));
      assert.ok(!raw(payload).includes(privateText));
      if (index === 1) return call('route-unknown', 'update_analysis_task', {action: 'route', task_id: taskB.task_id, expected_version: '1', options: []});
      assert.equal(refreshes, 1);
      assert.equal(f.run.workspace_context.source_context_ready, false);
      if (index === 2) return call('rejected-ready', 'read_conversation', {after_seq: '0'});
      return {content: '来源仍未确定，保持现有读取边界。'};
    }, toolReply(input) {
      if (input.tool_name === 'update_analysis_task') return {source_context_ready: true, context_reset: taskB, data: {...taskB}};
      return {source_context_ready: true, data: {error: 'stale_knowledge', outcome: 'rejected', hint: privateText,
        recovery: {task: {...taskB, goal: privateText}}}};
    }, refresh() {refreshes++; return {...makeWorkspace(false), active_task_ref: taskB};}});
    try {await f.prompt(); assert.equal(f.payloads.length, 3);}
    finally {f.close();}
  });
  await check('已归属但来源未决的回执给出条件修订路径，修订前不开放正文也不取消Skill选择', async () => {
    const request = '按已选方法检查分析计划，先不要执行查询。';
    const f = await fixture({text: request, reply(payload, index) {
      if (index <= 2) hidden(payload, request);
      if (index === 1) return call('route-unresolved-source', 'update_analysis_task',
        {action: 'route', task_id: taskA.task_id, expected_version: '1', options: []});
      if (index === 2) {
        const line = payload.messages.flatMap(message => typeof message.content === 'string' ? message.content.split('\n')
          : (message.content ?? []).flatMap(part => part.type === 'text' ? part.text.split('\n') : []))
          .find(line => line.startsWith('{"sdk_tool_call_id":"route-unresolved-source"'));
        assert.ok(line, '成功归属回执须进入真实provider请求');
        const control = JSON.parse(line);
        assert.equal(control.data.routed, true, '不能把已完成的归属事实从未决投影中抹掉');
        assert.equal(control.source_context_ready, false);
        assert.equal(control.source_context_blocker, 'source_scope_unknown');
        assert.match(control.source_context_hint, /revise/);
        assert.match(control.source_context_hint, /unset/);
        assert.match(control.source_context_hint, /clarify/);
        assert.ok(!payload.tools.some(tool => tool.function.name === 'read'), '指导不能提前开放Skill正文');
        return call('declare-unrestricted-source', 'update_analysis_task', {action: 'revise',
          task_id: taskA.task_id, expected_version: '1', condition_patch: {set: {}, unset: ['source_limits']}});
      }
      assert.ok(payload.tools.some(tool => tool.function.name === 'read'));
      assert.ok(raw(payload).includes(markers.directory), '合法修订后原选择仍可供Pi原生read采用');
      return {content: '来源已裁决，继续按原选方法核对。'};
    }, toolReply(input) {
      return input.arguments.action === 'route'
        ? {source_context_ready: false, source_context_blocker: 'source_scope_unknown', data: {...taskA, routed: true}}
        : {source_context_ready: true, context_reset: {...taskA, condition_version: '2'},
          data: {...taskA, condition_version: '2'}};
    }, refresh: () => ({...makeWorkspace(true), active_task_ref: {...taskA, condition_version: '2'}})});
    delete f.run.workspace_context.tasks[0].conditions.source_limits;
    f.run.workspace_context.source_context_blocker = 'source_scope_unknown';
    f.workspace.replace(f.run.workspace_context);
    try {
      await f.prompt();
      assert.deepEqual(f.receiptCalls.map(call => call.arguments.action), ['route', 'revise'],
        '来源修订由模型工具调用送达，宿主不自动声明无限制');
      assert.equal(f.manager.getHeader().id, f.sessionId);
    } finally {f.close();}
  });
  await check('创建后刷新仍保留来源未决原因，当前修订省略字段不由Node猜测继承范围', async () => {
    const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null,
      channel: null, group_by: [], filters: [], knowledge_refs: [], notes: ''};
    const f = await fixture({reply(payload, index) {
      if (index <= 2) hidden(payload);
      if (index === 1) return call('create-unknown-source', 'update_analysis_task',
        {action: 'create', goal: '合成乙资料核对', conditions});
      if (index === 2) {
        assert.ok(raw(payload).includes('source_scope_unknown'));
        assert.ok(raw(payload).includes('revise') && raw(payload).includes('clarify'));
        assert.ok(!raw(payload).includes('create-unknown-source'), '刷新后已无原工具回合，原因必须来自当前宿主事实');
        return call('declare-limited-source', 'update_analysis_task', {action: 'revise', task_id: taskB.task_id,
          expected_version: '1', condition_patch: {set: {source_limits: {allowed_sources: [sourceB], origin_message_ids: []}}}});
      }
      assert.ok(payload.tools.some(tool => tool.function.name === 'read_knowledge'));
      assert.equal(f.run.workspace_context.source_context_blocker, undefined);
      return {content: '只按已确认的合成乙资料继续。'};
    }, toolReply(input) {
      return input.arguments.action === 'create'
        ? {source_context_ready: false, source_context_blocker: 'source_scope_unknown', context_reset: taskB, data: {...taskB}}
        : {source_context_ready: true, context_reset: {...taskB, condition_version: '2'}, data: {...taskB, condition_version: '2'}};
    }, refresh() {
      const decided = f.receiptCalls.some(call => call.arguments.action === 'revise');
      // 镜像真实宿主：来源未知时隐藏预览，明确选用数量仍为1。
      return {...makeWorkspace(decided), active_task_ref: {...taskB, condition_version: decided ? '2' : '1'},
        asset_counts: {memories: 0, selected_skills: 1},
        selected_skills: decided ? makeWorkspace(true).selected_skills : [],
        ...(decided ? {} : {source_context_blocker: 'source_scope_unknown'}), tasks: []};
    }});
    try {await f.prompt();}
    finally {f.close();}
  });
  await check('隐藏期间目录跨页保留宿主安全标题/任务身份及续页，剔除条件正文并在原session继续route', async () => {
    const privateMarker = '合成目录条件及派生目标私密哨兵';
    const question = '合成目录问题正文不可投影', answer = '合成目录答案正文不可投影';
    const sql = 'SELECT synthetic_directory_private_column FROM synthetic_directory_private_table';
    const targetGoal = '合成乙资料的独立核对目标';
    // 模拟宿主已净化的目录：第二项派生goal已被剔除，其他goal均为宿主允许的控制标题。
    // 条件/问题/答案/SQL刻意留作消费者反例；旧目录中的派生标题不能被Node擅自补回。
    const rows = Array.from({length: 29}, (_,index) => ({id: 'synthetic-directory-' + String(index + 1).padStart(2, '0'),
      condition_version: String(index % 3 + 1), lifecycle: 'active', phase: 'investigating', context_complete: index !== 1,
      ...(index === 1 ? {} : {goal: index === 26 ? targetGoal : '合成安全控制目标' + (index + 1)}),
      conditions: {notes: privateMarker}, clarification: {question}, answers: [answer], sql}));
    const directoryAt = (payload, sdk) => {
      const lines = payload.messages.flatMap(message => typeof message.content === 'string' ? message.content.split('\n')
        : (message.content ?? []).flatMap(part => part.type === 'text' ? part.text.split('\n') : []));
      const message = lines.find(line => line.startsWith('{"sdk_tool_call_id":"' + sdk + '"'));
      assert.ok(message, '本轮真实目录回执应进入provider控制投影');
      const data = JSON.parse(message).data;
      assert.ok(Array.isArray(data.tasks), '目录页必须保留任务控制身份列表');
      return data;
    };
    let pages = 0;
    const f = await fixture({reply(payload, index) {
      if (index <= 3) hidden(payload);
      for (const marker of [privateMarker, question, answer, sql])
        assert.ok(!raw(payload).includes(marker), '目录provider payload不能含正文：' + marker);
      if (index === 1) return call('directory-first', 'read_conversation', {task_directory: true, after_seq: '0'});
      if (index === 2) {
        const page = directoryAt(payload, 'directory-first');
        assert.equal(page.tasks.length, 20); assert.equal(page.next_task_after, rows[19].id);
        assert.equal(page.page_limited, true); assert.equal(page.tasks[0].goal, rows[0].goal);
        assert.deepEqual(page.tasks[1], {id: rows[1].id, condition_version: rows[1].condition_version,
          lifecycle: 'active', phase: 'investigating', context_complete: false}, '不从旧目录恢复已隐藏的派生goal');
        assert.ok(page.tasks.every(task => !('conditions' in task) && !('clarification' in task)
          && !('answers' in task) && !('sql' in task)));
        return call('directory-next', 'read_conversation', {task_directory: true, after_seq: '0', task_after: page.next_task_after});
      }
      if (index === 3) {
        const page = directoryAt(payload, 'directory-next');
        assert.equal(page.tasks.length, 9); assert.equal(page.next_task_after, null); assert.equal(page.page_limited, false);
        const selected = page.tasks.find(task => task.goal === targetGoal);
        assert.ok(selected, '启动24任务窗口之外的目标必须能按合法标题定位');
        return call('directory-route', 'update_analysis_task', {action: 'route', task_id: selected.id,
          expected_version: selected.condition_version, options: []});
      }
      return {content: '已按目录定位原目标并继续。'};
    }, toolReply(input) {
      if (input.tool_name === 'read_conversation') {
        assert.equal(input.arguments.task_directory, true); pages++;
        const start = input.arguments.task_after === undefined ? 0 : 20;
        if (start) assert.equal(input.arguments.task_after, rows[19].id);
        return {source_context_ready: false, data: {tasks: rows.slice(start, start + 20),
          next_task_after: start === 0 ? rows[19].id : null, page_limited: start === 0}};
      }
      assert.equal(input.arguments.task_id, rows[26].id); assert.equal(input.arguments.expected_version, rows[26].condition_version);
      return {source_context_ready: true, context_reset: {task_id: rows[26].id, condition_version: rows[26].condition_version},
        data: {task_id: rows[26].id, condition_version: rows[26].condition_version}};
    }, refresh: () => ({...makeWorkspace(true), active_task_ref: {task_id: rows[26].id, condition_version: rows[26].condition_version},
      tasks: [], query_observations: [], memories: [], selected_skills: []})});
    const oldDirectory = {tasks: [{id: rows[1].id, goal: privateMarker + '旧范围派生目标',
      condition_version: rows[1].condition_version, lifecycle: 'active', phase: 'investigating'}], next_task_after: null};
    f.manager.appendMessage(assistant([{type: 'toolCall', id: 'old-task-directory', name: 'read_conversation',
      arguments: {task_directory: true, after_seq: '0'}}]));
    f.manager.appendMessage({role: 'toolResult', toolCallId: 'old-task-directory', toolName: 'read_conversation',
      content: [{type: 'text', text: JSON.stringify(oldDirectory)}], isError: false, timestamp: 3,
      details: {operation_id: 'old-directory-operation', tool_name: 'read_conversation', tool_contract_version: 2,
        source_context_ready: true, data: oldDirectory}});
    f.session.refreshContext();
    try {
      await f.prompt(); assert.equal(pages, 2); assert.equal(f.payloads.length, 4);
      assert.equal(f.manager.getHeader().id, f.sessionId);
      assert.ok(JSON.stringify(f.manager.getEntries()).includes(privateMarker), '隐藏不删原目录或条件历史');
    } finally {f.close();}
    // DB已ready但Node尚待context_reset刷新时，同样只能采用宿主净化后的目录标题。
    const pending = await fixture({resume: true, reply(payload, index) {
      for (const marker of [privateMarker, question, answer, sql]) assert.ok(!raw(payload).includes(marker));
      if (index === 1) {
        hidden(payload);
        const page = directoryAt(payload, 'pending-directory');
        assert.equal(page.tasks[0].goal, rows[0].goal); assert.equal(page.tasks[1].goal, undefined);
        assert.equal(page.next_task_after, rows[19].id); assert.equal(page.page_limited, true);
      }
      return {content: '保留原目录控制身份继续处理。'};
    }, refresh: () => ({...makeWorkspace(true), tasks: [], query_observations: [], memories: [], selected_skills: []})});
    const reset = decodeContract('DataToolOutcome', {operation_id: 'pending-reset-operation', tool_name: 'update_analysis_task',
      tool_contract_version: 2, source_context_ready: true, context_reset: taskA, data: {...taskA}});
    pending.manager.appendMessage(assistant([
      {type: 'toolCall', id: 'pending-reset', name: 'update_analysis_task', arguments: {action: 'route', task_id: taskA.task_id, expected_version: taskA.condition_version, options: []}},
      {type: 'toolCall', id: 'pending-directory', name: 'read_conversation', arguments: {task_directory: true, after_seq: '0'}},
    ]));
    for (const [sdk, receipt] of [['pending-reset', reset], ['pending-directory', decodeContract('DataToolOutcome', {
      operation_id: 'pending-directory-operation', tool_name: 'read_conversation', tool_contract_version: 2,
      source_context_ready: true, data: {tasks: rows.slice(0, 20), next_task_after: rows[19].id, page_limited: true},
    })]]) pending.manager.appendMessage({role: 'toolResult', toolCallId: sdk, toolName: receipt.tool_name,
      content: [{type: 'text', text: JSON.stringify(receipt.data)}], details: receipt, isError: false, timestamp: 4});
    pending.run.workspace_context.source_context_ready = true;
    pending.projection.acceptReceipt(reset, 'pending-reset');
    pending.session.refreshContext();
    try {await pending.prompt(); assert.equal(pending.payloads.length, 2);}
    finally {pending.close();}
  });
  await check('明确继承原范围后同session恢复旧授权历史与Skill目录，普通浏览route无需create', async () => {
    const f = await fixture({compacted: true, reply(payload, index) {
      if (index === 1) {hidden(payload); return call('inherit-a', 'update_analysis_task', {action: 'route', task_id: null, expected_version: null, options: []});}
      assert.ok(raw(payload).includes(markers.tool));
      assert.ok(raw(payload).includes(markers.summary), '原压缩上下文在继承原范围后可恢复');
      assert.ok(raw(payload).includes(markers.memory), '原记忆候选仅临时隐藏');
      assert.ok(raw(payload).includes(markers.directory), 'Skill目录临时隐藏后可恢复');
      return {content: '按已继承的原范围继续。'};
    }, toolReply: () => ({source_context_ready: true, data: {task_id: null, condition_version: null}})});
    try {
      await f.prompt(); assert.equal(f.payloads.length, 2);
      assert.deepEqual(f.run.workspace_context.active_task_ref, taskA, 'taskless route不解除已有任务来源门');
      assert.equal(f.receiptCalls.some(input => input.arguments.action === 'create'), false);
    } finally {f.close();}
  });
  await check('resume和范围重投影后仍使用宿主原话，不把恢复通知/旧同文输入当本轮', async () => {
    for (const projectedInput of [false, true]) {
      const f = await fixture({resume: true, compacted: true, projectedInput});
      try {await f.prompt(); hidden(f.payloads[0]);} finally {f.close();}
    }
  });
  await check('成功回执更新flag，拒绝/缺字段不伪造ready，context_reset后直到刷新ready仍隐藏', async () => {
    let next = {source_context_ready: false, data: {}}, refreshReady = false;
    const f = await fixture({ready: undefined, toolReply: () => next, refresh: () => makeWorkspace(refreshReady)});
    try {
      // fixture默认值为false；显式移除模拟旧v1/旧完成回执的兼容快照。
      delete f.run.workspace_context.source_context_ready;
      f.workspace.replace(f.run.workspace_context);
      next = {data: {}};
      await f.data.invokeRecorded('read_conversation', 'legacy', {});
      assert.equal(f.run.workspace_context.source_context_ready, undefined);
      next = {source_context_ready: true, data: {error: 'source_not_allowed'}};
      await f.data.invokeRecorded('read_conversation', 'rejected', {});
      assert.equal(f.run.workspace_context.source_context_ready, undefined);
      next = {source_context_ready: false, data: {}};
      await f.data.invokeRecorded('read_conversation', 'hold', {});
      assert.equal(f.run.workspace_context.source_context_ready, false);
      next = {data: {}};
      await f.data.invokeRecorded('read_conversation', 'legacy-after-hold', {});
      assert.equal(f.run.workspace_context.source_context_ready, false);
      next = {source_context_ready: true, context_reset: taskB, data: {...taskB}};
      await f.data.invokeRecorded('update_analysis_task', 'reset', {action: 'route', task_id: taskB.task_id});
      assert.equal(f.run.workspace_context.source_context_ready, false, 'reset回执不能抢先放回旧材料');
      next = {source_context_ready: true, data: {hits: [identity]}};
      const pendingReceipt = await f.data.invokeRecorded('search_knowledge', 'next-before-refresh', {query: '合成乙', view: 'source_identity'});
      assert.equal(f.run.workspace_context.source_context_ready, false, '同批后续回执不绕过待刷新状态');
      const pendingBody = JSON.parse((await f.data.formatResult('search_knowledge',
        {query: '合成乙', view: 'source_identity'}, pendingReceipt)).content[0].text);
      assert.equal(pendingBody.source_context_ready, false, '等待刷新期间回执正文不得显示Rust原true为已可读');
      await f.projection.apply();
      assert.equal(f.run.workspace_context.source_context_ready, false, '刷新仍false时不恢复正文');
      await f.prompt(); hidden(f.payloads[0]);
      next = {source_context_ready: true, data: {}};
      await f.data.invokeRecorded('read_conversation', 'ready', {});
      assert.equal(f.run.workspace_context.source_context_ready, true);
      refreshReady = undefined;
      next = {source_context_ready: true, context_reset: taskB, data: {...taskB}};
      await f.data.invokeRecorded('update_analysis_task', 'missing-flag-refresh', {action: 'route', task_id: taskB.task_id});
      await f.projection.apply();
      assert.equal(f.run.workspace_context.source_context_ready, false, '新协议不能凭刷新缺flag恢复正文');
    } finally {f.close();}
  });
  await check('旧v1缺flag沿原行为，不把缺字段描述为安全隔离', async () => {
    const f = await fixture({ready: true,
      toolReply: () => ({context_reset: taskB, data: {...taskB}}),
      refresh: () => ({...makeWorkspace(undefined), active_task_ref: taskB})});
    try {
      delete f.run.workspace_context.source_context_ready; f.workspace.replace(f.run.workspace_context);
      await f.prompt(); assert.ok(raw(f.payloads[0]).includes(markers.tool));
      await f.data.invokeRecorded('update_analysis_task', 'legacy-reset', {action: 'route', task_id: taskB.task_id});
      assert.equal(f.projection.hidesSourceContext(), true, '旧reset仍需先完成原范围投影');
      await f.projection.apply();
      assert.equal(f.run.workspace_context.source_context_ready, undefined);
      assert.equal(f.projection.hidesSourceContext(), false, '旧v1刷新缺字段保持原兼容行为');
    } finally {f.close();}
  });
  await check('生产deliver的大历史预检及resume使用临时投影，首请求无旧正文，范围刷新后同session完成', async () => {
    for (const [resume, payloadLimit] of [[false, 131072], [true, 131072], [false, 16384]]) {
    const manager = SessionManager.inMemory('/synthetic/data-agent');
    manager.appendMessage({role: 'user', content: '先读取合成甲来源。', timestamp: 1});
    manager.appendMessage(assistant([{type: 'text', text: markers.assistant.repeat(20000)}]));
    if (resume) manager.appendMessage({role: 'user', content: currentText, timestamp: 2});
    const originalIds = manager.getBranch().map(entry => entry.id), sessionId = manager.getHeader().id;
    const payloads = [], hostErrors = [], finishes = [];
    let summaries = 0, reservations = 0;
    const sendSse = (response, delta) => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: ' + JSON.stringify({id: 'synthetic-deliver', choices: [{index: 0,
        delta: {role: 'assistant', ...delta}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
      response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}}) + '\n\n');
      response.end('data: [DONE]\n\n');
    };
    const server = createServer(async (request, response) => {
      const send = value => response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(value));
      try {
        let body = ''; for await (const part of request) body += part;
        const input = JSON.parse(body);
        if (request.url === '/chat/completions') {
          payloads.push(input); providerRequests++;
          if (!input.tools?.length) summaries++;
          assert.equal(summaries, 0, '不能为隐藏的旧历史先发送摘要');
          for (const marker of Object.values(markers)) assert.ok(!body.includes(marker));
          assert.ok(Buffer.byteLength(body) <= 131072, '实际投影继续受原容量门约束');
          return sendSse(response, payloads.length === 1 ? call('deliver-route-b', 'update_analysis_task',
            {action: 'route', task_id: taskB.task_id, expected_version: '1', options: []}) : {content: '已经切到合成乙范围。'});
        }
        if (request.url === '/internal/model/reserve') {reservations++; return send({state: 'reserved', send_allowed: false});}
        if (request.url === '/internal/model/send') return send({state: 'issued', send_allowed: true});
        if (request.url === '/internal/model/finalize') return send({state: input.usage ? 'settled' : 'unknown', send_allowed: false});
        if (request.url === '/internal/outputs') return send({chunk_seq: input.chunk_seq});
        if (request.url === '/internal/data/tool-calls') return send({operation_id: 'deliver-operation', tool_contract_version: 2});
        if (request.url === '/internal/data/tools') return send({operation_id: 'deliver-operation', tool_contract_version: 2,
          tool_name: 'update_analysis_task', data: {...taskB}, source_context_ready: true, context_reset: taskB});
        if (request.url === '/internal/context/refresh') return send({...makeWorkspace(true), active_task_ref: taskB,
          tasks: [], query_observations: [], memories: [], selected_skills: []});
        assert.equal(request.url, '/internal/finish');
        decodeContract('FinishRun', input); finishes.push(input);
        return send({state: 'finished', output_id: 'deliver-output'});
      } catch (error) {
        hostErrors.push(error.stack);
        response.writeHead(500, {'content-type': 'application/json'}).end(JSON.stringify({code: 'unavailable',
          request_id: 'synthetic-request', message: '合成本地协议失败', retryable: false}));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const previousEnv = new Map(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DATA_AGENT_PROVIDER_TEST']
      .map(name => [name, process.env[name]]));
    const blockedFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => new URL(input instanceof Request ? input.url : String(input)).origin === origin
      ? originalFetch(input, init) : blockedFetch(input, init);
    try {
      Object.assign(process.env, {DEEPSEEK_API_KEY: 'synthetic-only', DEEPSEEK_BASE_URL: origin, DATA_AGENT_PROVIDER_TEST: '1'});
      const run = {run_id: 'deliver-run', request_id: 'deliver-request', conversation_id: 'deliver-conversation',
        recovery_chain_id: 'deliver-chain', lease_epoch: '1', budget_scope_id: 'deliver-budget', output_id: 'deliver-output',
        attempt_id: 'deliver-attempt', message_id: 'deliver-message', text: currentText, checkpoint: exportCheckpoint(manager),
        tool_contract_version: 2, resume_same_input: resume, workspace_context: makeWorkspace(false),
        model_profile: {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: 'synthetic-trial',
          price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 2048, payload_bytes_limit: payloadLimit,
          request_call_limit: 24, toolset: 'data', thinking_level: 'off'}};
      if (payloadLimit === 16384) {
        await assert.rejects(() => deliver(run, origin, 'synthetic-token', ''),
          error => error.message === 'model_run_failed' && error.code === 'request_too_large: model_input_limit');
        assert.deepEqual(hostErrors, []); assert.equal(payloads.length, 0); assert.equal(finishes.length, 0);
        assert.equal(reservations, 0, '临时投影自身超限仍在预留和发送前明确失败');
        continue;
      }
      await deliver(run, origin, 'synthetic-token', '');
      assert.deepEqual(hostErrors, []); assert.equal(payloads.length, 2); assert.equal(finishes.length, 1);
      hidden(payloads[0]);
      assert.deepEqual(assertSourceSearch(payloads[0], false), assertSourceSearch(payloads[1], true),
        '实际首轮及恢复的声明前后均保留同一身份与精读工具合同');
      const restored = restoreCheckpoint('/synthetic/data-agent', finishes[0].checkpoint);
      assert.equal(restored.getHeader().id, sessionId);
      for (const id of originalIds) assert.ok(restored.getBranch().some(entry => entry.id === id));
      assert.ok(JSON.stringify(restored.getEntries()).includes(markers.assistant), '完整旧历史保留在同一session树');
    } finally {
      globalThis.fetch = blockedFetch;
      for (const [name, value] of previousEnv) {if (value === undefined) delete process.env[name]; else process.env[name] = value;}
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    }
  });
  await check('v2搜索说明以正式身份版本选择原文精读，选择不扩来源许可', async () => {
    const f = await fixture({ready: true, reply(payload) {
      const search = payload.tools.find(tool => tool.function.name === 'search_knowledge');
      assert.ok(search.function.parameters.properties.source_selection, '精确选择参数必须进入实际工具定义');
      assert.match(search.function.description, /source_selection/);
      assert.match(search.function.description, /object_version/);
      assert.match(search.function.description, /不扩许可/);
      return {content: '按正式身份选择获准原文。'};
    }});
    try {await f.prompt();} finally {f.close();}
  });
  await check('实际请求明确平台原始文本去重及统计范围，跨页distinct不可相加', async () => {
    const f = await fixture({ready: true, reply(payload) {
      assert.match(raw(payload), /distinct_count按平台返回的原始文本去重/);
      assert.match(raw(payload), /不含NULL/);
      assert.match(raw(payload), /跨页.*不可相加/);
      return {content: '按平台统计范围解释。'};
    }});
    try {await f.prompt();} finally {f.close();}
  });
  await check('查询说明将仅回状态限定到本消息刚确认，历史查询仍可查看', async () => {
    const f = await fixture({ready: true, reply(payload) {
      const query = payload.tools.find(tool => tool.function.name === 'get_query');
      assert.match(query.function.description, /本消息刚确认的查询只返状态/);
      return {content: '按当前消息确认归属查看。'};
    }});
    try {await f.prompt();} finally {f.close();}
  });
  await check('展示偏好与指标定义单位区分的指导及记忆范围/例外进入实际请求', async () => {
    const preference = '合成出行月报默认以公里、两位小数展示距离；当次要求米时以当次为准，不适用其他报告。';
    const f = await fixture({ready: true});
    try {
      f.workspace.replace({...f.run.workspace_context, memories: [asset('memory', 'synthetic-distance-preference', preference)]});
      await f.prompt();
      const payload = raw(f.payloads[0]);
      assert.ok(payload.includes(preference), '完整偏好及限定/例外不变');
      assert.ok(payload.includes('指标定义/存储单位与展示单位分开'), '实际系统指导须区分指标定义单位和展示单位');
      assert.ok(payload.includes('适用且不冲突的稳定偏好用于本次展示'), '范围内偏好应实际应用，而非被共享存储单位覆盖');
      assert.ok(!payload.includes('秒三位') && !payload.includes('毫秒时'), '不把真实原题答案写入指导');
    } finally {f.close();}
  });
  await check('原生压缩后真实范围刷新撤下长保留组，后续provider请求不带旧容量开销', async () => {
    const plan = deriveCapacityPlan(65536, 50000, 8192);
    const slack = plan.trigger - plan.summaryCap - plan.splitSummaryCap - plan.keepRecent;
    let fixed = slack - 2500, normalRequests = 0;
    const f = await fixture({ready: true, capacityPlan: plan, fixedOverhead: () => fixed,
      retainedText: 'x'.repeat((plan.keepRecent + 1500) * 4), afterReplace: () => {fixed += 2000;},
      reply(payload) {
        if (!payload.tools?.length) return {content: '合成历史摘要。'};
        if (normalRequests++ === 0) return call('capacity-route', 'update_analysis_task',
          {action: 'route', task_id: taskB.task_id, expected_version: '1', options: []});
        assert.ok(!raw(payload).includes('x'.repeat(100)), '新范围请求不携旧长正文');
        return {content: '按新范围继续。'};
      }, toolReply: () => ({data: {task_id: taskB.task_id, condition_version: '1'},
        source_context_ready: true, context_reset: taskB})});
    try {
      await f.session.compact();
      await f.prompt();
      assert.equal(normalRequests, 2, '范围刷新后的第一个provider请求应正常发送');
      assert.equal(f.manager.getBranch().filter(entry => entry.type === 'compaction').length, 2,
        '仅原生压缩和既有范围替换，不新增摘要/恢复循环');
    } finally {f.close();}
  });
  await check('隐藏期间原生compact在摘要发出前取消，原leaf与历史保留；ready后仍能原生compact', async () => {
    const f = await fixture({reply: (_payload, index) => index === 1
      ? call('compact-admission', 'update_analysis_task', {action: 'route', task_id: null, expected_version: null, options: []})
      : {content: '已继承原范围。'}, toolReply: () => ({source_context_ready: true, data: {task_id: null, condition_version: null}})});
    try {
      const leaf = f.manager.getLeafId(), count = f.manager.getEntries().length;
      await assert.rejects(f.session.compact(), /Compaction cancelled/);
      assert.equal(f.payloads.length, 0, '摘要不经过context事件，必须在SDK压缩入口阻止');
      assert.equal(f.manager.getLeafId(), leaf); assert.equal(f.manager.getEntries().length, count);
      await f.prompt();
      const beforeCompact = f.payloads.length;
      const result = await f.session.compact();
      // SDK可分别压缩历史和split-turn前缀；两次均为原生摘要，不固定调用次数。
      const summaries = f.payloads.slice(beforeCompact);
      assert.ok(result); assert.ok(summaries.length >= 1);
      assert.ok(summaries.every(payload => !payload.tools?.length));
      assert.ok(summaries.some(payload => raw(payload).includes(markers.tool)));
      assert.equal(f.manager.getHeader().id, f.sessionId);
    } finally {f.close();}
  });
} finally {globalThis.fetch = originalFetch;}
const report = {passed: failures.length === 0, checks, failures, providerRequests, networkAttempts, officialRequests: 0,
  boundary: 'Node消费者使用合法宿主flag的真实Pi循环与实际序列化mock payload；不代替Rust生产者、路由准入或正式整链验收。隐藏期间SDK手动compact会明确取消；生产deliver跳过旧分支预检压缩，实际provider容量门保持原上限。'};
await mkdir('.local/checks/source-authority-repair', {recursive: true});
await writeFile('.local/checks/source-authority-repair/node-request-context.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
assert.equal(report.passed, true, 'source_context_ready消费者反例未全部通过');
