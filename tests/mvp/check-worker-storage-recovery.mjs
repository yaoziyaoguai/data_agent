import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {harness, until} from './harness.mjs';

const cases = [
  {id: 'transient', name: '领取、上下文读取和续租临时故障后沿原身份完成', faults: ['claim', 'context', 'renew']},
  {id: 'busy', name: 'Bridge未接纳且回退暂时失败后恢复', faults: ['defer'], dispatchFailure: 'busy'},
  {id: 'configuration', name: '确定配置错误的终态保存暂时失败后明确失败', faults: ['fail'], dispatchFailure: 'configuration'},
  {id: 'unknown-receipt', name: '模型结算未知停止派发、保留占额且原ID晚到结算可重放', faults: ['fail'], dispatchFailure: 'unknown-receipt'},
];
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--case' && cases.some(test => test.id === args[1])),
  '用法：node tests/mvp/check-worker-storage-recovery.mjs [--case transient|busy|configuration|unknown-receipt]');
const selectedCase = args[1] ?? null;
const selectedCases = selectedCase ? cases.filter(test => test.id === selectedCase) : cases;
// 单组选跑写独立报告，绝不能覆盖或冒充全套四场证据。
const reportPath = '.local/checks/mvp-worker-storage-recovery' + (selectedCase ? '-' + selectedCase : '') + '.json';
const leaseMs = 3000;
const checks = [];
let passed = false;

