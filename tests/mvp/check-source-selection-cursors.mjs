import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';

const legacyApi = process.argv[2] && resolve(process.argv[2]);
const evidence = {passed: false, officialRequests: 0, checks: [], calls: []};
const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const query = 'syntheticcursorordinary';
const h = await harness({capture: true, startWorker: false, apiBinary: legacyApi, env: {
  DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '', DATA_AGENT_LEASE_MS: '120000',
}});
console.log(JSON.stringify({evidenceDirectory: h.directory}));
const manager = SessionManager.inMemory('/synthetic/source-selection-cursors');
let run;

function toolInput(name, args, sdkToolCallId) {
  return {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: sdkToolCallId,
    tool_name: name, arguments: args,
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
}
async function invoke(name, args, {sdkId = randomUUID(), error, whenStaged} = {}) {
  const input = toolInput(name, args, sdkId);
  const registration = ok(await h.internal('/internal/data/tool-calls', input));
  const change = whenStaged && (async () => {
    const api = h.logs.findLast(log => log.name.startsWith('api'));
    const ready = () => api.output.split('test_retrieval_stage_ready run=' + run.run_id).length - 1;
    const before = ready();
    await until(() => ready() > before, '精读锁外阶段结束');
    const [saved] = h.sql(`SELECT JSON_ARRAY(state,receipt) FROM tool_calls WHERE operation_id='${registration.operation_id}'`);
    assert.deepEqual(saved, ['registered', null], '改变范围时原精读尚未写回');
    evidence.calls.push({phase: 'stage_ready', sdkId, operation: registration.operation_id});
    await whenStaged();
  })();
  const [response] = await Promise.all([h.internal('/internal/data/tools', input), change]);
  evidence.calls.push({name, args, sdkId, operation: registration.operation_id, ...response});
  if (error) {
    assert.notEqual(response.status, 200, error);
    assert.equal(response.value.code, error, JSON.stringify(response.value));
    assert.equal(Object.hasOwn(response.value, 'data'), false, '失效续页没有正文');
    const rejection = ok(await h.internal('/internal/data/tool-rejections', input));
    assert.equal(rejection.operation_id, registration.operation_id);
    assert.equal(rejection.data.error, error);
    assert.equal(Object.hasOwn(rejection.data, 'hits'), false);
    assert.deepEqual(h.sql(`SELECT JSON_ARRAY(state,JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.data.error')))
      FROM tool_calls WHERE operation_id='${registration.operation_id}'`), [['rejected', error]]);
    assert.deepEqual(ok(await h.internal('/internal/data/tools', input)), rejection);
    return rejection;
  }
  const receipt = ok(response);
  assert.equal(receipt.operation_id, registration.operation_id);
  return receipt;
}
const search = (args, options) => invoke('search_knowledge', args, options);
const cursorOf = receipt => {
  const next = receipt.data.search_coverage.next;
  assert.equal(next, 'rc1:' + receipt.operation_id);
  return next;
};
const persistedWindow = receipt => {
  const saved = h.sql(`SELECT JSON_OBJECT('state',state,'contract',tool_contract_version,
    'conversation',conversation_id,'next',JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.data.search_coverage.next')))
    FROM tool_calls WHERE operation_id='${receipt.operation_id}'`)[0];
  assert.equal(saved.state, 'succeeded');
  assert.equal(saved.contract, 2);
  assert.equal(saved.conversation, run.conversation_id);
  assert.ok(saved.next?.startsWith('{'), '合成小窗口应持久化为完整 JSON');
  return JSON.parse(saved.next);
};
const fullHeadReads = () => h.sql(`SELECT JSON_OBJECT('n',COALESCE(SUM(s.COUNT_EXECUTE),0))
  FROM performance_schema.prepared_statements_instances s
  JOIN performance_schema.threads t ON t.THREAD_ID=s.OWNER_THREAD_ID
  WHERE t.PROCESSLIST_DB=DATABASE()
  AND s.SQL_TEXT LIKE 'SELECT id,version FROM knowledge_objects WHERE space_id=%'`)[0].n;
const activeTask = async (goal, allowedSources = null) => (await invoke('update_analysis_task', {
  action: 'create', goal, options: [], conditions: {time_start: null, time_end: null, timezone: 'UTC',
    metric: null, channel: null, group_by: [], filters: [], knowledge_refs: [], notes: '',
    source_limits: allowedSources && {allowed_sources: allowedSources, origin_message_ids: [run.message_id]}},
})).data;
async function start(goal, allowedSources) {
  if (run) h.releaseRun(run.run_id);
  await h.resumeWorker();
  run = await h.capture(await h.create(), goal);
  await h.pauseWorker();
  return activeTask(goal, allowedSources);
}

try {
  const terms = [];
  for (const label of ['甲', '乙']) {
    terms.push(ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
      name: query + label, body: '合成借用规则' + label + '，归还后方可续借。', related_ids: []})));
  }
  await h.resumeWorker();
  await until(() => h.sql(`SELECT JSON_ARRAY(object_id,state) FROM knowledge_index_jobs
    WHERE object_id IN (${terms.map(term => `'${term.id}'`).join(',')}) AND target_kind='knowledge_entry'`)
    .filter(([, state]) => state === 'indexed').length === 2, '普通游标的两项真实 SQL 投影', 60000);
  const task = await start('核对合成付款和退款定义，以及普通检索游标。');
  const fieldIds = ['field-paid_amount_cents', 'field-refunded_amount_cents'];
  const identity = (await search({view: 'source_identity', query: fieldIds.join(' '), kinds: ['field']})).data;
  const selected = identity.hits.filter(hit => fieldIds.includes(hit.object_id));
  assert.deepEqual(selected.map(hit => hit.object_id), fieldIds);
  const args = {query: 'paid_amount_cents refunded_amount_cents', limit: 1,
    source_selection: selected.map(hit => ({object_id: hit.object_id, version: hit.object_version}))};
  const ordinaryArgs = {query, kinds: ['term'], limit: 1};
  const firstSdk = randomUUID();
  const headsBeforeSelected = fullHeadReads();
  const first = await search(args, {sdkId: firstSdk});
  const oldSelectedReads = fullHeadReads() - headsBeforeSelected;
  assert.equal(first.data.hits.length, 1);
  assert.equal(first.data.hits[0].record_kind, 'source_excerpt');
  const nextArgs = {...args, cursor: cursorOf(first)};
  const control = await search(nextArgs);
  assert.equal(control.data.hits.length, 1);
  assert.notDeepEqual(control.data.hits, first.data.hits);
  const headsBeforeOrdinary = fullHeadReads();
  const ordinary = await search(ordinaryArgs);
  const ordinaryReads = fullHeadReads() - headsBeforeOrdinary;
  assert.ok(ordinaryReads > 0, '普通搜索是完整允许集 SQL 计数的正控');
  const ordinaryNext = {...ordinaryArgs, cursor: cursorOf(ordinary)};
  const ordinaryControl = await search(ordinaryNext);
  assert.equal(ordinaryControl.data.hits.length, 1);
  assert.deepEqual(new Set([ordinary.data.hits[0], ordinaryControl.data.hits[0]].map(hit => hit.ref.object_id)),
    new Set(terms.map(term => term.id)));
  const selectedWindow = persistedWindow(first), ordinaryWindow = persistedWindow(ordinary);
  evidence.before = {selectedWindow, ordinaryWindow, task, selected: args.source_selection,
    fullHeadReads: {selected: oldSelectedReads, ordinary: ordinaryReads}};

  if (legacyApi) {
    assert.match(selectedWindow.scope, /^[a-f0-9]{64}$/);
    assert.match(ordinaryWindow.scope, /^[a-f0-9]{64}$/);
    assert.deepEqual(selectedWindow.task, [task.task_id, Number(task.condition_version)]);
    assert.ok(oldSelectedReads > 0, '旧精读实际读取完整允许集');
    evidence.legacyApiSha256 = createHash('sha256').update(await readFile(legacyApi)).digest('hex');
    await h.restartApi();
    const resumed = await search(nextArgs);
    assert.deepEqual(resumed.data.hits, control.data.hits, '同库升级后原精读 rc1 交付同一第二页');
    const ordinaryResumed = await search(ordinaryNext);
    assert.deepEqual(ordinaryResumed.data.hits, ordinaryControl.data.hits, '同库升级后原普通 rc1 交付同一第二页');
    assert.deepEqual((await search(args, {sdkId: firstSdk})).data, first.data, '原操作重放接回旧成功回执');
    await search({...nextArgs, source_selection: args.source_selection.slice(1)}, {error: 'invalid_cursor'});
    await search({...args, cursor: JSON.stringify(selectedWindow)}, {error: 'stale_cursor'});
    evidence.checks.push('同库升级的两类旧 rc1 均交付原第二页，精读成功操作按原回执重放，拒绝选择变更和旧内联精读窗口');
  }

  const freshHeadReads = fullHeadReads();
  const fresh = await search(args);
  evidence.freshFullHeadReads = fullHeadReads() - freshHeadReads;
  assert.deepEqual(fresh.data.hits, first.data.hits);
  const unrelated = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成无关新文档', body: '该材料未被精读选择。', related_ids: []}));
  evidence.unrelated = unrelated.id;
  const freshNext = {...args, cursor: cursorOf(fresh)};
  const read = await search(freshNext);
  assert.deepEqual(read.data.hits, control.data.hits, '新精读游标在无关文档新增后仍交付同一第二页');
  assert.equal(evidence.freshFullHeadReads, 0, '精读准备不运行全目录 SQL');
  assert.match(persistedWindow(fresh).scope, /^sg1:[a-f0-9]{64}$/);
  assert.deepEqual((await search(ordinaryNext)).data.hits, ordinaryControl.data.hits,
    '普通召回的 kinds=term 排除了新增文档');
  ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: '合成无关新词条', body: '该词条进入普通召回的允许范围。', related_ids: []}));
  await search(ordinaryNext, {error: 'stale_cursor'});
  evidence.checks.push('新增无关文档后精读仍交付同一第二页，精读全目录 SQL 为零，普通游标只在其允许集合变化时失效');

  const switched = await activeTask('切换到另一项合成核对。');
  assert.notEqual(switched.task_id, task.task_id);
  await search(freshNext, {error: 'stale_cursor'});
  if (legacyApi) await search(nextArgs, {error: 'stale_cursor'});
  await start('在另一会话单独核对合成精读来源。');
  await search(freshNext, {error: 'invalid_cursor'});
  if (legacyApi) await search(nextArgs, {error: 'invalid_cursor'});
  evidence.checks.push('新旧精读公共游标均绑定活动任务和原会话');

  const guide = {kind: 'platform', id: 'business-guide'}, schema = {kind: 'platform', id: 'schema'};
  const scoped = await start('先允许合成业务说明和 DDL，随后撤销 DDL 许可。', [guide, schema]);
  const scopedFirst = await search(args);
  assert.deepEqual(scopedFirst.data.hits[0].citation.source, guide);
  assert.deepEqual(control.data.hits[0].citation.source, schema);
  const scopedNext = {...args, cursor: cursorOf(scopedFirst)};
  assert.deepEqual((await search(scopedNext)).data.hits, control.data.hits, '撤权前未交窗口可交付 DDL');
  // 另起同样的任务，确保变更时本会话尚未交付 DDL 正文。
  const revoking = await start('合成复核中撤销 DDL 许可。', [guide, schema]);
  assert.notEqual(revoking.task_id, scoped.task_id);
  const revokingFirst = await search(args);
  assert.deepEqual(revokingFirst.data.hits, scopedFirst.data.hits);
  h.env.DATA_AGENT_TEST_RETRIEVAL_DELAY_MS = '6000';
  await h.restartApi();
  await search({...args, cursor: cursorOf(revokingFirst)}, {error: 'stale_cursor', whenStaged: async () => {
    const revised = await invoke('update_analysis_task', {action: 'revise', task_id: revoking.task_id,
      expected_version: revoking.condition_version, goal: '', options: [], condition_patch: {set: {
        source_limits: {allowed_sources: [guide], origin_message_ids: [run.message_id]}}, unset: []}});
    assert.notEqual(revised.data.condition_version, revoking.condition_version);
    evidence.revisedGate = revised.data.conditions.source_limits;
    assert.deepEqual(evidence.revisedGate.allowed_sources, [guide]);
  }});
  delete h.env.DATA_AGENT_TEST_RETRIEVAL_DELAY_MS;
  await h.restartApi();
  evidence.checks.push('锁外阶段结束且回执尚未写回时收紧任务来源，旧页明确 stale_cursor，持久拒绝无正文且可重放');

  await start('核对未交付字段换版，仅读合成 DDL。', [schema]);
  const ddl = await search(args);
  assert.match(ddl.data.hits[0].text, /^paid_amount_cents /);
  assert.deepEqual(ddl.data.hits[0].citation.source, schema);
  const pendingField = ok(await h.request('/knowledge/' + fieldIds[1]));
  const definition = pendingField.entries.find(entry => entry.path === 'meaning');
  const changed = ok(await h.request('/knowledge/' + pendingField.id, {operation_id: randomUUID(),
    expected_version: pendingField.version, entry_id: definition.entry_id, value: definition.effective_value,
    structured_value: definition.effective_structure}, 'alice', 'PATCH'));
  assert.notEqual(changed.version, pendingField.version);
  await search({...args, cursor: cursorOf(ddl)}, {error: 'stale_cursor'});
  evidence.checks.push('未交付字段从正式维护入口换版，旧精读游标拒绝且不交旧正文');

  await start('只改合成 DDL 原文修订，选中字段保持现版。', [guide, schema]);
  const current = (await search({view: 'source_identity', query: fieldIds.join(' '), kinds: ['field']})).data.hits;
  const currentArgs = {...args, source_selection: fieldIds.map(id => {
    const hit = current.find(hit => hit.object_id === id);
    return {object_id: hit.object_id, version: hit.object_version};
  })};
  const versioned = await search(currentArgs);
  assert.deepEqual(versioned.data.hits[0].citation.source, guide);
  const currentNext = {...currentArgs, cursor: cursorOf(versioned)};
  const revisionControl = await search(currentNext);
  assert.deepEqual(revisionControl.data.hits, control.data.hits);
  const sourceVersion = () => h.sql("SELECT JSON_ARRAY(version) FROM source_heads WHERE id='schema'")[0][0];
  const oldRevision = sourceVersion();
  assert.equal(String(oldRevision), revisionControl.data.hits[0].citation.revision);
  // 模拟原文 owner 已提交新修订、语义尚未换版的窗口。仅改隔离夹具中的来源。
  h.sql("START TRANSACTION; INSERT INTO source_snapshots(source_id,version,body,complete) " +
    "SELECT id,version+1,'合成 DDL 新修订。',TRUE FROM source_heads WHERE id='schema'; " +
    "UPDATE source_heads SET version=version+1 WHERE id='schema'; COMMIT;");
  assert.equal(Number(sourceVersion()), Number(oldRevision) + 1);
  const afterIdentity = (await search({view: 'source_identity', query: fieldIds.join(' '), kinds: ['field']})).data.hits;
  assert.deepEqual(fieldIds.map(id => afterIdentity.find(hit => hit.object_id === id).object_version),
    currentArgs.source_selection.map(value => value.version));
  await search(currentNext, {error: 'stale_cursor'});
  evidence.checks.push('原文修订变化且对象版本不变，旧精读游标拒绝且不交旧正文');

  evidence.passed = true;
  console.log(JSON.stringify({passed: true, checks: evidence.checks, officialRequests: 0}));
} finally {
  await writeFile(h.directory + '/source-selection-cursors.json', JSON.stringify(evidence, null, 2));
  await h.close();
}
