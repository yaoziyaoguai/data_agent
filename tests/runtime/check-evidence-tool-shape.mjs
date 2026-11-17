import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {Ajv2020} from 'ajv/dist/2020.js';
import {fullFormats} from 'ajv-formats/dist/formats.js';
import {InMemoryModelsStore} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {createAgentSession, ModelRuntime, SessionManager, SettingsManager, VERSION} from '@earendil-works/pi-coding-agent';
import schema from '../../packages/contracts/schema.json' with {type: 'json'};
import {resources} from '../../apps/agent/session/resources.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';

const run = {request_id: 'request', run_id: 'run', lease_epoch: '1', conversation_id: 'conversation',
  recovery_chain_id: 'chain', budget_scope_id: 'budget', output_id: 'output', attempt_id: 'attempt',
  message_id: 'message', text: '核对合成资料', checkpoint: null, model_profile: null};
const cases = JSON.parse(await readFile(new URL('../contracts/cases.json', import.meta.url), 'utf8'));
const mixed = cases.find(value => value.name === 'mixed search keeps knowledge nullable support completeness and raw citation').value;
for (const version of [undefined, 1, 2]) {
  const state = dataTools(new RustTransport({...run, ...(version ? {tool_contract_version: version} : {})}, 'http://127.0.0.1:1', 'synthetic-unused'), SessionManager.inMemory('/synthetic/evidence-tool-shape'), '');
  const taskTool = state.tools.find(tool => tool.name === 'update_analysis_task');
  const taskParameters = JSON.stringify(taskTool.parameters);
  if (version === 2) {
    assert.doesNotMatch(taskParameters, /"(?:web|app|store)"/,
      '当前任务参数不能把旧零售渠道当作分析候选；业务渠道通过通用 filters 表达');
    const fields = taskTool.parameters.allOf.find(branch => branch.properties).properties;
    assert.deepEqual(fields.conditions.properties.channel, {type: 'null'}, '完整条件保留空兼容字段');
    assert.equal(Object.hasOwn(fields.condition_patch.properties.set.properties, 'channel'), false,
      '当前条件补丁不再引导写旧渠道字段，历史字段仍可通过 unset 清除');
    assert.ok(!fields.condition_patch.properties.set.required?.includes('channel'));
    assert.ok(fields.condition_patch.properties.unset.items.enum.includes('channel'));
    assert.ok(fields.conditions.properties.filters);
  } else assert.match(taskParameters, /"web"/, '旧工具合同与历史调用保持可读');
  const tool = state.tools.find(tool => tool.name === 'search_knowledge');
  assert.ok(tool);
  assert.equal(tool.executionMode, 'sequential');
  assert.equal(Object.hasOwn(tool.parameters.properties, 'related_object_id'), version !== 2, '历史缺省1及显式1保持硬范围；2使用独立合同');
  const knowledgeTool = state.tools.find(tool => tool.name === 'read_knowledge');
  assert.equal(Object.hasOwn(knowledgeTool.parameters.properties, 'items'), version === 2);
  assert.equal(Object.hasOwn(knowledgeTool.parameters.properties, 'object_id'), version !== 2);
  if (version === 2) {
    assert.ok(JSON.stringify(knowledgeTool.parameters).includes('asset_ref'));
    const memory = cases.find(value => value.name === 'memory batch success preserves independent source page and nullable next offset').value;
    const formatted = await state.formatResult('read_knowledge', {items: [{kind: 'memory', asset_ref: {id: 'synthetic-memory', version: '2'}, part: 'source_text'}]},
      {operation_id: 'memory-operation', tool_name: 'read_knowledge', tool_contract_version: 2, data: memory});
    assert.deepEqual(JSON.parse(formatted.content[0].text), memory, '记忆正文与独立分页从Rust到Pi保持原JSON');
  }
  const sourceTool = state.tools.find(tool => tool.name === 'read_source');
  assert.equal(Object.hasOwn(sourceTool.parameters.properties, 'citation'), version === 2, 'v2原文补读必须绑定citation，旧合同保持source_id/version');
  assert.equal(Object.hasOwn(sourceTool.parameters.properties, 'source_id'), version !== 2);
  const receipt = {operation_id: 'operation', tool_name: 'search_knowledge',
    ...(version ? {tool_contract_version: version} : {}), data: version === 2 ? mixed : {objects: [], name: '合成旧目录'}};
  const result = await state.formatResult('search_knowledge', {query: '合成'}, receipt);
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, receipt);
  if (version === 2) {
    assert.deepEqual(JSON.parse(result.content[0].text), mixed, 'v2从Rust到SDK必须无损且无额外字段');
    assert.equal(result.content[0].text, JSON.stringify(mixed));
  } else assert.equal(JSON.parse(result.content[0].text).display_name, '合成旧目录');
}
const checks = [];
const hostAjv = new Ajv2020({strict: false, allErrors: true});
hostAjv.addFormat('date-time', fullFormats['date-time']);
const hostInvocation = hostAjv.compile({...schema, $id: undefined, properties: undefined, required: undefined,
  type: undefined, additionalProperties: undefined, $ref: '#/$defs/DataToolInvocation'});
