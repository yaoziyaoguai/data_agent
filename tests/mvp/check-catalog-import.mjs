import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {harness,until} from './harness.mjs';

// 目录与来源事务只依赖 API/平台/MySQL；此组不推进 Agent，也不消费预填队列。
const h=await harness({capture:true,startWorker:false,startupTimeout:60000});
let passed=false,server,release;const checks=[];
const column=(id,name=id)=>({id,name,data_type:'INTEGER',nullable:false,comment:'合成整数字段'});
const table=(id,name=id,version='1',columns=[column('record_id'),column('amount')])=>({id,name,platform_version:version,comment:'合成订单金额表',ddl:`CREATE TABLE ${name} (record_id INTEGER, amount INTEGER);`,columns,node:{id:'load-'+id,sql:`INSERT INTO ${name} SELECT record_id, amount FROM synthetic_source;`,upstream_ids:['synthetic_source']}});
const catalog=async(tables,authoritative=true)=>writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-catalog-test',authoritative,tables}));
const sync=(key=randomUUID())=>h.request('/source-syncs',{operation_id:key});
const objects=()=>h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%' ORDER BY id");
const find=name=>objects().find(v=>v.name===name);
const read=id=>h.request('/knowledge/'+id);
const serve=async callback=>{server=createServer(callback);await new Promise(r=>server.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',r));};
const page=(tables,snapshot='fixed',complete=true,next=null)=>({schema_version:1,source_namespace:'synthetic-catalog-test',snapshot_id:snapshot,tables,next_cursor:next,complete,authoritative:true});
const respond=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
try{
 const initial=[table('orders'),table('customers')];await catalog(initial);
 const key=randomUUID(),first=await sync(key);assert.equal(first.status,200,JSON.stringify(first.value));
 assert.equal(objects().length,6);assert.deepEqual((await sync(key)).value,first.value);
 const order=find('orders'),amount=find('orders.amount');assert.ok(order&&amount);
 const source=(await h.request('/sources/'+order.source_id)).value;
 for(const object of objects())for(const entry of object.entries){const quote=entry.source_facts.quote;if(quote)assert.ok(source.body.includes(quote)||object.source_id!==order.source_id);}
 assert.ok(!objects().some(v=>v.kind==='relationship'));
 checks.push('仅用接口元数据/DDL/SQL创建表和全部字段，事实引用原文，生产血缘不冒充JOIN');

 const edited=await h.request('/knowledge/'+amount.id,{operation_id:randomUUID(),expected_version:amount.version,entry_id:'meaning',value:'人工确认：金额单位为合成分'},'alice','PATCH');assert.equal(edited.status,200);
 await catalog([table('orders','order_facts','2',[column('record_id','business_key'),column('amount','amount_cents'),column('channel')]),table('customers')]);
 assert.equal((await sync()).status,200);
 const renamed=find('order_facts'),renamedField=find('order_facts.amount_cents');
 assert.equal(renamed.id,order.id);assert.equal(renamedField.id,amount.id);
 assert.equal(renamedField.entries.find(e=>e.entry_id==='meaning').effective_value,'人工确认：金额单位为合成分');
 assert.equal(renamedField.entries.find(e=>e.entry_id==='meaning').review_state,'needs_review');
 assert.ok(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM prefill_attempts WHERE object_id='${renamed.id}' AND expected_version=${renamed.version}`)[0].n===1);
 assert.ok(h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${renamed.id}' AND expected_version=${renamed.version}`)[0].sources[0].body.includes('order_facts'));
 assert.ok(find('order_facts.channel'));assert.equal(find('customers').version,'1');
 checks.push('平台稳定ID保留改名身份；新增字段自动出现；人工值及标识保留；未变对象不升版');

 const prefilled=await h.request('/knowledge/'+renamed.id+'/reanalyze',{operation_id:randomUUID(),expected_version:renamed.version});assert.equal(prefilled.status,200,JSON.stringify(prefilled.value));
 const queued=h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${renamed.id}' ORDER BY created_at DESC LIMIT 1`)[0];
 assert.equal(queued.sources[0].source_id,renamed.source_id);assert.ok(queued.sources[0].body.includes('order_facts'));
 checks.push('目录对象按需重分析取当前原始快照，无须手编语义catalog');

 await catalog([table('orders','order_facts','3',[column('record_id'),column('channel')])],false);assert.equal((await sync()).status,200);
 assert.equal((await read(amount.id)).value.state,'enabled');assert.equal((await read(find('customers').id)).value.state,'enabled');
 await catalog([table('orders','order_facts','3',[column('record_id'),column('channel')])],true);assert.equal((await sync()).status,200);
 assert.equal((await read(amount.id)).value.state,'disabled');assert.equal((await read(find('customers').id)).value.state,'disabled');
 assert.equal((await read(amount.id)).value.entries.find(e=>e.entry_id==='meaning').effective_value,'人工确认：金额单位为合成分');
 assert.ok((await h.request('/knowledge?q=customers')).value.objects.every(o=>o.source_id!==find('customers').source_id));
 checks.push('仅权威完整同步后移除字段/表失效，人工正文与历史保留；非权威范围不推断删除');

 await catalog([table('orders','order_facts','4',[column('record_id'),column('amount'),column('channel')]),table('customers','customers','2')]);assert.equal((await sync()).status,200);
 assert.equal((await read(amount.id)).value.state,'enabled');const userDisabled=find('customers');assert.equal((await h.request('/knowledge/'+userDisabled.id+'/disable',{operation_id:randomUUID(),expected_version:userDisabled.version})).status,200);
 await catalog([table('orders','order_facts','5'),table('customers','customer_profiles','3')]);assert.equal((await sync()).status,200);assert.equal((await read(userDisabled.id)).value.state,'disabled');
 checks.push('可靠目录重新出现恢复平台退休对象，人工停用仍受保护');

 await h.pausePlatform();let reached;const fetched=new Promise(r=>reached=r);let calls=0;
 await serve(async(req,res)=>{for await(const _ of req){};calls++;if(calls===1){release=()=>respond(res,page([table('orders','old_name','6')],'older'));reached();}else respond(res,page([table('orders','newest_name','7')],'newer'));});
 const older=sync();await fetched;assert.equal((await sync()).status,200);release();release=undefined;const oldResult=await older;
 assert.equal(oldResult.status,409,JSON.stringify(oldResult.value));assert.equal(find('newest_name').id,order.id);
 assert.ok(!find('old_name'));checks.push('采集前基线CAS拒绝晚到旧目录，旧平台版本不会覆盖新来源');
 await new Promise(r=>server.close(r));server=undefined;

 // 新完整目录内容未变，仍足以阻止旧空快照删除。
 let reachedEmpty;const emptyFetched=new Promise(r=>reachedEmpty=r);calls=0;
 await serve(async(req,res)=>{for await(const _ of req){};calls++;if(calls===1){release=()=>respond(res,page([],'stale-empty'));reachedEmpty();}else respond(res,page([table('orders','newest_name','7')],'fresh-unchanged'));});
 const staleEmpty=sync();await emptyFetched;assert.equal((await sync()).status,200);release();release=undefined;
 assert.equal((await staleEmpty).status,409);assert.equal(find('newest_name').state,'enabled');
 checks.push('新完整目录即使内容未变，也阻止晚到旧空快照停用表');
 await new Promise(r=>server.close(r));server=undefined;

 await serve(async(req,res)=>{for await(const _ of req){};respond(res,page([], 'broken',false,'next'));});
 const incomplete=await sync();assert.ok(incomplete.status>=400);assert.equal(find('newest_name').state,'enabled');
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM catalog_imports WHERE state='failed'")[0].n,3);
 checks.push('空页未完成不伪装成功，也不批量停用现有表');
 await new Promise(r=>server.close(r));server=undefined;await h.resumePlatform();

 const many=Array.from({length:65},(_,i)=>table('catalog_'+i));await catalog(many);assert.equal((await sync()).status,200);
 assert.equal(objects().filter(o=>o.state==='enabled'&&o.name.startsWith('catalog_')).length,195);
 checks.push('跨两页目录全部导入，表/字段没有首批截断');

 // 已开始采集的进程被中断后，旧操作保留原基线并明确失败。
 const orphanKey=randomUUID();h.sql(`INSERT INTO catalog_imports(id,space_id,owner_id,operation_id,baseline,namespace_baseline,state,lease_until) VALUES('${randomUUID()}','demo','alice','${orphanKey}',JSON_OBJECT(),JSON_OBJECT(),'fetching',TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)))`);
 assert.equal((await sync(orphanKey)).status,503);
 assert.deepEqual(h.sql(`SELECT JSON_OBJECT('state',state,'error',error_code) FROM catalog_imports WHERE operation_id='${orphanKey}'`)[0],{state:'failed',error:'source_interrupted'});
 assert.equal((await sync()).status,200);
 checks.push('中断后过期状态持久保存，旧operation不换基线重发，新同步收敛成功');

 await catalog([],true);assert.equal((await sync()).status,200);
 await catalog(many,true);assert.equal((await sync()).status,200);
 assert.equal(objects().filter(o=>o.state==='enabled'&&o.name.startsWith('catalog_')).length,195);
 checks.push('完整移除后同平台版本重新出现，也恢复平台退休对象');

 const deletedObjects=[find('catalog_0'),find('catalog_1.amount')];
 for(const object of deletedObjects)assert.equal((await h.request('/knowledge/'+object.id+'/delete',{operation_id:randomUUID(),expected_version:object.version})).status,200);
 const tombstones=deletedObjects.map(o=>objects().find(v=>v.id===o.id));
 for(const changed of [false,true]){
  const refreshed=many.map((t,i)=>changed&&i<2?table(t.id,t.name,'2',[column('record_id'),column('amount'),column('new_column')]):t);
  await catalog(refreshed,true);assert.equal((await sync()).status,200);
  for(const deleted of tombstones){
   assert.equal((await read(deleted.id)).status,404);
   assert.deepEqual(objects().find(v=>v.id===deleted.id),deleted);
  }
 }
 assert.ok(find('catalog_0.new_column'));assert.ok(find('catalog_1.new_column'));
 checks.push('人工删除表或字段不被同版/改版目录复活，不阻断整批同步，其他字段正常更新');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{release?.();if(server)await new Promise(r=>server.close(r));await writeFile('.local/checks/mvp-catalog-import.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}
