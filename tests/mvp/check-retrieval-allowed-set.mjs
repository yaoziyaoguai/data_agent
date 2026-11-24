import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { exportCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { harness, until } from './harness.mjs';
import { embeddingProvider } from './embedding-provider.mjs';

// 05前置允许集：来源限制必须在每条召回通道之前生效——范围外高分候选不允许
// 先占满候选/命中名额再把允许范围内最佳项挤掉；空允许集就是无可召回记录，
// 不是全库过滤。受限检索仍只交付允许来源实际贡献的命中，过滤事实进入回执。
const provider = await embeddingProvider();
const collection = 'da_allowed_' + randomUUID().replaceAll('-', '');
const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'allowed_'+randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:200,trial_cost_micros:'1000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const token = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const milvus = async (action, input = {}) => {
  const response = await fetch('http://127.0.0.1:19531/v2/vectordb/' + action, {
    method: 'POST', headers: { authorization: 'Bearer root:' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ collectionName: collection, dbName: 'default', ...input }),
  });
  const value = await response.json();
  assert.equal(value.code, 0, JSON.stringify(value));
  return value.data;
};
const manager = SessionManager.inMemory('/synthetic/data-agent');
let h, run, passed = false;
const checks = [];
// 记录代理：透传真实Milvus并记录每次/search请求体——05范围前置的验收看
// 实际请求是否携带允许记录集，结果层后过滤不能证明召回前生效。
const searches = [];
const proxy = createServer(async (req, res) => {
  try {
    let body = '';
    req.setEncoding('utf8');
    for await (const part of req) body += part;
    if (req.url.endsWith('/search')) searches.push(JSON.parse(body));
    const remote = await fetch('http://127.0.0.1:19531' + req.url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: req.headers.authorization }, body });
    const result = await remote.text();
    res.writeHead(remote.status, { 'content-type': 'application/json' });
    res.end(result);
  } catch {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"code":1}');
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
const invoke = async (name, args) => {
  const input = { run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args,
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot) };
  ok(await h.internal('/internal/data/tool-calls', input));
  return ok(await h.internal('/internal/data/tools', input)).data;
};
const conditions = { time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
  group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null };

