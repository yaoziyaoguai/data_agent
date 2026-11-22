import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const traffic = {bytes: 0, injected: 0};
const sockets = new Set();
const proxyErrors = [];
let failNextPage = false;
// 只识别窄正文查询的prepare/execute；认证与参数原样透传且不记录。
const frames = consume => {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUIntLE(0, 3) + 4;
      if (pending.length < length) break;
      const frame = pending.subarray(0, length);
      pending = pending.subarray(length);
      consume(frame, frame.subarray(4));
    }
  };
};
const proxy = net.createServer(socket => {
  const upstream = net.connect(13306, '127.0.0.1');
  for (const connection of [socket, upstream]) {
    sockets.add(connection);
    connection.on('error', () => {});
    connection.on('close', () => sockets.delete(connection));
  }
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  let authenticated = false, hello = false, preparing;
  const statements = new Set();
  const isPage = sql => sql.includes('FROM knowledge_objects k') && sql.includes("SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(e,'$.effective_value'))");
  const clientFrames = frames((frame, payload) => {
    if (!authenticated) {
      hello = true;
      upstream.write(frame);
      return;
    }
    if (payload[0] === 0x16) preparing = isPage(payload.subarray(1).toString());
    if (payload[0] === 0x19) statements.delete(payload.readUInt32LE(1));
    const page = payload[0] === 0x17 ? statements.has(payload.readUInt32LE(1))
      : payload[0] === 0x03 && isPage(payload.subarray(1).toString());
    if (page && failNextPage) {
      failNextPage = false;
      traffic.injected++;
      socket.destroy();
      upstream.destroy();
      return;
    }
    upstream.write(frame);
  });
  const serverFrames = frames((frame, payload) => {
    if (!authenticated) {
      if (hello && payload[0] === 0x00) authenticated = true;
    } else if (preparing !== undefined && frame[3] === 1) {
      if (preparing && payload[0] === 0x00) statements.add(payload.readUInt32LE(1));
      preparing = undefined;
    }
    traffic.bytes += frame.length;
    socket.write(frame);
  });
  socket.on('data', chunk => {
    try { clientFrames(chunk); }
    catch (error) {proxyErrors.push(error.message); socket.destroy(); upstream.destroy();}
  });
  upstream.on('data', chunk => {
    try { serverFrames(chunk); }
    catch (error) {proxyErrors.push(error.message); socket.destroy(); upstream.destroy();}
  });
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
let h, run, prepared = false, passed = false;
const observations = {};
const checks = [];
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
try {
  h = await harness({capture: true, startWorker: false,
    onDatabaseUrl: value => {
      const url = new URL(value);
      url.port = String(proxy.address().port);
      url.searchParams.set('ssl-mode', 'DISABLED');
      return url.toString();
    },
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  const object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: '合成定点补读边界', body: '初始化', related_ids: []}));
  const text = '甲'.repeat(90_000) + '选定🧪é区间。' + '乙'.repeat(90_000);
  const entry = object.entries[0];
  entry.effective_value = text;
  entry.suggestion = {};
  entry.human_override = null;
  entry.source_facts = {complete: false, gap: '合成补读材料'};
  object.entries.push({...structuredClone(entry), entry_id: 'unselected', path: 'unselected',
    effective_value: '无关大条目。'.repeat(50_000)});
  const encoded = Buffer.from(JSON.stringify(object)).toString('hex');
  h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${object.id}';
    UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}'`);
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对合成大条目中的指定窗口。'); await h.pauseWorker();
  assert.equal(run.tool_contract_version, 2);
  const manager = SessionManager.inMemory('/synthetic/evidence-read-boundaries');
  // 与其他直调测试一致：read_knowledge受正文准入门约束，先按原消息route再补读。
  const route = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: 'update_analysis_task',
    arguments: {action: 'route', task_id: null, expected_version: null, goal: '', options: []},
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', route));
  ok(await h.internal('/internal/data/tools', route));
  const register = async args => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: 'read_knowledge', arguments: args,
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls', input));
    return input;
  };
  const reference = {object_id: object.id, version: object.version, path: entry.path};
  const before = traffic.bytes;
  const input = await register({items: [{kind: 'knowledge', ref: reference, offset: 90_000, limit: 6}]});
  const read = ok(await h.internal('/internal/data/tools', input)).data;
  observations.narrowRead = {bytes: traffic.bytes - before, selectedChars: [...text].length, unselectedChars: 300_000};
  validateContract('KnowledgeReadReply', read);
  assert.equal(read.items[0].content, '选定🧪é区');
  assert.equal(read.items[0].content_page.offset, 90_000);
  assert.equal(read.items[0].content_page.next_offset, 90_006);
  assert.ok(observations.narrowRead.bytes < 80_000, '正式批量补读只下行所选Unicode窗口，不能加载巨大entry或未选条目：' + JSON.stringify(observations));
  checks.push('大条目与未选条目不整读，保留原Unicode坐标');

  const failureInput = await register({items: [{kind: 'knowledge', ref: {...reference, object_id: 'synthetic-unavailable'}},
    {kind: 'knowledge', ref: reference, offset: 90_000, limit: 6}]});
  failNextPage = true;
  const failed = await h.internal('/internal/data/tools', failureInput);
  assert.equal(traffic.injected, 1, '故障必须在真实MySQL正文请求派发时发生');
  assert.equal(failed.status, 503, JSON.stringify(failed.value));
  assert.equal(failed.value.code, 'upstream_failed', '服务故障必须整次失败，不能伪装逐项不存在');
  assert.equal(Object.hasOwn(failed.value, 'items'), false);
  const rejection = ok(await h.internal('/internal/data/tool-rejections', failureInput));
  assert.equal(rejection.data.error, 'upstream_failed');
  assert.equal(Object.hasOwn(rejection.data, 'items'), false);
  assert.equal(Object.hasOwn(rejection.data, 'content'), false);
  checks.push('真实MySQL连接故障整次upstream_failed并保存明确拒绝');
  observations.failure = {status: failed.status, code: failed.value.code, injected: traffic.injected};
  assert.deepEqual(proxyErrors, []);
  h.releaseRun(run.run_id);
  passed = true;
  console.log(JSON.stringify({passed, checks, observations, officialRequests: 0}));
} finally {
  if (h) {await writeFile(h.directory + '/evidence-read-boundaries.json', JSON.stringify({passed, checks, observations, proxyErrors, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
}
