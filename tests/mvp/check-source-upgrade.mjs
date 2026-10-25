import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness, until} from './harness.mjs';

// 只由当前兼容writer运行；SQL仅构造升级前缺失/过期的派生存储和受控并发窗口。
const selected = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
const cases = ['stable-keys', 'legacy-backfill', 'comparison-upgrade', 'concurrent-write'];
assert.ok(selected === null || cases.includes(selected), 'unknown upgrade case');
const h = await harness({capture: true, startWorker: false, env: {DATA_AGENT_TEST_WORKER_ROLE: 'source_sync'}});
const database = new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
assert.match(database, /^data_agent_test_[a-f0-9]+$/);
const checks = [], gates = [];
let passed = false;
const quote = value => "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
const table = (id, comment = '完全合成的座舱语音事件') => ({
  id, name: id, platform_version: '1', maintainer_id: 'alice', comment,
  ddl: `CREATE TABLE ${id} (event_id INTEGER, state TEXT);`,
  columns: [{id: 'event_id', name: 'event_id', data_type: 'INTEGER', nullable: false, comment: '一次合成事件的稳定标识'},
    {id: 'state', name: 'state', data_type: 'TEXT', nullable: false, comment: '合成链路状态'}],
  node: {id: 'load_' + id, sql: `INSERT INTO ${id} SELECT event_id, '未 完成' FROM synthetic_events;`, upstream_ids: ['synthetic_events']},
});
const save = (namespace, tables) => writeFile(h.directory + '/platform/catalog.json', JSON.stringify({source_namespace: namespace, authoritative: true, tables}));
const startSync = async (namespace, tables) => {
  await save(namespace, tables);
  const response = await h.request('/source-syncs', {operation_id: randomUUID()});
  assert.equal(response.status, 202, JSON.stringify(response.value));
  return response.value;
};
const finished = accepted => until(async () => {
  const current = ok(await h.request(accepted.status_url));
  assert.notEqual(current.status, 'failed', JSON.stringify(current));
  return current.status === 'completed' && current;
}, '来源同步完成', 60000);
const synchronize = async (namespace, tables) => {
  const accepted = await startSync(namespace, tables);
  await h.resumeWorker();
  return finished(accepted);
};
const identities = namespace => h.sql(`SELECT JSON_OBJECT('source_id',p.source_id,'external_id',p.platform_table_id,'object_id',k.id,'object_version',k.version,'revision',s.version)
  FROM catalog_platform_heads p JOIN source_heads s ON s.id=p.source_id
  JOIN knowledge_objects k ON k.source_id=p.source_id AND k.kind='table'
  WHERE BINARY p.namespace=BINARY ${quote(namespace)} ORDER BY BINARY p.platform_table_id`);
const current = source => h.sql(`SELECT JSON_OBJECT('source_id',source_id,'revision',revision,'body',body,'metadata',metadata,
  'observed',observed_metadata,'method',comparison_method,'namespace',namespace,'external_id',external_id,
  'fingerprint',content_fingerprint) FROM source_current WHERE source_id=${quote(source)}`)[0];
