import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import net from 'node:net';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

// 05切片3反例：统一候选推进。候选深度必须由"元信息核验后的可交付候选"驱动，
// 位置按原始record前进（Milvus offset），而不是由召回数量驱动重复请求同一前缀。
// 阶段A：前200个record在元信息阶段判无效（撤下对象的索引残留），不消耗内容
// 读取名额；唯一合法目标在第201位之后——必须真实扩深并交付其正文。
// 阶段B：正文核验失效的候选占用共享30个内容读取名额，名额耗尽即停止扩深并
// 如实报告bounded，不得冒充complete，也不得为填页继续读到名单之外。
const A_TERM = 'advghost';
const B_TERM = 'advfatal';
const NEEDLE_A = 'advanceneedle-a';
const NEEDLE_B = 'advanceneedle-b';

const entry = (entryId, text) => ({
  entry_id: entryId, path: entryId, label: '正文', effective_value: text,
  source_facts: {complete: false, gap: '独立合成推进夹具'}, suggestion: {},
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

const checks = [];
const observations = {};
let passed = false;
let run;
const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};

const provider = await embeddingProvider();
const collection = 'da_advance_' + randomUUID().replaceAll('-', '');
const token = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const requests = [];
const wireEvents = [];
const proxyErrors = [];
let phase = 'existing';
let race;
// 门闩有界失败，不用睡眠猜测两路是否在途；返回值只放行真实Milvus响应或HTTP故障。
const gate = label => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return {release, wait: () => Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: '+label)), 4000);
    timer.unref();
    promise.finally(() => clearTimeout(timer));
  })])};
};
const proxy = createServer(async (req, res) => {
  let event;
  try {
    const requestPhase = phase;
    const requestRace = race;
    let raw = '';
    for await (const part of req) raw += part;
    const input = JSON.parse(raw);
    if (req.url.endsWith('/search')) {
      event = {phase:requestPhase, channel:input.annsField, offset:input.offset || 0,
        limit:input.limit, filter:input.filter, ids:[], startedAt:Date.now()};
      requests.push(event);
      wireEvents.push({kind:'dispatch', request:event});
      // 第一页词法未返回前等dense实际派发，Embedding的本地结算快慢不改变首轮额度。
      if (requestRace && event.channel==='vector' && event.offset===0) requestRace.denseFirst.release();
      if (requestRace && event.channel==='sparse' && event.offset===0) await requestRace.denseFirst.wait();
      // 第三轮dense只在词法第三轮的真实响应已经发回后放行；第四轮因此确在900处争额。
      if (requestRace && event.channel==='vector' && event.offset===250)
        await requestRace.lexicalThird.wait();
      if (requestRace && event.channel==='sparse' && event.offset===450) {
        event.heldForLast100 = true;
        requestRace.heldEvent = event;
        requestRace.lastReservation.release();
        await requestRace.releaseLast.wait();
        if (requestRace.mode==='failure') {
          Object.assign(event, {status:503, injected:true, respondedAt:Date.now()});
          wireEvents.push({kind:'complete', request:event});
          res.writeHead(503, {'content-type':'application/json'}).end('{"code":1}');
          return;
        }
      }
    }
    const response = await fetch('http://127.0.0.1:19531'+req.url, {
      method:'POST', headers:{'content-type':'application/json', authorization:req.headers.authorization}, body:raw});
    const output = await response.text();
    if (event) {
      const value = JSON.parse(output);
      const rows = Array.isArray(value.data) ? value.data.flat() : [];
      Object.assign(event, {status:response.status, code:value.code, ids:rows.map(row=>row.id),
        entries:rows.map(row=>row.entry_id), objectIds:rows.map(row=>row.object_id), respondedAt:Date.now()});
      wireEvents.push({kind:'complete', request:event});
    }
    res.writeHead(response.status, {'content-type':'application/json'}).end(output);
    if (event && requestRace && event.channel==='sparse' && event.offset===250)
      requestRace.lexicalThird.release();
  } catch (error) {
    proxyErrors.push({phase, message:error.message});
    if (event && !event.respondedAt) {
      Object.assign(event, {status:503, error:error.message, respondedAt:Date.now()});
      wireEvents.push({kind:'complete', request:event});
    }
    res.writeHead(503, {'content-type':'application/json'}).end('{"code":1}');
  }
});
await new Promise(resolve=>proxy.listen(0, '127.0.0.1', resolve));

