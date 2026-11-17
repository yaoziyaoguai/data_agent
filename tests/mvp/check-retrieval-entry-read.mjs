import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

// 被选对象自身的窄读证据（05切片2）：候选阶段不读全库已由granularity检查证明；
// 此处固定同一被选对象与命中位置，只扩大该对象未命中的entries——选中后的
// 定点读取不得装配整对象正文。判据是真实MySQL下行：命中查询相对零命中查询
// 的下行增量必须远小于对象总体积。向量路与SQL后备路分别取证：SQL后备必须
// 返回真实条目身份，窄读后片段仍能定位到命中条目。
const structureOnly = process.argv.includes('--structure-only');
if (!structureOnly) execFileSync(homedir()+'/.cargo/bin/cargo', ['test','--offline','--locked','-p','data-agent','--lib','modules::retrieval'], {stdio:'inherit'});

const MARKER = 'narneedle';
const FILLER_ENTRIES = 15;
const FILLER_REPEAT = 112; // 每条2240字符、8个索引片，15条+定位条目共121片<128上限
const fillerEntry = index => ('第'+index+'章例行运行记录与资料保管台账。').repeat(FILLER_REPEAT); // 20字×112
const objectBody = {
  id: '', kind: 'document', name: '窄读定位资料', version: '1', state: 'enabled',
  entries: [
    {entry_id: 'needle-entry', path: 'needle-entry', label: '定位规则',
      effective_value: '窄读定位标记词 '+MARKER+' 必须出现在唯一条目，其余章节均不含该标记。',
      source_facts: {complete: false, gap: '独立合成窄读夹具'}, suggestion: {}, human_override: null, review_state: 'unverified'},
    ...Array.from({length: FILLER_ENTRIES}, (_, i) => ({
      entry_id: 'filler-'+i, path: 'filler-'+i, label: '例行章节',
      effective_value: fillerEntry(i + 1),
      source_facts: {complete: false, gap: '独立合成窄读夹具'}, suggestion: {}, human_override: null, review_state: 'unverified',
    })),
  ],
  related_ids: [], source_id: null, source_version: '0', updated_by: 'synthetic-test',
};

