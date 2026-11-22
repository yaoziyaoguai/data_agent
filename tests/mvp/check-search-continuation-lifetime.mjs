import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {SessionManager, ExtensionRunner, convertToLlm} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint,restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

// R07窗口生命周期正式反例：1202个dense位置（>1200）跨两个候选窗直到末项可读。
// 首窗在单次调用内交付/退休完毕即释放去重记录；BM25第1的同身份在dense第1000位
// 之后的新窗中重现并再次交付（旧合同为全查询恰一次，已确认改为窗口生命周期）；
// 每窗单页即耗尽，观测到的游标均为释放后的薄游标；通道位置沿真实offset前进。
// 默认内部直工具证明后端；--pi用同夹具/范围/容量经正式Pi工具链验证集成。
// 此夹具Pi分页曾出现tool_response_capacity；具体首错和容量归因由本文件实测，
// 内部直工具的通过不代表Pi集成。范围用kinds:['term']：retail种子空间只有field/table/document/
// metric/relationship，term为本夹具独占（v2合同已删related_object_id锚定）。
const usePi = process.argv.includes('--pi');
await mkdir('.local/checks/semantic-delivery', {recursive:true});
const query = 'lifetimex7qneedle';
const collection = 'da_lifetime_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const VALID_COUNT = 6;
const INVALID_A = 964;
const INVALID_B = 230;
const DENSE_TOTAL = VALID_COUNT + INVALID_A + INVALID_B + 2;
const PAGE_LIMIT = 30;