// 只观测本次隔离库的owner窄读，不记录SQL、认证包或任意正文。
const ownerReads = [];
const fallbackReads = [];
const sockets = new Set();
const packets = observe => {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length>=4) {
      const bytes = pending.readUIntLE(0,3)+4;
      if (pending.length<bytes) break;
      observe(pending.subarray(4,bytes));
      pending = pending.subarray(bytes);
    }
  };
};
const sqlBoundary = query => {
  const sql = query.replace(/\s+/g,' ').trim();
  // 08迁移后owner正文读走knowledge_objects现行版本。head查询带scope约束，
  // 锚点related_id作为绑定参数混入execute帧，不能用于对象归因；
  // units查询只绑对象与版本、无scope约束，每次合法启动恰好执行一次。
  if (sql.startsWith("WITH entries AS (SELECT JSON_EXTRACT(j.e,'$.entry_id')")) return 'owner';
  if (sql.startsWith('SELECT owner_id,owner_version,mapping_state FROM knowledge_dependency_states')) return 'rank';
  if (/\bWITH\s+query_terms\s+AS\b/i.test(sql)) return 'fallback';
};
const sqlProxy = net.createServer(socket => {
  const remote = net.connect(13306,'127.0.0.1');
  for (const connection of [socket,remote]) {
    sockets.add(connection);
    connection.on('error',()=>{});
    connection.on('close',()=>sockets.delete(connection));
  }
  socket.on('close',()=>remote.destroy());
  remote.on('close',()=>socket.destroy());
  const statements = new Map();
  let preparing;
  let commitWitness;
  let rankingRace;
  let authenticated = false;
  let clientHello = false;
  const clientPackets = packets(payload => {
    if (!authenticated) { clientHello = true; return; }
    if (payload[0]===0x16) preparing = {boundary:sqlBoundary(payload.subarray(1).toString('utf8'))};
    else if (payload[0]===0x19 && payload.length>=5) statements.delete(payload.readUInt32LE(1));
    else if (payload[0]===0x17 || payload[0]===0x03) {
      if (payload[0]===0x03 && /^\s*COMMIT\s*$/i.test(payload.subarray(1).toString('utf8'))) {
        if (rankingRace===race && race?.heldEvent && !race.heldEvent.respondedAt) commitWitness = race;
        rankingRace = undefined;
      }
      const boundary = payload[0]===0x17 ? statements.get(payload.readUInt32LE(1))?.boundary
        : sqlBoundary(payload.subarray(1).toString('utf8'));
      if (boundary==='rank' && race && payload.includes(Buffer.from('adv-race-ghost'))) rankingRace = race;
      if (boundary==='owner') ownerReads.push({phase, at:Date.now(),
        owners:['adv-small-fatal','adv-small-target','adv-race-ghost','adv-race-target','adv-round-ghost','adv-round-target']
          .filter(id=>payload.includes(Buffer.from(id)))});
      if (boundary==='fallback') fallbackReads.push({phase, at:Date.now()});
    }
  });
  const serverPackets = packets(payload => {
    if (!authenticated) { if (clientHello && payload[0]===0x00) authenticated = true; return; }
    if (commitWitness && payload[0]===0x00) {
      commitWitness.ownerYieldAt = Date.now();
      commitWitness.ownerYield.release();
      commitWitness = undefined;
    }
    if (preparing) {
      if (payload[0]===0x00 && payload.length>=5) statements.set(payload.readUInt32LE(1),preparing);
      preparing = undefined;
    }
  });
  socket.on('data',chunk=>{clientPackets(chunk);remote.write(chunk);});
  remote.on('data',chunk=>{serverPackets(chunk);socket.write(chunk);});
});
await new Promise(resolve=>sqlProxy.listen(0,'127.0.0.1',resolve));
const milvus = async (action, input) => {
  const response = await fetch('http://127.0.0.1:19531/v2/vectordb/'+action, {method:'POST',
    headers:{authorization:'Bearer root:'+token, 'content-type':'application/json'},
    body:JSON.stringify({collectionName:collection, dbName:'default', ...input})});
  const value = await response.json();
  assert.equal(value.code, 0, JSON.stringify(value));
  return value.data;
};
const h = await harness({
  capture: true, startWorker: false,
  onDatabaseUrl: value => {
    const url = new URL(value);
    url.port = String(sqlProxy.address().port);
    url.searchParams.set('ssl-mode','DISABLED');
    return url.toString();
  },
  profile: {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'advance_'+randomUUID(),
    price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,
    request_call_limit:24,toolset:'data',payload_bytes_limit:131072,budget_mode:'request'},
  env: {...provider.env, DATA_AGENT_LEASE_MS: '120000',
    DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:'+proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'},
});

