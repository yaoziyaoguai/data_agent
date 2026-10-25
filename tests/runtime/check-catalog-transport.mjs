import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import net from 'node:net';

const sourceLimit = 8 * 1024 * 1024;
const pageLimit = 16 * 1024 * 1024;
const token = 'synthetic-catalog-transport-token';
const column = index => ({id: `field_${index}`, name: `field_${index}`, data_type: 'INTEGER', nullable: false, comment: '合成字段'});
const table = id => ({id, name: id, platform_version: '1', maintainer_id: 'alice', comment: '合成目录',
  ddl: `CREATE TABLE ${id} (field_0 INTEGER)`, columns: [column(0)],
  node: {id: `load_${id}`, sql: '', upstream_ids: []}});
const sizedTable = (id, bytes) => {
  const value = table(id);
  const available = bytes - Buffer.byteLength(JSON.stringify(value));
  value.node.sql = '中'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
  assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes, '夹具按UTF-8字节构造，不按字符数');
  return value;
};
const page = tables => ({schema_version: 1, source_namespace: 'synthetic-transport', snapshot_id: 'snapshot',
  tables, next_cursor: null, complete: true, authoritative: true});
const checks = [];
const env = {...process.env};
for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DATA_AGENT_MODEL_PROFILE', 'DATA_AGENT_FAULT', 'DATA_AGENT_DATABASE_URL']) delete env[key];
let passed = false;
await mkdir('.local/checks', {recursive: true});