const countCurrent = ids => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM source_current WHERE source_id IN (${ids.map(quote).join(',')})`)[0].n;
async function hold(query) {
  const container = execFileSync('docker', ['--context', 'colima-data-agent', 'ps', '--filter', 'label=com.docker.compose.project=data-agent',
    '--filter', 'label=com.docker.compose.service=mysql', '--format', '{{.ID}}'], {encoding: 'utf8'}).trim();
  assert.match(container, /^[a-f0-9]+$/);
  const child = spawn('docker', ['--context', 'colima-data-agent', 'exec', '-i', container, 'mysql', '--defaults-extra-file=/run/secrets/mysql_root_client',
    '--default-character-set=utf8mb4', '--batch', '--raw', '--unbuffered', '--skip-column-names', database], {stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', errors = '';
  child.stdout.on('data', value => output += value); child.stderr.on('data', value => errors += value);
  const ended = new Promise(resolve => child.once('exit', resolve));
  const gate = {child, ended, released: false}; gates.push(gate);
  child.stdin.write(`START TRANSACTION; ${query}; SELECT 'upgrade_lock_held';\n`);
  await until(() => { assert.equal(errors, ''); return output.includes('upgrade_lock_held'); }, '取得升级并发锁');
  return async () => {
    if (gate.released) return;
    gate.released = true; child.stdin.end('COMMIT;\n');
    assert.equal(await ended, 0, errors);
  };
}
try {
  if (!selected || selected === 'stable-keys') {
    const namespace = 'synthetic-voice-case';
    const lower = table('voice_events', '小写外部键的原文标记'), upper = table('VOICE_EVENTS', '大写外部键的原文标记');
    upper.name = lower.name;
    await synchronize(namespace, [lower, upper]);
    const ids = identities(namespace);
    assert.equal(ids.length, 2); assert.notEqual(ids[0].source_id, ids[1].source_id);
    assert.notEqual(ids[0].object_id, ids[1].object_id);
    for (const value of [lower, upper]) {
      const id = ids.find(item => item.external_id === value.id);
      const source = ok(await h.request('/sources/' + id.source_id));
      assert.ok(source.body.includes(value.comment), '大小写不同外部键不能读到另一来源的正文');
      assert.equal(current(id.source_id)?.external_id, value.id, '每个稳定键都要有独立当前正文');
    }
    const otherNamespace = 'synthetic-Voice-case';
    await synchronize(otherNamespace, [{...lower, comment: '大小写不同namespace的独立原文'}]);
    const other = identities(otherNamespace)[0];
    assert.ok(other); assert.ok(ids.every(id => id.source_id !== other.source_id));
    assert.equal(current(other.source_id)?.namespace, otherNamespace);
    const original = ids.find(id => id.external_id === lower.id);
    assert.equal(current(original.source_id).namespace, namespace);
    const renamed = {...lower, name: 'renamed_voice_events', platform_version: '2'};
    await synchronize(namespace, [renamed, upper]);
    const after = identities(namespace).find(id => id.external_id === lower.id);
    assert.equal(after.source_id, original.source_id); assert.equal(after.object_id, original.object_id);
    assert.equal(ok(await h.request('/knowledge/' + original.object_id)).name, renamed.name);
    assert.equal(current(other.source_id).body.includes('大小写不同namespace的独立原文'), true);
    checks.push('同名对象按namespace/external_id精确身份隔离，大小写不折叠，改名不换来源与对象ID');
  }

  if (!selected || selected === 'legacy-backfill') {
    const namespace = 'synthetic-voice-upgrade-batches';
    await synchronize(namespace, Array.from({length: 33}, (_, index) => table('legacy_voice_' + String(index).padStart(2, '0'))));
    await h.pauseWorker();
    const before = identities(namespace), ids = before.map(value => value.source_id).sort();
    assert.equal(ids.length, 33);
    const contents = new Map(ids.map(id => [id, current(id).body]));
    // 旧结构有source_heads/snapshots和知识对象，但迁移后的派生当前表尚未回填。
    h.sql(`DELETE FROM source_current WHERE source_id IN (${ids.map(quote).join(',')})`);
    assert.equal(countCurrent(ids), 0);
    // 小表上的大IN列表可能被MySQL改成全表扫描并锁住全部头；逐个主键只锁预定的尾部。
    const release = await hold(ids.slice(17).map(id => `SELECT id FROM source_heads WHERE id=${quote(id)} FOR UPDATE`).join('; '));
    await h.resumeWorker();
    try {
      await until(() => countCurrent(ids) === 17, '回填超过一个批次并跳过被锁住的剩余来源');
    } catch (error) {
      console.error(JSON.stringify({backfilled: countCurrent(ids), locks: h.sql(`SELECT JSON_OBJECT('table',l.OBJECT_NAME,
        'mode',l.LOCK_MODE,'status',l.LOCK_STATUS,'key',l.LOCK_DATA) FROM performance_schema.data_locks l
        WHERE l.OBJECT_SCHEMA=${quote(database)} AND l.LOCK_TYPE='RECORD'`)}));
      throw error;
    }
    await h.pauseWorker();
    assert.equal(countCurrent(ids), 17, '中断点确实仍有未完成来源');
    assert.deepEqual(identities(namespace), before, '部分回填不修改旧来源/对象ID及修订');
    await release(); await h.resumeWorker();
    await until(() => countCurrent(ids) === 33, '重启后补齐剩余来源');
    await h.pauseWorker();
    assert.deepEqual(identities(namespace), before);
    for (const item of before) {
      assert.equal(current(item.source_id).revision, item.revision);
      assert.equal(current(item.source_id).body, contents.get(item.source_id));
      assert.equal(ok(await h.request('/sources/' + item.source_id)).body, contents.get(item.source_id));
    }
    checks.push('33份旧来源分批回填，明确中断后恢复，原来源/对象身份、修订与正文逐份保留');
  }

  if (!selected || selected === 'comparison-upgrade') {
    const namespace = 'synthetic-voice-comparison-upgrade', original = table('comparison_voice');
    await synchronize(namespace, [original]);
    const identity = identities(namespace)[0];
    const baseline = current(identity.source_id);
    const observed = {...original, platform_version: '9', maintainer_id: 'bob',
      node: {...original.node, sql: "INSERT  INTO comparison_voice\nSELECT event_id, '未 完成'\nFROM synthetic_events;"}};
    await synchronize(namespace, [observed]);
    await h.pauseWorker();
    assert.deepEqual(current(identity.source_id).observed, {platform_version: '9', maintainer_id: 'bob'});
    assert.equal(current(identity.source_id).metadata.platform_version, '1', '保留原文的旧元数据与最新观测分离');
    h.sql(`UPDATE source_current SET comparison_method='retired_comparison_v0',content_fingerprint=REPEAT('0',64),explanation_fingerprint=REPEAT('1',64) WHERE source_id=${quote(identity.source_id)}`);
    await h.resumeWorker();
    await until(() => current(identity.source_id).method === baseline.method, '仅回填升级比较方法');
    await h.pauseWorker();
    assert.deepEqual(current(identity.source_id).observed, {platform_version: '9', maintainer_id: 'bob'},
      '方法回填不能用旧正文metadata覆盖较新观测版本或负责人');
    assert.equal(current(identity.source_id).body, baseline.body);
    const jobsBefore = h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE resource_id=${quote(identity.source_id)} AND kind IN ('prepare_source','raw_source_index')`)[0].n;
    h.sql(`UPDATE source_current SET comparison_method='retired_comparison_v0',content_fingerprint=REPEAT('2',64) WHERE source_id=${quote(identity.source_id)}`);
    h.sql(`UPDATE source_heads SET fingerprint=REPEAT('3',64) WHERE id=${quote(identity.source_id)}`);
    await synchronize(namespace, [{...observed, platform_version: '10', node: {...observed.node,
      sql: "INSERT\nINTO comparison_voice SELECT event_id, '未 完成' FROM synthetic_events;"}}]);
    assert.equal(current(identity.source_id).revision, identity.revision);
    assert.equal(current(identity.source_id).body, baseline.body);
    assert.equal(ok(await h.request('/knowledge/' + identity.object_id)).version, String(identity.object_version));
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE resource_id=${quote(identity.source_id)} AND kind IN ('prepare_source','raw_source_index')`)[0].n, jobsBefore);
    assert.deepEqual(current(identity.source_id).observed, {platform_version: '10', maintainer_id: 'bob'});
    checks.push('比较方法升级同方法重比两份SQL，纯排版不升版、不改正文或重复排任务，旧metadata不覆盖新观测');
  }

  if (!selected || selected === 'concurrent-write') {
    const namespace = 'synthetic-voice-upgrade-race', original = table('race_voice', '回填前的旧合成说明');
    await synchronize(namespace, [original]); await h.pauseWorker();
    const identity = identities(namespace)[0];
    h.sql(`UPDATE source_current SET comparison_method='retired_comparison_v0' WHERE source_id=${quote(identity.source_id)}`);
    const release = await hold(`SELECT source_id FROM source_current WHERE source_id=${quote(identity.source_id)} FOR UPDATE`);
    const changed = {...original, platform_version: '2', comment: '实时同步的新合成说明'};
    const accepted = await startSync(namespace, [changed]);
    await h.resumeWorker();
    await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM performance_schema.data_lock_waits w
      JOIN performance_schema.data_locks l ON w.REQUESTING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID
      WHERE l.OBJECT_SCHEMA=${quote(database)} AND l.OBJECT_NAME='source_current'`)[0].n > 0, '实时写与旧当前内容回填真实竞争');
    await h.resumeSourceSyncWorker();
    await release();
    await finished(accepted);
    await until(() => current(identity.source_id).revision === identity.revision + 1, '较新来源修订保存完成');
    const value = current(identity.source_id);
    assert.ok(value.body.includes(changed.comment)); assert.ok(!value.body.includes(original.comment));
    assert.deepEqual(value.observed, {platform_version: '2', maintainer_id: 'alice'});
    assert.equal(identities(namespace)[0].revision, value.revision);
    assert.equal(identities(namespace)[0].object_id, identity.object_id);
    assert.equal(ok(await h.request('/sources/' + identity.source_id)).body, value.body);
    const pending = h.sql(`SELECT JSON_OBJECT('kind',kind,'state',state,'attempts',attempts,'version',resource_version)
      FROM background_jobs WHERE resource_id=${quote(identity.source_id)} AND kind IN ('prepare_source','raw_source_index') ORDER BY kind,resource_version`);
    assert.equal(pending.length, 4);
    assert.ok(pending.every(job => job.state === 'queued' && job.attempts === 0), '未接处理器的新任务不能被旧消费者领取或伪完成');
    checks.push('回填与实时写真实竞争后当前正文保持新修订，新prepare/raw任务仍未被错误消费');
  }
  passed = true;
} finally {
  for (const gate of gates) if (!gate.released) { gate.released = true; gate.child.stdin.end('ROLLBACK;\n'); await gate.ended; }
  await h.close();
  await writeFile('.local/checks/source-upgrade' + (selected ? '-' + selected : '') + '.json', JSON.stringify({passed, checks, selected,
    evidence: {api: 'real', worker: 'real', storage: 'MySQL', platform: 'synthetic', model: 'capture'}, officialRequests: 0}, null, 2));
}
console.log(JSON.stringify({passed, checks, selected, officialRequests: 0}));
