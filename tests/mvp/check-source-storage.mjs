import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {harness} from './harness.mjs';
import {synchronizeSources} from './source-sync.mjs';

// 合成平台只提供完整资料；保存、分页、版本和回源经过真实 API、Worker 与 MySQL。
const sourceLimit = 8 * 1024 * 1024;
const caseIndex = process.argv.indexOf('--case');
const selected = caseIndex<0?'all':process.argv[caseIndex+1];
assert.ok(['all','representation','boundary','pages'].includes(selected),'--case accepts representation, boundary or pages');
const reportPath = '.local/checks/source-storage'+(selected==='all'?'':'-'+selected)+'.json';
const digest = text => createHash('sha256').update(text).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const column = (name, comment) => ({id:name,name,data_type:'INTEGER',nullable:false,comment});
const table = (id, columns = [column('event_id','模拟语音链路事件标识'), column('latency_ms','模拟链路耗时，单位毫秒')]) => ({
  id,name:id,platform_version:'1',maintainer_id:'alice',
  comment:'完全虚构的数字座舱语音链路；每行表示一条模拟事件，不含原始音频或真实业务资料。',
  ddl:`CREATE TABLE ${id} (${columns.map(field => field.name+' INTEGER NOT NULL').join(', ')});`,
  columns,
  node:{id:'load_'+id,sql:`INSERT INTO ${id} (${columns.map(field => field.name).join(', ')}) SELECT ${columns.map(field => field.name).join(', ')} FROM synthetic_voice_probe;`,upstream_ids:['synthetic_voice_probe']},
});
const sizedTable = (id, expectedBytes) => {
  const value = table(id);
  const explanation = '合成语音链路容量验证：耗时来自仿真测量，单位为毫秒，不含录音，不推导真实用户行为。';
  value.node.sql += '\n/* 完整装载说明：';
  const ending = '\n合成装载说明结束；完整SQL尾部保留。 */';
  value.node.sql += ending;
  const remaining = expectedBytes - bytes(value);
  assert.ok(remaining > 0);
  const repetitions = Math.floor(remaining / Buffer.byteLength(explanation));
  const residual = remaining % Buffer.byteLength(explanation);
  const padding = explanation.repeat(repetitions)+'中'.repeat(Math.floor(residual / 3))+'x'.repeat(residual % 3);
  value.node.sql = value.node.sql.slice(0,-ending.length)+padding+ending;
  assert.equal(bytes(value),expectedBytes,'来源大小按紧凑JSON的UTF-8字节计算');
  assert.ok(value.node.sql.length < Buffer.byteLength(value.node.sql),'中文字符不能按字节数代替');
  return value;
};

const h = await harness({capture:true,startWorker:false,startupTimeout:60000});
const checks = [];
let server, serverError, primaryError, passed = false, stage = 'startup';
const cleanupErrors = [];
const report = () => ({passed,case:selected,stage,checks,officialRequests:0,
  database:new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1),
  error:primaryError?.message ?? null,cleanupErrors,
  evidence:'real API, Worker and MySQL; synthetic platform; no model calls'});
const markStage = async value => {
  stage=value;
  await writeFile(reportPath,JSON.stringify(report(),null,2));
  console.log(JSON.stringify({stage,completedChecks:checks.length}));
};
const ok = response => {
  assert.equal(response.status,200,'读取应成功；失败时不打印可能很大的正文');
  return response.value;
};
const synchronize = async (tables, namespace) => {
  await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:namespace,authoritative:true,tables}));
  return ok(await synchronizeSources(h));
};
const completed = progress => assert.equal(progress.status,'completed',JSON.stringify(progress));
const sourceState = source => h.sql(`SELECT JSON_OBJECT(
  'revision',c.revision,'head_revision',s.version,'body_bytes',OCTET_LENGTH(c.body),'body_sha256',SHA2(c.body,256),
  'sql_bytes',OCTET_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(c.metadata,'$.node.sql'))),
  'sql_sha256',SHA2(JSON_UNQUOTE(JSON_EXTRACT(c.metadata,'$.node.sql')),256),
  'columns',JSON_LENGTH(c.metadata,'$.columns'),
  'object_versions',(SELECT SUM(version) FROM knowledge_objects WHERE source_id=c.source_id),
  'pending_jobs',(SELECT COUNT(*) FROM background_jobs WHERE resource_id=c.source_id)
  ) FROM source_current c JOIN source_heads s ON s.id=c.source_id WHERE c.source_id='${source}'`)[0];