async function rustTransport() {
  const expanded = table('wide_table');
  expanded.columns = Array.from({length: 201}, (_, index) => column(index));
  expanded.node.sql = '中'.repeat(40001);
  const first = sizedTable('large_first', sourceLimit);
  const second = table('large_second');
  const emptyPageSize = Buffer.byteLength(JSON.stringify(page([first, second])));
  const last = sizedTable('large_second', Buffer.byteLength(JSON.stringify(second)) + pageLimit - emptyPageSize);
  const exactPage = JSON.stringify(page([first, last]));
  assert.equal(Buffer.byteLength(exactPage), pageLimit);
  const closedCases = new Set();
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let body = '';
    for await (const chunk of request) body += chunk;
    const {cursor} = JSON.parse(body);
    response.on('close', () => closedCases.add(cursor));
    if (cursor === 'oversized_content_length') {
      response.writeHead(200, {'content-length': pageLimit + 1});
      response.flushHeaders();
      return;
    }
    if (cursor === 'oversized_chunked') {
      response.writeHead(200, {'content-type': 'application/json', 'transfer-encoding': 'chunked'});
      const chunk = Buffer.alloc(64 * 1024, 32);
      for (let remaining = pageLimit + 1; remaining > 0 && !response.destroyed;) {
        const bytes = chunk.subarray(0, Math.min(chunk.length, remaining));
        remaining -= bytes.length;
        if (!response.write(bytes)) await new Promise(resolve => {
          const done = () => {
            response.off('drain', done);
            response.off('close', done);
            resolve();
          };
          response.once('drain', done);
          response.once('close', done);
        });
      }
      return;
    }
    if (cursor === 'upstream_source_over_limit') {
      response.writeHead(413, {'content-type': 'application/json'});
      response.end(JSON.stringify({code: 'payload_limit', message: '完整来源JSON为8388609字节，超过8388608字节上限。'}));
      return;
    }
    const payload = cursor === 'expanded_table' ? JSON.stringify(page([expanded]))
      : cursor === 'source_below_limit' ? JSON.stringify(page([sizedTable('below', sourceLimit - 1)]))
      : cursor === 'source_at_limit' ? JSON.stringify(page([first]))
      : cursor === 'source_over_limit' ? JSON.stringify(page([sizedTable('above', sourceLimit + 1)]))
      : cursor === 'page_at_limit' ? exactPage
      : cursor === 'page_over_limit' ? exactPage + ' '
      : '{"schema_version":1,"tables":[';
    response.writeHead(200, {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)});
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.env.CARGO ?? `${process.env.HOME}/.cargo/bin/cargo`,
      ['test', '--offline', '--locked', '-p', 'data-agent', '--test', 'catalog_transport', '--', '--nocapture'], {
        env: {...env, DATA_AGENT_PLATFORM_URL: `http://127.0.0.1:${server.address().port}`, DATA_AGENT_INTERNAL_TOKEN: token},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {output += chunk; process.stdout.write(chunk);});
    const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});
    await writeFile('.local/checks/catalog-transport-rust.log', output);
    assert.equal(code, 0, 'Rust真实HTTP目录读取检查');
    assert.ok(closedCases.has('oversized_content_length'));
    assert.ok(closedCases.has('oversized_chunked'));
    checks.push('Rust真实HTTP：201字段/40001字符SQL、8MiB对象及16MiB页边界、逐块超限提前断开、截断JSON失败');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function mockTransport() {
  const directory = await mkdtemp('.local/checks/catalog-transport-');
  const allocator = net.createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const child = spawn('python3', ['apps/platform-mock/server.py', '--directory', directory, '--port', String(port)], {
    env: {...env, DATA_AGENT_INTERNAL_TOKEN: token}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output += chunk);
  const request = async body => {
    const result = await fetch(`http://127.0.0.1:${port}/catalog`, {method: 'POST',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    const bytes = Buffer.from(await result.arrayBuffer());
    return {status: result.status, bytes: bytes.length, value: JSON.parse(bytes.toString())};
  };
  const catalog = (tables, authoritative = true) => writeFile(`${directory}/catalog.json`, JSON.stringify({source_namespace: 'synthetic-transport', tables, authoritative}));
  try {
    const deadline = Date.now() + 20000;
    while (true) {
      try {if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;} catch {}
      assert.equal(child.exitCode, null, output);
      assert.ok(Date.now() < deadline, '合成平台启动');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const large = [sizedTable('voice_a', 6 * 1024 * 1024), sizedTable('voice_b', 6 * 1024 * 1024), sizedTable('voice_c', 6 * 1024 * 1024)];
    await catalog(large);
    const first = await request({limit: 50});
    assert.equal(first.status, 200);
    assert.equal(first.value.tables.length, 2, '超过16MiB时只交付完整的前两个对象');
    assert.ok(first.bytes <= pageLimit);
    assert.equal(first.value.complete, false);
    assert.deepEqual(first.value.tables, large.slice(0, 2));
    const next = await request({limit: 50, snapshot_id: first.value.snapshot_id, cursor: first.value.next_cursor});
    assert.equal(next.status, 200);
    assert.deepEqual(next.value.tables, large.slice(2));
    assert.equal(next.value.complete, true);
    assert.equal(next.value.next_cursor, null);
    checks.push('mock真实HTTP按完整对象分页，页字节有界，游标不跳过对象');

    await catalog([sizedTable('voice_limit', sourceLimit)]);
    const exact = await request({limit: 50});
    assert.equal(exact.status, 200);
    assert.equal(Buffer.byteLength(JSON.stringify(exact.value.tables[0])), sourceLimit);
    assert.equal(exact.value.complete, true);
    await catalog([sizedTable('voice_above', sourceLimit + 1)]);
    const refused = await request({limit: 50});
    assert.equal(refused.status, 413);
    assert.equal(refused.value.code, 'payload_limit');
    assert.match(refused.value.message, /8388609/);
    assert.match(refused.value.message, /8388608/);
    assert.equal('tables' in refused.value, false);
    checks.push('mock按中文UTF-8实际字节接受8MiB、拒绝多1字节，不截断成功');

    await catalog([table('voice_scope')], false);
    const scoped = await request({limit: 1});
    assert.equal(scoped.status, 200);
    assert.equal(scoped.value.source_namespace, 'synthetic-transport');
    assert.equal(scoped.value.authoritative, false);
    assert.equal(scoped.value.complete, true);
    const changed = await request({snapshot_id: first.value.snapshot_id});
    assert.equal(changed.status, 409);
    assert.equal(changed.value.code, 'version_conflict');
    for (const input of [{cursor: 'wrong-cursor'}, {limit: 0}]) {
      const invalid = await request(input);
      assert.equal(invalid.status, 409);
      assert.equal(invalid.value.code, 'invalid_input');
    }
    checks.push('mock保留来源命名空间/非权威标记，以及快照变化和非法游标拒绝');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await writeFile('.local/checks/catalog-transport-mock.log', output);
    await rm(directory, {recursive: true, force: true});
  }
}

try {
  if (!process.argv.includes('--mock-only')) await rustTransport();
  if (!process.argv.includes('--rust-only')) await mockTransport();
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0, mysql: false}));
} finally {
  await writeFile('.local/checks/catalog-transport.json', JSON.stringify({passed, checks, officialRequests: 0, mysql: false}, null, 2));
}