try {
  h = await harness({ capture: true, profile, startWorker: false, env: { ...provider.env,
    DATA_AGENT_LEASE_MS: '120000',
    DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password' } });
  ok(await h.request('/knowledge-index/rebuilds', { operation_id: randomUUID() }));
  // 干扰资料：范围外文档以高频重复同一口径，词法/BM25通道必然压过允许文档。
  const phrase = '退款时效承诺';
  const noisy = [];
  for (let i = 0; i < 5; i++) {
    noisy.push(ok(await h.request('/knowledge', { operation_id: randomUUID(), kind: 'document',
      name: '干扰资料' + i, body: (`${phrase}以内部口径为准，${phrase}不对外公开，${phrase}仅作演练。`).repeat(6),
      source_url: null, related_ids: [] })));
  }
  const allowed = ok(await h.request('/knowledge', { operation_id: randomUUID(), kind: 'document',
    name: '允许资料', body: `面向用户的${phrase}说明：七日内完成退款，超时自动补偿。`, source_url: null, related_ids: [] }));
  const unrelated = ok(await h.request('/knowledge', { operation_id: randomUUID(), kind: 'document',
    name: '无关资料', body: '本资料不含查询口径，只描述归档流程。', source_url: null, related_ids: [] }));
  await h.resumeWorker();
  await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id IN ('${allowed.id}','${unrelated.id}',${noisy.map(doc => `'${doc.id}'`).join(',')}) AND vector_state<>'indexed'`)[0].n === 0, '受限检索资料完成知识索引', 60000);
  await h.pauseWorker();

  const cid = await h.create();
  await h.resumeWorker();
  run = await h.capture(cid, `请核对${phrase}的对外口径。`);
  await h.pauseWorker();
  const task = await invoke('update_analysis_task', { action: 'create', goal: '核对退款时效的对外承诺',
    conditions, options: [] });
  await invoke('update_analysis_task', { action: 'revise', task_id: task.task_id,
    expected_version: task.condition_version, goal: '', options: [],
    condition_patch: { set: { source_limits: { allowed_sources: [
      { kind: 'document', id: allowed.id } ], origin_message_ids: [run.message_id] } }, unset: [] } });

  // 范围外高频候选足以挤满limit=3的命中名额：允许范围内最佳项必须仍然返回，
  // 不能被先召回后过滤丢掉；范围外对象不得借名额进入交付。
  const limited = await invoke('search_knowledge', { query: phrase + ' 对外承诺', limit: 3 });
  const ids = limited.objects.map(object => object.id);
  assert.ok(ids.includes(allowed.id), '允许范围内最佳项必须返回: ' + JSON.stringify({ ids, coverage: limited.search_coverage }));
  assert.ok(ids.every(id => id === allowed.id), '范围外对象不得进入受限交付: ' + JSON.stringify(ids));
  assert.ok(limited.source_limits, '过滤事实进入回执source_limits块');
  checks.push('来源限制在每路召回前生效：范围外高分不占名额，允许范围内最佳项返回，回执保留过滤事实');

  // 无可召回记录的允许集：门合法但允许来源对当前知识无贡献，返回零对象，
  // 不把全库过滤当成果，也不得报错或伪装降级。
  const barrenTask = await invoke('update_analysis_task', { action: 'create', goal: '核对无贡献来源',
    conditions, options: [] });
  const barrenRevised = await invoke('update_analysis_task', { action: 'revise', task_id: barrenTask.task_id,
    expected_version: barrenTask.condition_version, goal: '', options: [],
    condition_patch: { set: { source_limits: { allowed_sources: [
      { kind: 'platform', id: 'ghost-source-no-contribution' } ], origin_message_ids: [run.message_id] } }, unset: [] } });
  await invoke('update_analysis_task', { action: 'route', task_id: barrenTask.task_id,
    expected_version: barrenRevised.condition_version, goal: '', options: [] });
  const sendsBeforeEmpty = provider.requests.length;
  const searchesBeforeEmpty = searches.length;
  const barrenSearch = await invoke('search_knowledge', { query: phrase, limit: 5 });
  assert.equal(provider.requests.length, sendsBeforeEmpty, 'v1没有可交付知识候选时不发送Embedding');
  assert.equal(searches.length, searchesBeforeEmpty, 'v1空知识允许集不执行向量检索');
  assert.equal(barrenSearch.objects.length, 0, '无可召回记录的允许集返回零对象');
  assert.ok(barrenSearch.source_limits, '过滤事实仍进入回执');
  checks.push('无可召回记录的允许集按零结果交付，不整库过滤也不报错冒充降级');
  // 05接续：无来源限制时的v1硬范围（related_object_id）与对象启停也要前置到
  // 每条召回通道；范围内仅dense可达的项不能被范围外满分干扰挤出首批，v1不
  // 执行原文摘录通道。夹具手法与channel-faults一致：行向量替换为查询词的协议
  // 向量——范围内资料轻微扰动严格低于满幅，60份范围外干扰取满幅向量。
  const scopeTask = await invoke('update_analysis_task', { action: 'create', goal: '核对限定关联范围的对外口径', conditions, options: [] });
  await invoke('update_analysis_task', { action: 'route', task_id: scopeTask.task_id,
    expected_version: scopeTask.condition_version, goal: '', options: [] });
  // anchor必须是真实存在的对象：v1硬范围在入口即校验anchor存在。
  const anchorDoc = ok(await h.request('/knowledge', { operation_id: randomUUID(), kind: 'document',
    name: '范围锚点资料', body: '锚点对象自身正文，不含查询标记词。', source_url: null, related_ids: [] }));
  const anchorId = anchorDoc.id;
  const scopedNeedle = '范围前置稠密专用标记';
  const scopedDoc = ok(await h.request('/knowledge', { operation_id: randomUUID(), kind: 'document',
    name: '锚点关联正文册', body: '常规正文说明，不含任何检索测试词。', source_url: null, related_ids: [anchorId] }));
  const crowd = [];
  for (let i = 0; i < 60; i++) {
    crowd.push(ok(await h.request('/knowledge', { operation_id: randomUUID(), kind: 'document',
      name: '范围外稠密干扰' + i, body: `${scopedNeedle}高频重复口径第${i}份，仅作范围外干扰。`.repeat(3),
      source_url: null, related_ids: [] })));
  }
  const disabledDoc = ok(await h.request('/knowledge', { operation_id: randomUUID(), kind: 'document',
    name: '停用稠密资料', body: '停用专用独占标记词的说明正文。', source_url: null, related_ids: [anchorId] }));
  await h.resumeWorker();
  await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE object_id IN ('${anchorDoc.id}','${scopedDoc.id}','${disabledDoc.id}',${crowd.map(doc => `'${doc.id}'`).join(',')}) AND vector_state<>'indexed'`)[0].n === 0, '范围前置资料完成索引', 120000);
  await h.pauseWorker();
  const entityRows = async id => (await milvus('entities/query', { filter: `object_id == "${id}" && target == "knowledge_entry"`,
    outputFields: ['id', 'object_id', 'object_version', 'kind', 'space_id', 'model', 'projection_version', 'vector', 'text', 'entry_id', 'entry_path', 'statement_id', 'statement_offset', 'char_offset', 'char_length', 'content_hash'], limit: 512, consistencyLevel: 'Strong' }));
  const embedOf = async text => {
    const response = await fetch(provider.env.DATA_AGENT_EMBEDDING_URL, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.7-text-embedding', dimensions: 1024, input: [text] }) });
    assert.equal(response.status, 200);
    return (await response.json()).data.find(v => v.index === 0).embedding;
  };
  const full = await embedOf(scopedNeedle);
  const norm = Math.sqrt(full.reduce((sum, value) => sum + value * value, 0));
  const perturbed = full.slice();
  perturbed[0] *= 0.98;
  const perturbedNorm = Math.sqrt(perturbed.reduce((sum, value) => sum + value * value, 0));
  for (let i = 0; i < perturbed.length; i++) perturbed[i] = perturbed[i] / perturbedNorm * norm;
  await milvus('entities/upsert', { data: (await entityRows(scopedDoc.id)).map(row => ({ ...row, vector: perturbed })) });
  for (const doc of crowd) {
    await milvus('entities/upsert', { data: (await entityRows(doc.id)).map(row => ({ ...row, vector: full })) });
  }
  h.sql(`UPDATE knowledge_objects SET state='disabled' WHERE id='${disabledDoc.id}'`);

  searches.length = 0;
  const scoped = await invoke('search_knowledge', { query: scopedNeedle, limit: 3, related_object_id: anchorId });
  assert.ok(scoped.objects.some(object => object.id === scopedDoc.id),
    '范围内仅dense可达项必须返回：' + JSON.stringify({ ids: scoped.objects.map(object => object.id), coverage: scoped.search_coverage }));
  const filters = searches.map(request => request.filter || '').join('\n');
  assert.ok(filters.includes(scopedDoc.id), '实际请求必须携带范围（允许记录集进入通道过滤）');
  for (const doc of crowd) {
    assert.ok(!filters.includes(doc.id), '范围外对象不得进入任何通道请求: ' + doc.id);
  }
  // 知识通道自身的基础过滤含 kind != "source_excerpt" 排除子句；判raw通道执行
  // 看正向匹配 kind == "source_excerpt"（raw_base）是否出现在任何请求里。
  assert.ok(!filters.includes('kind == "source_excerpt"'), 'v1不得执行原文摘录通道');
  assert.ok(!filters.includes(disabledDoc.id), '停用对象不得进入通道请求');
  const disabledProbe = await invoke('search_knowledge', { query: '停用专用独占标记词', limit: 3, related_object_id: anchorId });
  assert.ok(!disabledProbe.objects.some(object => object.id === disabledDoc.id), '停用对象不进入交付');
  checks.push('v1硬范围与启停前置到每路召回：范围内dense可达项不被范围外挤出，实际请求携带范围，v1不执行raw通道，停用对象不召回');

  // 公共向量连接已配置时，个人资产目录仍不得派发公共检索。
  const callsBeforeAssets=provider.requests.length;
  searches.length=0;
  const assets=await invoke('search_knowledge',{query:'*',limit:1});
  assert.deepEqual(assets.objects,[],'资产目录不混入公共知识命中');
  assert.equal(searches.length,0,'query=*不派发公共BM25/dense查询');
  assert.equal(provider.requests.length,callsBeforeAssets,'资产目录不发送查询Embedding');
  const continuedAssets=await invoke('search_knowledge',{query:phrase,limit:1,asset_after:'synthetic-missing-asset'});
  assert.deepEqual(continuedAssets.objects,[],'资产续页不混入公共知识命中');
  assert.equal(continuedAssets.asset_cursor_invalid,true,'未知资产游标仍返回原目录状态');
  assert.equal(searches.length,0,'asset_after不派发公共BM25/dense查询');
  assert.equal(provider.requests.length,callsBeforeAssets,'资产续页不发送查询Embedding');
  checks.push('向量连接已配置时query=*和asset_after仍走原个人资产目录，无公共检索或查询Embedding');

  // 索引覆盖按本题实际范围计核（05接续，审计缺口6）：来源限制外的无关待办不能
  // 把本题报成未就绪；本题自己的待办即使在零命中时也要如实报incomplete。v1不
  // 交付raw，原文待办不混入本次覆盖。
  const coverageTask = await invoke('update_analysis_task', { action: 'create', goal: '核对索引覆盖范围', conditions, options: [] });
  const coverageRevised = await invoke('update_analysis_task', { action: 'revise', task_id: coverageTask.task_id,
    expected_version: coverageTask.condition_version, goal: '', options: [],
    condition_patch: { set: { source_limits: { allowed_sources: [
      { kind: 'document', id: allowed.id } ], origin_message_ids: [run.message_id] } }, unset: [] } });
  await invoke('update_analysis_task', { action: 'route', task_id: coverageTask.task_id,
    expected_version: coverageRevised.condition_version, goal: '', options: [] });
  const markPending = id => h.sql(`UPDATE knowledge_index_jobs SET vector_state='pending',vector_target=NULL WHERE target_kind='knowledge_entry' AND object_id='${id}'`);
  markPending(unrelated.id);
  const outsideLag = await invoke('search_knowledge', { query: phrase, limit: 3 });
  assert.equal(outsideLag.search_coverage.index_state, 'current',
    '范围外知识待办不得把本题报成未就绪：' + JSON.stringify(outsideLag.search_coverage));
  markPending(allowed.id);
  await milvus('entities/delete', { filter: `object_id == "${allowed.id}"` });
  const ownLag = await invoke('search_knowledge', { query: '氍毹魍魉绮语', limit: 3 });
  assert.equal(ownLag.objects.length, 0, '本题对象未索引且词法无命中：零候选');
  assert.equal(ownLag.search_coverage.index_state, 'incomplete', '本题未索引时零命中也如实报告：' + JSON.stringify(ownLag.search_coverage));
  checks.push('索引覆盖只按本题实际范围与当前修订计核：范围外pending不误报未就绪，本题未索引时零命中仍如实报incomplete，v1不把raw待办混入覆盖');

  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} finally {
  await h?.close();
  proxy.closeAllConnections?.();
  await new Promise(resolve => proxy.close(resolve));
  if ((await milvus('collections/has')).has) await milvus('collections/drop');
  await provider.close();
  await writeFile('.local/checks/retrieval-allowed-set.json', JSON.stringify({ passed, checks, officialRequests: 0 }, null, 2));
}
