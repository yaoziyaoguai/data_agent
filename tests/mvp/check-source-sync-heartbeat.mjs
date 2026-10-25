import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {harness} from './harness.mjs';

// 只在本次测试库延迟真实页提交；续租等待该行锁时，同步事务必须仍能继续提交。
const leaseMs = 6000, releaseDelaySeconds = 3, completionLimitMs = 15000;
const namespace = 'synthetic-source-heartbeat', snapshot = 'source-heartbeat-snapshot';
const h = await harness({capture: true, startWorker: false, env: {
  DATA_AGENT_TEST_WORKER_ROLE: 'source_sync', DATA_AGENT_LEASE_MS: String(leaseMs),
}});
const database = new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
assert.match(database, /^data_agent_test_[a-f0-9]+$/);
const checks = [], calls = [];
const observations = {leaseMs, releaseDelaySeconds, completionLimitMs, maxJobLockWaits: 0};
let server, platformFailure, startedAt, lastProgress, passed = false, failure;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const table = id => ({
  id, name: id, platform_version: '1', maintainer_id: 'alice', comment: '完全合成的来源续租小样',
  ddl: `CREATE TABLE ${id} (event_id INTEGER);`,
  columns: [{id: 'event_id', name: 'event_id', data_type: 'INTEGER', nullable: false, comment: '合成事件标识'}],
  node: {id: 'load_' + id, sql: `INSERT INTO ${id} SELECT event_id FROM synthetic_events;`, upstream_ids: ['synthetic_events']},
});
const tables = [table('heartbeat_voice_a'), table('heartbeat_voice_b')];