const shipped = {bytes: 0};
const sockets = new Set();
const proxy = net.createServer(sock => {
  sock.on('error', () => {});
  const remote = net.connect(13306, '127.0.0.1');
  remote.on('error', () => {});
  sockets.add(sock); sockets.add(remote);
  sock.on('close', () => { remote.destroy(); sockets.delete(sock); });
  remote.on('close', () => { sock.destroy(); sockets.delete(remote); });
  sock.on('data', chunk => remote.write(chunk));
  remote.on('data', chunk => { shipped.bytes += chunk.length; sock.write(chunk); });
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

const checks = [];
const windows = {};
let passed = false;
const manager = SessionManager.inMemory('/synthetic/data-agent');
const invoke = async (h, run, name, args) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args,
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
  await h.internal('/internal/data/tool-calls', input);
  return ok(await h.internal('/internal/data/tools', input)).data;
};
const assertNarrowRead = (result, objectBytes, label) => {
  assert.equal(result.objects.length, 1, JSON.stringify(result.search_coverage));
  const object = result.objects[0];
  assert.equal(object.retrieval.state, 'located', JSON.stringify(object.retrieval));
  const excerpt = object.retrieval.excerpts.find(value => value.entry_id === 'needle-entry');
  assert.ok(excerpt, '片段必须定位到命中条目needle-entry：' + JSON.stringify(object.retrieval));
  assert.ok(excerpt.text.includes(MARKER), '片段须含命中标记词');
  assert.ok(object.entries.some(entry => entry.entry_id === 'needle-entry' && entry.effective_value.includes(MARKER)),
    '回执须保留命中条目正文');
  assert.equal(object.entries_complete, false, '未选条目不得伪装成完整对象');
  return excerpt;
};

try {
  // 阶段一：向量路可用（真实Milvus+Embedding替身）。命中位置来自向量命中的
  // entry/offset，选中后只窄读命中条目及必要支持。
  if (!structureOnly) {
    const provider = await embeddingProvider();
    const collection = 'da_entryread_'+randomUUID().replaceAll('-','');
    const h = await harness({capture: true, startWorker: false,
      onDatabaseUrl: url => url.replace('@127.0.0.1:13306/', '@127.0.0.1:' + proxy.address().port + '/'),
      env: {...provider.env, DATA_AGENT_LEASE_MS: '120000',
        DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
        DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
    try {
      const created = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '窄读定位资料', body: '初始化正文', source_url: null, related_ids: []});
      assert.equal(created.status, 200, JSON.stringify(created.value));
      objectBody.id = created.value.id;
      const encoded = Buffer.from(JSON.stringify(objectBody)).toString('hex');
      h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${objectBody.id}';
        UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${objectBody.id}' AND version=1;
        UPDATE retrieval_documents SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${objectBody.id}'`);
      const bytes = Number(h.sql(`SELECT JSON_OBJECT('b',OCTET_LENGTH(body)) FROM knowledge_objects WHERE id='${objectBody.id}'`)[0].b);
      assert.ok(bytes > 60_000, '夹具对象须显著大于单条目读取量：'+bytes+'B');
      assert.equal((await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})).status, 200);
      await h.resumeWorker();
      for (let i = 0; i < 90; i++) {
        const rows = h.sql(`SELECT JSON_OBJECT('k',target_kind,'v',vector_state,'a',vector_attempts,'e',vector_error,'j',state) AS s FROM knowledge_index_jobs WHERE object_id='${objectBody.id}'`);
        if (rows.length > 0 && rows.every(job => job.v === 'indexed')) break;
        if (i % 10 === 9) console.error('INDEX-STATE', JSON.stringify(rows));
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (i === 89) throw new Error('窄读夹具完成索引超时：' + JSON.stringify(rows));
      }
      const run = await h.capture(await h.create(), '核对唯一标记词的窄读定位');
      await h.pauseWorker();
      const before = shipped.bytes;
      const miss = await invoke(h, run, 'search_knowledge', {query: 'qqzzwwjjyy', limit: 10});
      const missWindow = shipped.bytes - before;
      assert.equal(miss.objects.length, 0);
      const hitStart = shipped.bytes;
      const hit = await invoke(h, run, 'search_knowledge', {query: MARKER, limit: 10});
      const hitWindow = shipped.bytes - hitStart;
      const excerpt = assertNarrowRead(hit, bytes, 'vector');
      assert.ok(excerpt.offset < 100, '命中条目自身较短，片段应落在条目前段');
      assert.ok(hitWindow - missWindow < bytes / 10,
        '选中对象不得整读：对象'+bytes+'B，命中查询相对零命中下行增量'+(hitWindow - missWindow)+'B');
      checks.push('向量路：命中条目定点窄读，对象'+bytes+'B时命中增量'+(hitWindow - missWindow)+'B，片段定位needle-entry');
      windows.vector = {missWindow, hitWindow, bytes};
    } finally {
      await h.close();
      await provider.close();
    }
  }

  // 阶段二：SQL后备路（不配置向量服务）。条目身份必须由SQL候选返回，窄读后
  // 词法片段仍定位到命中条目，而不是回退整对象装配。
  if (!structureOnly) {
    const h = await harness({capture: true, startWorker: false,
      onDatabaseUrl: url => url.replace('@127.0.0.1:13306/', '@127.0.0.1:' + proxy.address().port + '/'),
      env: {DATA_AGENT_LEASE_MS: '120000'}});
    try {
      objectBody.id = 'entryread-lexical-fixture';
      const encoded = Buffer.from(JSON.stringify(objectBody)).toString('hex');
      h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
        VALUES('${objectBody.id}','demo','document','窄读定位资料',1,'enabled',CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
        INSERT INTO knowledge_versions(object_id,version,body) VALUES('${objectBody.id}',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));
        INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${objectBody.id}','demo',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));
        INSERT IGNORE INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) VALUES('demo','${objectBody.id}','${objectBody.id}','system','synthetic-test')`);
      const bytes = Number(h.sql(`SELECT JSON_OBJECT('b',OCTET_LENGTH(body)) FROM knowledge_objects WHERE id='${objectBody.id}'`)[0].b);
      assert.ok(bytes > 60_000, '夹具对象须显著大于单条目读取量：'+bytes+'B');
      await h.resumeWorker();
      const run = await h.capture(await h.create(), '核对唯一标记词的窄读定位');
      await h.pauseWorker();
      const before = shipped.bytes;
      const miss = await invoke(h, run, 'search_knowledge', {query: 'qqzzwwjjyy', limit: 10});
      const missWindow = shipped.bytes - before;
      assert.equal(miss.objects.length, 0);
      const hitStart = shipped.bytes;
      const hit = await invoke(h, run, 'search_knowledge', {query: MARKER, limit: 10});
      const hitWindow = shipped.bytes - hitStart;
      const excerpt = assertNarrowRead(hit, bytes, 'lexical');
      assert.ok(excerpt.offset < 100, '命中条目自身较短，片段应落在条目前段');
      assert.ok(hitWindow - missWindow < bytes / 10,
        'SQL后备不得整读选中对象：对象'+bytes+'B，命中增量'+(hitWindow - missWindow)+'B');
      checks.push('SQL后备：候选返回真实条目身份，命中条目定点窄读，对象'+bytes+'B时命中增量'+(hitWindow - missWindow)+'B');
      windows.lexical = {missWindow, hitWindow, bytes};
    } finally {
      await h.close();
    }
  }
  // 结构命中只需当前绑定；关联表未选中的加工SQL不应随每次检索下行。
  {
    const h = await harness({capture: true, startWorker: false,
      onDatabaseUrl: url => url.replace('@127.0.0.1:13306/', '@127.0.0.1:' + proxy.address().port + '/'),
      env: {DATA_AGENT_LEASE_MS: '120000'}});
    try {
      const table = (await h.request('/knowledge/table-demo_order_detail')).value;
      const originalMetric = (await h.request('/knowledge/metric-net_revenue')).value;
      const rule = structuredClone(originalMetric.entries.find(entry => entry.entry_id === 'definition').effective_structure);
      rule.table = {object_id: table.id, version: table.version};
      const created = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'metric',
        name: '结构窄读定位指标', body: '结构命中 '+MARKER, source_url: null, related_ids: [table.id]});
      assert.equal(created.status, 200, JSON.stringify(created.value));
      const saved = await h.request('/knowledge/' + created.value.id, {operation_id: randomUUID(),
        expected_version: created.value.version, entry_id: 'body', value: '结构命中 '+MARKER,
        structured_value: rule}, 'alice', 'PATCH');
      assert.equal(saved.status, 200, JSON.stringify(saved.value));
      const largeSql = 'SELECT order_id, line_id FROM demo_order_detail /* '+('与指标定义无关的已上线加工说明。'.repeat(16_000))+' */';
      const processing = table.entries.find(entry => entry.path === 'etl');
      assert.ok(processing, '合成表应已有一份加工 SQL');
      processing.effective_value = largeSql;
      processing.source_facts = {...processing.source_facts, value: largeSql};
      processing.suggestion = {};
      processing.human_override = null;
      const encoded = Buffer.from(JSON.stringify(table)).toString('hex');
      h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${table.id}';
        UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${table.id}' AND version=${table.version}`);
      const bytes = Number(h.sql(`SELECT JSON_OBJECT('b',OCTET_LENGTH(body)) FROM knowledge_objects WHERE id='${table.id}'`)[0].b);
      assert.ok(bytes > 500_000, '关联表未选中SQL须显著大于结构窄投影');
      await h.resumeWorker();
      const run = await h.capture(await h.create(), '检查有结构指标的关联表窄读');
      await h.pauseWorker();
      const before = shipped.bytes;
      const miss = await invoke(h, run, 'search_knowledge', {query: 'qqzzwwjjyy', limit: 10});
      const missWindow = shipped.bytes - before;
      assert.equal(miss.objects.length, 0);
      const start = shipped.bytes;
      const hit = await invoke(h, run, 'search_knowledge', {query: MARKER, limit: 10});
      const hitWindow = shipped.bytes - start;
      assert.deepEqual(hit.objects.map(object => object.id), [created.value.id]);
      assert.ok(hit.objects[0].structure_dependencies.some(ref => ref.object_id === table.id && ref.version === table.version),
        '结构依赖必须沿窄投影保持可用，不能为减少读取删掉结构');
      assert.ok(hitWindow - missWindow < bytes / 10,
        '结构装配不得整读关联表：关联表'+bytes+'B，命中增量'+(hitWindow-missWindow)+'B');
      windows.structure = {missWindow, hitWindow, bytes};
      checks.push('结构命中保留绑定，关联表未选SQL不随检索下行');
    } finally {
      await h.close();
    }
  }
  passed = true;
  console.log(JSON.stringify({passed, checks, windows, officialRequests: 0}));
} finally {
  for (const sock of sockets) sock.destroy();
  proxy.closeAllConnections?.();
  await new Promise(resolve => proxy.close(resolve));
  await writeFile('.local/checks/retrieval-entry-read.json', JSON.stringify({passed, checks, windows, officialRequests: 0}, null, 2));
}
