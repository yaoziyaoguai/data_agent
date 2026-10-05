import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';

const h = await harness({capture:true, env:{DATA_AGENT_LEASE_MS:'120000'}});
await h.pauseWorker();
const checks=[];
let passed=false, blocker;
const read=async id => (await h.request('/knowledge/'+id)).value;
const entry=(object,id) => object.entries.find(e=>e.entry_id===id);
const patch=(object,input) => h.request('/knowledge/'+object.id,input,'alice','PATCH');
const command=object=>({operation_id:randomUUID(),expected_version:object.version});
const counts=()=>h.sql("SELECT JSON_OBJECT('objects',(SELECT COUNT(*) FROM knowledge_objects),'versions',(SELECT COUNT(*) FROM knowledge_versions),'operations',(SELECT COUNT(*) FROM knowledge_operations),'assets',(SELECT COUNT(*) FROM personal_assets),'asset_versions',(SELECT COUNT(*) FROM personal_asset_versions),'asset_operations',(SELECT COUNT(*) FROM asset_operations),'queued',(SELECT COUNT(*) FROM prefill_attempts))")[0];
const equalReceipts=responses=>{
  assert.ok(responses.every(r=>r.status===200),JSON.stringify(responses));
  for(const response of responses)assert.deepEqual(response.value,responses[0].value);
  return responses[0].value;
};
const parallel=async fn=>equalReceipts(await Promise.all(Array.from({length:8},fn)));
const hold=async(table,id)=>{
  assert.ok(['knowledge_objects','personal_assets'].includes(table));
  const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();
  assert.match(container,/^[a-f0-9]+$/);
  const database=new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
  assert.match(database,/^data_agent_test_[a-f0-9]+$/);
  blocker=spawn('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--unbuffered','--skip-column-names'],{stdio:['pipe','pipe','pipe']});
  let output='';blocker.stdout.on('data',chunk=>output+=chunk);
  blocker.stdin.write(`USE ${database}; START TRANSACTION; SELECT id FROM ${table} WHERE id='${id}' FOR UPDATE; SELECT 'held';\n`);
  await until(()=>output.includes('held'),'固定对象锁');
  return table=>h.sql(`SELECT JSON_OBJECT('n',COUNT(DISTINCT w.REQUESTING_THREAD_ID)) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA='${database}' AND l.OBJECT_NAME='${table}'`)[0].n;
};
const release=async()=>{
  const child=blocker;blocker=undefined;
  const closed=new Promise(resolve=>child.once('exit',resolve));child.stdin.end('COMMIT;\n');assert.equal(await closed,0);
};
const interleaved=async(table,operationTable,id,invoke)=>{
  const waiting=await hold(table,id);
  const first=invoke();await until(()=>waiting(table)===1,'首请求已持操作身份并等对象');
  const duplicate=invoke();await until(()=>waiting(operationTable)===1,'重传已等原操作身份');
  await release();return equalReceipts(await Promise.all([first,duplicate]));
};
const column={id:'record_id',name:'record_id',data_type:'INTEGER',nullable:false,comment:'合成记录键'};
const table=(version,node)=>({id:'records',name:'replay_records',platform_version:String(version),comment:'合成维护记录表',ddl:'CREATE TABLE replay_records (record_id INTEGER NOT NULL);',columns:[column],node});
const node={id:'load-records',sql:'INSERT INTO replay_records SELECT record_id FROM synthetic_records;',upstream_ids:['synthetic_records']};
const syncCatalog=async value=>{
  await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'maintenance-replay',authoritative:true,tables:[value]}));
  const response=await h.request('/source-syncs',{operation_id:randomUUID()});assert.equal(response.status,200,JSON.stringify(response.value));
};
const modelRead=async object=>{
  await h.resumeWorker();const cid=await h.create();const run=await h.capture(cid,'读取合成维护表的当前来源');await h.pauseWorker();
  const manager=SessionManager.inMemory('/synthetic/data-agent');
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'read_knowledge',arguments:{object_id:object.id,version:object.version},checkpoint:exportCheckpoint(manager)};
  assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
  const current=await h.internal('/internal/data/tools',input);assert.equal(current.status,200,JSON.stringify(current.value));
  assert.equal((await h.request('/conversations/'+cid+'/messages/'+run.message_id+'/withdraw',{operation_id:randomUUID()})).status,200);
  h.releaseRun(run.run_id);return current.value.data;
};