const search = async (query, limit, scope = {}) => {
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: 'search_knowledge', arguments: {query, limit, ...scope},
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const registration = ok(await h.internal('/internal/data/tool-calls', input));
  const receipt = ok(await h.internal('/internal/data/tools', input));
  const saved = h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt) FROM tool_calls
    WHERE sdk_tool_call_id='${input.sdk_tool_call_id}' AND origin_run_id='${run.run_id}'`);
  assert.equal(saved.length,1,'正式工具登记只产生一份回执');
  assert.equal(saved[0].state,'succeeded');
  assert.equal(receipt.operation_id,registration.operation_id);
  assert.deepEqual(saved[0].receipt,receipt,'HTTP正文及覆盖须与最终核验后裁剪保存的回执逐字一致');
  return receipt.data;
};

// 每个dispatch先占limit，只有响应送回才释放；唯一身份按真实Milvus主键累计。
// 代理可见的发回时点早于用例吸收，因而此账本对尚未吸收的响应只给更宽的额度；
// 最后100的门闩断言另行保证争额时没有这个观测间隙。
const auditBudget = requestPhase => {
  const seen = new Set();
  const inFlight = new Map();
  const ledger = [];
  for (const event of wireEvents.filter(event=>event.request.phase===requestPhase)) {
    const request = event.request;
    const before = seen.size;
    if (event.kind==='dispatch') {
      assert.ok(!inFlight.has(request));
      inFlight.set(request,request.limit);
    } else {
      assert.ok(inFlight.has(request),'每次完成必须对应真实在途请求');
      inFlight.delete(request);
      if (request.status===200 && request.code===0) {
        assert.ok(request.ids.length<=request.limit,'Milvus实际返回不能超已分配limit');
        request.ids.forEach(id=>seen.add(id));
      }
    }
    const reserved = [...inFlight.values()].reduce((sum,value)=>sum+value,0);
    const snapshot = {kind:event.kind,channel:request.channel,offset:request.offset,limit:request.limit,
      unique:seen.size,newUnique:seen.size-before,reserved,total:seen.size+reserved};
    ledger.push(snapshot);
    assert.ok(snapshot.total<=1000,'真实已收唯一+在途不得超1000：'+JSON.stringify(snapshot));
  }
  assert.equal(inFlight.size,0,'返回前所有已派发页均已收尾');
  return {unique:seen.size,ledger};
};
const embedVector = async query => {
  const response = await fetch(provider.env.DATA_AGENT_EMBEDDING_URL,{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'qwen3.7-text-embedding',dimensions:1024,input:[query]})});
  assert.equal(response.status,200);
  return (await response.json()).data.find(row=>row.index===0).embedding;
};
const cosineVector = (queryVector,score) => {
  const norm = Math.hypot(...queryVector);
  const unit = queryVector.map(value=>value/norm);
  const axis = unit.reduce((best,value,index)=>Math.abs(value)<Math.abs(unit[best])?index:best,0);
  const orthogonal = unit.map((value,index)=>(index===axis?1:0)-unit[axis]*value);
  const orthogonalNorm = Math.hypot(...orthogonal);
  return unit.map((value,index)=>score*value+Math.sqrt(1-score**2)*orthogonal[index]/orthogonalNorm);
};

try {
  // 阶段A夹具：520个索引后换版对象（索引行仍按version 1命中）+ 1个合法目标。
  // 查询词词频梯度：换版对象×5、目标×1。允许集分片按id字典序200/片：目标所在
  // 末片内排第153位，首轮该片150额度取不到，必须真实扩深（offset前进）。
  const ghosts = Array.from({length: 520}, (_, i) =>
    body('adv-ghost-' + String(i).padStart(4, '0'), 'document', '换版残留资料',
      [entry('body', ('推进探针 ' + A_TERM + ' ').repeat(5) + '已换版资料正文。')]));
  const targetA = body('adv-target-a', 'document', '推进合法目标',
    [entry('body', '推进探针 ' + A_TERM + ' 唯一合法目标，标记 ' + NEEDLE_A + '。')]);
  // 阶段B夹具：32个正文核验失效对象（引用document源在索引完成后换版）词频×4
  // + 1个合法目标×1。失效在选中窄读后的来源核验阶段才暴露——占用内容读取名额。
  const sourceDoc = body('adv-source-doc', 'document', '推进引用源',
    [entry('body', '推进夹具引用源正文，不参与查询词。')]);
  const fatals = Array.from({length: 32}, (_, i) => {
    const value = body('adv-fatal-' + String(i).padStart(3, '0'), 'metric', '正文失效资料',
      [entry('body', ('推进探针 ' + B_TERM + ' ').repeat(4) + '正文核验期失效。')]);
    value.entries[0].source_facts = {source_id: 'document-adv-source-doc', version: '1', complete: true};
    return value;
  });
  const targetB = body('adv-target-b', 'metric', '推进后备合法目标',
    [entry('body', '推进探针 ' + B_TERM + ' 名单外合法目标，标记 ' + NEEDLE_B + '。')]);

  // 一个owner下220条失效entry，避免允许集分片使目标提前出现在另一片首批。
  const denseGhost = body('adv-dense-ghost', 'metric', '稠密旧版合成资料',
    Array.from({length:220}, (_, i)=>entry('old-'+i, '常规历史说明 '+i+'。')));
  const denseTarget = body('adv-dense-target', 'metric', '稠密后页合法资料',
    [entry('body', '合成尾页规则：设备在校准完成之前不得投入使用。')]);
  for (const value of [denseGhost,denseTarget]) value.related_ids=['adv-dense-ghost'];
  for (const value of [...ghosts, targetA, sourceDoc, ...fatals, targetB, denseGhost, denseTarget]) insert(h, value);
  await h.resumeWorker();
  assert.equal((await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})).status, 200);
  const ids = [...ghosts, targetA, sourceDoc, ...fatals, targetB, denseGhost, denseTarget].map(value => value.id);
  for (let i = 0; i < 600; i++) {
    const rows = h.sql(`SELECT JSON_OBJECT('k',COUNT(*),'v',SUM(vector_state='indexed')) AS s FROM knowledge_index_jobs WHERE object_id IN (${ids.map(id => `'${id}'`).join(',')})`);
    if (rows[0].k > 0 && rows[0].k === rows[0].v) break;
    if (i % 30 === 29) console.error('INDEX-STATE', JSON.stringify(rows));
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (i === 599) throw new Error('推进夹具完成索引超时：' + JSON.stringify(rows));
  }
  run = await h.capture(await h.create(), '核对推进探针的合法目标');
  await h.pauseWorker();
  // worker 已停：阶段A的200个对象在索引后换版到2——Milvus索引行仍按version 1
  // 命中（异步重索引未运行），元信息阶段按版本绑定判无效、不占内容读取名额；
  // 来源门只看对象启停不看版本，召回照常返回。阶段B的引用源换版到2：fatal对象
  // 按version 1引用，正文核验阶段失效。
  h.sql(`UPDATE knowledge_objects SET version=2 WHERE id LIKE 'adv-ghost-%';
    INSERT INTO knowledge_revisions(object_id,version,archived_body) SELECT object_id,2,body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE version=1 AND object_id LIKE 'adv-ghost-%';
    UPDATE knowledge_objects SET version=2 WHERE id='adv-source-doc';
    INSERT INTO knowledge_revisions(object_id,version,archived_body) SELECT object_id,2,body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id='adv-source-doc' AND version=1`);

  // 词法成功空、Embedding晚到时，不得为尚未派发的dense虚增到第5轮。
  provider.setDelay(800);
  requests.length=0;
  const lateDense=await search('lateembedonlyneedle',1,{related_object_id:denseTarget.id});
  provider.setDelay(0);
  observations.lateDense={objects:lateDense.objects.map(item=>item.id),coverage:lateDense.search_coverage,requests:requests.slice()};
  assert.deepEqual(lateDense.objects.map(item=>item.id),[denseTarget.id]);
  assert.equal(lateDense.search_coverage.channels.dense.rounds,1,'未派发不能空转增加共同深度');
  assert.deepEqual(requests.filter(request=>request.channel==='vector').map(request=>[request.offset,request.limit]),[[0,50]],
    '晚到dense首批仍为首轮实际额度');
  checks.push('词法成功空后等待晚到Embedding，dense首批只占实际第1轮且额度50');

  const denseQuery='densepaginationonlyneedle';
  const embedded = await fetch(provider.env.DATA_AGENT_EMBEDDING_URL, {method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'qwen3.7-text-embedding', dimensions:1024, input:[denseQuery]})});
  assert.equal(embedded.status,200);
  const vector = (await embedded.json()).data[0].embedding;
  const norm = Math.hypot(...vector);
  const normalized = vector.map(value=>value/norm);
  const alternate = normalized.map((_,i)=>i === 0 ? 1 : 0);
  const dot = normalized[0];
  for (let i=0; i<alternate.length; i++) alternate[i]-=dot*normalized[i];
  const alternateNorm = Math.hypot(...alternate);
  const targetVector = normalized.map((value,i)=>0.75*value+Math.sqrt(1-0.75**2)*alternate[i]/alternateNorm);
  const outputFields=['id','object_id','object_version','kind','space_id','model','projection_version','text',
    'entry_id','entry_path','statement_id','statement_offset','char_offset','char_length','content_hash'];
  const currentRows = await milvus('entities/query',{filter:'object_id in ["adv-dense-ghost","adv-dense-target"] && target == "knowledge_entry"',
    outputFields,limit:512,consistencyLevel:'Strong'});
  assert.equal(currentRows.filter(row=>row.object_id===denseGhost.id).length,220,'夹具须实际索引220个独立entry');
  // 220行不能用完全相同的向量：Milvus对并列向量的跨请求排序不稳定，分页会重读
  // 已收行。逐行微扰首维保持全部高于目标，使排序确定。
  const ghostOrder = currentRows.filter(row=>row.object_id===denseGhost.id);
  await milvus('entities/upsert',{data:currentRows.map(row=>row.object_id===denseGhost.id
    ? {...row, vector:normalized.map((value,i)=>i===0
        ? value + (219-ghostOrder.indexOf(row))*1e-4 : value)}
    : {...row, vector:targetVector})});
  h.sql(`UPDATE knowledge_objects SET version=2 WHERE id='${denseGhost.id}';
    INSERT INTO knowledge_revisions(object_id,version,archived_body) SELECT object_id,2,body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id='${denseGhost.id}' AND version=1`);
  requests.length=0;
  const denseResult=await search(denseQuery,1,{related_object_id:denseGhost.id});
  observations.denseAfter200={objects:denseResult.objects.map(item=>item.id),coverage:denseResult.search_coverage,requests:requests.slice()};
  assert.deepEqual(denseResult.objects.map(item=>item.id),[denseTarget.id],
    '前220个元信息失效内容之后，dense后页仍须交付合法目标正文');
  assert.ok(denseResult.objects[0].entries.some(item=>item.effective_value.includes('校准完成之前不得投入使用')));
  const targetRecord=currentRows.find(row=>row.object_id===denseTarget.id).id;
  assert.ok(requests.some(request=>request.channel==='vector' && request.offset>0
    && request.ids.includes(targetRecord) && request.offset+request.ids.indexOf(targetRecord)===220),
    'dense须沿真实消费位置前进，合法目标为第221条而不是重复前缀');
  const lexicalRequests=requests.filter(request=>request.channel==='sparse');
  assert.ok(lexicalRequests.length>0 && lexicalRequests.every(request=>request.ids.length===0),
    'BM25实际请求成功空，不靠SQL或词法召回目标');
  assert.ok(denseResult.search_coverage.channels.dense.rounds>=2 && denseResult.search_coverage.channels.dense.rounds<=5);
  assert.equal(denseResult.search_coverage.candidate_count,221,'失效已收内容仍占候选，跨轮不重复');
  checks.push('dense前220个entry由元信息排除不耗主读取，后页按offset前进，BM25成功空时合法正文仍经同一工具交付');

  // 阶段A：唯一合法目标在第201位之后，必须真实扩深并交付。
  const a = await search(A_TERM, 30);
  observations.stageA = {
    objects: a.objects.map(item => item.id),
    coverage: a.search_coverage,
  };
  assert.ok(a.objects.some(item => item.id === targetA.id),
    '第201位后的合法目标必须交付：' + JSON.stringify(a.objects.map(item => item.id)));
  assert.ok(a.objects.every(item => !item.id.startsWith('adv-ghost-')),
    '撤下残留不得进入交付');
  assert.ok(a.objects.some(item => item.id === targetA.id
    && item.entries.some(e => (e.effective_value || '').includes(NEEDLE_A))),
    '交付须含合法目标正文');
  const aRounds = a.search_coverage.channels.lexical.rounds;
  assert.ok(aRounds >= 2, '位置前进须体现为真实扩深（rounds=' + aRounds + '）：' + JSON.stringify(a.search_coverage.channels));
  assert.equal(a.search_coverage.query_terms_complete, true);
  checks.push('阶段A：前200撤下残留由元信息排除不占读取名额，第201位后合法目标经真实扩深（lexical rounds=' + aRounds + '）交付正文');

  // 阶段B：32个正文失效对象占满共享30内容读取名额，耗尽即停止扩深、如实bounded。
  const b = await search(B_TERM, 1);
  observations.stageB = {
    objects: b.objects.map(item => item.id),
    coverage: b.search_coverage,
  };
  assert.equal(b.objects.length, 0, '名额耗尽后不得再读取名单之外的目标：' + JSON.stringify(b.objects.map(item => item.id)));
  assert.equal(b.search_coverage.state, 'bounded',
    '读取名额耗尽须如实bounded，不得冒充complete：' + JSON.stringify(b.search_coverage));
  const bRounds = b.search_coverage.channels.lexical.rounds;
  assert.ok(bRounds >= 1 && bRounds <= 5, '轮数在界内：' + JSON.stringify(b.search_coverage.channels));
  checks.push('阶段B：正文失效候选占满30读取名额即停止扩深（rounds=' + bRounds + '），零交付如实bounded不冒充complete');

  // 原四组先执行完；新增entry不进入原例无范围查询的允许集。
  // 小额失败：第一轮恰为48个元信息失效+2个正文来源失效，合法项在第51条。
  const smallQuery = 'smallbodyadvanceonlyneedle';
  const smallGhost = body('adv-small-ghost','metric','少量读取旧资料',
    Array.from({length:48},(_,i)=>entry('old-'+i,'少量读取历史条目 '+i+'。')));
  const smallFatal = body('adv-small-fatal','metric','少量读取待核资料',
    Array.from({length:2},(_,i)=>entry('fatal-'+i,'少量读取待核正文 '+i+'。')));
  for (const value of smallFatal.entries)
    value.source_facts = {source_id:'document-adv-source-doc',version:'2',complete:true};
  const smallText = 'smallbodydelivered：合成设备复核通过后才允许使用。';
  const smallTarget = body('adv-small-target','metric','少量读取后页资料',[entry('body',smallText)]);
  for (const value of [smallGhost,smallFatal,smallTarget]) value.related_ids = [smallGhost.id];

  // 两路前三轮50+200+200互不重叠：450 sparse + 450 dense = 900唯一身份。
  // sparse第四页的100条与dense前页重叠，或整页503；合法项在dense第451条。
  const raceQuery = 'reservationadvanceonlyneedle';
  const raceGhost = body('adv-race-ghost','metric','候选竞争历史资料',[
    ...Array.from({length:450},(_,i)=>entry('lex-'+String(i).padStart(3,'0'),
      (raceQuery+' ').repeat(4)+'词法历史 '+i+'。')),
    ...Array.from({length:100},(_,i)=>entry('overlap-'+String(i).padStart(3,'0'),
      raceQuery+' 跨通道历史 '+i+'。')),
    ...Array.from({length:350},(_,i)=>entry('dense-'+String(i).padStart(3,'0'),'语义历史 '+i+'。')),
    ...Array.from({length:200},(_,i)=>entry('tail-'+String(i).padStart(3,'0'),'未查历史 '+i+'。')),
  ]);
  const raceText = 'reservationdelivered：候选竞争后的合法正文必须保存。';
  const raceTarget = body('adv-race-target','metric','候选竞争合法资料',[entry('body',raceText)]);
  for (const value of [raceGhost,raceTarget]) value.related_ids = [raceGhost.id];

  // dense五轮50+200×4=850，850个失效entry填满第五页；第851条合法但须止步。
  const roundQuery = 'fifthroundonlyneedle';
  const roundGhost = body('adv-round-ghost','metric','轮次边界历史资料',
    Array.from({length:850},(_,i)=>entry('old-'+String(i).padStart(3,'0'),'轮次历史 '+i+'。')));
  const roundTarget = body('adv-round-target','metric','轮次边界合法资料',
    [entry('body','sixthroundforbidden：第六页合法正文只能由正控读取。')]);
  for (const value of [roundGhost,roundTarget]) value.related_ids = [roundGhost.id];
  const added = [smallGhost,smallFatal,smallTarget,raceGhost,raceTarget,roundGhost,roundTarget];
  for (const value of added) insert(h,value);
  const indexTarget = h.sql(`SELECT JSON_OBJECT('target',vector_target) FROM knowledge_index_jobs
    WHERE target_kind='knowledge_entry' AND object_id='${denseTarget.id}' AND version=1`)[0].target;
  assert.match(indexTarget,/^[a-f0-9]{64}$/,'新增隔离夹具须沿原正式集合目标');
  // 只给新增隔离数据排原队列；不全库rebuild已经故意失效的原四组资料。
  h.sql(`INSERT INTO knowledge_index_jobs(target_kind,object_id,version,state,vector_target) VALUES
    ${added.map(value=>`('knowledge_entry','${value.id}',1,'pending','${indexTarget}')`).join(',')}`);
  await h.resumeWorker();
  await until(() => {
    const rows = h.sql(`SELECT JSON_OBJECT('n',COUNT(*),'ready',SUM(vector_state='indexed'))
      FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND version=1
        AND object_id IN (${added.map(value=>`'${value.id}'`).join(',')})`)[0];
    return rows.n===added.length && rows.ready===added.length;
  },'新增推进entry由真实消费者完成索引',120000);
  h.releaseRun(run.run_id);
  run = await h.capture(await h.create(),'核对新增推进反例的合法正文与轮次边界');
  await h.pauseWorker();

  const indexedRows = async values => {
    const rows = await milvus('entities/query',{
      filter:'target == "knowledge_entry" && object_id in '+JSON.stringify(values.map(value=>value.id)),
      outputFields,limit:4096,consistencyLevel:'Strong'});
    for (const value of values)
      assert.equal(rows.filter(row=>row.object_id===value.id).length,value.entries.length,
        value.id+'须由真实writer索引每个独立entry');
    return rows;
  };
  const smallRows = await indexedRows([smallGhost,smallFatal,smallTarget]);
  const raceRows = await indexedRows([raceGhost,raceTarget]);
  const roundRows = await indexedRows([roundGhost,roundTarget]);
  const [smallVector,raceVector,roundVector] = await Promise.all(
    [smallQuery,raceQuery,roundQuery].map(embedVector));
  const upsertRows = async rows => {
    for (let offset=0;offset<rows.length;offset+=100)
      await milvus('entities/upsert',{data:rows.slice(offset,offset+100).map(row=>({...row,target:'knowledge_entry'}))});
  };
  await upsertRows(smallRows.map(row=>({...row,vector:cosineVector(smallVector,
    row.object_id===smallGhost.id?0.98:row.object_id===smallFatal.id?0.9:0.7)})));
  await upsertRows(raceRows.map(row=>({...row,vector:cosineVector(raceVector,
    row.object_id===raceTarget.id?0.7:row.entry_id.startsWith('overlap-')?0.98
      :row.entry_id.startsWith('dense-')?0.9:row.entry_id.startsWith('tail-')?0.5:0.3)})));
  await upsertRows(roundRows.map(row=>({...row,vector:cosineVector(roundVector,
    row.object_id===roundGhost.id?0.98:0.7)})));
  h.sql(`UPDATE knowledge_objects SET version=2 WHERE id IN ('${smallGhost.id}','${raceGhost.id}','${roundGhost.id}');
    INSERT INTO knowledge_revisions(object_id,version,archived_body) SELECT object_id,2,body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows
      WHERE version=1 AND object_id IN ('${smallGhost.id}','${raceGhost.id}','${roundGhost.id}');
    UPDATE knowledge_objects SET version=3 WHERE id='adv-source-doc';
    INSERT INTO knowledge_revisions(object_id,version,archived_body) SELECT object_id,3,body FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows
      WHERE object_id='adv-source-doc' AND version=2`);

  // 原B只证明读满30即停；这里须确实读失败两次后，继续同一offset并补读第3次。
  phase = 'small-body-failure';
  const small = await search(smallQuery,1,{related_object_id:smallGhost.id});
  const smallRequests = requests.filter(request=>request.phase===phase);
  const smallReads = ownerReads.filter(event=>event.phase===phase);
  observations.smallBodyFailure = {objects:small.objects.map(value=>value.id),coverage:small.search_coverage,
    requests:smallRequests,ownerReads:smallReads};
  assert.deepEqual(small.objects.map(value=>value.id),[smallTarget.id]);
  assert.ok(small.objects[0].entries.some(value=>value.effective_value===smallText),'后页须交付实际owner正文');
  assert.equal(smallReads.length,3,'两次正文失效仍占名额，只再启动一次合法正文读取');
  assert.equal(smallReads.filter(event=>event.owners.includes(smallFatal.id)).length,2,
    '失效须在owner正文核验发生，不能由元信息排除冒充');
  assert.equal(smallReads.filter(event=>event.owners.includes(smallTarget.id)).length,1);
  assert.deepEqual(smallRequests.filter(request=>request.channel==='vector').map(request=>[request.offset,request.limit,request.ids.length]),
    [[0,50,50],[50,200,1]],'仅花两次正文名额后仍沿真实第51条补取');
  assert.ok(smallRequests.filter(request=>request.channel==='sparse').length>0);
  assert.ok(smallRequests.filter(request=>request.channel==='sparse').every(request=>request.status===200 && request.code===0 && request.ids.length===0));
  assert.equal(small.search_coverage.candidate_count,51,'元信息失效与正文失效已收身份均不退款');
  assert.equal(small.search_coverage.channels.dense.rounds,2);
  assert.equal(fallbackReads.filter(event=>event.phase===phase).length,0,'成功空不加SQL后备票');
  assert.equal(auditBudget(phase).unique,51);
  checks.push('少量正文失败：48元信息失效+2正文失效后按offset50补取，第三次正文窄读及最终保存回执交付合法正文');

  for (const mode of ['duplicate','failure']) {
    phase = 'last100-'+mode;
    // 预检只核真实索引排名，不经过应用代理，不计入应用候选账本。
    // sparse前450与dense前450必须互斥，sparse后100必须已见，target须为dense第451。
    const filter = 'target == "knowledge_entry" && object_id in '+JSON.stringify([raceGhost.id,raceTarget.id]);
    const sparseProbe = await milvus('entities/search',{annsField:'sparse',data:[raceQuery],filter,
      outputFields:['id','object_id','entry_id'],offset:0,limit:550,consistencyLevel:'Strong'});
    const denseProbe = await milvus('entities/search',{annsField:'vector',data:[raceVector],filter,
      outputFields:['id','object_id','entry_id'],offset:0,limit:550,consistencyLevel:'Strong'});
    observations.last100Setup = {sparseProbe,denseProbe};
    assert.equal(sparseProbe.length,550,'真实BM25须有550条，不能伪造搜索响应');
    assert.equal(denseProbe.length,550);
    assert.ok(sparseProbe.slice(0,450).every(row=>row.entry_id.startsWith('lex-')));
    assert.ok(sparseProbe.slice(450).every(row=>row.entry_id.startsWith('overlap-')));
    assert.ok(denseProbe.slice(0,450).every(row=>/^(overlap|dense)-/.test(row.entry_id)));
    assert.equal(new Set([...sparseProbe.slice(0,450),...denseProbe.slice(0,450)].map(row=>row.id)).size,900);
    assert.equal(denseProbe[450].object_id,raceTarget.id,'合法项须在dense第四页，不能首轮提前交付');
    const denseFirst450 = new Set(denseProbe.slice(0,450).map(row=>row.id));
    assert.ok(sparseProbe.slice(450).every(row=>denseFirst450.has(row.id)));
    race = {mode,denseFirst:gate('dense实际首派'),lexicalThird:gate('词法第三轮'),lastReservation:gate('最后100已预留'),
      releaseLast:gate('最后100放行'),ownerYield:gate('owner本轮派发后已让出')};
    const currentRace = race;
    const pending = search(raceQuery,1,{related_object_id:raceGhost.id});
    // 立刻接失败分支，防止门闩诊断期间形成未处理拒绝；finally再接回同一次搜索。
    const settled = pending.then(data=>({data}),error=>({error}));
    let result;
    try {
      await currentRace.lastReservation.wait();
      await currentRace.ownerYield.wait();
      const active = requests.filter(request=>request.phase===phase);
      const beforeLast = wireEvents.filter(event=>event.request.phase===phase
        && event.kind==='complete' && event.request.offset<450);
      const seenBeforeLast = new Set(beforeLast.flatMap(event=>event.request.ids));
      assert.equal(seenBeforeLast.size,900,'争额前真实两路各450个互斥已收身份');
      assert.equal(active.filter(request=>request.offset===450).length,1,
        '最后100被词法占住且owner已让出时，dense不得超领并发派发');
      assert.equal(currentRace.heldEvent.limit,100,'请求前实际仅分配最后100');
      currentRace.releaseLast.release();
      const completed = await settled;
      if (completed.error) throw completed.error;
      result = completed.data;
    } finally {
      currentRace.denseFirst.release();
      currentRace.lexicalThird.release();
      currentRace.releaseLast.release();
      await settled;
      race = undefined;
    }
    const raceRequests = requests.filter(request=>request.phase===phase);
    const held = currentRace.heldEvent;
    const resumedDense = raceRequests.find(request=>request.channel==='vector' && request.offset===450);
    const audit = auditBudget(phase);
    const raceReads = ownerReads.filter(event=>event.phase===phase);
    observations['last100'+mode] = {objects:result.objects.map(value=>value.id),coverage:result.search_coverage,
      requests:raceRequests,ledger:audit.ledger,ownerYieldAt:currentRace.ownerYieldAt,ownerReads:raceReads};
    assert.ok(resumedDense,'失败/重复释放后，曾未派发的dense须沿原轮继续');
    assert.ok(wireEvents.indexOf(wireEvents.find(event=>event.kind==='complete' && event.request===held))
      < wireEvents.indexOf(wireEvents.find(event=>event.kind==='dispatch' && event.request===resumedDense)),
      'dense须在最后100释放后派发');
    assert.equal(resumedDense.limit,100,'释放预留后继续使用真实剩余100，不另开上限');
    assert.equal(held.offset,450);
    assert.equal(held.limit,100);
    if (mode==='duplicate') {
      assert.equal(held.ids.length,100,'重复页也必须来自真实Milvus');
      assert.ok(audit.ledger.some(event=>event.kind==='complete' && event.channel==='sparse'
        && event.offset===450 && event.newUnique===0 && event.unique===900),'100个重复身份全释放未用预留');
    } else {
      assert.equal(held.status,503);
      assert.equal(held.injected,true);
      assert.ok(audit.ledger.some(event=>event.kind==='complete' && event.channel==='sparse'
        && event.offset===450 && event.newUnique===0 && event.unique===900),'失败页释放100且已收失效900不退款');
    }
    assert.deepEqual(result.objects.map(value=>value.id),[raceTarget.id]);
    assert.ok(result.objects[0].entries.some(value=>value.effective_value===raceText));
    assert.equal(audit.unique,1000,'最终1000来自真实已收唯一身份');
    assert.equal(result.search_coverage.candidate_count,audit.unique,'响应计数须与独立事件账本一致');
    assert.equal(result.search_coverage.channels.lexical.rounds,4);
    assert.equal(result.search_coverage.channels.dense.rounds,4,'释放后补派仍属共同第四轮');
    assert.equal(raceReads.length,1,'1100失效entry由单owner元信息排除，不耗正文名额');
    assert.deepEqual(raceReads[0].owners,[raceTarget.id]);
    assert.equal(fallbackReads.filter(event=>event.phase===phase).length,0,'词法已有成功页，后页故障不启SQL');
    checks.push('最后100/'+mode+'：真实900已收+100预留到界，'+(mode==='duplicate'?'重复':'失败')
      +'释放后dense第四轮继续，逐事件唯一+在途≤1000且正式回执保存合法正文');
  }

  phase = 'fifth-round-stop';
  const roundResult = await search(roundQuery,1,{related_object_id:roundGhost.id});
  const roundRequests = requests.filter(request=>request.phase===phase);
  const roundAudit = auditBudget(phase);
  observations.fifthRound = {objects:roundResult.objects.map(value=>value.id),coverage:roundResult.search_coverage,
    requests:roundRequests,ledger:roundAudit.ledger,ownerReads:ownerReads.filter(event=>event.phase===phase)};
  const densePages = roundRequests.filter(request=>request.channel==='vector');
  assert.deepEqual(densePages.map(request=>[request.offset,request.limit,request.ids.length]),
    [[0,50,50],[50,200,200],[250,200,200],[450,200,200],[650,200,200]],
    '真实派发五轮含首批，第六轮offset850不能发出');
  assert.ok(roundRequests.filter(request=>request.channel==='sparse').length>0);
  assert.ok(roundRequests.filter(request=>request.channel==='sparse').every(request=>request.status===200 && request.code===0 && request.ids.length===0));
  assert.equal(roundAudit.unique,850,'850<1000，停止原因不能偷换成候选已满');
  assert.equal(roundResult.search_coverage.candidate_count,850);
  assert.equal(roundResult.search_coverage.channels.dense.rounds,5,'未派发第六轮不能计入报告');
  assert.equal(roundResult.search_coverage.channels.lexical.rounds,1,'成功空通道不借深度空计轮');
  assert.equal(roundResult.search_coverage.channels.dense.exhausted,false);
  assert.equal(roundResult.search_coverage.channels.dense.uncovered,'candidate_limit');
  assert.equal(roundResult.search_coverage.state,'candidate_limit');
  assert.equal(roundResult.objects.length,0,'第六页合法项不得越第五轮读取交付');
  assert.equal(ownerReads.filter(event=>event.phase===phase).length,0,'五轮元信息失效不消耗正文名额');
  assert.equal(fallbackReads.filter(event=>event.phase===phase).length,0);
  const beyond = await milvus('entities/search',{annsField:'vector',data:[roundVector],
    filter:'target == "knowledge_entry" && object_id in '+JSON.stringify([roundGhost.id,roundTarget.id]),
    offset:850,limit:1,outputFields:['id','object_id','entry_id'],consistencyLevel:'Strong'});
  assert.equal(beyond.length,1);
  assert.equal(beyond[0].object_id,roundTarget.id,'真实后端仍有合法第851项，不是已耗尽');
  assert.ok(!densePages.some(request=>request.ids.includes(beyond[0].id)));
  phase = 'sixth-target-positive-control';
  const positive = await search(roundQuery,1,{related_object_id:roundTarget.id});
  assert.deepEqual(positive.objects.map(value=>value.id),[roundTarget.id],'同一正式工具独立窄范围正控须能回源交付');
  assert.ok(positive.objects[0].entries.some(value=>value.effective_value.includes('sixthroundforbidden')));
  observations.fifthRound.positiveControl = {objects:positive.objects.map(value=>value.id),coverage:positive.search_coverage};
  checks.push('第五轮真实停止：dense五次50+200×4=850，后端第851项有效但不发第六轮、不读正文，独立正式工具正控可交付');
  assert.deepEqual(proxyErrors,[],'代理门闩/真实Milvus故障必须明确失败，不能当成产品通过');

  passed = true;
  console.log(JSON.stringify({passed, checks, observations, officialRequests: 0}));
} finally {
  if (run) h.releaseRun(run.run_id);
  observations.trace = {phase,requests,ownerReads,fallbackReads,proxyErrors};
  await writeFile('.local/checks/retrieval-deep-advance.json',
    JSON.stringify({passed, checks, observations, officialRequests: 0}, null, 2));
  await h.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve=>sqlProxy.close(resolve));
  proxy.closeAllConnections();
  await new Promise(resolve=>proxy.close(resolve));
  await provider.close();
}
