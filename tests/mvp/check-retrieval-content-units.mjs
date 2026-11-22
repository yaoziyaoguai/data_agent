import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

const traffic = {bytes: 0};
const sockets = new Set();
const proxy = net.createServer(socket => {
  const upstream = net.connect(13306, '127.0.0.1');
  for (const connection of [socket, upstream]) {
    sockets.add(connection);
    connection.on('error', () => {});
    connection.on('close', () => sockets.delete(connection));
  }
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  socket.pipe(upstream);
  upstream.on('data', bytes => {traffic.bytes += bytes.length; socket.write(bytes);});
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const checks = [];
const observations = {};
let passed = false;
let h, run;
try {
  h = await harness({capture: true, startWorker: false,
    onDatabaseUrl: url => url.replace('@127.0.0.1:13306/', '@127.0.0.1:'+proxy.address().port+'/'),
    env: {DATA_AGENT_LEASE_MS: '120000'}});
  const created = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'metric',
    name: '内容定位合成资料', body: '初始化', source_url: null, related_ids: []});
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const object = created.value;
  const text = '背景🌏。'.repeat(20_000)+'只有 narunitneedle 的内容应定点交付。'+'附录记录。'.repeat(20_000);
  const entry = object.entries[0];
  entry.effective_value = text;
  entry.suggestion = {};
  entry.human_override = null;
  entry.source_facts = {value: text, complete: false, gap: '合成定位资料'};
  const encoded = Buffer.from(JSON.stringify(object)).toString('hex');
  h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${object.id}';
    UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}';
    UPDATE retrieval_documents SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}'`);
  await h.resumeWorker();
  run = await h.capture(await h.create(), '核对合成资料中的定位文字');
  await h.pauseWorker();
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  const invoke = async (name, args) => {
    const input = {run_id:run.run_id, lease_epoch:run.lease_epoch, sdk_tool_call_id:randomUUID(),
      tool_name:name, arguments:args,
      checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
    assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
    const reply = await h.internal('/internal/data/tools',input);
    assert.equal(reply.status,200,JSON.stringify(reply.value));
    return reply.value.data;
  };
  const read = async (ref, {statement_id, offset, limit} = {}) => {
    const reply = await invoke('read_knowledge',{items:[{kind:'knowledge',ref,statement_id,offset,limit}]});
    assert.equal(reply.items[0].state,'ok');
    return reply.items[0];
  };
  const missStart = traffic.bytes;
  assert.equal((await invoke('search_knowledge',{query:'zzunitmiss',limit:1})).hits.length,0);
  const missBytes = traffic.bytes-missStart;
  const hitStart = traffic.bytes;
  const hit = await invoke('search_knowledge',{query:'narunitneedle',limit:1});
  const hitBytes = traffic.bytes-hitStart;
  assert.deepEqual(hit.hits.map(value=>value.ref.object_id),[object.id]);
  const excerpt = hit.hits[0], length = [...excerpt.definition].length;
  const offset = excerpt.continuation.content_next_offset - length;
  assert.ok(excerpt.definition.includes('narunitneedle'));
  assert.ok(offset > 70_000,'窗口必须保留原 Unicode 坐标');
  assert.equal(excerpt.definition,[...text].slice(offset,offset+length).join(''));
  observations.hugeEntry = {missBytes,hitBytes,delta:hitBytes-missBytes,chars:[...text].length,offset,length};
  assert.ok(hitBytes-missBytes < 50_000,
    '单个巨大命中 entry 只读所选窗口，不能传整条正文：'+JSON.stringify(observations.hugeEntry));
  const reread = await read(excerpt.ref,{offset,limit:length});
  assert.equal(reread.content,excerpt.definition,'同版 entry/offset 必须能补读相同正文');
  assert.equal(reread.content_page.total_chars,[...text].length);
  checks.push('巨大命中entry只下行定点窗口，保留原总长度和Unicode坐标，正式工具同版补读一致');

  // 第二个条目的第二条陈述只交付自己的正文和范围，通过 statement_id 精读。
  const statementObject = structuredClone(object);
  statementObject.id = 'statement-location-fixture';
  statementObject.name = '非首陈述合成资料';
  const firstStatement = '陈述背景🌏。'.repeat(151);
  const selectedText = 'stunitneedle：停用后的设备不得继续计入有效设备数。';
  const selectedScope = '仅适用已完成复核的合成设备。';
  const statementText = selectedText+'\n'+selectedScope;
  const rendered = firstStatement+'\n\n'+statementText;
  const statement = (statementId, text, scopeText) => ({statement_id:statementId,
    object_ref:{object_id:statementObject.id,version:'1',path:'rules'},
    text,scope_text:scopeText,origin:'model_inference',citations:[],supports:[]});
  statementObject.entries = [
    {...structuredClone(entry),effective_value:'无关目录',source_facts:{complete:false,gap:'合成资料'},suggestion:{}},
    {entry_id:'rules',path:'rules',label:'规则',effective_value:rendered,
      source_facts:{complete:false,gap:'合成资料'},
      suggestion:{value:rendered,statements:[statement('earlier-statement',firstStatement,''),
        statement('selected-statement',selectedText,selectedScope)]},
      human_override:null,review_state:'unverified'}];
  const statementHex = Buffer.from(JSON.stringify(statementObject)).toString('hex');
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
      VALUES('${statementObject.id}','demo','metric','非首陈述合成资料',1,'enabled',CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${statementObject.id}',1,CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${statementObject.id}','demo',1,CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON));
    INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
      SELECT '${statementObject.id}',1,JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.statement_id')),'demo','rules','model_suggestion',s.value
      FROM JSON_TABLE(CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON),'$.entries[1].suggestion.statements[*]' COLUMNS(value JSON PATH '$')) s`);
  const statementHit = await invoke('search_knowledge',{query:'stunitneedle',limit:3});
  assert.deepEqual(statementHit.hits.map(value=>[value.ref.object_id,value.statement_id]),
    [[statementObject.id,'selected-statement']],'来自两个检索通道的同一规范陈述只交付一次');
  const selectedExcerpt = statementHit.hits[0];
  observations.nonFirstStatement = {excerpt:selectedExcerpt};
  assert.equal(selectedExcerpt.ref.path,'rules');
  assert.equal(selectedExcerpt.definition,selectedText,'不得携带前一条陈述或临时制造窗口');
  assert.equal(selectedExcerpt.scope_text,selectedScope);
  const statementReread = await read(selectedExcerpt.ref,{statement_id:selectedExcerpt.statement_id});
  assert.equal(statementReread.content,statementText);
  checks.push('非首entry的非首statement独立定点读取，正文与范围各自保留，按原版本和陈述ID精读，跨通道不重复');

  const multiEntry = structuredClone(statementObject);
  multiEntry.id='multi-entry-location-fixture';multiEntry.name='多条目合成资料';
  multiEntry.entries=['first','second','third'].map((entryId,i)=>({entry_id:entryId,path:entryId,
    label:'规则'+i,effective_value:'manyunitneedle 合成规则 '+entryId,
    source_facts:{complete:false,gap:'合成资料'},suggestion:{},human_override:null,review_state:'unverified'}));
  const multiHex=Buffer.from(JSON.stringify(multiEntry)).toString('hex');
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
      VALUES('${multiEntry.id}','demo','metric','多条目合成资料',1,'enabled',CAST(CONVERT(0x${multiHex} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${multiEntry.id}',1,CAST(CONVERT(0x${multiHex} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${multiEntry.id}','demo',1,CAST(CONVERT(0x${multiHex} USING utf8mb4) AS JSON))`);
  const multiHit=await invoke('search_knowledge',{query:'manyunitneedle',limit:3});
  observations.multiEntry={hits:multiHit.hits.map(hit=>hit.ref)};
  assert.deepEqual(multiHit.hits.map(hit=>hit.ref.object_id),Array(3).fill(multiEntry.id));
  assert.deepEqual(multiHit.hits.map(hit=>hit.ref.path).sort(),['first','second','third']);
  checks.push('同一个对象的三个同词entry分别交付规范内容，一条不丢且不重复');

  // 同一个entry的两个规范窗口分别读回，末端聚合不能只留下第一处正文。
  const windowsObject=structuredClone(multiEntry);
  windowsObject.id='same-entry-windows-fixture';windowsObject.name='同条目多窗口合成资料';
  const firstRule='sameworkunitneedle 规则甲🧪。',secondRule='sameworkunitneedle 规则乙🌏。';
  const windowsText='甲'.repeat(90)+firstRule+'乙'.repeat(390-90-[...firstRule].length)+secondRule+'丙'.repeat(300);
  windowsObject.entries=[{...structuredClone(multiEntry.entries[0]),entry_id:'rules',path:'rules',effective_value:windowsText}];
  const windowsHex=Buffer.from(JSON.stringify(windowsObject)).toString('hex');
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
      VALUES('${windowsObject.id}','demo','metric','同条目多窗口合成资料',1,'enabled',CAST(CONVERT(0x${windowsHex} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${windowsObject.id}',1,CAST(CONVERT(0x${windowsHex} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${windowsObject.id}','demo',1,CAST(CONVERT(0x${windowsHex} USING utf8mb4) AS JSON))`);
  const windowsHit=await invoke('search_knowledge',{query:'sameworkunitneedle',limit:2});
  assert.deepEqual(windowsHit.hits.map(hit=>hit.ref),Array(2).fill({object_id:windowsObject.id,version:'1',path:'rules'}));
  const windowsExcerpts=windowsHit.hits.map(hit=>({hit,
    offset:hit.continuation.content_next_offset-[...hit.definition].length})).sort((a,b)=>a.offset-b.offset);
  assert.deepEqual(windowsExcerpts.map(item=>item.offset),[0,280],'两个规范窗口保留各自的原坐标');
  for(const {hit,offset} of windowsExcerpts){
    assert.equal(hit.definition,[...windowsText].slice(offset,offset+360).join(''));
    const reread=await read(hit.ref,{offset,limit:[...hit.definition].length});
    assert.equal(reread.content,hit.definition);
    assert.equal(reread.content_page.total_chars,[...windowsText].length);
  }
  assert.ok(windowsExcerpts[0].hit.definition.includes(firstRule));
  assert.ok(windowsExcerpts[1].hit.definition.includes(secondRule));
  observations.sameEntryWindows={excerpts:windowsExcerpts};
  checks.push('同一entry两处规范窗口独立交付，按原Unicode坐标和版本精读都逐字一致');
  const ownerEnv={...h.env};
  for(const name of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL',
    'DATA_AGENT_MODEL_PROFILE','DATA_AGENT_MODEL_FAULT','DATABASE_URL'])delete ownerEnv[name];
  let ownerOutput='';
  const ownerCode=await new Promise((resolve,reject)=>{
    const child=spawn(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent',
      '--test','knowledge_dependencies','selected_content_','--','--test-threads=1'],
      {env:ownerEnv,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{ownerOutput+=chunk;process.stdout.write(chunk);});
    child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.once('error',reject);child.once('close',resolve);
  });
  assert.equal(ownerCode,0);
  assert.match(ownerOutput,/test result: ok\. 2 passed; 0 failed/);
  checks.push('正式owner拒绝原record指向另一窗口，保合法子窗口；适用陈述定位缺字段可恢复，text/scope及支持依赖不丢失');
  passed = true;
  console.log(JSON.stringify({passed,checks,observations,officialRequests:0}));
} finally {
  if (run) h.releaseRun(run.run_id);
  if (h) await h.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve=>proxy.close(resolve));
  await writeFile('.local/checks/retrieval-content-units.json',JSON.stringify({passed,checks,observations,officialRequests:0},null,2));
}