const entry = (entryId, text) => ({
  entry_id: entryId, path: entryId, label: '正文', effective_value: text,
  source_facts: {complete: false, gap: '独立合成生命周期夹具'}, suggestion: {},
  human_override: null, review_state: 'unverified',
});
const body = (id, kind, name, entries) => ({
  id, kind, name, version: '1', state: 'enabled', entries, related_ids: [],
  source_id: null, source_version: '0', updated_by: 'synthetic-test',
});
const insert = (h, value) => {
  const encoded = Buffer.from(JSON.stringify(value)).toString('hex');
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
    VALUES('${value.id}','demo','${value.kind}','${value.name}',1,'enabled',CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${value.id}',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${value.id}','demo',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));
    INSERT IGNORE INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) VALUES('demo','${value.id}','${value.id}','system','synthetic-test')`);
};

const validText = index => `生命周期合法记录🧪第${index}条：口径完整🌏可交付。`;
const crossText = (`跨窗重现条件 ${query} `).repeat(5) + '同一身份经BM25首达后在新窗重现🌏。';
const lastText = '窗口末项🌏：本条为最后一个dense位置，必须可读。';

const anchor = 'life-valid-a';
const objects = {
  validA: body(anchor, 'term', '生命周期首窗合法资料',
    Array.from({length: VALID_COUNT}, (_, i) => entry('va-' + String(i).padStart(2, '0'), validText(i)))),
  invalidA: body('life-invalid-a', 'term', '生命周期首窗旧版资料',
    Array.from({length: INVALID_A}, (_, i) => entry('ia-' + String(i).padStart(3, '0'), `首窗旧版记录${i}：已换版。`))),
  invalidB: body('life-invalid-b', 'term', '生命周期后窗旧版资料',
    Array.from({length: INVALID_B}, (_, i) => entry('ib-' + String(i).padStart(3, '0'), `后窗旧版记录${i}：已换版。`))),
  cross: body('life-cross', 'term', '生命周期跨窗重现', [entry('body', crossText)]),
  last: body('life-last', 'term', '生命周期末项', [entry('body', lastText)]),
};
for (const value of Object.values(objects)) value.related_ids = [anchor];

const checks = [], errors = [];
const searches = [];
let phase = 'setup';
const cursorLengths = [];
const deliveries = [];
let passed = false, h, run, prepared = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};

const proxy = createServer(async (request, response) => {
  let event;
  try {
    let raw = '';
    const buffers = [];
    for await (const chunk of request) buffers.push(chunk);
    raw = Buffer.concat(buffers).toString('utf8');
    const input = JSON.parse(raw);
    if (request.url.endsWith('/search')) {
      event = {phase, channel: input.annsField, offset: input.offset || 0, limit: input.limit, ids: []};
      searches.push(event);
    }
    const upstream = await fetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const text = await upstream.text();
    if (event) {
      const value = JSON.parse(text);
      event.code = value.code;
      event.ids = Array.isArray(value.data) ? value.data.flat().map(row => row.id) : [];
    }
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {
    errors.push(error.message);
    response.writeHead(503).end('{"code":1}');
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

function observePage(value) {
  result = value;
  pageNo++;
  assert.ok(pageNo <= 8, '窗口生命周期须在有界页数内完成');
  validateContract('KnowledgeSearchReply', result);
  assert.ok(result.hits.length <= PAGE_LIMIT, '每次调用的原限额保持');
  const page = [];
  for (const hit of result.hits) {
    assert.equal(hit.record_kind, 'knowledge_entry');
    const identity = hit.ref.object_id + ':' + (hit.statement_id || hit.ref.path);
    assert.equal(page.includes(identity), false, '同窗不得重复，同身份跨窗只能在不同页重现');
    page.push(identity);
    if (hit.ref.object_id === anchor) assert.equal(hit.definition, validText(Number(hit.ref.path.slice(3))));
    if (hit.ref.object_id === 'life-cross') assert.equal(hit.definition, crossText);
    if (hit.ref.object_id === 'life-last') assert.equal(hit.definition, lastText);
  }
  deliveries.push({page:pageNo,phase:'page-'+pageNo,hits:page});
  const next=result.search_coverage.next;
  if(next===null) {
    assert.ok(result.search_coverage.state==='searched' || (result.search_coverage.state==='bounded'
      && result.search_coverage.reasons.length===1 && result.search_coverage.reasons[0]==='index_lag'),
      '末窗bounded只能源于换版夹具的真实索引滞后：'+JSON.stringify(result.search_coverage));
  } else {
    assert.equal(typeof next,'string');
    assert.ok(next.length>0 && Buffer.byteLength(next)<=65536);
    cursorLengths.push(Buffer.byteLength(next));
  }
}
const budgets = [], wires = [], projections = [];
let providerFailure, pageNo = 0, result, stage = 'search', pendingArgs = {query, limit: PAGE_LIMIT, kinds: ['term']};
let modelCalls = 0, summaries = 0, activeManager, runBudget;
const previous = Object.fromEntries(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST'].map(key => [key,process.env[key]]));
const originalFetch = globalThis.fetch;
const originalContext = ExtensionRunner.prototype.emitContext;
let capacityProjection;
if (usePi) ExtensionRunner.prototype.emitContext = async function(...args) {
  const messages = await originalContext.apply(this,args);
  capacityProjection = messages;
  projections.push({phase,roles:messages.map(message=>message.role),bytes:Buffer.byteLength(JSON.stringify(messages))});
  return messages;
};
if (usePi) {
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/internal/data/tools') && typeof init?.body === 'string') {
      const invocation = JSON.parse(init.body);
      if (['search_knowledge','read_knowledge'].includes(invocation.tool_name)) {
        const response = await originalFetch(input,init);
        const receipt = await response.clone().json();
        const projection = activeManager?.buildSessionProjection();
        const projected = capacityProjection ?? projection?.messages ?? [];
        const current = projection?.messages.findLast(message=>message.role==='assistant');
        const calls = current?.content.filter(part=>part.type==='toolCall')??[];
        const hasCurrent = projected.some(message=>message.role==='assistant' && message.content.some(part=>part.type==='toolCall' && calls.some(call=>call.id===part.id)));
        const snapshot = convertToLlm(!hasCurrent && current ? [...projected,current] : projected).map(item => {
          if (item.role === 'system') return {role:item.role,content:item.content,sections:item.sections,
            toolsAdded:item.toolsAdded?.map(({name,description,parameters})=>({name,description,parameters})),toolsRemoved:item.toolsRemoved};
          if (item.role === 'toolResult') return {role:item.role,content:item.content,toolCallId:item.toolCallId,toolName:item.toolName};
          return {role:item.role,content:item.content};
        });
        const serialized = JSON.stringify({messages:snapshot});
        const wrappers = calls.map(call=>JSON.stringify({role:'tool',tool_call_id:call.id,content:''})).join('');
        budgets.push({phase, tool:invocation.tool_name, responseBudget:invocation.response_budget,
          receiptBytes:Buffer.byteLength(JSON.stringify(receipt.data)), status:response.status,error:receipt.data?.error ?? receipt.code,
          projectionBytes:Buffer.byteLength(serialized), protocolBytes:Buffer.byteLength(JSON.stringify(serialized))+Buffer.byteLength(wrappers)+4096,
          estimatedTokens:Math.ceil((serialized.length+wrappers.length)/4)+1024,
          budgetTiming:'context_with_system投影加本次assistant的估算；首批预算含route完成后的预留释放',
          remainingCalls:h.sql(`SELECT JSON_OBJECT('n',call_limit-issued_calls) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0].n,
          roles:projection?.messages.map(message=>message.role)});
        return response;
      }
    }
    return originalFetch(input,init);
  };
}
const provider = createServer(async (request,response) => {
  try {
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString('utf8'), input=JSON.parse(raw);
    const summary=!input.tools?.length;
    const toolsBytes=Buffer.byteLength(JSON.stringify(input.tools??[]));
    const systemBytes=Buffer.byteLength(JSON.stringify(input.messages.filter(message=>message.role==='system')));
    wires.push({phase,summary,wireBytes:Buffer.byteLength(raw),toolsBytes,systemBytes,
      historyBytes:Buffer.byteLength(JSON.stringify(input.messages.filter(message=>message.role!=='system'))),
      cursorBytes:pendingArgs.cursor?Buffer.byteLength(pendingArgs.cursor):0});
    assert.ok(Buffer.byteLength(raw)<=131072,'实际provider wire不能超过原容量');
    let delta;
    if(summary){summaries++;delta={role:'assistant',content:'合成历史摘要：继续原搜索游标，已成功操作不重做。'};}
    else {
      modelCalls++;assert.ok(modelCalls+summaries<=24,'压缩与工具沿原24次预算');
      const last=input.messages.findLast(message=>message.role==='tool' && (message.tool_call_id.startsWith('life-search-')||message.tool_call_id==='life-last-read'));
      if(last){
        const reply=JSON.parse(last.content);assert.equal(reply.error,undefined,'Pi正式回执须成功：'+JSON.stringify(reply));
        if(last.tool_call_id==='life-last-read') {
          assert.equal(reply.items[0].content,lastText);checks.push('末项经Pi正式read_knowledge原文补读');stage='done';
        } else {
          const stored=h.sql(`SELECT receipt FROM tool_calls WHERE origin_run_id='${run.run_id}' AND sdk_tool_call_id='${last.tool_call_id}'`)[0];
          if (typeof reply.search_coverage.next === 'string')
            assert.equal(reply.search_coverage.next,'rc1:'+stored.operation_id,'provider只见本操作短引用，完整窗口只在存储回执');
          assert.deepEqual(reply,reply.search_coverage.next==null?stored.data
            :{...stored.data,search_coverage:{...stored.data.search_coverage,next:reply.search_coverage.next}},
            'Pi续页回执等于首次Rust冻结回执的公开投影');
          observePage(reply);
          if(reply.search_coverage.next===null)stage='read';
          else pendingArgs={query,limit:PAGE_LIMIT,kinds:['term'],cursor:reply.search_coverage.next};
        }
      }
      if(stage==='done')delta={role:'assistant',content:'合成深翻页与末项读取完成。'};
      else {
        const call=stage==='read'?{id:'life-last-read',name:'read_knowledge',args:{items:[{kind:'knowledge',ref:{object_id:'life-last',version:'1',path:'body'}}]}}
          :{id:'life-search-'+(pageNo+1),name:'search_knowledge',args:pendingArgs};
        phase=stage==='read'?'last-read':'page-'+(pageNo+1);
        const batch=modelCalls===1?[{id:'life-route',name:'update_analysis_task',args:{action:'route',task_id:null,expected_version:null,goal:'',options:[]}},call]:[call];
        delta={role:'assistant',tool_calls:batch.map((item,index)=>({index,id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.args)}}))};
      }
    }
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.write('data: '+JSON.stringify({id:'synthetic-lifetime',choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\n');
    response.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+'\n\n');
    response.end('data: [DONE]\n\n');
  }catch(error){providerFailure=error;response.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{type:'invalid_request_error',message:'synthetic_lifetime_assertion_failed'}}));}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const providerUrl='http://127.0.0.1:'+provider.address().port;

