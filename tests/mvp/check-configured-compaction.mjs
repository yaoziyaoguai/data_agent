import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

// 配置服务、真实MySQL、真实Pi压缩和工具账本；只有供应商回复及历史材料为合成输入。
const definition = {
  id: 'configured-compaction', service_id: 'configured-compaction-service',
  model_id: 'synthetic/configured-compaction', label: '合成中型上下文模型',
  thinking_levels: ['off'], reasoning_supported: false, default_thinking: 'off',
  context_window: 240000, input_limit: 200000, output_limit: 35000,
  payload_bytes_limit: 1048576, request_timeout_ms: 600000,
  capability_source: 'admin_declared', input_rate: '0', output_rate: '0',
  enabled: true, expected_version: '0',
};
const zeroUsage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const requests = [], providerErrors = [], checks = [];
let passed = false, h, currentRun, ordinaryMode = 'route';
const currentPhase = () => currentRun?.message_id ?? 'no-run';
const contentText = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    const text = payload.messages.map(contentText).join('\n');
    const summary = !payload.tools?.length;
    const kind = summary ? (text.includes('earlier context from an ongoing conversation') ? 'turn_prefix' : 'history') : 'ordinary';
    const bytes = Buffer.byteLength(raw);
    // 本地协议的usage按实际输入正文估算；不是现实模型tokenizer或质量评分。
    const inputTokens = Math.ceil(raw.length / 4);
    requests.push({message: currentPhase(), run: currentRun?.run_id, scope: currentRun?.budget_scope_id,
      kind, bytes, inputTokens, outputCap: payload.max_tokens ?? payload.max_completion_tokens});
    assert.ok(currentRun, '请求必须关联当前真实宿主run');
    assert.ok(bytes <= currentRun.model_profile.payload_bytes_limit, '已知超字节请求不得到达供应商');
    assert.ok(inputTokens <= currentRun.model_profile.input_limit, '已知超输入摘要不得到达供应商');
    assert.ok(requests.at(-1).outputCap <= currentRun.model_profile.output_limit);
    let delta;
    if (summary) delta = {role: 'assistant', content: kind === 'history'
      ? '合成历史摘要：既有上下文围绕文档解释；保留已登记工具和真实条件。'
      : '合成当前轮摘要：继续解释合成资料，最近的工具回执保留在摘要之后。'};
    else if (ordinaryMode === 'route') {
      ordinaryMode = 'answer';
      delta = {role: 'assistant', tool_calls: [{index: 0, id: randomUUID(), type: 'function',
        function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null,
          expected_version: null, goal: '', question: null, options: []})}}]};
    } else delta = {role: 'assistant', content: '已核对合成资料，当前对话可以继续。'};
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'synthetic', choices: [{index: 0, delta,
      finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({id: 'synthetic', choices: [],
      usage: {prompt_tokens: inputTokens, completion_tokens: 100, total_tokens: inputTokens + 100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerErrors.push(error.message);
    if (!response.headersSent) response.writeHead(400, {'content-type': 'application/json'});
    response.end(JSON.stringify({error: {message: 'synthetic capacity assertion failed'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerUrl = 'http://127.0.0.1:' + provider.address().port;
const beforeProtocol = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
const assistant = content => ({role: 'assistant', content, api: 'openai-completions',
  provider: 'synthetic-history', model: 'synthetic/historical', stopReason: 'stop',
  usage: zeroUsage, timestamp: Date.now()});
const loadCheckpoint = run => h.sql(`SELECT JSON_OBJECT('checkpoint',checkpoint) FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0].checkpoint;

async function capture(conversation, text) {
  await h.resumeWorker();
  const run = await h.capture(conversation, text);
  await h.pauseWorker();
  currentRun = run;
  ordinaryMode = 'route';
  return run;
}

async function rejectWithoutSending(conversation, run, label) {
  const before = requests.length;
  let rejected;
  try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
  catch (error) { rejected = error; }
  assert.ok(rejected, label + '必须明确拒绝');
  assert.match(String(rejected.code ?? rejected.message), /model_input_limit|model_capacity_invalid/, label);
  assert.equal(requests.length, before, label + '不能发送已知装不下的请求');
  const attempts = h.sql(`SELECT JSON_OBJECT('count',COUNT(*)) FROM model_call_attempts WHERE budget_scope_id='${run.budget_scope_id}'`)[0].count;
  assert.equal(attempts, 0, label + '不能领取摘要或普通请求的模型许可');
  const snapshot = await h.snapshot(conversation);
  assert.equal(snapshot.messages.filter(message => message.role === 'assistant' && message.committed).length, 0);
  ok(await h.request('/conversations/' + conversation + '/messages/' + run.message_id + '/withdraw', {operation_id: randomUUID()}));
  h.releaseRun(run.run_id);
  return {error: String(rejected.code ?? rejected.message), requests: 0, attempts};
}

try {
  h = await harness({capture: true, protocolProviderUrl: providerUrl, env: {DATA_AGENT_LEASE_MS: '120000'}});
  ok(await h.request('/model-services', {id: definition.service_id, name: '合成压缩服务',
    provider_id: 'compatible', api: 'openai-completions', base_url: providerUrl + '/v1',
    api_key: 'synthetic-compaction-key', enabled: true, expected_version: '0'}));
  const saved = ok(await h.request('/model-definitions', definition));
  ok(await h.request('/model-configuration/default', {model_id: definition.id, expected_version: saved.version}));

  const documents = [];
  for (let index = 0; index < 24; index++) {
    const body = ('Synthetic reference ' + index + ': retained document facts. ').repeat(220).slice(0, 8192);
    const object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
      name: '合成压缩文档 ' + index, body, related_ids: [], source_url: null}));
    documents.push({id: object.id, body});
  }
  const conversation = await h.create();
  const first = await capture(conversation, '继续解释已经读取的合成文档。');
  for (const field of ['context_window', 'input_limit', 'output_limit', 'payload_bytes_limit', 'request_timeout_ms', 'capability_source'])
    assert.equal(first.model_profile[field], definition[field], field + '必须在宿主消息中冻结');
  assert.equal(first.model_profile.request_call_limit, undefined, '正常新配置不恢复已取消的默认24次帽');

  // 与正式运行一致使用Pi持久journal；大历史不能作为内联checkpoint反复塞入工具HTTP请求。
  const manager = restoreCheckpoint('/synthetic/data-agent', null);
  for (let index = 0; index < 40; index++) {
    manager.appendMessage({role: 'user', content: 'Historical synthetic context. '.repeat(550), timestamp: Date.now()});
    manager.appendMessage(assistant([{type: 'text', text: 'Saved historical result.'}]));
  }
  manager.appendMessage({role: 'user', content: '读取本轮合成文档，保留原回执。', timestamp: Date.now()});
  const calls = documents.map((document, index) => ({type: 'toolCall', id: 'retained-document-' + index,
    name: 'read_knowledge', arguments: {items: [{kind: 'knowledge', ref: {object_id: document.id, version: '1', path: 'body'}, offset: 0, limit: 8192}]}}));
  manager.appendMessage({...assistant(calls), stopReason: 'toolUse'});
  // 按真实宿主接口先登记、执行工具，构造需要split-turn压缩的已持久化工具批次。
  for (const call of calls) {
    const invocation = {run_id: first.run_id, lease_epoch: first.lease_epoch,
      sdk_tool_call_id: call.id, tool_name: call.name, arguments: call.arguments,
      checkpoint: exportCheckpoint(manager)};
    ok(await h.internal('/internal/data/tool-calls', invocation));
    const receipt = ok(await h.internal('/internal/data/tools', invocation));
    assert.equal(receipt.data.error, undefined);
    manager.appendMessage({role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{type: 'text', text: JSON.stringify(receipt.data)}], isError: false, timestamp: Date.now()});
  }
  const initialTools = h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'operation',operation_id,'origin',origin_run_id,'state',state) FROM tool_calls WHERE conversation_id='${conversation}' ORDER BY sdk_tool_call_id`);
  assert.equal(initialTools.length, documents.length);
  first.checkpoint = exportCheckpoint(manager, first.workspace_context.authority_revision, first.workspace_context.authority_snapshot);
  const originalSession = manager.getHeader().id;
  await deliver(first, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
  h.releaseRun(first.run_id);
  let checkpoint = loadCheckpoint(first);
  const firstRequests = requests.filter(request => request.message === first.message_id);
  assert.ok(firstRequests.some(request => request.kind === 'history'), '真实Pi须执行历史摘要');
  assert.ok(firstRequests.some(request => request.kind === 'turn_prefix'), '同一次压缩须执行split-turn前缀摘要');
  // 1.4两类摘要都用O=35000；此样本I+O+SDK余量小于C，未触发wire输出收紧。
  assert.ok(firstRequests.filter(request => request.kind === 'history').every(request => request.outputCap === 35000));
  assert.ok(firstRequests.filter(request => request.kind === 'turn_prefix').every(request => request.outputCap === 35000));
  assert.equal(restoreCheckpoint('/synthetic/data-agent', checkpoint).getHeader().id, originalSession);
  assert.ok(restoreCheckpoint('/synthetic/data-agent', checkpoint).getBranch().some(entry => entry.type === 'compaction'));
  const projection = restoreCheckpoint('/synthetic/data-agent', checkpoint).buildSessionContext().messages;
  for (const call of calls) {
    const result = projection.find(message => message.role === 'toolResult' && message.toolCallId === call.id);
    assert.ok(result, '近期整个工具批次必须保留：' + call.id);
    const body = JSON.parse(result.content.find(part => part.type === 'text').text).items[0].content;
    assert.equal(body, documents.find(document => document.id === call.arguments.items[0].ref.object_id).body);
  }
  checks.push({name: '中型新profile原生split-turn双摘要，两类输出沿冻结O且实际输入受限，近期工具正文逐字保留',
    summaryRequests: firstRequests.filter(request => request.kind !== 'ordinary')});

  const allRuns = [first];
  for (let index = 0; index < 2; index++) {
    const run = await capture(conversation, '继续同一对话，补充合成说明 ' + index);
    allRuns.push(run);
    await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
    h.releaseRun(run.run_id);
    checkpoint = loadCheckpoint(run);
    assert.equal(restoreCheckpoint('/synthetic/data-agent', checkpoint).getHeader().id, originalSession);
  }
  assert.equal((await h.snapshot(conversation)).runs.filter(run => run.state === 'finished').length, 3);
  const remainingTools = h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'operation',operation_id,'origin',origin_run_id,'state',state) FROM tool_calls WHERE conversation_id='${conversation}' AND sdk_tool_call_id LIKE 'retained-document-%' ORDER BY sdk_tool_call_id`);
  assert.deepEqual(remainingTools, initialTools, '多轮续接不得重新登记或重复执行旧工具副作用');
  for (const run of allRuns) {
    const attempts = h.sql(`SELECT JSON_OBJECT('scope',budget_scope_id,'run',run_id,'state',state,'cap',output_tokens_max) FROM model_call_attempts WHERE budget_scope_id='${run.budget_scope_id}'`);
    const sent = requests.filter(request => request.message === run.message_id);
    assert.equal(attempts.length, sent.length);
    assert.ok(attempts.every(attempt => attempt.scope === run.budget_scope_id && attempt.run === run.run_id && attempt.state === 'settled'));
    assert.deepEqual(attempts.map(attempt => attempt.cap).sort((a, b) => a - b), sent.map(request => request.outputCap).sort((a, b) => a - b));
    const scope = h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0];
    assert.equal(scope.limit, null, '正常scope无默认累计帽；有限旧profile和显式trial另由原回归验证');
    assert.equal(scope.calls, sent.length);
  }
  checks.push({name: '三轮保持同一个Pi会话，摘要和普通请求沿各原消息预算范围，旧工具operation和origin不变',
    messages: allRuns.length, originalTools: initialTools.length});

  const oversizedConversation = await h.create();
  const oversizedRun = await capture(oversizedConversation, '继续读取合成历史。');
  const oversized = restoreCheckpoint('/synthetic/data-agent', null);
  oversized.appendMessage({role: 'user', content: 'Earlier synthetic context. '.repeat(2000), timestamp: Date.now()});
  oversized.appendMessage(assistant([{type: 'text', text: 'Recorded.'}]));
  oversized.appendMessage({role: 'user', content: '合成旧版本工具批次。', timestamp: Date.now()});
  oversized.appendMessage({...assistant([{type: 'toolCall', id: 'legacy-retained-batch', name: 'read_knowledge',
    arguments: {object_id: documents[0].id}}]), stopReason: 'toolUse'});
  // 合法SDK检查点中的合成大回执，专门验证保留边界；不声称该正文来自当前受限read工具。
  oversized.appendMessage({role: 'toolResult', toolCallId: 'legacy-retained-batch', toolName: 'read_knowledge',
    content: [{type: 'text', text: 'synthetic '.repeat(100000)}], isError: false, timestamp: Date.now()});
  oversizedRun.checkpoint = exportCheckpoint(oversized, oversizedRun.workspace_context.authority_revision, oversizedRun.workspace_context.authority_snapshot);
  checks.push({name: '近期保留按消息边界超过K且无法容纳时明确拒绝，不发送摘要或改写旧工具正文',
    ...await rejectWithoutSending(oversizedConversation, oversizedRun, '近期保留边界')});

  const tiny = {...definition, id: 'fixed-overhead-small', model_id: 'synthetic/fixed-overhead-small',
    context_window: 16384, input_limit: 10000, output_limit: 256};
  const tinySaved = ok(await h.request('/model-definitions', tiny));
  ok(await h.request('/model-configuration/default', {model_id: tiny.id, expected_version: tinySaved.version}));
  const tinyConversation = await h.create();
  const tinyRun = await capture(tinyConversation, '解释合成资料。');
  checks.push({name: '保存时公式可行但实际固定规则和工具装不下时明确拒绝，不尝试无限摘要',
    ...await rejectWithoutSending(tinyConversation, tinyRun, '固定开销')});
  assert.deepEqual(providerErrors, []);
  passed = true;
} finally {
  if (beforeProtocol === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST;
  else process.env.DATA_AGENT_PROVIDER_TEST = beforeProtocol;
  await h?.close();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  const report = {passed, checks, requests, providerErrors, officialRequests: 0,
    limits: ['实际使用Pi和专用MySQL；平台与供应商为本地合成协议，不代表真实模型质量或云端600秒/8MiB验证。']};
  await mkdir('.local/checks', {recursive: true});
  await writeFile('.local/checks/mvp-configured-compaction.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
