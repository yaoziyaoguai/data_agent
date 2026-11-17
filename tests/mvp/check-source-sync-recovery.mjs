import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {harness, until} from './harness.mjs';
import {synchronizeSources} from './source-sync.mjs';

const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'2400'}});
let server, release, passed=false;
const checks=[];
const namespace='synthetic-resumable-voice';
const table=(id,owner='alice')=>({id,name:id,platform_version:'1',maintainer_id:owner,comment:'从零构造的语音事件表',ddl:`CREATE TABLE ${id} (event_id INTEGER);`,columns:[{id:'event_id',name:'event_id',data_type:'INTEGER',nullable:false,comment:'合成事件标识'}],node:{id:'load_'+id,sql:`INSERT INTO ${id} SELECT event_id FROM synthetic_voice;`,upstream_ids:['synthetic_voice']}});
const a=table('voice_a'), b=table('voice_b');
const save=tables=>writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:namespace,authoritative:true,tables}));
const page=(tables,next=null)=>({schema_version:1,source_namespace:namespace,snapshot_id:'resumable-voice',authoritative:true,tables,next_cursor:next,complete:next===null});
const reply=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const serve=async handler=>{await h.pausePlatform();server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;await handler(JSON.parse(raw),res);});await new Promise(r=>server.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',r));};
const closeServer=async()=>{release?.();release=undefined;server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));server=undefined;};
const object=async name=>{
  const result=await h.request('/knowledge?directory=all&q='+name);
  assert.equal(result.status,200);
  return result.value.objects.find(o=>o.kind==='table'&&o.name===name);
};
const terminal=async accepted=>until(async()=>{const r=await h.request(accepted.status_url);assert.equal(r.status,200);return ['completed','failed'].includes(r.value.status)&&r.value;},'后台同步恢复终态',60000);
try {
  await save([a,b]);
  const initial=await h.request('/source-syncs',{operation_id:randomUUID()});
  assert.equal((await terminal(initial.value)).status,'completed');
  const original=await object(a.name);
  assert.equal(original.maintenance.maintainer_id,'alice');
  let reached;
  const suspended=new Promise(r=>reached=r);
  let secondCalls=0;
  await serve(async(input,res)=>{
    if(!input.cursor)reply(res,page([{...a,maintainer_id:'bob'}],'second'));
    else if(++secondCalls===1){release=()=>reply(res,page([b]));reached();}
    else reply(res,page([b]));
  });
  const key=randomUUID();
  const accepted=await h.request('/source-syncs',{operation_id:key});assert.equal(accepted.status,202);
  await suspended;
  const partial=await h.request(accepted.value.status_url);
  assert.equal(partial.value.pages_committed,1);assert.equal(partial.value.processed_sources,1);
  assert.equal((await object(a.name)).maintenance.maintainer_id,'alice','第一页只暂存负责人');
  await h.pauseWorker();release();release=undefined;
  await h.resumeWorker();
  const completed=await terminal(accepted.value);assert.equal(completed.status,'completed',JSON.stringify(completed));
  assert.equal(completed.pages_committed,2);assert.equal(completed.processed_sources,2);
  const recovered=await object(a.name);
  assert.equal(recovered.id,original.id);assert.equal(recovered.version,original.version);
  assert.equal(recovered.maintenance.maintainer_id,'bob');assert.equal(recovered.state,'enabled');
  const field=(await h.request('/knowledge?directory=all&q=voice_a.event_id')).value.objects.find(o=>o.kind==='field');
  assert.equal(field.state,'enabled','未变成员的子对象不能因重启遗漏而退休');
  const prepared=h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE kind='prepare_source' AND resource_id='"+original.source_id+"'")[0].n;
  const rawTargets=h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='platform' AND object_id='"+original.source_id+"'")[0].n;
  assert.equal(prepared,1,'同页恢复不重复排整理待办');
  assert.equal(rawTargets,1,'同页恢复不重复登记原文索引目标');
  const replay=await h.request('/source-syncs',{operation_id:key});assert.equal(replay.status,202);assert.equal(replay.value.sync_id,accepted.value.sync_id);
  checks.push('第一页unchanged及待生效负责人持久保存；Worker退出后原游标/原批次完成，子对象不误退休，待办不重复');
  await closeServer();await h.resumePlatform();

  // 后页明确失败：已经提交的新内容保留，整批负责人不生效，也不推断缺席删除。
  await serve(async(input,res)=>reply(res,input.cursor?page([], 'broken'):page([{...a,platform_version:'2',comment:'已提交的新说明',maintainer_id:'carol'}],'second')));
  const failedKey=randomUUID();
  const failed=await synchronizeSources(h,failedKey);
  assert.equal(failed.value.status,'failed');assert.equal(failed.value.error_code,'source_incomplete');
  assert.equal(failed.value.processed_sources,1);
  assert.equal((await object(a.name)).maintenance.maintainer_id,'bob');
  assert.equal((await object(b.name)).state,'enabled');
  assert.equal((await object(a.name)).entries.find(e=>e.entry_id==='description').source_facts.value,'已提交的新说明');
  const again=await h.request('/source-syncs',{operation_id:failedKey});assert.equal(again.value.sync_id,failed.value.sync_id);assert.equal(again.value.status,'failed');
  checks.push('后页失败保留前页内容及raw待办，整批负责人不生效、不退休缺席对象，原命令只回失败');
  await closeServer();await h.resumePlatform();

  // 旧成功回执只读回，不能凭升级补建作业。
  const oldKey=randomUUID(), oldId=randomUUID();
  const oldReceipt={operation_id:oldKey,resource_id:oldId,version:'1',state:'synchronized'};
  h.sql(`INSERT INTO catalog_imports(id,space_id,owner_id,operation_id,baseline,namespace_baseline,state,receipt) VALUES('${oldId}','demo','alice','${oldKey}',JSON_OBJECT(),JSON_OBJECT(),'succeeded','${JSON.stringify(oldReceipt)}')`);
  const legacy=await h.request('/source-syncs',{operation_id:oldKey});assert.equal(legacy.status,200);assert.deepEqual(legacy.value,oldReceipt);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE resource_id='${oldId}'`)[0].n,0);
  checks.push('升级前成功命令精确返回原200回执，零新作业');
  passed=true;
} finally {
  await closeServer();await h.close();
  await writeFile('.local/checks/source-sync-recovery.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}
console.log(JSON.stringify({passed,checks,officialRequests:0}));