try {
  await h.pausePlatform();
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/catalog');
      let raw = '';
      for await (const part of request) raw += part;
      const input = JSON.parse(raw);
      const first = input.cursor === null;
      assert.ok(first || input.cursor === 'second');
      assert.equal(input.snapshot_id, first ? null : snapshot);
      calls.push(input.cursor);
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({schema_version: 1, source_namespace: namespace, snapshot_id: snapshot,
        authoritative: true, tables: [tables[first ? 0 : 1]], next_cursor: first ? 'second' : null, complete: !first}));
    } catch (error) {
      platformFailure = error;
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: 'synthetic_heartbeat_fixture_invalid'}));
    }
  });
  await new Promise(resolve => server.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port), '127.0.0.1', resolve));

  h.sql('CREATE TABLE source_sync_heartbeat_releases(sync_id VARCHAR(64) NOT NULL, lease_epoch BIGINT UNSIGNED NOT NULL)');
  h.sql(`
DELIMITER $$
CREATE TRIGGER delay_source_page_release BEFORE UPDATE ON background_jobs FOR EACH ROW
BEGIN
  IF OLD.kind='source_sync' AND OLD.state='running' AND NEW.state='queued' THEN
    INSERT INTO source_sync_heartbeat_releases(sync_id,lease_epoch) VALUES(OLD.resource_id,OLD.lease_epoch);
    DO SLEEP(${releaseDelaySeconds});
  END IF;
END$$
DELIMITER ;
`);

  const operationId = randomUUID();
  const accepted = await h.request('/source-syncs', {operation_id: operationId});
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  assert.match(accepted.value.sync_id, /^[A-Za-z0-9_-]+$/);
  observations.syncId = accepted.value.sync_id;
  startedAt = Date.now();
  await h.resumeWorker();
  const deadline = startedAt + completionLimitMs;
  let nextLockObservation = startedAt;
  while (Date.now() < deadline) {
    if (platformFailure) throw platformFailure;
    const response = await fetch(h.env.DATA_AGENT_API_URL + accepted.value.status_url, {
      headers: {authorization: 'Bearer ' + h.tokens.alice},
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    lastProgress = ok({status: response.status, value: await response.json()});
    assert.notEqual(lastProgress.status, 'failed', JSON.stringify(lastProgress));
    if (Date.now() >= nextLockObservation) {
      const waits = h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM performance_schema.data_lock_waits w
        JOIN performance_schema.data_locks l ON w.REQUESTING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID
        WHERE l.OBJECT_SCHEMA='${database}' AND l.OBJECT_NAME='background_jobs'`)[0].n;
      observations.maxJobLockWaits = Math.max(observations.maxJobLockWaits, waits);
      nextLockObservation = Date.now() + 300;
    }
    if (lastProgress.status === 'completed') break;
    await delay(75);
  }
  observations.elapsedMs = Date.now() - startedAt;
  assert.equal(lastProgress?.status, 'completed',
    `两页来源应在${completionLimitMs}ms内提交；续租不能阻塞持作业行锁的原事务：${JSON.stringify(observations)}`);
  assert.ok(observations.elapsedMs < completionLimitMs);
  assert.ok(observations.elapsedMs >= releaseDelaySeconds * 1000, '真实数据库提交确实经过有界延迟');
  assert.ok(observations.maxJobLockWaits > 0, '必须观察到续租与页提交竞争同一真实作业行锁');
  assert.equal(lastProgress.pages_committed, 2);
  assert.equal(lastProgress.processed_sources, 2);
  assert.deepEqual(calls, [null, 'second'], '不能靠重取页面或重建批次避开续租冲突');
  checks.push('真实页提交持锁超过心跳间隔时，续租仍允许原事务继续，两个来源在15秒内完成');

  const syncId = accepted.value.sync_id;
  const releases = h.sql('SELECT JSON_OBJECT(\'sync_id\',sync_id,\'lease_epoch\',lease_epoch) FROM source_sync_heartbeat_releases');
  assert.deepEqual(releases, [{sync_id: syncId, lease_epoch: 1}], '只延迟第一页的一次正常释放');
  const jobs = h.sql("SELECT JSON_OBJECT('sync_id',resource_id,'state',state,'epoch',lease_epoch,'attempts',attempts) FROM background_jobs WHERE kind='source_sync'");
  assert.deepEqual(jobs, [{sync_id: syncId, state: 'finished', epoch: 2, attempts: 0}], '两页只各领取一次，没有租约超时后重领');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM catalog_imports WHERE operation_id='${operationId}'`)[0].n, 1);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM catalog_sync_members WHERE sync_id='${syncId}'`)[0].n, 2);
  const pending = h.sql(`SELECT JSON_OBJECT('kind',j.kind,'state',j.state,'attempts',j.attempts) FROM background_jobs j
    JOIN catalog_sync_members m ON m.source_id=j.resource_id AND m.accepted_revision=j.resource_version
    WHERE m.sync_id='${syncId}' AND j.kind IN ('prepare_source','raw_source_index')`);
  assert.equal(pending.length, 4);
  assert.ok(pending.every(job => job.state === 'queued' && job.attempts === 0));
  const replay = await h.request('/source-syncs', {operation_id: operationId});
  assert.equal(replay.status, 202);
  assert.equal(replay.value.sync_id, syncId);
  assert.equal(replay.value.status, 'completed');
  assert.equal(h.captured.length, 0);
  checks.push('原命令/批次完成，两页无重复领取或待办；未接处理器的四个任务仍为pending，模型调用为零');
  observations.jobs = jobs;
  passed = true;
} catch (error) {
  failure = error.message;
  throw error;
} finally {
  observations.elapsedMs ??= startedAt ? Date.now() - startedAt : null;
  observations.lastProgress = lastProgress;
  observations.calls = calls;
  // 先停测试Worker释放事务；触发器随本次专库一并清理，不在持锁期间DROP。
  await h.pauseWorker();
  if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
  await h.close();
  await writeFile('.local/checks/source-sync-heartbeat.json', JSON.stringify({passed, checks, failure, observations,
    evidence: {api: 'real', worker: 'real', storage: 'MySQL', platform: 'synthetic HTTP', model: 'capture',
      serviceLogs: relative(process.cwd(), h.directory) + '/service-logs.json'}, officialRequests: 0}, null, 2));
}
console.log(JSON.stringify({passed, checks, observations, officialRequests: 0}));
