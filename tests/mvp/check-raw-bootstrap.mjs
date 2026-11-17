import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {synchronizeSources} from './source-sync.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const directory = resolve('.local/checks/raw-bootstrap-' + randomUUID());
const sourceDirectory = directory + '/sources';
await mkdir(sourceDirectory, {recursive: true});
const source = resolve('docs/sources/cockpit');
const manifest = JSON.parse(await readFile(source + '/knowledge-manifest.json', 'utf8'));
// 平台seed只由执行器加载，不属于知识输入；其余仅复制允许的知识资料。
for (const file of [...manifest.knowledge_files, 'knowledge-manifest.json', 'semantic-catalog.json', 'seed.sql']) {
  await mkdir(dirname(sourceDirectory + '/' + file), {recursive: true});
  await copyFile(source + '/' + file, sourceDirectory + '/' + file);
}
const catalog = JSON.parse(await readFile(sourceDirectory + '/semantic-catalog.json', 'utf8'));
catalog.objects = [];
await writeFile(sourceDirectory + '/semantic-catalog.json', JSON.stringify(catalog));
const provider = await embeddingProvider();
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const body = '# 集成校准观察窗\n\n' + Array.from({length: 180}, (_, i) => `第${i + 1}段：本段只记录合成背景，不定义校准观察窗。`).join('\n\n')
  + '\n\n校准观察窗从用户提交开始，到第一条有效回执为止。\n\n例外：用户取消后的晚到回执不计入校准观察窗。';
const ok = r => {assert.equal(r.status, 200, JSON.stringify(r.value)); return r.value;};
let h, passed = false, prepared = false;
try {
  h = await harness({sourceDirectory, startWorker: false, capture: true,
    env: {...provider.env, DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PUBLIC_CONTENT_RETENTION: 'latest_only',
      DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531',
      DATA_AGENT_VECTOR_COLLECTION: collection, DATA_AGENT_VECTOR_TOKEN_FILE: resolve('.local/infra/milvus-root-password')}});
  const empty = h.sql("SELECT JSON_OBJECT('count',COUNT(*)) FROM knowledge_objects")[0];
  assert.equal(empty.count, 0);
  await writeFile(directory + '/empty-count.json', JSON.stringify(empty));
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  assert.equal(h.sql("SELECT JSON_OBJECT('count',COUNT(*)) FROM knowledge_objects WHERE kind='table'")[0].count, 28);
  const document = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '集成校准观察窗', body, related_ids: []}));
  // 只在本次隔离库暂借准备作业租约，索引和普通会话调度仍按实际Worker执行。
  h.sql("UPDATE background_jobs SET lease_until=TIMESTAMPADD(HOUR,1,UTC_TIMESTAMP(3)) WHERE kind='prepare_source'");
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  await h.resumeWorker();
  await until(() => h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE source_kind='document' AND object_id='${document.id}'`).some(row => row.state === 'indexed'), '新文档raw索引', 120000);
  assert.equal(h.sql(`SELECT JSON_OBJECT('count',COUNT(*)) FROM knowledge_statements WHERE object_id='${document.id}'`)[0].count, 0);
  const question = '只依据《集成校准观察窗》解释校准观察窗的起止，以及哪些回执应排除。不要执行SQL。';
  const run = await h.capture(await h.create(), question); await h.pauseWorker();
  assert.equal(run.tool_contract_version, 2);
  const manager = SessionManager.inMemory('/synthetic/raw-bootstrap');
  const trace = [];
  const invoke = async (name, args) => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: name,
      arguments: args, checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls', input));
    const receipt = ok(await h.internal('/internal/data/tools', input)); trace.push({name, args, data: receipt.data}); return receipt.data;
  };
  const search = await invoke('search_knowledge', {query: '第一条有效回执 取消后的晚到回执', kinds: ['document'], limit: 10});
  const hit = search.hits.find(hit => hit.record_kind === 'source_excerpt' && hit.citation.source.id === document.id
    && hit.text.includes('第一条有效回执'));
  assert.ok(hit, JSON.stringify(search.hits.map(h => ({kind: h.record_kind, text: h.text?.slice(-200)}))));
  assert.ok(hit.citation.locator.offset > 0, '只能定点读取尾部，不能先交整篇');
  const read = await invoke('read_source', {citation: hit.citation});
  assert.match(read.text, /用户提交开始，到第一条有效回执为止/);
  assert.match(read.text, /用户取消后的晚到回执不计入/);
  assert.ok([...read.text].length < [...body].length / 2);
  assert.equal(ok(await h.request('/conversations/' + run.conversation_id + '/queries')).queries.length, 0);
  await writeFile(directory + '/tool-trace.json', JSON.stringify(trace, null, 2));
  await writeFile(directory + '/source-and-index.json', JSON.stringify({document: document.id, revision: document.version,
    collection, body_sha256: createHash('sha256').update(body).digest('hex'), run_contract: run.tool_contract_version,
    environment: 'real MySQL/Milvus + local embedding protocol + host tools; model answer not tested', runtime: h.directory}, null, 2));
  h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, directory, checks: ['空业务知识起点', '正常同步28表', '未整理文档raw索引', '尾部起止与取消例外定点补读', '无查询执行'], officialRequests: 0}));
} finally {
  if (h) {h.sql("UPDATE background_jobs SET lease_until=NULL WHERE kind='prepare_source' AND lease_owner IS NULL"); await h.close();}
  await provider.close();
  if (prepared) {
    const token = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + token}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await writeFile(directory + '/result.json', JSON.stringify({passed, officialRequests: 0}));
}