try{
  let before=counts();
  const creation={operation_id:randomUUID(),kind:'document',name:'合成维护文档',body:'本人录入的合成说明',related_ids:[],source_url:null};
  let doc=await parallel(()=>h.request('/knowledge',creation));
  assert.deepEqual(counts(),{...before,objects:before.objects+1,versions:before.versions+1,operations:before.operations+1});
  before=counts();
  const edit={...command(doc),entry_id:'body',value:'合成更新正文'};
  doc=await interleaved('knowledge_objects','knowledge_operations',doc.id,()=>patch(doc,edit));
  assert.equal(doc.version,'2');assert.equal(entry(doc,'body').effective_value,edit.value);
  assert.deepEqual(counts(),{...before,versions:before.versions+1,operations:before.operations+1});
  for(const action of ['disable','enable']){
    before=counts();const input=command(doc);
    doc=await parallel(()=>h.request('/knowledge/'+doc.id+'/'+action,input));
    assert.deepEqual(counts(),{...before,versions:before.versions+1,operations:before.operations+1});
  }
  before=counts();
  assert.equal((await patch(doc,{...edit,value:'同操作异参'})).value.code,'idempotency_conflict');
  assert.equal((await patch(doc,{...edit,operation_id:randomUUID()})).value.code,'version_conflict');
  assert.deepEqual(counts(),before);
  const old=(await h.request('/knowledge/'+doc.id+'?version=1')).value;assert.equal(entry(old,'body').effective_value,creation.body);
  const cleared=await patch(doc,{...command(doc),entry_id:'body',value:'',clear_override:true});assert.equal(cleared.status,200);assert.equal(entry(cleared.value,'body').effective_value,'');
  checks.push('知识创建/固定锁交错修改/启停同操作重传同回执且仅一版；异参与旧版本失败回滚；纯人工文档清除退空且历史保留');

  before=counts();
  const assetInput={operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'合成私人范围',body:'仅用于合成测试',scope:'合成维护',verified:false,source_text:'本人录入',dependencies:[]};
  let asset=await parallel(()=>h.request('/assets',assetInput));
  assert.deepEqual(counts(),{...before,assets:before.assets+1,asset_versions:before.asset_versions+1,asset_operations:before.asset_operations+1});
  before=counts();
  const assetEdit={...assetInput,...command(asset),id:asset.id,body:'合成私人修订'};
  asset=await interleaved('personal_assets','asset_operations',asset.id,()=>h.request('/assets',assetEdit));
  assert.equal(asset.version,'2');assert.equal(asset.body,assetEdit.body);
  assert.deepEqual(counts(),{...before,asset_versions:before.asset_versions+1,asset_operations:before.asset_operations+1});
  for(const action of ['disable','enable']){
    before=counts();const input=command(asset);
    asset=await parallel(()=>h.request('/assets/'+asset.id+'/'+action,input));
    assert.deepEqual(counts(),{...before,asset_versions:before.asset_versions+1,asset_operations:before.asset_operations+1});
  }
  before=counts();
  assert.equal((await h.request('/assets',{...assetEdit,body:'同操作异参'})).value.code,'idempotency_conflict');
  assert.equal((await h.request('/assets',{...assetEdit,operation_id:randomUUID()})).value.code,'version_conflict');
  assert.deepEqual(counts(),before);
  const competing=await Promise.all(['甲','乙'].map(body=>h.request('/assets',{...assetInput,...command(asset),id:asset.id,body})));
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);assert.equal(competing.find(r=>r.status===409).value.code,'version_conflict');
  checks.push('本人资产创建/固定锁交错修改/启停同参重传仅一版；同操作异参拒绝、不同操作竞争旧版本仍冲突');

  const dependency=await read(doc.id),ref={object_id:dependency.id,version:dependency.version,path:'body'};
  const dependentInputs=['memory','skill'].map(kind=>({...assetInput,operation_id:randomUUID(),kind,name:'合成依赖'+kind,dependencies:[ref]}));
  const dependent=[];for(const input of dependentInputs){const response=await h.request('/assets',input);assert.equal(response.status,200);dependent.push(response.value);}
  const selectionCid=await h.create(),selection={operation_id:randomUUID(),asset_id:dependent[1].id,version:dependent[1].version};
  const selected=await h.request('/conversations/'+selectionCid+'/skill-selections',selection);assert.equal(selected.status,200);
  const changedDependency=await patch(dependency,{...command(dependency),entry_id:'body',value:'已改版依赖'});assert.equal(changedDependency.status,200);
  for(const state of ['changed','disabled']){
    if(state==='disabled')assert.equal((await h.request('/knowledge/'+dependency.id+'/disable',command(changedDependency.value))).status,200);
    before=counts();
    for(let index=0;index<dependentInputs.length;index++){
      const replay=await h.request('/assets',dependentInputs[index]);assert.equal(replay.status,200);assert.deepEqual(replay.value,dependent[index]);
      const fresh=await h.request('/assets',{...dependentInputs[index],operation_id:randomUUID()});assert.equal(fresh.status,state==='changed'?409:404);assert.equal(fresh.value.code,state==='changed'?'stale_knowledge':'not_available');
    }
    const replaySelection=await h.request('/conversations/'+selectionCid+'/skill-selections',selection);assert.equal(replaySelection.status,200);assert.deepEqual(replaySelection.value,selected.value);
    assert.ok((await h.request('/conversations/'+selectionCid+'/skill-selections',{...selection,operation_id:randomUUID()})).status>=400);
    assert.deepEqual(counts(),before);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM skill_selections WHERE conversation_id='${selectionCid}' AND asset_id='${dependent[1].id}'`)[0].n,1);
  }
  checks.push('知识依赖改版/停用后，memory/Skill保存与原选择重传接回成功回执、不重复或重新激活；新操作仍校验依赖并回滚');

  await syncCatalog(table(1,node));
  const imported=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'");
  let catalogTable=imported.find(o=>o.kind==='table'),field=imported.find(o=>o.kind==='field');
  for(const [original,entries] of [[catalogTable,['description','ddl']],[field,['meaning','type']]]){
    let object=original;
    for(const entryId of entries){
      const basis=entry(object,entryId).effective_value;
      const overwritten=await patch(object,{...command(object),entry_id:entryId,value:'人工覆盖'+entryId});assert.equal(overwritten.status,200);object=overwritten.value;
      if(entryId==='ddl'||entryId==='type'){
        // 模拟升级前缺少基础值的持久条目，quote包含结构元数据而非有效类型。
        const index=object.entries.findIndex(e=>e.entry_id===entryId);
        h.sql(`UPDATE knowledge_objects SET body=JSON_REMOVE(body,'$.entries[${index}].source_facts.value') WHERE id='${object.id}'`);
      }
      const response=await patch(object,{...command(object),entry_id:entryId,value:'',clear_override:true});assert.equal(response.status,200,JSON.stringify(response.value));object=response.value;
      assert.equal(entry(object,entryId).effective_value,basis);assert.equal(entry(object,entryId).human_override,null);
      assert.equal(entry(object,entryId).review_state,'unverified');
      const previous=await read(object.id+'?version='+(Number(object.version)-1));assert.equal(entry(previous,entryId).effective_value,'人工覆盖'+entryId);
    }
    if(object.kind==='table')catalogTable=object;else field=object;
  }
  checks.push('来源description/meaning及DDL/type覆盖清除准确恢复；升级前无value也回源同版，不把quote误当类型；人工历史可读');

  const reanalysis=command(catalogTable);
  before=counts();const result=await parallel(()=>h.request('/knowledge/'+catalogTable.id+'/reanalyze',reanalysis));
  assert.deepEqual(counts(),{...before,versions:before.versions+1,operations:before.operations+1,queued:before.queued+1});
  const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  // 旧trial持久指纹证明source_version按字符串编码；升级不修改原账本。
  const legacyFingerprint=createHash('sha256').update(JSON.stringify(canonical({object_id:catalogTable.id,input:reanalysis,source_version:result.source_version}))).digest('hex');
  h.sql(`UPDATE knowledge_operations SET fingerprint='${legacyFingerprint}' WHERE owner_id='alice' AND operation_id='${reanalysis.operation_id}'`);
  before=counts();assert.deepEqual((await h.request('/knowledge/'+catalogTable.id+'/reanalyze',reanalysis)).value,result);
  assert.equal((await h.request('/knowledge/'+field.id+'/reanalyze',reanalysis)).value.code,'idempotency_conflict');assert.deepEqual(counts(),before);
  const lineageOverride=await patch(result,{...command(result),entry_id:'lineage',value:'人工记录的待核血缘'});assert.equal(lineageOverride.status,200);
  await syncCatalog(table(2,null));catalogTable=await read(catalogTable.id);
  assert.equal(catalogTable.source_version,'2');
  for(const item of catalogTable.entries)assert.equal(item.source_facts.version,'2');
  assert.equal(entry(catalogTable,'lineage').source_facts.value,'');assert.equal(entry(catalogTable,'lineage').source_facts.complete,false);assert.ok(entry(catalogTable,'lineage').source_facts.gap);
  assert.equal(entry(catalogTable,'lineage').effective_value,'人工记录的待核血缘');assert.equal(entry(catalogTable,'lineage').review_state,'needs_review');
  assert.equal(entry(catalogTable,'etl').effective_value,'');
  const search=(await h.request('/knowledge?q=replay_records')).value.objects;assert.ok(search.some(o=>o.id===catalogTable.id));
  const missingNode=await modelRead(catalogTable);assert.equal(entry(missingNode,'lineage').effective_value,'人工记录的待核血缘');assert.equal(entry(missingNode,'etl').effective_value,'');
  before=counts();const replay=await h.request('/knowledge/'+catalogTable.id+'/reanalyze',reanalysis);assert.equal(replay.status,200);assert.deepEqual(replay.value,result);assert.deepEqual(counts(),before);
  assert.equal((await h.request('/knowledge/'+catalogTable.id+'/reanalyze',{...reanalysis,expected_version:catalogTable.version})).value.code,'idempotency_conflict');assert.deepEqual(counts(),before);
  const historical=await read(catalogTable.id+'?version='+result.version);assert.equal(entry(historical,'lineage').effective_value,JSON.stringify(node.upstream_ids));
  checks.push('重分析同操作并发仅排队一次，来源变更后接回原回执；节点移除更新全部来源版本、缺口和检索，人工血缘及历史受保护');

  const clearedLineage=await patch(catalogTable,{...command(catalogTable),entry_id:'lineage',value:'',clear_override:true});assert.equal(clearedLineage.status,200);assert.equal(entry(clearedLineage.value,'lineage').effective_value,'');
  await syncCatalog(table(3,{...node,upstream_ids:['restored_synthetic_records']}));catalogTable=await read(catalogTable.id);
  assert.equal(entry(catalogTable,'lineage').effective_value,'["restored_synthetic_records"]');assert.equal(entry(catalogTable,'lineage').source_facts.version,'3');
  const current=await modelRead(catalogTable);assert.equal(entry(current,'lineage').effective_value,'["restored_synthetic_records"]');
  checks.push('清除已移除血缘退当前空值、恢复节点后准确更新；当前模型受控读取不再误判旧血缘过期');
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  if(blocker){const closed=new Promise(resolve=>blocker.once('exit',resolve));blocker.stdin.end('ROLLBACK;\n');await closed;}
  await writeFile('.local/checks/mvp-maintenance-replay.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
  await h.close();
}
