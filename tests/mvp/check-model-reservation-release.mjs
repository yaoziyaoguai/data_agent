import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, until } from './harness.mjs';

const profile = { provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
  price_version: '2026-10-04-peak-usd', input_limit: 32768, output_limit: 2048,
  trial_call_limit: 20, trial_cost_micros: '400000', request_call_limit: 24,
  toolset: 'data', payload_bytes_limit: 65536 };
const h = await harness({ capture: true, profile, protocolProviderUrl: 'http://127.0.0.1:1',
  env: { DATA_AGENT_LEASE_MS: '120000' } });
const model = async (action, body) => {
  const result = await h.internal('/internal/model/' + action, body);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value;
};
const trial = () => h.sql(`SELECT JSON_OBJECT('held',reserved_micros,'spent',spent_micros,'allocated',allocated_calls)
  FROM model_trials WHERE id='${profile.trial_id}'`)[0];

try {
  const live = await h.capture(await h.create(), '合成账本：活跃租约。');
  const abandoned = await h.capture(await h.create(), '合成账本：失去租约。');
  await h.pauseWorker();

  const create = async (run, state) => {
    const input = { run_id: run.run_id, lease_epoch: run.lease_epoch, call_attempt_id: randomUUID(),
      parameters_fingerprint: 'f'.repeat(64) };
    assert.equal((await model('reserve', { ...input, input_tokens_upper: profile.input_limit,
      output_tokens_max: profile.output_limit })).state, 'reserved');
    if (state !== 'reserved') assert.equal((await model('send', input)).send_allowed, true);
    if (state === 'unknown') assert.equal((await model('finalize', { ...input, usage: null,
      outcome: 'transient_error' })).state, 'unknown');
    return input;
  };
  const active = await create(live, 'issued');
  const reserved = await create(abandoned, 'reserved');
  const issued = await create(abandoned, 'issued');
  const unknown = await create(abandoned, 'unknown');
  const recent = await create(abandoned, 'issued');
  const callIds = [active, reserved, issued, unknown, recent].map(row => row.call_attempt_id);
  const statements = callIds.map((id, index) => `UPDATE model_call_attempts
    SET permit_expires_at=TIMESTAMPADD(SECOND,${index === 4 ? -510 : -580},UTC_TIMESTAMP(3)) WHERE id='${id}'`);
  h.sql(statements.join(';'));
  const attempts = () => new Map(h.sql(`SELECT JSON_OBJECT('id',id,'state',state,
    'held',reserved_micros,'actual',actual_micros,'released',reservation_released_at IS NOT NULL)
    FROM model_call_attempts WHERE id IN ('${callIds.join("','")}')`).map(row => [row.id, row]));
  const before = trial();
  const loss = await h.request(`/conversations/${abandoned.conversation_id}/cancel-run`, {
    run_id: abandoned.run_id, lease_epoch: abandoned.lease_epoch });
  assert.equal(loss.status, 200, JSON.stringify(loss.value));
  h.releaseRun(abandoned.run_id);

  await h.resumeWorker();
  const after = await until(() => {
    const rows = attempts();
    return [reserved, issued, unknown].every(call => rows.get(call.call_attempt_id).released) && rows;
  }, 'release model reservations with expired run', 20000);
  assert.deepEqual(callIds.map(id => [after.get(id).state, Boolean(after.get(id).released)]),
    [['issued', false], ['reserved', true], ['unknown', true], ['unknown', true], ['issued', false]]);
  const remaining = after.get(active.call_attempt_id).held + after.get(recent.call_attempt_id).held;
  assert.deepEqual(trial(), { held: remaining, spent: before.spent, allocated: before.allocated - 1 });

  const late = { ...unknown, usage: { input_tokens: 100, output_tokens: 10, elapsed_ms: 1 },
    outcome: 'transient_error' };
  assert.equal((await model('finalize', late)).state, 'settled');
  const charged = attempts().get(unknown.call_attempt_id);
  assert.equal(charged.actual, 42);
  assert.equal((await model('finalize', late)).state, 'settled');
  assert.deepEqual(trial(), { held: remaining, spent: before.spent + 42, allocated: before.allocated - 1 });

  const [applicationTables] = h.sql(`SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name<>'_sqlx_migrations'`);
  assert.ok(applicationTables <= 60, `application tables: ${applicationTables}`);
  console.log(JSON.stringify({ passed: true, applicationTables, releasedReservations: 3,
    lateChargeMicros: charged.actual, officialRequests: 0 }));
} finally {
  await h.close();
}
