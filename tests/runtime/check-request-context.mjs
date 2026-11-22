import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {InMemoryModelsStore} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {streamSimple as streamAnthropic} from '@earendil-works/pi-ai/api/anthropic-messages';
import {createAgentSession, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {resources} from '../../apps/agent/session/resources.ts';
import {workspaceContext} from '../../apps/agent/session/workspace-context.ts';
import {taskProjection} from '../../apps/agent/session/task-projection.ts';
import {selectedSkillResources} from '../../apps/agent/session/skills.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {RECOVERY_NOTICE} from '../../apps/agent/session/checkpoint.ts';
import {decodeContract} from '../../packages/contracts/validate.ts';
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
  projection = taskProjection(transport, manager, value => {workspace.replace(value); afterReplace();}, () => session.refreshContext());
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
  const unbind = await session.bindExtensions({onError: error => errors.push(error)});
  const prompt = async () => {
    await session.prompt(resume ? RECOVERY_NOTICE + ' 继续处理原输入。' : text, {expandPromptTemplates: false});
    if (providerFailure) throw providerFailure;
    assert.deepEqual(errors, [], 'Pi不能吞下投影异常后继续带原上下文');
    assert.equal(manager.getHeader().id, sessionId);
    for (const id of originalEntries) assert.ok(manager.getEntries().some(entry => entry.id === id), '原会话树完整保留历史');
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
        : (message.content ?? []).map(part => part.text ?? '').join('')).find(text => text.startsWith('当前宿主事实。'));
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
  await check('普通续接保留工具与原会话，原生压缩保留仍可用的历史', async () => {
    for (const compacted of [false, true]) {
      const f = await fixture({compacted});
      try {
        await f.prompt();
        const payload = raw(f.payloads[0]);
        for (const name of ['search_knowledge', 'read_knowledge', 'read_source', 'validate_sql'])
          assert.ok(f.payloads[0].tools.some(tool => tool.function.name === name));
        for (const marker of Object.values(markers).filter(value => compacted || value !== markers.summary))
          assert.ok(payload.includes(marker));
      } finally {f.close();}
    }
  });
  await check('身份结果可选稳定细源，范围改变先刷新再读正文，后续来源门负控仍拒绝', async () => {
    let f, refreshes = 0;
    const citation = source => ({source, revision: '1', locator: {offset: 0, length: 12}});
    const directory = {hits: [identity], search_coverage: {state: 'bounded', next: 'synthetic-identity-next',
      reasons: ['candidate_limit'], channels: [{channel: 'exact', state: 'available'}]}};
    f = await fixture({reply(payload, index) {
      assert.ok(payload.tools.some(tool => tool.function?.name === 'read_source'));
      if (index > 2) assert.ok(!raw(payload).includes(markers.tool), '显式变更范围后移出旧正文');
      if (index === 1) return call('identity-b', 'search_knowledge', {query: '合成乙资料', view: 'source_identity'});
      if (index === 2) {
        assert.deepEqual(toolBody(payload, 'identity-b'), directory);
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
      refreshes++;
      return {...makeWorkspace(true), active_task_ref: taskB, memories: [], selected_skills: [], tasks: [], query_observations: []};
    }});
    try {await f.prompt(); assert.equal(f.payloads.length, 5); assert.deepEqual(f.run.workspace_context.active_task_ref, taskB);}
    finally {f.close();}
  });
  await check('同范围route后DeepSeek完整回放原reasoning_content及配对工具回合', async () => {
    // https://api-docs.deepseek.com/guides/thinking_mode/ 要求携tools时完整回传reasoning_content。
    const staleThought = '合成route前暂缺get_query和execute_query的旧思考哨兵';
    const f = await fixture({reasoning: true, reply(payload, index) {
      if (index === 1) {
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
      assert.equal(toolBody(payload, 'route-before-exec').routed, true);
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
  await check('同范围route后Anthropic原生序列化完整回放thinking及signature并匹配tool_result', async () => {
    // https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows 要求原块与签名不变。
    const thinking = '合成来源确认前的思考', signature = 'synthetic-original-thinking-signature';
    const f = await fixture({api: 'anthropic-messages', reasoning: true, reply(payload, index) {
      if (index === 1) {
        assert.ok(payload.tools.some(tool => tool.name === 'get_query'));
        return {reasoning_content: thinking, thinking_signature: signature,
          ...call('anthropic-route', 'update_analysis_task', {action: 'route', task_id: taskA.task_id, expected_version: '1', options: []})};
      }
      assert.ok(payload.tools.some(tool => tool.name === 'get_query'), '实际SDK的Anthropic工具集合始终开放');
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
  await check('同范围继续使用原会话和选用的Skill，普通浏览route无需create', async () => {
    const f = await fixture({compacted: true, reply(payload, index) {
      if (index === 1) {return call('inherit-a', 'update_analysis_task', {action: 'route', task_id: null, expected_version: null, options: []});}
      assert.ok(raw(payload).includes(markers.tool));
      assert.ok(raw(payload).includes(markers.summary), '原压缩上下文在继承原范围后可恢复');
      assert.ok(raw(payload).includes(markers.memory), '保留已采用的记忆候选');
      assert.ok(raw(payload).includes(markers.directory), '保留已选Skill目录');
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
      try {await f.prompt(); assert.ok(raw(f.payloads[0]).includes(JSON.stringify(currentText).slice(1, -1)));} finally {f.close();}
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
      assert.equal(f.manager.getEntries().filter(entry => entry.type === 'compaction').length, 1,
        '范围变化沿同一会话树续接，无人工强制摘要');
    } finally {f.close();}
  });
  await check('原生压缩按容量和已选分支运行，调用与恢复仍沿同一会话', async () => {
    const f = await fixture();
    try {
      await f.prompt();
      const beforeCompact = f.payloads.length;
      const result = await f.session.compact();
      const summaries = f.payloads.slice(beforeCompact);
      assert.ok(result);
      assert.ok(summaries.length >= 1);
      assert.ok(summaries.every(payload => !payload.tools?.length));
      assert.ok(summaries.some(payload => raw(payload).includes(markers.tool)));
      assert.equal(f.manager.getHeader().id, f.sessionId);
    } finally {f.close();}
  });
} finally {globalThis.fetch = originalFetch;}
const report = {passed: failures.length === 0, checks, failures, providerRequests, networkAttempts, officialRequests: 0,
  boundary: '真实 Pi 与本地合成协议。Rust 来源授权与恢复由整链另验。'};
await mkdir('.local/checks/source-authority-repair', {recursive: true});
await writeFile('.local/checks/source-authority-repair/node-request-context.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
assert.equal(report.passed, true, 'Pi 上下文消费者检查未全部通过');