const token = 'synthetic-original-tool-version';
const budget = {max_bytes: 1600, estimated_tokens: 400, projection_fingerprint: 'a'.repeat(64)};
const memory = cases.find(value => value.name === 'memory batch success preserves independent source page and nullable next offset').value;
const oldArgs = {object_id: 'synthetic-memory', version: '2', entry_id: 'body'};
const oldData = {id: 'synthetic-memory', version: '2', kind: 'memory', name: '合成旧记忆', body: '保留范围和例外。'};
const newArgs = {items: [{kind: 'memory', asset_ref: {id: 'synthetic-memory', version: '2'}, part: 'source_text'}]};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function check(name, test) {
  const evidence = {name, passed: false};
  try {await test(evidence); evidence.passed = true;}
  catch (error) {evidence.error = error.stack;}
  checks.push(evidence);
}

async function restoreTool(options, evidence) {
  const {currentVersion, originalVersion, registrationVersion, outcomeVersion, rejected = false, fresh = false} = options;
  const args = options.args ?? (originalVersion === 2 ? newArgs : oldArgs);
  const data = rejected ? {error: 'invalid_evidence', outcome: 'rejected', hint: '保留原拒绝事实。'}
    : options.data ?? (originalVersion === 2 ? memory : oldData);
  const call = {type: 'toolCall', id: 'original-read', name: options.toolName ?? 'read_knowledge', arguments: args};
  const stored = {operation_id: 'original-operation', tool_name: call.name, data,
    ...(outcomeVersion === undefined ? {} : {tool_contract_version: outcomeVersion})};
  const frozen = JSON.stringify(stored);
  const signature = digest({name: call.name, arguments: args});
  const calls = [], inputs = [], providerPayloads = [], hostErrors = [], accepted = [], budgetClaims = [];
  let businessCommits = 0;
  const server = createServer(async (request, response) => {
    const send = (status, value) => response.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify(value));
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      if (request.url === '/v1/chat/completions') {
        providerPayloads.push(input);
        assert.equal(providerPayloads.length, 1, '恢复只续答一次，不重新规划原工具');
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.write('data: ' + JSON.stringify({id: 'synthetic-original-version', object: 'chat.completion.chunk',
          choices: [{index: 0, delta: {role: 'assistant', content: '已核对原回执。'}, finish_reason: 'stop'}]}) + '\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      assert.ok(hostInvocation(input), JSON.stringify(hostInvocation.errors));
      assert.equal(input.run_id, 'current-run');
      assert.equal(input.lease_epoch, '7');
      assert.equal(input.sdk_tool_call_id, call.id);
      assert.equal(digest({name: input.tool_name, arguments: input.arguments}), signature,
        '当前运行和容量提示不能改变原业务指纹');
      calls.push(request.url); inputs.push(input);
      if (request.url === '/internal/data/tool-calls')
        return send(200, {operation_id: stored.operation_id,
          ...(registrationVersion === undefined ? {} : {tool_contract_version: registrationVersion})});
      if (request.url === '/internal/data/tool-rejections') {
        assert.equal(rejected, true);
        return send(200, stored);
      }
      assert.equal(request.url, '/internal/data/tools');
      if (rejected) return send(403, {code: 'invalid_evidence', message: '原工具已拒绝', request_id: 'request', retryable: false});
      if (fresh) businessCommits++;
      return send(200, stored);
    } catch (error) {
      hostErrors.push(error.stack);
      if (!response.headersSent) send(500, {code: 'unavailable', message: '合成端点失败', request_id: 'request', retryable: false});
      else response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const url = 'http://127.0.0.1:' + server.address().port;
  const transport = new RustTransport({...run, run_id: 'current-run', lease_epoch: '7',
    tool_contract_version: currentVersion}, url, token);
  const manager = SessionManager.inMemory('/synthetic/original-tool-version');
  const state = dataTools(transport, manager, '', (receipt, id) => accepted.push({receipt, id}), (id, usage) => {
    budgetClaims.push({id, usage}); return budget;
  });
  const runtime = await ModelRuntime.create({
    credentials: {read: async () => undefined, list: async () => [], modify: async () => {throw new Error('disabled');},
      delete: async () => {throw new Error('disabled');}},
    modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false,
  });
  runtime.registerProvider('synthetic_original_version', {
    api: 'openai-completions', apiKey: 'synthetic-only', baseUrl: url + '/v1',
    streamSimple: (model, context, options) => streamSimple(model, context, {...options, apiKey: 'synthetic-only', maxRetries: 0}),
    models: [{id: 'synthetic-original-version', name: 'Synthetic original version', api: 'openai-completions',
      reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 1024,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
  });
  const model = runtime.getModel('synthetic_original_version', 'synthetic-original-version');
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  manager.appendMessage({role: 'user', content: run.text, timestamp: 1});
  manager.appendMessage({role: 'assistant', content: [call], api: model.api, provider: model.provider,
    model: model.id, usage, stopReason: 'toolUse', timestamp: 2});
  const originalSession = manager.getSessionId();
  let session;
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== url) {externalRequests++; throw new Error('nonlocal request forbidden');}
    return originalFetch(input, init);
  };
  try {
    let formatted, received;
    if (fresh) formatted = await state.tools.find(tool => tool.name === call.name).execute(call.id, args);
    else {
      const unfinished = manager.buildSessionContext().messages.at(-1).content[0];
      received = await state.invokeRecorded(unfinished.name, unfinished.id, unfinished.arguments, 12000);
      formatted = await state.formatResult(unfinished.name, unfinished.arguments, received);
    }
    // 沿正式半轮入口接回原调用，再由Pi原生会话和协议序列化交付模型。
    manager.appendMessage({role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: formatted.content, details: formatted.details, isError: formatted.isError, timestamp: 3});
    ({session} = await createAgentSession({cwd: '/synthetic/original-tool-version', modelRuntime: runtime, model,
      thinkingLevel: 'off', settingsManager: SettingsManager.inMemory({defaultTools: [], compaction: {enabled: false}, retry: {enabled: false}}),
      sessionManager: manager, resourceLoader: resources(true), tools: state.tools.map(tool => tool.name), customTools: state.tools}));
    await session.prompt('继续处理原输入，沿已接回的工具回执续答。', {expandPromptTemplates: false});
    const providerResult = providerPayloads.flatMap(payload => payload.messages)
      .find(message => message.role === 'tool' && message.tool_call_id === call.id);
    assert.ok(providerResult, '实际本地模型协议必须收到原toolResult');
    const expected = options.expected ?? (!rejected && originalVersion === 1 ? {display_name: oldData.name, ...oldData} : data);
    evidence.providerBodyHash = digest(providerResult.content);
    evidence.calls = calls;
    evidence.budgetClaims = budgetClaims;
    assert.equal(providerResult.content, JSON.stringify(expected), '恢复必须按原tool合同包装，不能随当前run换形状');
    assert.equal(formatted.content[0].text, providerResult.content);
    assert.equal(formatted.isError, rejected);
    assert.deepEqual(formatted.details, accepted[0].receipt);
    if (received) assert.deepEqual(received, formatted.details);
    assert.equal(accepted[0].id, call.id);
    assert.equal(accepted[0].receipt.operation_id, stored.operation_id);
    assert.equal(manager.getSessionId(), originalSession);
    assert.equal(JSON.stringify(stored), frozen, '旧成功正文和拒绝回执不被恢复写回');
    assert.equal(businessCommits, fresh ? 1 : 0);
    assert.equal(providerPayloads.length, 1);
    assert.deepEqual(calls, ['/internal/data/tool-calls', '/internal/data/tools',
      ...(rejected ? ['/internal/data/tool-rejections'] : [])]);
    const budgeted = registrationVersion === 2 && call.name === 'read_knowledge';
    assert.equal(budgetClaims.length, budgeted ? 1 : 0,
      '容量提示只随原登记tool v2领取，不随当前run版本');
    assert.equal(Object.hasOwn(inputs[0], 'response_budget'), false, '登记先查原账本，不预用当前run的容量提示');
    for (const input of inputs.slice(1)) assert.deepEqual(input.response_budget, budgeted ? budget : undefined);
    assert.deepEqual(hostErrors, []);
    assert.equal(externalRequests, 0);
    return {providerContent: providerResult.content,
      systemPrompt: String(providerPayloads[0].messages.find(message => message.role === 'system')?.content ?? '')};
  } finally {
    if (session) {await session.abort(); session.dispose();}
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    evidence.hostErrors = hostErrors;
    evidence.externalRequests = externalRequests;
    evidence.businessCommits = businessCommits;
    evidence.providerRequests = providerPayloads.length;
  }
}

await check('历史缺版本tool v1在当前run2恢复仍保旧包装与原operation', evidence =>
  restoreTool({currentVersion: 2, originalVersion: 1}, evidence));
await check('显式原tool v1优先于当前run2且不领取v2容量', evidence =>
  restoreTool({currentVersion: 2, originalVersion: 1, registrationVersion: 1, outcomeVersion: 1}, evidence));
// 已成功登记的退休参数故意不符合当前Schema；恢复不能据此重做或追加显示字段。
const recordedArgs = {...newArgs, goal: '已退休的合成定位说明'};
await check('原tool v2在当前run1恢复，实际provider正文不附显示字段', evidence =>
  restoreTool({currentVersion: 1, originalVersion: 2, registrationVersion: 2, outcomeVersion: 2, args: recordedArgs}, evidence));
await check('原v2成功回执缺版本时沿登记回执补足，仍无损接入Pi', evidence =>
  restoreTool({currentVersion: 1, originalVersion: 2, registrationVersion: 2, args: recordedArgs}, evidence));
await check('结果回执显式原v2版本在历史登记缺字段时仍保持无损', evidence =>
  restoreTool({currentVersion: 1, originalVersion: 2, outcomeVersion: 2, args: recordedArgs}, evidence));
for (const originalVersion of [1, 2]) await check('原tool v' + originalVersion + '拒绝在反向run恢复，先接拒绝账本', evidence =>
  restoreTool({currentVersion: originalVersion === 1 ? 2 : 1, originalVersion,
    registrationVersion: originalVersion, outcomeVersion: originalVersion, rejected: true, args: recordedArgs}, evidence));
await check('新tool v2经正式execute及HTTP接收后按原回执进入Pi', evidence =>
  restoreTool({currentVersion: 2, originalVersion: 2, registrationVersion: 2, outcomeVersion: 2, fresh: true}, evidence));

const legacyConditions = structuredClone(cases.find(value => value.name === 'task conditions preserve UTC boundaries and the business timezone').value);
legacyConditions.channel = 'web';
for (const args of [
  {action: 'create', goal: '旧渠道分析', conditions: legacyConditions, options: []},
  {action: 'revise', task_id: 'original-task', expected_version: '1', condition_patch: {set: {channel: 'app'}, unset: []}},
]) await check('原v2已登记' + args.action + '的旧渠道参数恢复不经过新模型参数形状', evidence =>
  restoreTool({currentVersion: 2, originalVersion: 2, registrationVersion: 2, outcomeVersion: 2,
    toolName: 'update_analysis_task', args, data: {task_id: 'original-task', condition_version: '2'},
    expected: {...(args.action === 'create' ? {display_name: '旧渠道分析'} : {}), task_id: 'original-task', condition_version: '2'}}, evidence));

// DA-001 §4.1：原Q02真实代表运行留下的合成 read_knowledge 回执（toolCalls 与 toolObservations 的 outcome 逐字一致，
// 来源 .local/checks/query-submission-implementation-20261110/real-representative.json）经当前正式路径重新交付。
// 证明当前机制把完整指标定义、匿名边界规则和正文分页状态送进模型协议正文；
// 不冒充历史最终 HTTP 请求已被记录，也不证明真实模型会遵守这些正文。
const q02ReadReceiptData = JSON.parse(await readFile(new URL('./fixtures/q02-read-knowledge-receipt-data.json', import.meta.url), 'utf8'));
const q02ReadArgs = {items: [{kind: 'knowledge', ref: {object_id: 'metric-paying_customers', version: '1', path: 'definition'}},
  {kind: 'knowledge', ref: {object_id: 'document-guide-4', version: '1', path: 'body'}}],
  task_ref: {condition_version: '1', task_id: '3604bf57-a16d-431a-8eba-6c10f78b7b5d'}};
await check('Q02原read_knowledge回执经正式执行与Pi会话完整交付指标定义与匿名规则', async evidence => {
  const {providerContent, systemPrompt} = await restoreTool({currentVersion: 2, originalVersion: 2, registrationVersion: 2,
    outcomeVersion: 2, fresh: true, args: q02ReadArgs, data: q02ReadReceiptData}, evidence);
  // §4.2 规则接线：新指标与诊断分离规则须实际装配进provider系统提示，不能只存在源码里。
  assert.ok(systemPrompt.includes('记录存在不等于新增实体'), '实体识别约束必须进入实际provider系统提示');
  assert.ok(systemPrompt.includes('身份缺失不能证明不同于已知实体，也不能证明多个缺失记录对应不同实体'));
  assert.ok(systemPrompt.includes('去重键、粒度及包含/互斥关系足以支持时'), '有依据的合并与界限仍须允许');
  assert.ok(systemPrompt.includes('最终解释也须核对上述实体关系'), '规则覆盖SQL后的结果解释');
  assert.ok(systemPrompt.includes('匿名订单数'));
  assert.ok(systemPrompt.includes('保存SQL前核对度量表达式、已定解释、字段粒度和诊断列是否一致'));
  const delivered = JSON.parse(providerContent);
  const definition = delivered.items.find(item => item.ref?.object_id === 'metric-paying_customers');
  const guide = delivered.items.find(item => item.ref?.object_id === 'document-guide-4');
  assert.ok(definition?.content.includes('COUNT(DISTINCT customer_id)'), '完整指标定义必须进入模型协议正文');
  assert.ok(definition.content.includes('匿名客户不计已知客户数'));
  assert.ok(guide?.content.includes('空值表示匿名购买，不能补成一个统一客户参与 UV'), '匿名边界文档规则必须进入模型协议正文');
  for (const [item, chars] of [[definition, 434], [guide, 1150]]) {
    assert.equal(item.content_state, 'complete');
    assert.deepEqual(item.content_page, {offset: 0, complete: true, next_offset: null, total_chars: chars},
      '正文分页状态保留且与正文字数一致，不被裁剪');
    assert.equal(item.content.length, chars);
  }
});

const sourceHashes = {};
for (const path of ['apps/agent/session/resources.ts', 'apps/agent/tools/data-tools.ts', 'tests/runtime/check-evidence-tool-shape.mjs',
  'tests/runtime/fixtures/q02-read-knowledge-receipt-data.json',
  'packages/contracts/schema.json', 'packages/contracts/generated/boundary.ts', 'packages/contracts/generated/boundary.rs'])
  sourceHashes[path] = createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex');
const passed = checks.every(check => check.passed);
const report = {passed, node: process.version, piSdk: VERSION, checks, sourceHashes,
  boundary: 'actual invokeRecorded/execute, RustTransport HTTP, native Pi session, local OpenAI protocol payload',
  officialRequests: 0, databaseUsed: false, rustProviderUsed: false};
await mkdir('.local/evidence-delivery-20261029-902223e3', {recursive: true});
await writeFile('.local/evidence-delivery-20261029-902223e3/original-tool-version-runtime.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.ok(passed, '原tool版本恢复与Pi包装检查未全部通过');