const workerPid = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], {encoding: 'utf8'})
    .trim().split('\n').map(row => row.trim().split(/\s+/));
  const workers = rows.filter(row => Number(row[1]) === process.pid && row[2]?.endsWith('data-agent-worker'));
  assert.equal(workers.length, 1, '验收进程应只有一个Worker子进程');
  return Number(workers[0][0]);
};
const workerAlive = pid => {
  assert.equal(workerPid(), pid, '恢复不得依赖重启Worker进程');
  assert.doesNotThrow(() => process.kill(pid, 0));
};
const bodyOf = async request => {
  let body = '';
  request.setEncoding('utf8');
  for await (const part of request) body += part;
  return body;
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

async function verifyRecovery({id, name, faults, dispatchFailure}) {
  let h;
  const providerErrors = [], dispatches = [], providerCalls = [];
  const callsPerInput = new Map();
  let gatewayConflicts = 0;
  let unknownBinding;
  const provider = createServer(async (request, response) => {
    try {
      const input = JSON.parse(await bodyOf(request));
      const marker = JSON.stringify(input.messages).match(/worker-recovery-[a-z-]+/g)?.at(-1);
      assert.ok(marker, '本地协议请求必须带有当前合成用例标记');
      const count = (callsPerInput.get(marker) ?? 0) + 1;
      callsPerInput.set(marker, count);
      providerCalls.push({marker, count});
      // 真正请求保持在途超过会话TTL；一次续租故障后，后续心跳仍须保持原run有效。
      if (faults.includes('renew') && providerCalls.length === 1)
        await new Promise(resolve => setTimeout(resolve, leaseMs + 1200));
      const delta = count === 1
        ? {role: 'assistant', tool_calls: [{index: 0, id: randomUUID(), type: 'function', function: {
            name: 'update_analysis_task',
            arguments: JSON.stringify({action: 'create', goal: '核对合成语音链路资料', conditions: {
              time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
              group_by: [], filters: [], knowledge_refs: [], notes: '',
            }, options: []}),
          }}]}
        : {role: 'assistant', content: '已记录本次合成语音链路核对任务，尚未进行数据查询。'};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: ' + JSON.stringify({id: 'synthetic-worker-recovery', choices: [{
        index: 0, delta, finish_reason: count === 1 ? 'tool_calls' : 'stop',
      }]}) + '\n\n');
      response.write('data: ' + JSON.stringify({id: 'synthetic-worker-recovery', choices: [], usage: {
        prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
      }}) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      providerErrors.push(error.message);
      response.writeHead(500).end('synthetic_provider_assertion_failed');
    }
  });
  await listen(provider);
  // 只在真正Bridge接纳前制造409/确定配置错误，正常派发原样转发到真实Pi Bridge。
  const gateway = createServer(async (request, response) => {
    try {
      const raw = await bodyOf(request);
      if (request.url === '/resume-and-deliver') {
        const envelope = JSON.parse(raw);
        dispatches.push(envelope);
        const primary = envelope.text.includes('worker-recovery-primary');
        if (primary && dispatchFailure === 'busy' && gatewayConflicts === 0) {
          gatewayConflicts++;
          response.writeHead(409).end();
          return;
        }
        if (primary && dispatchFailure === 'unknown-receipt') {
          unknownBinding = {run_id: envelope.run_id, lease_epoch: envelope.lease_epoch,
            call_attempt_id: randomUUID(), parameters_fingerprint: 'b'.repeat(64)};
          assert.equal((await h.internal('/internal/model/reserve', {...unknownBinding,
            input_tokens_upper: 32768, output_tokens_max: 8192})).status, 200);
          const permit = await h.internal('/internal/model/send', unknownBinding);
          assert.equal(permit.status, 200);
          assert.equal(permit.value.send_allowed, true);
          response.writeHead(500, {'content-type': 'application/json'})
            .end(JSON.stringify({code: 'model_finalize_unconfirmed'}));
          return;
        }
        if (primary && dispatchFailure === 'configuration') {
          response.writeHead(500, {'content-type': 'application/json'})
            .end(JSON.stringify({code: 'provider_configuration_invalid'}));
          return;
        }
      }
      const upstream = await fetch('http://127.0.0.1:' + h.env.DATA_AGENT_BRIDGE_PORT + request.url, {
        method: request.method,
        headers: {'authorization': request.headers.authorization, 'content-type': 'application/json'},
        body: raw,
      });
      response.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') ?? 'text/plain'});
      response.end(await upstream.text());
    } catch (error) {
      providerErrors.push(error.message);
      response.writeHead(502).end('synthetic_bridge_proxy_failed');
    }
  });
  await listen(gateway);
  try {
    const profile = {
      provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
      price_version: '2026-10-04-peak-usd', input_limit: 32768, output_limit: 8192,
      trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24,
      toolset: 'data', payload_bytes_limit: 65536, thinking_level: 'low',
    };
    h = await harness({
      capture: false, startWorker: false, profile,
      protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
      env: {
        DATA_AGENT_TEST_STORAGE_FAULT: faults.join(','), DATA_AGENT_LEASE_MS: String(leaseMs),
        DATA_AGENT_BRIDGE_URL: 'http://127.0.0.1:' + gateway.address().port,
      },
    });
    const primary = await h.create();
    const message = await h.send(primary, 'worker-recovery-primary 请记录合成语音链路核对任务。');
    const initial = h.sql(`SELECT JSON_OBJECT('scope',budget_scope_id,'chain',recovery_chain_id) FROM conversation_messages WHERE id='${message.message_id}'`)[0];
    const started = performance.now();
    await h.resumeWorker();
    const pid = workerPid();
    let result;
    if (['configuration', 'unknown-receipt'].includes(dispatchFailure)) {
      result = await until(async () => {
        const snapshot = await h.snapshot(primary);
        return snapshot.events.some(event => event.type === 'run_failed') ? snapshot : false;
      }, '配置错误在终态存储恢复后明确失败', 30000);
      assert.equal(result.events.filter(event => event.type === 'run_failed').length, 1);
      assert.equal(result.tasks.length, 0);
      assert.equal(providerCalls.length, 0, 'Bridge配置错误不得触发模型');
      assert.equal(dispatches.length, 1, '暂态收尾只重试持久化，不能再派发模型或丢失原错误');
      const failure = h.sql(`SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE message_id='${message.message_id}'`)[0];
      assert.equal(failure.state, 'failed');
      const events = JSON.stringify(result.events);
      assert.ok(events.includes(dispatchFailure === 'configuration' ? 'provider_configuration_invalid' : 'model_finalize_unconfirmed'));
      assert.ok(!events.includes('retry_exhausted'), '确定错误不得丢失为笼统重试耗尽');
    } else {
      result = await h.finished(primary);
      assert.equal(result.tasks.length, 1);
      assert.equal(result.runs.filter(run => run.state === 'finished').length, 1);
      assert.equal(providerCalls.length, 2);
      assert.ok(performance.now() - started > leaseMs, '恢复场景实际跨越原租约TTL');
      const tools = h.sql(`SELECT JSON_OBJECT('name',tool_name,'state',state) FROM tool_calls WHERE conversation_id='${primary}'`);
      assert.deepEqual(tools, [{name: 'update_analysis_task', state: 'succeeded'}]);
      assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM condition_revisions WHERE task_id='${result.tasks[0].id}'`)[0].n, 1);
    }
    workerAlive(pid);
    const runs = h.sql(`SELECT JSON_OBJECT('run',id,'state',state,'scope',budget_scope_id,'chain',recovery_chain_id,'epoch',lease_epoch) FROM agent_runs WHERE message_id='${message.message_id}' ORDER BY created_at,id`);
    assert.equal(runs.length, ['configuration', 'unknown-receipt'].includes(dispatchFailure) ? 1 : 2, '只恢复真正交付中断；终态落盘重试不得再起run');
    assert.ok(runs.every(run => run.scope === initial.scope && run.chain === initial.chain));
    const stale = runs.reduce((oldest, run) => Number(run.epoch) < Number(oldest.epoch) ? run : oldest);
    if (runs.length > 1) assert.ok(runs.some(run => Number(run.epoch) > Number(stale.epoch)), '恢复保留原run并推进租约代次');
    assert.equal((await h.internal('/internal/model/reserve', {
      run_id: stale.run, lease_epoch: String(stale.epoch), call_attempt_id: randomUUID(),
      parameters_fingerprint: 'a'.repeat(64), input_tokens_upper: profile.input_limit,
      output_tokens_max: profile.output_limit,
    })).value.code, 'lease_lost', '旧代次晚到不能再获额度或修改状态');
    const budget = h.sql(`SELECT JSON_OBJECT('id',id,'limit',call_limit,'issued',issued_calls) FROM budget_scopes WHERE message_id='${message.message_id}'`);
    const expectedCalls = dispatchFailure === 'configuration' ? 0 : dispatchFailure === 'unknown-receipt' ? 1 : 2;
    assert.deepEqual(budget, [{id: initial.scope, limit: 24, issued: expectedCalls}]);
    const attempts = h.sql(`SELECT JSON_OBJECT('state',state) FROM model_call_attempts WHERE budget_scope_id='${initial.scope}'`);
    assert.equal(attempts.length, expectedCalls);
    if (unknownBinding) {
      assert.deepEqual(attempts, [{state: 'issued'}], '未确认结算保留已发送记录，不伪造成功/失败用量');
      const reservation = h.sql(`SELECT JSON_OBJECT('reserved',reserved_micros) FROM model_call_attempts WHERE id='${unknownBinding.call_attempt_id}'`)[0];
      assert.ok(reservation.reserved > 0, '未知调用继续占用原额度');
      const lateReceipt = {...unknownBinding, usage: {input_tokens: 100, output_tokens: 30, elapsed_ms: 100}, outcome: 'success'};
      for (let replay = 0; replay < 2; replay++) {
        const finalized = await h.internal('/internal/model/finalize', lateReceipt);
        assert.equal(finalized.status, 200);
        assert.equal(finalized.value.state, 'settled');
      }
      const after = h.sql(`SELECT JSON_OBJECT('n',COUNT(*),'state',MIN(state)) FROM model_call_attempts WHERE budget_scope_id='${initial.scope}'`)[0];
      assert.deepEqual(after, {n: 1, state: 'settled'}, '原ID晚到结算与精确重放不新增调用');
      assert.equal(h.sql(`SELECT JSON_OBJECT('issued',issued_calls) FROM budget_scopes WHERE id='${initial.scope}'`)[0].issued, 1);
    } else {
      assert.ok(attempts.every(attempt => attempt.state === 'settled'));
    }

    const followup = await h.create();
    await h.send(followup, 'worker-recovery-followup 请记录另一条合成语音核对任务。');
    const completed = await h.finished(followup);
    assert.equal(completed.tasks.length, 1);
    assert.equal(completed.runs.length, 1);
    workerAlive(pid);
    const workerLog = h.logs.find(log => log.name === 'worker-resumed')?.output ?? '';
    for (const fault of faults)
      assert.equal(workerLog.split('\n').filter(line => line === 'storage_fault_injected phase=' + fault).length, 1,
        `必须实际触发且仅触发一次${fault}故障`);
    if (id === 'transient')
      assert.equal(workerLog.split('\n').filter(line => line === 'worker_claim_transient code=unavailable').length, 1,
        '领取故障必须经过真实临时存储错误处理分支');
    if (dispatchFailure === 'busy') {
      assert.equal(gatewayConflicts, 1, 'gateway必须确实返回一次409');
      assert.equal(dispatches.filter(run => run.conversation_id === primary).length, 2,
        '一次未接纳后沿原消息恢复，并进入真实Bridge完成');
      assert.equal(workerLog.split('\n').filter(line => line.startsWith('delivery_defer_transient job=')).length, 1,
        '故障必须发生在409回退持久化，不能由启动时lease_lost路径代替');
      assert.ok(!workerLog.includes('storage_fault_injected phase=defer_lease'),
        '本用例不注入启动失租回退故障');
    }
    assert.deepEqual(providerErrors, []);
    const evidence = {
      id, name, faults, gatewayConflicts, dispatchFailure: dispatchFailure ?? null, passed: true,
      runs: runs.map(({state, epoch}) => ({state, epoch})),
      primaryLedgerCalls: attempts.length, loopbackModelRequests: providerCalls.length,
      lateReceiptSettledWithoutRedispatch: Boolean(unknownBinding),
      budgetLimit: budget[0].limit, sameWorkerHandledNextMessage: true,
      serviceLog: h.directory.slice(process.cwd().length + 1) + '/service-logs.json',
    };
    checks.push(evidence);
  } finally {
    if (h) await h.close();
    await close(gateway);
    await close(provider);
  }
}

try {
  for (const test of selectedCases) await verifyRecovery(test);
  passed = true;
} finally {
  const report = {passed, coverage: selectedCase ? 'selected_case' : 'full', selectedCases: selectedCases.map(test => test.id), checks, officialRequests: 0, storage: '真实MySQL隔离库', model: 'loopback协议替身，真实Pi/Bridge/Worker'};
  await mkdir('.local/checks', {recursive: true});
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