const verifyStored = async (expected, namespace) => {
  const identities = h.sql(`SELECT JSON_OBJECT('source',source_id) FROM source_current WHERE namespace='${namespace}' AND external_id='${expected.id}'`);
  assert.equal(identities.length,1);
  const source = identities[0].source;
  assert.match(source,/^catalog-[a-f0-9]+$/);
  await markStage(expected.id+': storage lengths and hashes');
  const state = sourceState(source);
  assert.equal(state.revision,1);
  assert.equal(state.head_revision,1);
  assert.equal(state.columns,expected.columns.length);
  assert.equal(state.sql_bytes,Buffer.byteLength(expected.node.sql));
  assert.equal(state.sql_sha256,digest(expected.node.sql),'数据库中的完整SQL必须与独立输入一致');
  await markStage(expected.id+': full source API readback');
  const body = ok(await h.request('/sources/'+source));
  assert.equal(body.version,'1');
  assert.equal(body.complete,true);
  assert.equal(Buffer.byteLength(body.body),state.body_bytes);
  assert.equal(digest(body.body),state.body_sha256,'HTTP回源正文与实际持久化内容一致');
  assert.ok(body.body.includes(expected.node.sql),'原文必须包含完整SQL，不能只存前缀');
  assert.ok(body.body.includes(expected.ddl),'原文必须包含完整DDL');
  await markStage(expected.id+': tail field and SQL excerpt');
  const objects = h.sql(`SELECT JSON_OBJECT('id',id,'kind',kind,'name',JSON_UNQUOTE(JSON_EXTRACT(body,'$.name'))) FROM knowledge_objects WHERE source_id='${source}' ORDER BY id`);
  assert.equal(objects.filter(object => object.kind==='table').length,1);
  assert.equal(objects.filter(object => object.kind==='field').length,expected.columns.length);
  const finalField = expected.columns.at(-1);
  const fieldId = objects.find(object => object.kind==='field' && object.name===expected.name+'.'+finalField.name)?.id;
  assert.ok(fieldId,'末尾字段必须成为正式对象');
  const field = ok(await h.request('/knowledge/'+fieldId));
  assert.equal(field.name,expected.name+'.'+finalField.name);
  assert.equal(field.source_version,'1');
  assert.ok(field.entries.some(entry => entry.source_facts.quote.includes(finalField.comment)),'末尾字段说明完整回读');
  // 定点回读只交付尾部证据，不能为了验证尾部而再次返回完整大正文。
  const tail = expected.node.sql.slice(-80);
  const position = body.body.lastIndexOf(tail);
  assert.ok(position>=0);
  const offset = Array.from(body.body.slice(0,position)).length;
  const excerpt = ok(await h.request(`/sources/${source}?version=1&offset=${offset}&length=${Array.from(tail).length}`));
  assert.equal(digest(excerpt.content),digest(tail));
  assert.equal(excerpt.citation.revision,'1');
  assert.equal(excerpt.citation.locator.offset,offset);
  return {source,state,objectIds:objects.map(object=>object.id).sort()};
};

