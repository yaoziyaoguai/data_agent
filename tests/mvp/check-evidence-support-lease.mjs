import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';

// 仅延迟真实支持目录 SQL 的发送；认证、参数和响应原样透传，不用假回执替代读取。
const sockets = new Set(), observations = [];
let active, h, run, passed = false;
const frames = consume => {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUIntLE(0, 3) + 4;
      if (pending.length < size) break;
      const frame = pending.subarray(0, size);
      pending = pending.subarray(size);
      consume(frame, frame.subarray(4));
    }
  };
};
const proxy = net.createServer(socket => {
  const upstream = net.connect(13306, '127.0.0.1');
  for (const connection of [socket, upstream]) {
    sockets.add(connection);
    // Worker停止会关闭池连接；实际工具成功与正文断言负责发现传输故障。
    connection.on('error', () => {});
    connection.on('close', () => sockets.delete(connection));
  }
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  let authenticated = false, hello = false, preparing;
  const statements = new Map();
  const readKind = sql => sql.includes('FROM knowledge_objects k')
    && sql.includes('FROM expanded WHERE duplicate=1') ? 'support'
    : sql.includes('WITH entry_values AS') && sql.includes('slices.fragment') ? 'source'
    : sql.includes('FROM retrieval_documents AS r FORCE INDEX') ? 'candidate' : undefined;
  const clientFrames = frames((frame, payload) => {
    if (!authenticated) { hello = true; upstream.write(frame); return; }
    if (payload[0] === 0x16) preparing = readKind(payload.subarray(1).toString()) ?? false;
    if (payload[0] === 0x19) statements.delete(payload.readUInt32LE(1));
    const kind = payload[0] === 0x17 ? statements.get(payload.readUInt32LE(1))
      : payload[0] === 0x03 && readKind(payload.subarray(1).toString());
    if (kind && active?.kind === kind && !active.reached) {
      active.reached = true;
      active.release = () => upstream.write(frame);
      return;
    }
    upstream.write(frame);
  });
  const serverFrames = frames((frame, payload) => {
    if (!authenticated) {
      if (hello && payload[0] === 0x00) authenticated = true;
    } else if (preparing !== undefined && frame[3] === 1) {
      if (preparing && payload[0] === 0x00) statements.set(payload.readUInt32LE(1), preparing);
      preparing = undefined;
    }
    socket.write(frame);
  });
  socket.on('data', clientFrames);
  upstream.on('data', serverFrames);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
try {
  h = await harness({capture: true, startWorker: false,
    onDatabaseUrl: value => {
      const url = new URL(value); url.port = String(proxy.address().port);
      url.searchParams.set('ssl-mode', 'DISABLED'); return url.toString();
    }, env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2',
      DATA_AGENT_PREFILL_PROFILE: '', DATA_AGENT_VECTOR_URL: '', DATA_AGENT_VECTOR_COLLECTION: '',
      DATA_AGENT_EMBEDDING_URL: '', DATA_AGENT_MEMORY_URL: ''}});
  const query = 'supportlock' + randomUUID().replaceAll('-', '');
  const condition = '合成设备须经过人工复核，停用设备不得计入。';
  const source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成支持来源', body: condition, related_ids: []}));
  let object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: query, body: '初始化', related_ids: []}));
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version,
    entry_id: 'body', value: query + ' 合成已复核设备统计规则。', statements: [{key: 'verified-rule',
      target: {object_id: object.id, version: object.version, path: 'body'},
      text: query + ' 合成已复核设备统计规则。', scope_text: '', citations: [], supports_complete: true,
      supports: [{key: 'verification-condition', role: 'prerequisite', reference: {kind: 'source',
        citation: {source: {kind: 'document', id: source.id}, revision: source.version,
          locator: {offset: 0, length: [...condition].length}}}, content: condition, embedded_in: null}]}]}, 'alice', 'PATCH'));
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对合成规则与必要支持。'); await h.pauseWorker();
  assert.equal(run.tool_contract_version, 2);
  const manager = SessionManager.inMemory('/synthetic/evidence-support-lease');
  // 与其他直调测试一致：三项读取工具受正文准入门约束，先按原消息route。
  const route = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: 'update_analysis_task',
    arguments: {action: 'route', task_id: null, expected_version: null, goal: '', options: []},
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', route));
  ok(await h.internal('/internal/data/tools', route));
  const probe = () => h.sql(`SET SESSION innodb_lock_wait_timeout=1; START TRANSACTION;
    SELECT JSON_OBJECT('id',id,'owner',lease_owner) FROM conversations WHERE id='${run.conversation_id}' FOR UPDATE; COMMIT;`);
  assert.equal(probe()[0].id, run.conversation_id, '无读取时独立连接应能锁到实际会话行');
  for (const toolName of ['search_knowledge', 'read_knowledge', 'read_source']) {
    const args = toolName === 'search_knowledge' ? {query, kinds: ['term'], limit: 1}
      : toolName === 'read_source' ? {citation: {source: {kind: 'document', id: source.id},
        revision: source.version, locator: {offset: 0, length: [...condition].length}}}
      : {items: [{kind: 'knowledge', ref: {object_id: object.id, version: object.version, path: 'body'},
        statement_id: object.entries[0].human_override.statements[0].statement_id}]};
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
      tool_name: toolName, arguments: args,
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls', input));
    active = {toolName, kind: toolName === 'read_source' ? 'source' : 'support', reached: false};
    const invocation = h.internal('/internal/data/tools', input);
    let result;
    try {
      await until(() => active.reached, 'actual evidence content query');
      const started = Date.now();
      try {
        const rows = probe();
        assert.equal(rows.length, 1); assert.equal(rows[0].id, run.conversation_id);
        observations.push({toolName, lockAvailable: true, elapsedMs: Date.now() - started});
      } catch (error) {
        if (!String(error.stderr).includes('ERROR 1205')) throw error;
        observations.push({toolName, lockAvailable: false, mysqlCode: 1205, elapsedMs: Date.now() - started});
      }
    } finally {
      active.release?.(); active = undefined;
      result = ok(await invocation).data;
    }
    if (toolName === 'read_source') {
      assert.equal(result.text, condition, '释放后必须真实交付所请求的原文范围');
    } else {
      const item = toolName === 'search_knowledge' ? result.hits[0] : result.items[0];
      assert.equal(item.supports[0].content, condition, '释放后必须真实交付原支持正文');
      assert.equal(item.support_state, 'delivered');
    }
    assert.equal(probe()[0].id, run.conversation_id, '工具完成后会话锁应释放');
  }
  assert.ok(observations.every(item => item.lockAvailable),
    '支持正文准备属于锁外读取，不应阻塞独立会话续租：' + JSON.stringify(observations));

  const invoke = async (toolName, args) => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
      tool_name: toolName, arguments: args,
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls', input));
    return {input, execute: () => h.internal('/internal/data/tools', input)};
  };
  // SQL后备的一个owner先完成，另一个仍等待时，覆盖原因必须保留真实的共同期限。
  const sqlQuery = 'sqlcoverage' + randomUUID().replaceAll('-', '');
  let sqlObject = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: sqlQuery, body: sqlQuery + ' 合成当前定义。', related_ids: []}));
  sqlObject = ok(await h.request('/knowledge/' + sqlObject.id, {operation_id: randomUUID(),
    expected_version: sqlObject.version, entry_id: 'body', value: sqlQuery + ' 合成当前定义。',
    statements: [{key: 'sql-definition', target: {object_id: sqlObject.id, version: sqlObject.version, path: 'body'},
      text: sqlQuery + ' 合成当前定义。', scope_text: '', citations: [], supports_complete: true,
      supports: []}]}, 'alice', 'PATCH'));
  const sqlDelayed = await invoke('search_knowledge', {query: sqlQuery, kinds: ['term'], limit: 1});
  active = {kind: 'candidate', reached: false};
  const sqlStarted = Date.now(), sqlInvocation = sqlDelayed.execute();
  let sqlBounded, sqlTimeout;
  try {
    await until(() => active.reached, 'actual SQL fallback owner query');
    const response = await Promise.race([sqlInvocation,
      new Promise(resolve => { sqlTimeout = setTimeout(() => resolve(undefined), 12000); })]);
    assert.ok(response, 'SQL后备仍等待时应按原期限返回已读内容');
    sqlBounded = ok(response).data;
  } finally {
    clearTimeout(sqlTimeout); active.release?.(); active = undefined;
    await sqlInvocation;
  }
  observations.push({toolName: 'search_knowledge', sqlDeadline: true,
    elapsedMs: Date.now() - sqlStarted, coverage: sqlBounded.search_coverage});
  assert.ok(sqlBounded.hits.some(item => item.ref?.object_id === sqlObject.id));
  assert.equal(sqlBounded.search_coverage.state, 'bounded');
  assert.ok(sqlBounded.search_coverage.reasons.includes('deadline'),
    'SQL后备超时不能只报bounded而丢掉deadline：' + JSON.stringify(sqlBounded.search_coverage));
  // R12已确认语义（channel-faults r12-sql-truncation锁定）：SQL替代真实供词法
  // 正文时bm25报available；未配置的dense保持not_configured，SQL不是额外RRF通道。
  assert.deepEqual(sqlBounded.search_coverage.channels, [
    {channel: 'exact', state: 'available'}, {channel: 'bm25', state: 'available'},
    {channel: 'dense', state: 'not_configured'}], '精确优先只处理实际核验候选，SQL后备不是额外RRF通道');

  const delayed = await invoke('search_knowledge', {query, kinds: ['term'], limit: 1});
  active = {kind: 'support', reached: false};
  const started = Date.now(), invocation = delayed.execute();
  let bounded, timeout;
  try {
    await until(() => active.reached, 'support read reaches the original search deadline');
    const response = await Promise.race([invocation,
      new Promise(resolve => { timeout = setTimeout(() => resolve(undefined), 12000); })]);
    assert.ok(response, '搜索须在支持SQL仍等待时按原期限交付已取主命中与支持续读入口');
    bounded = ok(response).data;
  } finally {
    clearTimeout(timeout); active.release?.(); active = undefined;
    await invocation;
  }
  const hit = bounded.hits.find(item => item.ref?.object_id === object.id);
  assert.ok(hit?.definition.includes(query), '支持期限耗尽不能丢弃已经获得的主命中');
  assert.equal(hit.support_state, 'partial');
  assert.deepEqual(hit.supports, []);
  assert.ok(hit.continuation.supports_next_cursor);
  assert.equal(bounded.search_coverage.state, 'bounded');
  assert.ok(bounded.search_coverage.reasons.includes('deadline'));
  observations.push({toolName: 'search_knowledge', supportDeadline: true, elapsedMs: Date.now() - started});
  const next = await invoke('read_knowledge', {items: [{kind: 'knowledge', ref: hit.ref,
    statement_id: hit.statement_id, limit: 0, supports_cursor: hit.continuation.supports_next_cursor}]});
  const continued = ok(await next.execute()).data.items[0];
  assert.equal(continued.supports[0].content, condition);
  assert.equal(continued.continuation.supports_next_cursor, null);
  assert.deepEqual(ok(await h.internal('/internal/data/tools', delayed.input)).data, bounded,
    '支持恢复可读后，原搜索操作仍重放第一次冻结的partial回执');

  // 读快照已建立、正文尚未返回时停用来源；最终重核不能持久化旧正文或新采用记录。
  const revocable = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成会失效的来源', body: '此正文停用后不可交付。', related_ids: []}));
  const changing = await invoke('read_source', {citation: {source: {kind: 'document', id: revocable.id},
    revision: revocable.version, locator: {offset: 0, length: 8}}});
  active = {kind: 'source', reached: false};
  const changingRead = changing.execute();
  try {
    await until(() => active.reached, 'source snapshot before invalidation');
    ok(await h.request('/knowledge/' + revocable.id + '/disable',
      {operation_id: randomUUID(), expected_version: revocable.version}));
  } finally {
    active.release?.(); active = undefined;
  }
  const rejected = await changingRead;
  assert.notEqual(rejected.status, 200, '准备后来源停用须阻止旧正文交付');
  assert.ok(['not_available', 'stale_knowledge', 'stale_source', 'stale_context'].includes(rejected.value.code), JSON.stringify(rejected.value));
  const receipt = ok(await h.internal('/internal/data/tool-rejections', changing.input));
  assert.equal(receipt.data.outcome, 'rejected');
  assert.equal(Object.hasOwn(receipt.data, 'text'), false);
  const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  assert.ok(!authority.sources.some(reference => reference[0] === 'document-' + revocable.id));
  observations.push({toolName: 'read_source', invalidatedDuringRead: true, error: receipt.data.error});
  passed = true;
} finally {
  active?.release?.(); active = undefined;
  if (h) {
    h.releaseRun(run?.run_id);
    await h.close();
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
  await writeFile('.local/checks/evidence-support-lease.json', JSON.stringify({passed, observations,
    officialRequests: 0, evidence: '真实API工具登记/执行及MySQL；仅延迟原支持SQL，不使用模型',
    serviceLogs: h?.directory + '/service-logs.json'}, null, 2));
}
