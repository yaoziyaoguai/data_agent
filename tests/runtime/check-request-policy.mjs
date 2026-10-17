import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { deliver } from '../../apps/agent/session/deliver.ts';
import { exportCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { guardedDeepSeekStream } from '../../apps/agent/provider/deepseek.ts';
import { RustTransport } from '../../apps/agent/transport/client.ts';
import { harness, until } from '../mvp/harness.mjs';

const profile = { provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
  price_version: '2026-10-04-peak-usd', budget_mode: 'request', input_limit: 65536,
  output_limit: 2048, request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072 };
const h = await harness({ capture: true, profile, env: { DATA_AGENT_LEASE_MS: '120000' } });
let actions = [], network = [], passed = false;
const checks = [];
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), action = actions.shift() ?? 'answer';
  network.push({ action, summary: !body.tools?.length });
  if (action === 'slow') return;
  if (typeof action === 'number' || action === 'quota') {
    res.writeHead(action === 'quota' ? 429 : action, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: action === 'quota' ? 'insufficient_quota' : 'synthetic temporary failure' } })); return;
  }
  const tool = action === 'tool';
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: {
    name: 'update_analysis_task', arguments: JSON.stringify({ action: 'route', task_id: null,
      expected_version: null, goal: '', question: null, options: [] }) } }] }
    : { role: 'assistant', content: '合成调查已完成。' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (action === 'drop') {
    res.write('data: ' + JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: '未完成的合成输出' }, finish_reason: null }] }) + '\n\n');
    setTimeout(() => res.destroy(), 20); return;
  }
  res.write('data: ' + JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\n');
  if (action !== 'no_usage') res.write('data: ' + JSON.stringify({ id: 'synthetic', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const connection = { apiKey: 'synthetic-protocol-key', baseUrl: 'http://127.0.0.1:' + provider.address().port, protocolTest: true };
const previous = Object.fromEntries(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DATA_AGENT_PROVIDER_TEST', 'DATA_AGENT_MODEL_TIMEOUT_MS', 'DATA_AGENT_TEST_COMPACT'].map(key => [key, process.env[key]]));
Object.assign(process.env, { DEEPSEEK_API_KEY: connection.apiKey, DEEPSEEK_BASE_URL: connection.baseUrl, DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_MODEL_TIMEOUT_MS: '3000' });
const model = { id: 'deepseek-flash', name: 'synthetic', api: 'openai-completions', provider: 'controlled_deepseek',
  baseUrl: connection.baseUrl, contextWindow: 65536, maxTokens: 2048, reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStrictMode: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' } };
const context = { messages: [{ role: 'user', content: '合成请求', timestamp: 1 }], tools: [] };
const begin = async () => {
  await h.resumeWorker(); const cid = await h.create();
  const run = await h.capture(cid, '继续合成调查'); await h.pauseWorker(); return run;
};
const close = async run => {
  await h.request('/conversations/' + run.conversation_id + '/cancel-run', { run_id: run.run_id, lease_epoch: run.lease_epoch });
  h.releaseRun(run.run_id);
};
const ledger = run => h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit,'failures',model_failure_streak) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0];
const attempts = run => h.sql(`SELECT JSON_OBJECT('id',id,'state',state,'reserved',reserved_micros,'outcome',outcome,'fp',parameters_fingerprint,'sequence',scope_call_sequence) FROM model_call_attempts WHERE budget_scope_id='${run.budget_scope_id}' ORDER BY scope_call_sequence`);
const trialUsage = () => h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros,'spent',spent_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
const once = (run, signal = new AbortController().signal, options) => guardedDeepSeekStream(new RustTransport(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN), profile, connection, signal)(model, context, options).result();
const execute = (run, signal) => deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '', signal);
const check = name => { checks.push(name); console.log(JSON.stringify({ passed: true, check: name })); };
try {
  const migrationDatabase = 'data_agent_test_' + randomUUID().replaceAll('-', '');
  h.sql(`CREATE DATABASE ${migrationDatabase}`);
  try {
    h.sql(`USE ${migrationDatabase}; CREATE TABLE budget_scopes (id VARCHAR(64) PRIMARY KEY,call_limit INT UNSIGNED NOT NULL,issued_calls INT UNSIGNED NOT NULL); CREATE TABLE model_call_attempts (id VARCHAR(64) PRIMARY KEY,state VARCHAR(16) NOT NULL);\n` + await readFile('migrations/202610040001_model_calls.sql', 'utf8'));
    h.sql(`USE ${migrationDatabase}; INSERT INTO model_trials VALUES('old-trial','${'f'.repeat(64)}',6,50000,2,2458,619,'active','2026-10-04 12:00:00.000'); INSERT INTO budget_scopes(id,call_limit,issued_calls) VALUES('old-scope',6,2); INSERT INTO model_call_attempts(id,state,reserved_micros) VALUES('old-call','unknown',2458);`);
    const stored = () => h.sql(`USE ${migrationDatabase}; SELECT JSON_OBJECT('calls',call_limit,'cost',cost_limit_micros,'allocated',allocated_calls,'reserved',reserved_micros,'spent',spent_micros,'state',state,'expires',expires_at,'fp',configuration_fingerprint) FROM model_trials`)[0];
    const original = stored();
    h.sql(`USE ${migrationDatabase};\n` + await readFile('migrations/202610170001_request_budgets.sql', 'utf8'));
    assert.deepEqual(stored(), original);
    assert.deepEqual(h.sql(`USE ${migrationDatabase}; SELECT JSON_OBJECT('used',issued_calls,'limit',call_limit,'failures',model_failure_streak) FROM budget_scopes`)[0], { used: 2, limit: 6, failures: 0 });
    assert.deepEqual(h.sql(`USE ${migrationDatabase}; SELECT JSON_OBJECT('state',state,'reserved',reserved_micros,'outcome',outcome) FROM model_call_attempts`)[0], { state: 'unknown', reserved: 2458, outcome: null });
    check('实际旧schema账本迁移保留额度/已用/未知预留/到期/配置指纹');
  } finally { h.sql(`DROP DATABASE ${migrationDatabase}`); }

  const row = h.sql(`SELECT JSON_OBJECT('calls',call_limit,'cost',cost_limit_micros,'expires',expires_at) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
  assert.deepEqual(row, { calls: null, cost: null, expires: null });
  await h.restartApi();
  assert.deepEqual(h.sql(`SELECT JSON_OBJECT('calls',call_limit,'cost',cost_limit_micros,'expires',expires_at) FROM model_trials WHERE id='${profile.trial_id}'`)[0], row);
  check('正常配置无累计次数/金额/一小时门槛，重启保持同一账本');

  let run = await begin(); actions = [503, 429, 'tool', 503, 503, 'answer']; const before = network.length;
  await execute(run);
  assert.equal(network.length - before, 6); assert.equal(ledger(run).calls, 6); assert.equal(ledger(run).failures, 0);
  assert.deepEqual(attempts(run).map(call => call.outcome), ['transient_error', 'transient_error', 'success', 'transient_error', 'transient_error', 'success']);
  assert.ok(attempts(run).filter(call => call.state === 'unknown').every(call => call.reserved > 0));
  h.releaseRun(run.run_id); check('Pi普通重试每次单独许可，成功清零失败计数，旧未知预留保留');

  run = await begin(); actions = [503, 503, 503, 'tool', 'answer']; const exhaustedStart = network.length;
  await assert.rejects(execute(run)); assert.equal(network.length - exhaustedStart, 3);
  assert.equal(ledger(run).failures, 3); assert.equal(ledger(run).calls, 3);
  const last = attempts(run).at(-1), finish = { run_id: run.run_id, lease_epoch: run.lease_epoch,
    call_attempt_id: last.id, parameters_fingerprint: last.fp, usage: null, outcome: 'transient_error' };
  assert.equal((await h.internal('/internal/model/finalize', finish)).status, 200);
  assert.equal(ledger(run).failures, 3);
  const lateUsage = { ...finish, usage: { input_tokens: 100, output_tokens: 10, elapsed_ms: 1 } };
  assert.equal((await h.internal('/internal/model/finalize', lateUsage)).status, 200);
  const settledUsage = trialUsage();
  assert.equal((await h.internal('/internal/model/finalize', lateUsage)).status, 200);
  assert.deepEqual(trialUsage(), settledUsage);
  assert.equal(ledger(run).failures, 3);
  assert.equal(attempts(run).at(-1).state, 'settled');
  await h.restartApi(); assert.equal((await once(run)).errorMessage, 'model_retry_exhausted');
  assert.equal(network.length - exhaustedStart, 3); await close(run);
  check('连续三次失败终止，晚到用量可幂等结算，重复结算和API/SDK重启不补重试额度');

  run = await begin(); actions = [503, 503, 503, 'answer'];
  await once(run); await once(run); assert.equal(ledger(run).failures, 2);
  // 模拟旧交付租约到期，通过正式领取生成新run，保留原消息与预算。
  await h.restartApi();
  h.sql(`UPDATE conversations SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id='${run.conversation_id}'`);
  h.sql(`UPDATE background_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE message_id='${run.message_id}'`);
  h.releaseRun(run.run_id); await h.resumeWorker();
  const resumed = await until(() => h.captured.find(value => value.message_id === run.message_id && value.run_id !== run.run_id), 'new run on old budget');
  await h.pauseWorker(); assert.equal(resumed.budget_scope_id, run.budget_scope_id);
  const resumeStart = network.length; await assert.rejects(execute(resumed));
  assert.equal(network.length - resumeStart, 1); assert.equal(ledger(resumed).calls, 3); await close(resumed);
  check('两次失败后新run恢复，第三次失败停止，原scope保持');

  run = await begin();
  const old = { run_id: run.run_id, lease_epoch: run.lease_epoch, call_attempt_id: randomUUID(), parameters_fingerprint: 'd'.repeat(64) };
  assert.equal((await h.internal('/internal/model/reserve', { ...old, input_tokens_upper: profile.input_limit, output_tokens_max: profile.output_limit })).status, 200);
  assert.equal((await h.internal('/internal/model/send', old)).value.send_allowed, true);
  actions = [503, 503]; await once(run); await once(run);
  const late = { ...old, usage: { input_tokens: 100, output_tokens: 10, elapsed_ms: 1 }, outcome: 'success' };
  assert.equal((await h.internal('/internal/model/finalize', late)).status, 200);
  assert.equal((await h.internal('/internal/model/finalize', late)).status, 200);
  assert.equal(ledger(run).failures, 2);
  assert.equal((await h.internal('/internal/model/finalize', { ...late, outcome: 'permanent_error' })).status, 409);
  actions = [503, 'answer']; const lateStart = network.length;
  await assert.rejects(execute(run)); assert.equal(network.length - lateStart, 1); await close(run);
  check('晚到旧成功/重复结算不清新失败，不同outcome重放拒绝');

  run = await begin();
  const delayed = { run_id: run.run_id, lease_epoch: run.lease_epoch, call_attempt_id: randomUUID(), parameters_fingerprint: 'e'.repeat(64) };
  await h.internal('/internal/model/reserve', { ...delayed, input_tokens_upper: profile.input_limit, output_tokens_max: profile.output_limit });
  await h.internal('/internal/model/send', delayed);
  actions = [503, 503]; await once(run); await once(run); assert.equal(ledger(run).failures, 2);
  const pending = { ...delayed, call_attempt_id: randomUUID() };
  assert.equal((await h.internal('/internal/model/reserve', { ...pending, input_tokens_upper: profile.input_limit, output_tokens_max: profile.output_limit })).status, 200);
  assert.equal((await h.internal('/internal/model/finalize', { ...delayed, usage: null, outcome: 'transient_error' })).status, 200);
  assert.equal(ledger(run).failures, 3);
  assert.equal((await h.internal('/internal/model/send', pending)).value.code, 'model_retry_exhausted');
  const delayedStart = network.length; assert.equal((await once(run)).errorMessage, 'model_retry_exhausted');
  assert.equal(network.length, delayedStart); await close(run);
  check('晚到旧失败按调用顺序补计，形成三连败时不能继续发送');

  run = await begin(); actions = ['drop', 'tool', 'answer']; const dropStart = network.length;
  await execute(run); assert.equal(network.length - dropStart, 3); assert.equal(ledger(run).failures, 0);
  assert.equal(attempts(run)[0].outcome, 'transient_error');
  assert.equal(attempts(run)[0].state, 'unknown');
  const dropSnapshot = await h.snapshot(run.conversation_id);
  const committed = dropSnapshot.messages.filter(message => message.role === 'assistant' && message.committed);
  assert.equal(committed.length, 1); assert.equal(committed[0].text, '合成调查已完成。');
  h.releaseRun(run.run_id);
  check('200流中断由Pi原生重试，半截输出不提交、旧未知预留保留');

  for (const action of [401, 403, 400, 'quota', 'no_usage']) {
    run = await begin(); actions = [action, 'tool', 'answer']; const start = network.length;
    await assert.rejects(execute(run)); assert.equal(network.length - start, 1); await close(run);
  }
  check('认证/参数/配额/缺失用量均只尝试一次，停止而非自动重试');

  run = await begin(); actions = ['slow', 'slow', 'slow', 'answer']; process.env.DATA_AGENT_MODEL_TIMEOUT_MS = '500';
  const timeoutStart = network.length; await assert.rejects(execute(run));
  assert.equal(network.length - timeoutStart, 3); assert.equal(ledger(run).failures, 3); await close(run);
  process.env.DATA_AGENT_MODEL_TIMEOUT_MS = '3000'; check('单次请求超时沿原额度最多三次，未知预留不释放');

  for (const action of [503, 'slow']) {
    run = await begin(); actions = [action, 'tool', 'answer']; const start = network.length;
    const controller = new AbortController(); const result = execute(run, controller.signal).catch(error => error);
    await until(() => network.length > start && (action === 'slow' || ledger(run).failures === 1), 'request before cancellation');
    controller.abort(); assert.ok(await result instanceof Error); assert.equal(network.length - start, 1);
    assert.equal(ledger(run).failures, action === 'slow' ? 0 : 1); await close(run);
  }
  run = await begin(); actions = [503, 503, 'slow', 'answer'];
  await once(run); await once(run); assert.equal(ledger(run).failures, 2);
  const optionSignal = new AbortController(); const cancelStart = network.length;
  const optionResult = once(run, new AbortController().signal, { signal: optionSignal.signal });
  await until(() => network.length > cancelStart, 'options signal request'); optionSignal.abort();
  assert.equal((await optionResult).errorMessage, 'run_cancelled');
  assert.equal(ledger(run).failures, 2); assert.equal(attempts(run).at(-1).outcome, null);
  assert.equal(network.length - cancelStart, 1); await close(run);
  check('退避/发送中取消与SDK options.signal取消均不重试，不增加或清空原失败计数');

  run = await begin(); const capStart = network.length; actions = Array(25).fill('answer');
  for (let i = 0; i < 24; i++) assert.equal((await once(run)).stopReason, 'stop');
  assert.equal((await once(run)).errorMessage, 'model_budget_exhausted');
  assert.equal(network.length - capStart, 24); assert.equal(ledger(run).calls, 24);
  await h.restartApi(); assert.equal((await once(run)).errorMessage, 'model_budget_exhausted');
  assert.equal(network.length - capStart, 24); await close(run);
  check('正常24次实际HTTP获准，第25次与重启后的再次调用均在发送前拒绝');

  run = await begin();
  h.sql(`UPDATE model_trials SET cost_limit_micros=1 WHERE id='${profile.trial_id}'`);
  const cappedStart = network.length;
  assert.equal((await once(run)).errorMessage, 'model_budget_exhausted'); assert.equal(network.length, cappedStart);
  h.sql(`UPDATE model_trials SET cost_limit_micros=NULL WHERE id='${profile.trial_id}'`);
  await close(run); check('正常模式显式配置累计费用门槛时仍在发送前拒绝');

  run = await begin(); const manager = SessionManager.inMemory('/synthetic/data-agent');
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < 16; i++) {
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '合成语义说明'.repeat(167) }], timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '已记录。' }], api: 'openai-completions', provider: 'local_mock', model: 'task_demo', stopReason: 'stop', usage, timestamp: Date.now() });
  }
  run.checkpoint = exportCheckpoint(manager); actions = ['tool', 'answer', 503, 503, 'answer']; const summaryStart = network.length;
  process.env.DATA_AGENT_TEST_COMPACT = '1';
  await execute(run); delete process.env.DATA_AGENT_TEST_COMPACT;
  assert.ok(network.slice(summaryStart, summaryStart + 2).every(call => !call.summary));
  assert.ok(network.slice(summaryStart + 2, summaryStart + 5).every(call => call.summary));
  assert.equal(network.length - summaryStart, 5); assert.equal(ledger(run).calls, 5); assert.equal(ledger(run).failures, 0);
  h.releaseRun(run.run_id); check('Pi原生摘要复用相同三次重试策略，每次摘要/续答都计原scope');

  passed = true;
} finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await h.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await writeFile('.local/checks/request-policy.json', JSON.stringify({ passed, checks, network: network.length, officialRequests: 0 }, null, 2));
}