const milvus = async (action, input) => {
  const response = await fetch('http://127.0.0.1:19531/v2/vectordb/' + action, {method: 'POST',
    headers: {authorization: 'Bearer root:' + vectorToken, 'content-type': 'application/json'},
    body: JSON.stringify({collectionName: collection, dbName: 'default', ...input})});
  const value = await response.json();
  assert.equal(value.code, 0, JSON.stringify(value));
  return value.data;
};

try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192,
    trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, ...(usePi?{protocolProviderUrl:providerUrl}:{}),
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  // 与deep-advance同序：先落库再触发全量rebuild，rebuild只为已存在对象排索引任务。
  for (const value of Object.values(objects)) insert(h, value);
  await h.resumeWorker();
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  await until(() => {
    const ids = Object.values(objects).map(value => `'${value.id}'`).join(',');
    const rows = h.sql(`SELECT JSON_OBJECT('k',COUNT(*),'v',SUM(vector_state='indexed')) AS s FROM knowledge_index_jobs WHERE object_id IN (${ids})`);
    return rows[0].k > 0 && rows[0].k === rows[0].v;
  }, '生命周期夹具由真实消费者完成索引', 1200000);
  // capture等待的是delivery bridge收到派发：worker须在运行中处理完本次输入，
  // 版本抬升是裸SQL不产生重索引作业，短暂恢复不会重索引换版对象（deep-advance同款顺序）。
  run = await h.capture(await h.create(), '逐页读全生命周期窗口直到末项。'); await h.pauseWorker();

  // 索引完成后换版：两批旧版资料的元信息核验按版本绑定失效，占用候选但不交付。
  h.sql(`UPDATE knowledge_objects SET version=2 WHERE id IN ('life-invalid-a','life-invalid-b');
    INSERT INTO knowledge_revisions(object_id,version,archived_body) SELECT object_id,2,body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows
      WHERE version=1 AND object_id IN ('life-invalid-a','life-invalid-b')`);

  // 受控向量：dense名次 validA > invalidA > invalidB > cross > last，末项位置超过首窗1000候选。
  const outputFields = ['id', 'object_id', 'object_version', 'kind', 'space_id', 'model', 'projection_version', 'text',
    'entry_id', 'entry_path', 'statement_id', 'statement_offset', 'char_offset', 'char_length', 'content_hash'];
  const rows = await milvus('entities/query', {filter: 'target == "knowledge_entry" && object_id in ' + JSON.stringify(Object.values(objects).map(value => value.id)),
    outputFields, limit: 4096, consistencyLevel: 'Strong'});
  assert.equal(rows.length, DENSE_TOTAL, DENSE_TOTAL + '个独立entry须实际索引');
  const embedded = await fetch(embedding.env.DATA_AGENT_EMBEDDING_URL, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: 'qwen3.7-text-embedding', dimensions: 1024, input: [query]})});
  const queryVector = (await embedded.json()).data[0].embedding;
  const norm = Math.hypot(...queryVector);
  const unit = queryVector.map(value => value / norm);
  const axis = unit.reduce((best, value, index) => Math.abs(value) < Math.abs(unit[best]) ? index : best, 0);
  const orthogonal = unit.map((value, index) => (index === axis ? 1 : 0) - unit[axis] * value);
  const orthogonalNorm = Math.hypot(...orthogonal);
  const cosineVector = score => unit.map((value, index) =>
    score * value + Math.sqrt(1 - score ** 2) * orthogonal[index] / orthogonalNorm);
  const scores = new Map();
  rows.filter(row => row.object_id === anchor).forEach((row, index) => scores.set(row.id, 0.991 - index * 5e-6));
  rows.filter(row => row.object_id === 'life-invalid-a').forEach((row, index) => scores.set(row.id, 0.990 - index * 4e-6));
  rows.filter(row => row.object_id === 'life-invalid-b').forEach((row, index) => scores.set(row.id, 0.980 - index * 5e-6));
  scores.set(rows.find(row => row.object_id === 'life-cross').id, 0.75);
  scores.set(rows.find(row => row.object_id === 'life-last').id, 0.70);
  for (let offset = 0; offset < rows.length; offset += 100)
    await milvus('entities/upsert', {data: rows.slice(offset, offset + 100).map(row => ({...row, vector: cosineVector(scores.get(row.id))}))});

  // 两条路径共用原夹具和观察断言，kinds:['term']不引入demo其他种类。
  const manager = SessionManager.inMemory('/synthetic/search-continuation-lifetime');
  const searchPage = async args => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
      tool_name: 'search_knowledge', arguments: args,
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    const registration = ok(await h.internal('/internal/data/tool-calls', input));
    const receipt = ok(await h.internal('/internal/data/tools', input));
    const saved = h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt) FROM tool_calls
      WHERE sdk_tool_call_id='${input.sdk_tool_call_id}' AND origin_run_id='${run.run_id}'`);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].state, 'succeeded');
    assert.equal(receipt.operation_id, registration.operation_id);
    const publicNext = receipt.data.search_coverage.next;
    if (typeof publicNext === 'string')
      assert.equal(publicNext, 'rc1:' + receipt.operation_id, '公共游标是本操作短引用，完整窗口只在存储回执');
    assert.deepEqual(publicNext == null ? saved[0].receipt
      : {...saved[0].receipt, data: {...saved[0].receipt.data,
        search_coverage: {...saved[0].receipt.data.search_coverage, next: publicNext}}}, receipt,
      '每页HTTP结果等于Rust首次冻结回执的公开投影');
    validateContract('KnowledgeSearchReply', receipt.data);
    return receipt.data;
  };

  if (usePi) {
    process.env.DEEPSEEK_API_KEY='synthetic-protocol-key';process.env.DEEPSEEK_BASE_URL=providerUrl;process.env.DATA_AGENT_PROVIDER_TEST='1';
    // 同配置保留真实长会话压力，验证原生压缩后仍能续读同题；不增加模型或payload上限。
    const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    for(let index=0;index<24;index++){
      manager.appendMessage({role:'user',content:'合成深翻页旧轮资料'.repeat(180),timestamp:index*2});
      manager.appendMessage({role:'assistant',content:[{type:'text',text:'旧轮已记录。'}],api:'openai-completions',provider:'deepseek',model:'deepseek-flash',stopReason:'stop',usage,timestamp:index*2+1});
    }
    run.checkpoint=exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
    // 仅观测真实deliver创建的SDK manager，不替换工具或Agent循环。
    const originalAppend=SessionManager.prototype.appendMessage;
    SessionManager.prototype.appendMessage=function(...args){activeManager=this;return originalAppend.apply(this,args);};
    try {await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}
    catch(error){throw providerFailure??error;}
    finally{SessionManager.prototype.appendMessage=originalAppend;}
    assert.equal(stage,'done');
    assert.ok(summaries>0,'深翻页同配置经真实Pi压缩后完成');
    const saved=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
    const restored=restoreCheckpoint('/synthetic/data-agent',saved);
    assert.equal(restored.getSessionId(),manager.getSessionId());
    assert.ok(restored.getBranch().some(entry=>entry.type==='compaction'));
    const budget=h.sql(`SELECT JSON_OBJECT('id',r.budget_scope_id,'calls',b.issued_calls,'limit',b.call_limit) FROM agent_runs r JOIN budget_scopes b ON b.id=r.budget_scope_id WHERE r.id='${run.run_id}'`)[0];
    runBudget={...budget,attempts:h.sql(`SELECT JSON_OBJECT('purpose',purpose,'state',state,'run',run_id,'budget',budget_scope_id,'operation',operation_id) FROM model_call_attempts WHERE budget_scope_id='${run.budget_scope_id}'`)};
    assert.equal(budget.id,run.budget_scope_id);assert.equal(budget.limit,24);
    assert.equal(runBudget.attempts.filter(attempt=>attempt.run===run.run_id).length,modelCalls+summaries);
    assert.ok(budget.calls<=24);
  } else {
    // 直调检索受正文准入门约束：先按本消息route（与Pi分支首批route同参），再深翻页。
    const route = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
      tool_name: 'update_analysis_task',
      arguments: {action: 'route', task_id: null, expected_version: null, goal: '', options: []},
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls', route));
    ok(await h.internal('/internal/data/tools', route));
    let args={query,limit:PAGE_LIMIT,kinds:['term']};
    while(true){
      phase='page-'+(pageNo+1);
      observePage(await searchPage(args));
      if(result.search_coverage.next===null)break;
      args={query,limit:PAGE_LIMIT,kinds:['term'],cursor:result.search_coverage.next};
    }
  }
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []);

  // 交付总账：合法恰一次、旧版0次、同身份跨窗两次、末项恰一次且在最后一页。
  const all = deliveries.flatMap(value => value.hits);
  const count = identity => all.filter(value => value === identity).length;
  const validHits = all.filter(value => value.startsWith(anchor + ':'));
  assert.equal(new Set(validHits).size, validHits.length, '首窗合法entry不得重复交付');
  assert.equal(validHits.length, VALID_COUNT, '全部合法entry须恰好交付一次');
  assert.equal(all.filter(value => value.startsWith('life-invalid-')).length, 0, '换版旧资料不得交付');
  const crossKey = 'life-cross:body';
  assert.equal(count(crossKey), 2, '同身份跨窗必须重现并再次交付（旧合同全查询恰一次已按确认改为窗口生命周期）');
  assert.equal(count('life-last:body'), 1);
  assert.ok(deliveries.at(-1).hits.includes('life-last:body'), '末项须在最后一页交付');
  checks.push(DENSE_TOTAL + '个dense位置跨两窗全部推进：合法恰一次、旧版0、跨窗同身份恰两次、末项最后一页可读');

  // 游标体积：每窗单页即耗尽，观测到的都是释放后的薄游标——不得随总页数增长，
  // 也不得携带窗口成员明细（游标体积回落至通道/范围状态的量级）。
  assert.ok(cursorLengths.length >= 1, '至少经历一次窗口游标');
  assert.ok(cursorLengths.every(length => length <= 4096),
    '释放后的薄游标不得超过通道/范围状态量级：' + JSON.stringify(cursorLengths));
  checks.push('窗口单页耗尽即释放：全部游标为薄游标（' + JSON.stringify(cursorLengths) + '），不随总页数增长');

  // 通道真实前进：dense offset跨页递增并越过首窗1000候选；每次调用1000候选预算保持。
  // 预算优先扫描下sparse未必穷尽，新窗重发未穷尽通道是正确行为（不重发已消费offset，
  // 由dense断言与身份总账分别约束）。
  const denseOffsets = [...new Set(searches.filter(event => event.channel === 'vector').map(event => event.offset))].sort((a, b) => a - b);
  assert.ok(denseOffsets.length >= 3 && denseOffsets.at(-1) > denseOffsets[0], 'dense须沿真实offset前进：' + JSON.stringify(denseOffsets));
  assert.ok(denseOffsets.at(-1) >= 999, '后窗dense位置越过首窗1000候选：' + JSON.stringify(denseOffsets));
  const perCallUnique = new Map();
  for (const event of searches) {
    const page = event.phase;
    const seen = perCallUnique.get(page) ?? new Set();
    event.ids.forEach(id => seen.add(id));
    perCallUnique.set(page, seen);
  }
  for (const [page, seen] of perCallUnique) assert.ok(seen.size <= 1000, '每次调用1000候选预算保持：' + page + '=' + seen.size);
  checks.push('dense沿真实offset前进至' + denseOffsets.at(-1) + '（跨过首窗1000候选），每调用候选≤1000');
  passed = true;
  console.log(JSON.stringify({passed, checks, pages: deliveries.length, cursorLengths, officialRequests: 0}));
} finally {
  globalThis.fetch=originalFetch;ExtensionRunner.prototype.emitContext=originalContext;
  for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  if (h) {await writeFile(h.directory + '/search-continuation-lifetime.json', JSON.stringify({passed, usePi, checks, errors, deliveries, searches, cursorLengths,
    budgets,wires,projections,modelCalls,summaries,usageKind:'本地协议合成usage，非真实provider计量',officialRequests: 0}, null, 2));
    if(usePi) await writeFile('.local/checks/semantic-delivery/deep-pi-diagnostic.json',JSON.stringify({passed,usePi,budgets,wires,projections,modelCalls,summaries,runBudget,officialRequests:0},null,2));await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close();
  for(const server of [proxy,provider]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