try {
  if(selected==='all'||selected==='representation') {
  const fields = [column('event_id','模拟语音链路事件标识'), ...Array.from({length:200},(_,index)=>column('latency_probe_'+String(index+1).padStart(3,'0'),'离线仿真测量点'+(index+1)+'的分段耗时，单位毫秒'))];
  const wide = table('voice_latency_profile',fields);
  wide.node.sql += '\n/* '+ '每个分段耗时独立保存，不将分段次数当作事件数。'.repeat(2200)+' 宽表SQL尾部完整。 */';
  assert.ok(Array.from(wide.node.sql).length>40000);
  await markStage('representative: synchronize wide table and complete SQL');
  const representative = await synchronize([wide],'synthetic-voice-storage');
  completed(representative);
  assert.equal(representative.processed_sources,1);
  await verifyStored(wide,'synthetic-voice-storage');
  checks.push({name:'201字段及超过40000字符的有效生产SQL完整保存，末尾字段、DDL和SQL原文均能回读',fields:wide.columns.length,sqlCharacters:Array.from(wide.node.sql).length,sourceBytes:bytes(wide)});
  }

  if(selected==='all'||selected==='boundary') {
  const boundary = sizedTable('voice_large_definition',sourceLimit);
  await markStage('byte boundary: synchronize exact 8 MiB');
  const limitProgress = await synchronize([boundary],'synthetic-voice-byte-limit');
  completed(limitProgress);
  const retained = await verifyStored(boundary,'synthetic-voice-byte-limit');
  assert.equal(limitProgress.processed_sources,1);
  checks.push({name:'中文UTF-8完整来源精确8MiB可经过平台、API、Worker、MySQL保存并完整回源',sourceBytes:bytes(boundary),storedBodyBytes:retained.state.body_bytes,sqlSha256:retained.state.sql_sha256});

  const oversized = structuredClone(boundary);
  oversized.platform_version='2';
  oversized.node.sql=oversized.node.sql.replace(' */','! */');
  assert.equal(bytes(oversized),sourceLimit+1);
  await markStage('byte overflow: reject one additional byte');
  const refused = await synchronize([oversized],'synthetic-voice-byte-limit');
  assert.equal(refused.status,'failed',JSON.stringify(refused));
  assert.equal(refused.error_code,'payload_limit');
  assert.equal(refused.processed_sources,0);
  assert.equal(refused.pages_committed,0);
  await markStage('byte overflow: verify retained revisions and storage hashes');
  assert.deepEqual(sourceState(retained.source),retained.state,'超限不能推进修订、覆盖正文或增加该来源待办');
  await markStage('byte overflow: verify retained source through API');
  const current = ok(await h.request('/sources/'+retained.source));
  assert.equal(current.version,'1');
  assert.equal(digest(current.body),retained.state.body_sha256);
  checks.push({name:'同来源多1字节明确失败；不截断、不推进内容及知识修订、不覆盖旧正文',sourceBytes:bytes(oversized),errorCode:refused.error_code});
  }

  if(selected==='all'||selected==='pages') {
  // 平台按完整对象分成101页；这是可控的合成分页接口，实际保存与游标仍由产品执行。
  const namespace='synthetic-voice-many-pages';
  const tables=Array.from({length:101},(_,index)=>table('voice_page_'+String(index).padStart(3,'0')));
  const requested=[];
  await markStage('pagination: synchronize 101 complete pages');
  await h.pausePlatform();
  server=createServer(async(request,response)=>{
    try {
      assert.ok(request.headers.authorization==='Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'平台调用必须携带认证');
      let raw='';for await(const chunk of request)raw+=chunk;
      const input=JSON.parse(raw);
      const pageNumber=input.cursor===null||input.cursor===undefined?0:Number(input.cursor);
      assert.ok(Number.isInteger(pageNumber)&&pageNumber>=0&&pageNumber<tables.length);
      if(pageNumber>0)assert.equal(input.snapshot_id,'voice-many-pages');
      requested.push(pageNumber);
      const next=pageNumber+1<tables.length?String(pageNumber+1):null;
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({schema_version:1,source_namespace:namespace,snapshot_id:'voice-many-pages',authoritative:true,tables:[tables[pageNumber]],next_cursor:next,complete:next===null}));
    } catch(error) {
      serverError=error;
      response.writeHead(500,{'content-type':'application/json'});response.end('{"code":"synthetic_platform_failure"}');
    }
  });
  await new Promise(resolve=>server.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',resolve));
  const paged=ok(await synchronizeSources(h));
  if(serverError)throw serverError;
  completed(paged);
  assert.equal(paged.pages_committed,101);
  assert.equal(paged.processed_sources,101);
  assert.deepEqual(requested,Array.from({length:101},(_,index)=>index),'每页依次保存，不在第100页提前结束');
  const members=h.sql(`SELECT JSON_OBJECT('id',platform_table_id,'revision',accepted_revision,'objects',JSON_LENGTH(retained_objects),'maintainers',JSON_LENGTH(pending_maintainers)) FROM catalog_sync_members WHERE sync_id='${paged.sync_id}' ORDER BY platform_table_id`);
  assert.deepEqual(members,tables.map(value=>({id:value.id,revision:1,objects:3,maintainers:1})));
  const counts=h.sql(`SELECT JSON_OBJECT('sources',COUNT(DISTINCT c.source_id),'tables',SUM(k.kind='table'),'fields',SUM(k.kind='field'),'enabled',SUM(k.state='enabled')) FROM source_current c JOIN knowledge_objects k ON k.source_id=c.source_id WHERE c.namespace='${namespace}'`)[0];
  assert.deepEqual(counts,{sources:101,tables:101,fields:202,enabled:303});
  await verifyStored(tables.at(-1),namespace);
  checks.push({name:'101页持续后台同步完整结束，全部成员、表、字段和最后一页来源正确',pages:paged.pages_committed,sources:counts.sources,objects:counts.enabled});
  }
  assert.equal(h.sql('SELECT JSON_OBJECT(\'n\',COUNT(*)) FROM maintenance_model_calls')[0].n,0);
  passed=true;
  stage='completed';
} catch(error) {
  primaryError=error;
} finally {
  // 先保存主失败及已完成切片；数据库不可用造成的清理失败不能覆盖实际验收错误。
  await writeFile(reportPath,JSON.stringify(report(),null,2));
  try {
    server?.closeAllConnections();
    if(server)await new Promise(resolve=>server.close(resolve));
    await h.close();
  } catch(error) {
    cleanupErrors.push(error.message);
    passed=false;
  }
  await writeFile(reportPath,JSON.stringify(report(),null,2));
}
if(primaryError)throw primaryError;
assert.deepEqual(cleanupErrors,[],'测试资源必须完整清理');
console.log(JSON.stringify({passed,case:selected,checks,officialRequests:0}));
