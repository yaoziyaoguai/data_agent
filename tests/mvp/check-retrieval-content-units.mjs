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
    UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}';
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
  const missStart = traffic.bytes;
  assert.equal((await invoke('search_knowledge',{query:'zzunitmiss',limit:1})).objects.length,0);
  const missBytes = traffic.bytes-missStart;
  const hitStart = traffic.bytes;
  const hit = await invoke('search_knowledge',{query:'narunitneedle',limit:1});
  const hitBytes = traffic.bytes-hitStart;
  assert.deepEqual(hit.objects.map(value=>value.id),[object.id]);
  const excerpt = hit.objects[0].retrieval.excerpts[0];
  assert.ok(excerpt.text.includes('narunitneedle'));
  assert.ok(excerpt.offset > 70_000,'窗口必须保留原 Unicode 坐标');
  assert.equal(excerpt.total_chars,[...text].length);
  observations.hugeEntry = {missBytes,hitBytes,delta:hitBytes-missBytes,chars:[...text].length,excerpt};
  assert.ok(hitBytes-missBytes < 50_000,
    '单个巨大命中 entry 只读所选窗口，不能传整条正文：'+JSON.stringify(observations.hugeEntry));
  const reread = await invoke('read_knowledge',{object_id:object.id,version:object.version,
    entry_id:entry.entry_id,offset:excerpt.offset,limit:excerpt.length});
  assert.equal(reread.entries[0].effective_value,excerpt.text,'同版 entry/offset 必须能补读相同正文');
  checks.push('巨大命中entry只下行定点窗口，保留原总长度和Unicode坐标，正式工具同版补读一致');

  // 第二个条目的第二条陈述只交付自身正文；原 entry 坐标仍可用于 v1 同版补读。
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
    INSERT INTO knowledge_versions(object_id,version,body) VALUES('${statementObject.id}',1,CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${statementObject.id}','demo',1,CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON));
    INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
      SELECT '${statementObject.id}',1,JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.statement_id')),'demo','rules','model_suggestion',s.value
      FROM JSON_TABLE(CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON),'$.entries[1].suggestion.statements[*]' COLUMNS(value JSON PATH '$')) s`);
  const statementHit = await invoke('search_knowledge',{query:'stunitneedle',limit:1});
  assert.deepEqual(statementHit.objects.map(value=>value.id),[statementObject.id]);
  const selectedExcerpt = statementHit.objects[0].retrieval.excerpts[0];
  assert.equal(statementHit.search_coverage.candidate_count,1,'当前知识与SQL检索投影的相同statement规范身份只记一次');
  observations.nonFirstStatement = {excerpt:selectedExcerpt,expectedOffset:[...firstStatement].length+2,
    candidateCount:statementHit.search_coverage.candidate_count};
  assert.equal(selectedExcerpt.entry_id,'rules');
  assert.equal(selectedExcerpt.text,statementText,'规范 statement 窗口不能携带前一条陈述或按 query 临时制造窗口');
  assert.equal(selectedExcerpt.offset,[...firstStatement].length+2);
  assert.equal(selectedExcerpt.total_chars,[...rendered].length);
  const statementReread = await invoke('read_knowledge',{object_id:statementObject.id,version:'1',
    entry_id:'rules',offset:selectedExcerpt.offset,limit:selectedExcerpt.length});
  assert.equal(statementReread.entries[0].effective_value,statementText);
  checks.push('非首entry的非首statement独立定点读取，text/scope保留且原ref/offset可补读，SQL两来源规范身份只计一次');

  const multiEntry = structuredClone(statementObject);
  multiEntry.id='multi-entry-location-fixture';multiEntry.name='多条目合成资料';
  multiEntry.entries=['first','second','third'].map((entryId,i)=>({entry_id:entryId,path:entryId,
    label:'规则'+i,effective_value:'manyunitneedle 合成规则 '+entryId,
    source_facts:{complete:false,gap:'合成资料'},suggestion:{},human_override:null,review_state:'unverified'}));
  const multiHex=Buffer.from(JSON.stringify(multiEntry)).toString('hex');
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
      VALUES('${multiEntry.id}','demo','metric','多条目合成资料',1,'enabled',CAST(CONVERT(0x${multiHex} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_versions(object_id,version,body) VALUES('${multiEntry.id}',1,CAST(CONVERT(0x${multiHex} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${multiEntry.id}','demo',1,CAST(CONVERT(0x${multiHex} USING utf8mb4) AS JSON))`);
  const multiHit=await invoke('search_knowledge',{query:'manyunitneedle',limit:3});
  observations.multiEntry={objects:multiHit.objects.map(item=>({id:item.id,entries:item.entries.map(e=>e.entry_id)})),candidateCount:multiHit.search_coverage.candidate_count};
  assert.equal(multiHit.objects.length,1,'v1只在交付末端聚合为一个对象');
  assert.deepEqual(multiHit.objects[0].entries.map(e=>e.entry_id).sort(),['first','second','third']);
  assert.equal(multiHit.search_coverage.candidate_count,3,'三个entry仍是三个规范内容候选');
  checks.push('同对象三个同词entry分别占内容候选，v1末端聚为一个对象且保留三个正文');

  // 同一个entry的两个规范窗口分别读回，末端聚合不能只留下第一处正文。
  const windowsObject=structuredClone(multiEntry);
  windowsObject.id='same-entry-windows-fixture';windowsObject.name='同条目多窗口合成资料';
  const firstRule='sameworkunitneedle 规则甲🧪。',secondRule='sameworkunitneedle 规则乙🌏。';
  const windowsText='甲'.repeat(90)+firstRule+'乙'.repeat(390-90-[...firstRule].length)+secondRule+'丙'.repeat(300);
  windowsObject.entries=[{...structuredClone(multiEntry.entries[0]),entry_id:'rules',path:'rules',effective_value:windowsText}];
  const windowsHex=Buffer.from(JSON.stringify(windowsObject)).toString('hex');
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
      VALUES('${windowsObject.id}','demo','metric','同条目多窗口合成资料',1,'enabled',CAST(CONVERT(0x${windowsHex} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_versions(object_id,version,body) VALUES('${windowsObject.id}',1,CAST(CONVERT(0x${windowsHex} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${windowsObject.id}','demo',1,CAST(CONVERT(0x${windowsHex} USING utf8mb4) AS JSON))`);
  const windowsHit=await invoke('search_knowledge',{query:'sameworkunitneedle',limit:2});
  assert.equal(windowsHit.search_coverage.candidate_count,2,'相交但不相同的知识窗口仍是两个规范候选');
  assert.deepEqual(windowsHit.objects.map(item=>item.id),[windowsObject.id]);
  assert.deepEqual(windowsHit.objects[0].entries.map(item=>item.entry_id),['rules']);
  const windowsExcerpts=windowsHit.objects[0].retrieval.excerpts;
  assert.deepEqual(windowsExcerpts.map(item=>item.offset),[0,280],'共同次序保留两个规范窗口原坐标');
  for(const excerpt of windowsExcerpts){
    assert.equal(excerpt.text,[...windowsText].slice(excerpt.offset,excerpt.offset+360).join(''));
    assert.equal(excerpt.total_chars,[...windowsText].length);
    const reread=await invoke('read_knowledge',{object_id:windowsObject.id,version:'1',entry_id:'rules',offset:excerpt.offset,limit:excerpt.length});
    assert.equal(reread.entries[0].effective_value,excerpt.text);
  }
  assert.ok(windowsExcerpts[0].text.includes(firstRule));
  assert.ok(windowsExcerpts[1].text.includes(secondRule));
  observations.sameEntryWindows={candidateCount:windowsHit.search_coverage.candidate_count,excerpts:windowsExcerpts};
  checks.push('同entry两个规范窗口分别计候选并回源，末端单entry仍保留两处正文与原offset，均可同版补读');
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
