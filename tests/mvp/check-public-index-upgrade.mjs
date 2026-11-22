import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';
import {assetInput, select} from './skill-fixtures.mjs';

// 同一隔离库由兼容统一版本顺序切换公共目标；旧集合保留，切点后不再写入。
for (const name of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DATA_AGENT_MODEL_PROFILE',
  'DATA_AGENT_MODEL_FAULT','DATABASE_URL','DATA_AGENT_DATABASE_URL']) delete process.env[name];
const missingOnly = process.argv.includes('--missing-raw');
const owner = process.argv.includes('--owner');
const filter = process.argv.find(value => value.startsWith('--filter='))?.slice(9);
if (filter) assert.match(filter, /^[a-z0-9_]+$/);
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? 'run';
assert.match(label, /^[a-z0-9-]+$/);
const embedding = await embeddingProvider();
const names = ['data_agent_test_old_', 'data_agent_test_current_'].map(prefix => prefix + randomUUID().replaceAll('-', ''));
const token = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const requests = [];
let active = 0;
const proxy = createServer(async (req, res) => {
  active++;
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({path:req.url, collection:body.collectionName, channel:body.annsField, filter:body.filter});
    const response = await fetch('http://127.0.0.1:19531' + req.url, {
      method:'POST', headers:{'content-type':'application/json', authorization:req.headers.authorization}, body:raw,
    });
    res.writeHead(response.status, {'content-type':'application/json'}).end(await response.text());
  } catch {
    res.writeHead(503).end();
  } finally { active--; }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const milvus = async (collection, action, body = {}) => {
  const response = await fetch('http://127.0.0.1:19531/v2/vectordb/' + action, {
    method:'POST', headers:{'content-type':'application/json', authorization:'Bearer root:' + token},
    body:JSON.stringify({dbName:'default', collectionName:collection, ...body}),
  });
  const result = await response.json();
  assert.equal(result.code, 0, JSON.stringify(result));
  return result.data;
};
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const quote = value => "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
let h, passed = false, workerStarted = false, memoryFailure;
const memoryRequests = [], memoryIndexes = new Map();
const memory = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    assert.ok(['/index','/search'].includes(req.url), '公共切换不触发个人记忆重新提取');
    validateContract(req.url === '/index' ? 'MemoryIndexRequest' : 'MemorySearchRequest', input);
    memoryRequests.push({path:req.url, operation:input.operation_id});
    const call = {action:'issue', budget:input.budget, call_attempt_id:randomUUID(), purpose:'memory_embedding',
      parameters_fingerprint:createHash('sha256').update(raw).digest('hex'), input_tokens_upper:100, output_tokens_max:0, usage:null};
    assert.equal(ok(await h.internal('/internal/memory/model-calls', call)).send_allowed, true);
    ok(await h.internal('/internal/memory/model-calls', {...call, action:'finalize', usage:{input_tokens:20, output_tokens:0, elapsed_ms:1}}));
    if (req.url === '/index') memoryIndexes.set(input.asset.id, {...input.asset, owner:input.owner_id, space:input.space_id});
    const result = req.url === '/index' ? {operation_id:input.operation_id, state:'ready'}
      : {candidates:[...memoryIndexes.values()].filter(asset => asset.owner === input.owner_id && asset.space === input.space_id)
        .map(asset => ({asset_id:asset.id, version:asset.version})), bounded:false};
    validateContract(req.url === '/index' ? 'MemoryIndexReceipt' : 'MemorySearchReceipt', result);
    res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(result));
  } catch (error) {
    memoryFailure ??= error;
    res.writeHead(503, {'content-type':'application/json'}).end(JSON.stringify({error:'memory_unavailable'}));
  }
});
await new Promise(resolve => memory.listen(0, '127.0.0.1', resolve));
const checks = [];
try {
  const profile = {provider_id:'deepseek', model_id:'deepseek-flash', trial_id:randomUUID(), price_version:'2026-10-04-peak-usd', input_limit:65536, output_limit:8192, trial_call_limit:24, trial_cost_micros:'300000', request_call_limit:24, toolset:'data', payload_bytes_limit:131072, thinking_level:'off'};
  h = await harness({capture:true, startWorker:false, profile, env:{...embedding.env,
    DATA_AGENT_PREFILL_PROFILE:'', DATA_AGENT_PUBLIC_CONTENT_RETENTION:'archive',
    ...(!owner && !missingOnly ? {DATA_AGENT_MEMORY_URL:'http://127.0.0.1:' + memory.address().port,
      DATA_AGENT_MEMORY_INDEX_TARGET:'synthetic_personal_unchanged'} : {}),
    DATA_AGENT_VECTOR_URL:'http://127.0.0.1:' + proxy.address().port,
    DATA_AGENT_VECTOR_COLLECTION:names[0], DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd() + '/.local/infra/milvus-root-password'}});
  if (owner) {
    const command = ['test','--offline','--locked','-p','data-agent','--test','raw_index_handover',
      ...(filter ? [filter] : []), '--','--test-threads=1','--nocapture'];
    let output = '';
    const result = await new Promise((resolve, reject) => {
      const child = spawn(homedir() + '/.cargo/bin/cargo', command, {env:{...h.env,
        DATA_AGENT_PUBLIC_CONTENT_RETENTION:'latest_only'}, stdio:['ignore','pipe','pipe']});
      child.stdout.on('data', chunk => {output += chunk; process.stdout.write(chunk);});
      child.stderr.on('data', chunk => {output += chunk; process.stderr.write(chunk);});
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal}));
    });
    await writeFile('.local/checks/public-index-owner-' + label + '-' + Date.now() + '.log', output, {flag:'wx'});
    assert.equal(result.code, 0, '公开索引owner测试必须完整通过');
    assert.equal(result.signal, null);
    assert.match(output, /test result: ok\. [1-9]\d* passed; 0 failed/);
    assert.doesNotMatch(output, /running 0 tests/);
    checks.push('公开索引重建与旧积压移交owner在真实隔离MySQL验证');
  } else {
  const originalBody = '合成索引迁移文档。\n' + '背景只用于分段，不提供案例答案。'.repeat(210) + '\n尾部保留条件：仅确认完成的请求计入尾部口径。🧪';
  const document = ok(await h.request('/knowledge', {operation_id:randomUUID(), kind:'document', name:'合成尾部迁移文档', body:originalBody, related_ids:[]}));
  const outside = ok(await h.request('/knowledge', {operation_id:randomUUID(), kind:'document', name:'合成范围外迁移文档', body:'尾部保留条件：范围外正文不得交付。', related_ids:[]}));
  // 升级前已存在正文，却未登记raw任务；不能让空UPDATE冒充已重建来源。
  h.sql(`DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=${quote(document.id)}`);
  const beforePreparation = h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE kind='prepare_source'")[0].n;
  const operation = randomUUID();
  const prepared = ok(await h.request('/knowledge-index/rebuilds', {operation_id:operation}));
  assert.deepEqual(ok(await h.request('/knowledge-index/rebuilds', {operation_id:operation})), prepared);
  const pending = h.sql(`SELECT JSON_OBJECT('kind',source_kind,'id',object_id,'version',version,'attempts',vector_attempts) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND space_id='demo' ORDER BY source_kind,object_id`);
  assert.ok(pending.some(row => row.kind === 'document' && row.id === document.id && row.version === 1),
    '显式重建必须补登记缺失的当前文档raw目标：' + JSON.stringify({id:document.id, pending}));
  const heads = h.sql("SELECT JSON_OBJECT('id',h.id,'version',h.version) FROM source_heads h LEFT JOIN catalog_platform_heads p ON p.source_id=h.id WHERE h.space_id='demo' AND COALESCE(p.retired,FALSE)=FALSE");
  for (const head of heads) assert.ok(pending.some(row => row.kind === 'platform' && row.id === head.id && row.version === head.version), '显式重建必须覆盖当前平台来源：' + head.id);
  assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE kind='prepare_source'")[0].n, beforePreparation, '补齐索引不新增语义准备');
  checks.push('同一维护回执幂等，缺失的当前平台/文档raw待办从owner补齐，不重新整理');
  if (!missingOnly) {
    const personalMemory = ok(await h.request('/assets', assetInput({kind:'memory', name:'合成升级偏好', body:'合成金额默认用元展示。'})));
    const skill = ok(await h.request('/assets', assetInput({name:'合成升级方法', body:'核对当前资料并保留实际缺口。'})));
    const unselectedSkill = ok(await h.request('/assets', assetInput({name:'未选合成升级方法', body:'未选方法不能进入工具上下文。'})));
    const conversation = await h.create(); ok(await select(h, conversation, skill));
    const personalState = () => ({
      assets:h.sql("SELECT JSON_OBJECT('id',id,'version',version,'state',state,'body',body) FROM personal_assets ORDER BY id"),
      versions:h.sql("SELECT JSON_OBJECT('id',asset_id,'version',version,'body',body) FROM personal_asset_versions ORDER BY asset_id,version"),
      selections:h.sql("SELECT JSON_OBJECT('id',id,'owner',owner_id,'conversation',conversation_id,'asset',asset_id,'version',asset_version) FROM skill_selections ORDER BY id"),
      jobs:h.sql("SELECT JSON_OBJECT('id',id,'asset',asset_id,'version',asset_version,'target',index_target,'state',state,'attempts',attempts,'epoch',lease_epoch,'budget',budget_scope_id,'profile',model_profile) FROM personal_memory_index_jobs ORDER BY id"),
      indexes:[...memoryIndexes.values()],
    });
    const indexed = async target => {
      await h.resumeWorker();
      workerStarted = true;
      await until(() => h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE vector_state NOT IN ('indexed','superseded')")[0].n === 0,
        '公共目标全部实际索引完成', 120000);
      await h.pauseWorker();
      await until(() => active === 0, '已停止writer的在途Milvus请求结束');
      const targets = h.sql("SELECT JSON_OBJECT('target',j.vector_target,'kind',j.target_kind,'id',j.object_id,'version',j.version) FROM knowledge_index_jobs j LEFT JOIN knowledge_objects k ON k.id=j.object_id LEFT JOIN source_heads s ON s.id=j.object_id WHERE j.vector_state='indexed' AND ((j.target_kind='knowledge_entry' AND j.version=k.version) OR (j.target_kind='source_excerpt' AND j.version=IF(j.source_kind='document',k.version,s.version)))");
      assert.ok(targets.some(row => row.kind === 'knowledge_entry'));
      assert.ok(targets.some(row => row.kind === 'source_excerpt'));
      assert.ok(targets.every(row => row.target === target), JSON.stringify({target, targets}));
    };
    await indexed(prepared.resource_id);
    await h.resumeWorker();
    await until(() => {if (memoryFailure) throw memoryFailure; return h.sql("SELECT JSON_OBJECT('state',state) FROM personal_memory_index_jobs")[0]?.state === 'indexed';}, '个人记忆在原独立目标完成索引');
    await h.pauseWorker();
    const beforePersonal = personalState();
    assert.equal(beforePersonal.jobs.length, 1); assert.equal(beforePersonal.jobs[0].target, 'synthetic_personal_unchanged');
    assert.equal(memoryRequests.filter(request => request.path === '/index').length, 1);
    assert.equal(memoryIndexes.get(personalMemory.id).body, personalMemory.body);
    const oldIdentity = (await milvus(names[0], 'collections/describe')).collectionID;
    const oldDocument = h.sql(`SELECT body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id=${quote(document.id)} AND version=1`)[0];
    h.env.DATA_AGENT_PUBLIC_CONTENT_RETENTION = 'latest_only';
    await h.restartApi();
    const nextBody = originalBody + '\n新修订尾部条件：忽略取消和未知状态。';
    const updated = ok(await h.request('/knowledge/' + document.id, {operation_id:randomUUID(), expected_version:'1', entry_id:'body', value:nextBody, clear_override:false}, 'alice', 'PATCH'));
    assert.equal(updated.version, '2');
    assert.deepEqual(h.sql(`SELECT body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id=${quote(document.id)} AND version=1`)[0], oldDocument);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id=${quote(document.id)}`)[0].n, 1);
    const oldJobs = h.sql(`SELECT JSON_OBJECT('kind',target_kind,'version',version,'target',vector_target,'state',vector_state,'attempts',vector_attempts,'epoch',lease_epoch) FROM knowledge_index_jobs WHERE object_id=${quote(document.id)} AND version=1 ORDER BY target_kind`);
    assert.equal(oldJobs.length, 2);
    const beforeCut = requests.length;
    h.env.DATA_AGENT_VECTOR_COLLECTION = names[1];
    await h.restartApi();
    const gap = ok(await h.request('/knowledge?q=' + encodeURIComponent('尾部口径')));
    assert.equal(gap.search_coverage.vector_state, 'unavailable');
    assert.equal((await milvus(names[1], 'collections/has')).has, false, '切换间隙普通读取不自建集合');
    const rebuilt = ok(await h.request('/knowledge-index/rebuilds', {operation_id:randomUUID()}));
    assert.notEqual(rebuilt.resource_id, prepared.resource_id);
    await indexed(rebuilt.resource_id);
    const newIdentity = (await milvus(names[1], 'collections/describe')).collectionID;
    assert.notEqual(newIdentity, oldIdentity);
    assert.equal((await milvus(names[0], 'collections/describe')).collectionID, oldIdentity, '旧集合原样保留');
    assert.deepEqual(h.sql(`SELECT JSON_OBJECT('kind',target_kind,'version',version,'target',vector_target,'state',vector_state,'attempts',vector_attempts,'epoch',lease_epoch) FROM knowledge_index_jobs WHERE object_id=${quote(document.id)} AND version=1 ORDER BY target_kind`), oldJobs, '旧修订已完成回执保留，不改成当前目标');
    const projection = h.sql(`SELECT JSON_OBJECT('revision',revision,'target',collection_target,'complete',complete) FROM retrieval_source_projections WHERE source_kind='document' AND source_id=${quote(document.id)}`)[0];
    assert.equal(projection.revision, 2);
    assert.equal(projection.target, rebuilt.resource_id);
    assert.equal(projection.complete, 1);
    const bRequests = requests.slice(beforeCut);
    assert.ok(bRequests.some(row => row.collection === names[1] && row.path.endsWith('/upsert')));
    assert.ok(bRequests.filter(row => /\/(upsert|delete|create)$/.test(row.path)).every(row => row.collection === names[1]), '切点后所有公共索引写入仅发往新集合');
    const count = embedding.requests.length;
    const maintenance = h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls")[0].n;
    ok(await h.request('/knowledge-index/rebuilds', {operation_id:randomUUID()}));
    await indexed(rebuilt.resource_id);
    assert.equal(embedding.requests.length, count, '同正文/同端点重建复用既有Embedding回执');
    assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls")[0].n, maintenance, '索引重建不增加语义模型调用');
    assert.equal(maintenance, 0, '此层不配置语义模型');
    const thirdBody = nextBody + '\n第三修订尾部：仅记录已经核实的终态。';
    const third = ok(await h.request('/knowledge/' + document.id, {operation_id:randomUUID(), expected_version:'2', entry_id:'body', value:thirdBody, clear_override:false}, 'alice', 'PATCH'));
    assert.equal(third.version, '3');
    await indexed(rebuilt.resource_id);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id=${quote(document.id)}`)[0].n, 1);
    assert.deepEqual(h.sql(`SELECT body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id=${quote(document.id)} AND version=1`)[0], oldDocument);
    assert.ok(requests.slice(beforeCut).filter(row => /\/(upsert|delete|create)$/.test(row.path)).every(row => row.collection === names[1]), '切换后的新修订也只能写B');

    h.env.DATA_AGENT_TOOL_CONTRACT_VERSION = '2';
    h.env.DATA_AGENT_LEASE_MS = '120000';
    await h.restartApi();
    await h.resumeWorker();
    const run = await h.capture(conversation, '只核对合成尾部迁移文档的尾部条件。');
    await h.pauseWorker();
    if (memoryFailure) throw memoryFailure;
    assert.deepEqual(personalState(), beforePersonal, '公共A→B和latest_only不改个人资产版本、Skill选择或Mem0目标/作业');
    assert.equal(memoryRequests.filter(request => request.path === '/index').length, 1, '公共重建不重复派发个人索引');
    assert.ok(run.workspace_context.memories.some(asset => asset.id === personalMemory.id && asset.version === personalMemory.version));
    assert.ok(run.workspace_context.selected_skills.some(asset => asset.id === skill.id && asset.version === skill.version));
    assert.ok(!run.workspace_context.selected_skills.some(asset => asset.id === unselectedSkill.id), '公共切换不能扩展Skill选用范围');
    assert.equal(run.tool_contract_version, 2, '新公共目标验证后才显式启用新消息v2');
    const manager = SessionManager.inMemory('/synthetic/public-index-upgrade');
    const invoke = async (name, args, error) => {
      const input = {run_id:run.run_id, lease_epoch:run.lease_epoch, sdk_tool_call_id:randomUUID(), tool_name:name, arguments:args,
        checkpoint:exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
      const registered = ok(await h.internal('/internal/data/tool-calls', input));
      const response = await h.internal('/internal/data/tools', input);
      if (error) {assert.notEqual(response.status, 200); assert.equal(response.value.code, error); return;}
      const receipt = ok(response); assert.equal(receipt.operation_id, registered.operation_id);
      return receipt.data;
    };
    const task = await invoke('update_analysis_task', {action:'create', goal:'核对尾部条件', options:[], conditions:{
      time_start:null, time_end:null, timezone:'UTC', metric:null, channel:null, group_by:[], filters:[], knowledge_refs:[], notes:'',
      source_limits:{allowed_sources:[{kind:'document', id:document.id}], origin_message_ids:[run.message_id]}}});
    const taskRef = {task_id:task.task_id, condition_version:task.condition_version};
    const beforeSearch = requests.length;
    const searched = await invoke('search_knowledge', {query:'尾部保留条件', limit:10, kinds:['document'], task_ref:taskRef});
    validateContract('KnowledgeSearchReply', searched);
    assert.ok(searched.hits.length > 0, JSON.stringify(searched.search_coverage));
    assert.ok(searched.hits.every(hit => hit.record_kind === 'source_excerpt'
      ? hit.citation.source.id === document.id && hit.citation.revision === '3'
      : hit.ref.object_id === document.id && hit.ref.version === '3'));
    const tail = searched.hits.find(hit => hit.record_kind === 'source_excerpt' && hit.text.includes('尾部保留条件'));
    assert.ok(tail, '切B后真实中文检索必须召回原长文尾部');
    assert.equal(tail.source_length, [...thirdBody].length);
    assert.equal(tail.text, [...thirdBody].slice(tail.citation.locator.offset, tail.citation.locator.offset + tail.citation.locator.length).join(''));
    assert.ok(tail.citation.locator.offset > 0, '尾部命中不能用全文前缀代替');
    const searches = requests.slice(beforeSearch).filter(row => row.path.endsWith('/search'));
    assert.ok(searches.some(row => row.channel === 'sparse') && searches.some(row => row.channel === 'vector'));
    assert.ok(searches.every(row => row.collection === names[1] && row.filter.includes(document.id) && !row.filter.includes(outside.id)), 'BM25和dense真实请求均先限制允许来源');
    const exactText = '尾部口径。🧪';
    const offset = [...thirdBody.slice(0, thirdBody.indexOf(exactText))].length;
    assert.ok(thirdBody.includes(exactText));
    const citation = {source:{kind:'document', id:document.id}, revision:'3', locator:{offset, length:[...exactText].length}};
    const first = await invoke('read_source', {citation, limit:3, task_ref:taskRef});
    validateContract('SourceReadReply', first);
    assert.equal(first.text, [...exactText].slice(0, 3).join(''));
    assert.deepEqual(first.locator, {offset, length:3});
    assert.deepEqual(first.next_locator, {offset:offset+3, length:[...exactText].length-3});
    assert.equal(first.content_state, 'partial');
    const rest = await invoke('read_source', {citation:{...citation, locator:first.next_locator}, task_ref:taskRef});
    validateContract('SourceReadReply', rest);
    assert.equal(first.text + rest.text, exactText);
    assert.equal(rest.source_length, [...thirdBody].length);
    assert.equal(rest.content_state, 'complete'); assert.equal(rest.next_locator, null, '补读结束于原请求范围');
    await invoke('read_source', {citation:{source:{kind:'document', id:outside.id}, revision:'1', locator:{offset:0, length:5}}, task_ref:taskRef}, 'source_not_allowed');
    checks.push('切B后新修订只写B，中文尾部与两路前置范围过滤、v2原修订Unicode精确补读通过');

    // writer已停；兼容读取版本可查看旧集合并回源核当前正文，不恢复旧writer。
    const beforeRollback = requests.length;
    h.env.DATA_AGENT_VECTOR_COLLECTION = names[0];
    await h.restartApi();
    const fallback = ok(await h.request('/knowledge?q=' + encodeURIComponent('尾部口径')));
    assert.notEqual(fallback.search_coverage.vector_state, 'unavailable');
    assert.equal((await invoke('read_source', {citation, task_ref:taskRef})).text, exactText);
    assert.ok(requests.slice(beforeRollback).some(row => row.collection === names[0] && row.path.endsWith('/search')));
    assert.equal(requests.slice(beforeRollback).filter(row => /\/(upsert|delete|create)$/.test(row.path)).length, 0, '兼容回退读取不启动旧集合writer');
    assert.equal((await milvus(names[0], 'collections/describe')).collectionID, oldIdentity);
    assert.equal((await milvus(names[1], 'collections/describe')).collectionID, newIdentity);
    assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls")[0].n, 0);
    assert.deepEqual(personalState(), beforePersonal, '兼容回退也不重建个人目标或改写个人资产');
    assert.equal(memoryRequests.filter(request => request.path === '/index').length, 1);
    const memoryCalls = h.sql("SELECT JSON_OBJECT('purpose',purpose,'state',state) FROM model_call_attempts WHERE purpose LIKE 'memory_%'");
    assert.equal(memoryCalls.length, memoryRequests.length); assert.ok(memoryCalls.every(call => call.purpose === 'memory_embedding' && call.state === 'settled'));
    if (memoryFailure) throw memoryFailure;
    h.releaseRun(run.run_id);
    checks.push('公共切换/重建/兼容回退均保个人资产全部版本、明确Skill选择与原Mem0目标，个人索引只派发一次且许可/usage结算保持');
    checks.push('停止新写后兼容读取旧集合并精确回源，旧新集合身份及语义调用账本保持');
    checks.push('旧集合writer停止后切一次新集合，知识/raw目标和投影核实际身份；旧集合保留且停写');
    checks.push('latest_only新修订无新全文旧档，切换间隙明确降级，重启与重建复用原Embedding回执且不增加整理调用');
  }
  }
  passed = true;
} finally {
  await h?.close();
  memory.closeAllConnections(); await new Promise(resolve => memory.close(resolve));
  for (const name of names) if ((await milvus(name, 'collections/has')).has) await milvus(name, 'collections/drop');
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  await embedding.close();
  await writeFile('.local/checks/public-index-upgrade-' + label + '-' + Date.now() + '.json', JSON.stringify({passed, checks,
    missingOnly, owner, filter, requests, officialRequests:0, evidence:{api:owner?'bootstrap_only':'real',
      worker:workerStarted?'real':'not_run', storage:'MySQL', index:requests.length?'Milvus':'not_called',
      embedding:embedding.requests.length?'local_protocol':'not_called', memory:memoryRequests.length?'local_protocol':'not_called', semantic_model:'not_called'}}, null, 2), {flag:'wx'});
}
console.log(JSON.stringify({passed, checks, officialRequests:0}));
