import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {synchronizeSources} from './source-sync.mjs';
import {harness,until} from './harness.mjs';

// 来源级语义整理消费链路验收：分批覆盖与成果落地、在途调用中断按unknown终态不重发、
// 新修订重新整理且旧记录保留。对象级预填链路由check-prefill单独验收。
const checks=[];let passed=false,calls=0,h,blocked=false,release,arrived,raceDoc,raceDocEdited=false,raceTableSource,raceTableObject,raceTableEdited=false;
const batches=[];
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 calls++;assert.ok(Buffer.byteLength(raw)<=65536);
 const request=JSON.parse(raw);assert.equal(request.model,'deepseek-flash');
 assert.equal(request.tools.length,1);assert.equal(request.tools[0].function.name,'submit_semantic_preparation');
 const material=JSON.parse(request.messages[1].content);
 if(!material.draft)batches.push(material);
 // 阶段四竞态钩子：批次在途时人工推进冻结对象版本——文档走正文改版（新修订作业
 // 接管），平台表对象走二次人工覆盖（同修订内依赖指纹不变，必须按新版本重开批）。
 if(raceDoc&&material.source?.id===raceDoc&&!material.draft&&!raceDocEdited){
  raceDocEdited=true;
  const parts=(await h.request('/knowledge/'+raceDoc+'/document')).value.parts;
  const patched=await h.request('/knowledge/'+raceDoc+'/document',{operation_id:randomUUID(),
   body:'# 并发改版\n\n人工在途改写的正文。',parts:parts.map(p=>({id:p.id,expected_version:p.version}))},'alice','PATCH');
  assert.equal(patched.status,200,'文档人工改版在批次在途时落地');
 }
 if(raceTableObject&&material.source?.kind==='platform'&&material.source?.id===raceTableSource
   &&!material.draft&&!raceTableEdited){
  raceTableEdited=true;
  const edited=await h.request('/knowledge/'+raceTableObject,{operation_id:randomUUID(),
   expected_version:'2',entry_id:'description',value:'人工在途二次改写的表描述'},'alice','PATCH');
  assert.equal(edited.status,200,'表对象人工二次覆盖在批次在途时落地');
 }
 if(blocked&&!material.draft){blocked=false;arrived?.();await new Promise(r=>release=r);}
 const output=material.draft??preparationOutput(material);
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_preparation',arguments:JSON.stringify(output)}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));

function preparationOutput(material){
 const objects=material.objects??[];
 const segment=material.segments[0];
 const cite={source:material.source,revision:material.revision,locator:{offset:segment.citation.locator.offset,length:Math.min(24,segment.citation.locator.length)}};
 const writable=entry=>!['ddl','etl','type','lineage'].includes(entry.path);
 const target=objects.find(o=>o.kind==='table')??objects[0];
 const support=objects.find(o=>o.kind==='field');
 const entry=target?.entries.find(writable);
 if(!target||!entry)return {statements:[],relations:[],unresolved:['本批没有可更新的知识对象条目'],semantic_status:'partial'};
 return {statements:[{key:'s-'+material.coverage.batch_start,
  target:{object_id:target.id,version:target.version,path:entry.path},
  text:`合成陈述：批次自第${material.coverage.batch_start}字符起可解释`,scope_text:'适用范围：合成来源整理验收',
  citations:[cite],
  supports:support?[{key:'precondition',role:'prerequisite',reference:{kind:'knowledge',ref:{object_id:support.id,version:support.version,path:support.entries.find(writable)?.path??'meaning'}},content:'字段含义是本结论的前提',embedded_in:null}]:[]}],
 relations:[{key:'computes-lineage',subject:{object_id:target.id,version:target.version,path:entry.path},predicate:'computes',target:{kind:'source',citation:cite},scope_text:'',citations:[cite]}],
 unresolved:[],semantic_status:material.coverage.final_batch?'ready':'partial'};
}

const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:100,trial_cost_micros:'5000000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
try{
 h=await harness({keep:process.env.KEEP==='1',env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();
 const lines=Array.from({length:26},(_,i)=>`INSERT INTO event_stream VALUES (${i}, '${'e'.repeat(960)}');`);
 const firstEdition='-- 头部标记：从这里开始。\n'+lines.join('\n')+'\n-- 尾部标记：成功才计数。';
 const table=(id,version,sql)=>({id,name:id,platform_version:version,comment:'合成表 '+id,columns:[{id:'amount',name:'amount',data_type:'INTEGER',nullable:false,comment:'合成金额'}],ddl:`CREATE TABLE ${id}(amount INTEGER NOT NULL);`,node:{id:'load-'+id,sql,upstream_ids:[]}});
 const writeCatalog=(events,tiny)=>writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'preparation-checks',authoritative:true,tables:[table('event_stream',events.version,events.sql),table('tiny_signal',tiny.version,tiny.sql)]}));
 const preparation=(source,revision)=>h.sql(`SELECT JSON_OBJECT('status',semantic_status,'call',call_state,'error',error_code,'seq',batch_sequence,'segments',segments_read) FROM source_preparations WHERE source_id='${source}' AND revision=${revision}`)[0];
 const isolateObjectPrefill=()=>h.sql("DELETE FROM prefill_attempts WHERE state='queued'");

 // 阶段一：长正文分批整理到ready，成果落地并全程结算。
 await writeCatalog({version:'1',sql:firstEdition},{version:'1',sql:'INSERT INTO tiny_signal SELECT 1;'});
 assert.equal((await synchronizeSources(h)).value.status,'completed');
 isolateObjectPrefill();
 const eventsSource=h.sql("SELECT JSON_OBJECT('source_id',source_id) FROM source_current WHERE external_id='event_stream'")[0].source_id;
 const tinySource=h.sql("SELECT JSON_OBJECT('source_id',source_id) FROM source_current WHERE external_id='tiny_signal'")[0].source_id;
 await h.resumeWorker();
 await until(async()=>{const row=preparation(eventsSource,1);return row&&row.status==='ready'&&row.call===null?row:false;},'长来源整理到ready',120000);
 await until(async()=>{const r=h.sql("SELECT JSON_OBJECT('total',COUNT(*),'finished',SUM(state='finished')) FROM background_jobs WHERE kind='prepare_source'")[0];return Number(r.total)===Number(r.finished)?r:false;},'全部整理作业到达终态',120000);
 const stable=calls;await new Promise(r=>setTimeout(r,1500));assert.equal(calls,stable,'作业完成后不得继续发起新调用');
 const editionOne=batches.filter(m=>m.source.id===eventsSource);
 assert.ok(editionOne.length>=2,'长正文必须分多批整理');
 assert.ok(editionOne.every(m=>m.revision==='1'));
 const starts=editionOne.map(m=>m.coverage.batch_start);assert.equal(new Set(starts).size,starts.length,'批次起点不得重复');
 assert.equal(editionOne.at(-1).coverage.final_batch,true,'最后一批必须声明覆盖完成');
 const covered=editionOne.flatMap(m=>m.segments.map(s=>s.text)).join('\n');
 assert.ok(covered.includes('头部标记：从这里开始'),'分批覆盖必须包含正文开头');
 assert.ok(covered.includes('尾部标记：成功才计数。'),'分批覆盖必须读到最后一批尾部');
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 assert.equal(ledger.calls,calls);assert.equal(ledger.reserved,0);
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state='settled'")[0].n,calls);
 const eventsTable=h.sql(`SELECT JSON_OBJECT('id',id) FROM knowledge_objects WHERE source_id='${eventsSource}' AND kind='table'`)[0].id;
 const knowledge=(await h.request('/knowledge/'+eventsTable)).value;
 const description=knowledge.entries.find(e=>e.path==='description');
 assert.ok(description.suggestion.statements.length>=2,'各批陈述应累积保存');
 for(const statement of description.suggestion.statements){
  assert.equal(statement.origin,'model_inference');
  assert.ok(statement.citations.every(c=>c.source.id===eventsSource&&c.revision==='1'),'陈述引用必须绑定整理来源与修订');
 }
 assert.ok(description.effective_value.includes('合成陈述'));
 assert.equal(description.review_state,'unverified');
 assert.equal(knowledge.semantic_relations.length,1);
 assert.equal(knowledge.semantic_relations[0].predicate,'computes');
 assert.ok(knowledge.semantic_relations[0].citations.every(c=>c.source.id===eventsSource&&c.revision==='1'));
 checks.push('长正文来源分批整理到ready，陈述/关系/支持引用全部绑定来源修订并结算预算');

 // 阶段二：分析在途进程中断，结果不确定按unknown终态，不换ID重发。
 await h.pauseWorker();
 await writeCatalog({version:'1',sql:firstEdition},{version:'2',sql:'INSERT INTO tiny_signal SELECT 2; -- 第二版'});
 assert.equal((await synchronizeSources(h)).value.status,'completed');
 isolateObjectPrefill();
 const tinyJobState=()=>h.sql(`SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE kind='prepare_source' AND resource_id='${tinySource}' AND resource_version=2`)[0].state;
 blocked=true;const inFlight=new Promise(r=>arrived=r);
 await h.resumeWorker();await inFlight;
 await until(async()=>{const row=preparation(tinySource,2);return row&&row.call==='analysis'?row:false;},'在途分析已登记',30000);
 await h.pauseWorker();
 h.sql("UPDATE source_preparations SET issued_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE call_state IN ('analysis','review')");
 h.sql("UPDATE background_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE kind='prepare_source' AND state='running'");
 release();release=undefined;
 await h.resumeWorker();
 await until(async()=>{const row=preparation(tinySource,2);return row&&row.status==='failed'&&row.error==='model_unknown'?row:false;},'过期在途调用按unknown终态处理',60000);
 assert.equal(tinyJobState(),'failed');
 const afterUnknown=calls;await new Promise(r=>setTimeout(r,1500));assert.equal(calls,afterUnknown,'unknown调用不得自动重发');
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state='issued'")[0].n,1,'账上只保留这一次不确定调用');
 const finalLedger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 assert.equal(finalLedger.calls,calls);assert.ok(finalLedger.reserved>0,'不确定调用的预留不得释放');
 const unknownReserved=Number(finalLedger.reserved);
 checks.push('在途分析结果不确定：过期标unknown终态，预算账目保留且不换ID重发');

 // 阶段三：来源新修订重新整理，新成果绑定新修订，旧修订记录保留。
 await h.pauseWorker();
 await writeCatalog({version:'2',sql:firstEdition+'\n-- 第二版尾部：口径更新。'},{version:'2',sql:'INSERT INTO tiny_signal SELECT 2; -- 第二版'});
 assert.equal((await synchronizeSources(h)).value.status,'completed');
 isolateObjectPrefill();
 await h.resumeWorker();
 await until(async()=>{const row=preparation(eventsSource,2);return row&&row.status==='ready'&&row.call===null?row:false;},'新修订整理到ready',120000);
 const editionTwo=batches.filter(m=>m.source.id===eventsSource&&m.revision==='2');
 assert.ok(editionTwo.length>=2,'新修订同样分批覆盖');
 assert.ok(editionTwo.some(m=>m.segments.some(s=>s.text.includes('第二版尾部：口径更新'))),'新修订正文必须实际进入分批材料');
 assert.equal(preparation(eventsSource,1).status,'ready','旧修订的整理记录保留');
 const refreshed=(await h.request('/knowledge/'+eventsTable)).value;
 const refreshedStatements=refreshed.entries.flatMap(e=>e.suggestion?.statements??[]);
 assert.ok(refreshedStatements.some(s=>s.citations.every(c=>c.source.id===eventsSource&&c.revision==='2')),'新修订成果必须引用新修订');
 checks.push('来源新修订触发重新整理，新成果绑定新修订且旧修订记录保留');

 // 阶段四：批次在途时人工推进冻结对象版本——文档改版由新修订作业接管（旧修订
 // 早停不冒充完成）；平台表对象的二次人工覆盖不改变依赖指纹，必须按新版本
 // 重开批完成同修订整理，不把version_conflict当永久失败；人工内容保留、账目如实结算。
 await h.pauseWorker();
 const raced=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'并发改版口径文档',
  body:'# 并发改版\n\n文档正文在整理批次进行中被人工改写。',related_ids:[]})).value;
 raceDoc=raced.id;raceDocEdited=false;
 await h.resumeWorker();
 await until(async()=>{const row=preparation('document-'+raced.id,2);return row&&row.status==='ready'&&row.call===null?row:false;},'文档改版由新修订作业重新整理到ready',120000);
 assert.ok(raceDocEdited,'文档人工改版确实发生在批次在途窗口');
 assert.equal(preparation('document-'+raced.id,1).status,'superseded','旧修订被新修订取代时明确终态，不冒充ready也不冒充处理中');
 const raceDocObject=(await h.request('/knowledge/'+raced.id)).value;
 assert.equal(raceDocObject.version,'2','人工改版推进文档版本');
 const raceBody=(await h.request('/knowledge/'+raced.id+'/document')).value;
 assert.ok(raceBody.body.includes('人工在途改写的正文'),'人工正文不被整理覆盖');
 const raceStatements=raceDocObject.entries.flatMap(e=>e.suggestion?.statements??[]);
 assert.ok(raceStatements.length>=1&&raceStatements.every(s=>s.citations.every(c=>c.source.id===raced.id&&c.revision==='2')),'新修订成果绑定新修订');
 raceDoc=undefined;
 checks.push('批次在途的文档改版由新修订作业接管，旧修订早停且人工正文保留');

 await h.pauseWorker();
 await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'preparation-checks',authoritative:true,tables:[
  table('event_stream','2',firstEdition+'\n-- 第二版尾部：口径更新。'),
  table('tiny_signal','2','INSERT INTO tiny_signal SELECT 2; -- 第二版'),
  table('race_table','1','-- 竞态表标记\nINSERT INTO race_table VALUES (1);')]}));
 assert.equal((await synchronizeSources(h)).value.status,'completed');
 isolateObjectPrefill();
 raceTableSource=h.sql("SELECT JSON_OBJECT('source_id',source_id) FROM source_current WHERE external_id='race_table'")[0].source_id;
 raceTableObject=h.sql(`SELECT JSON_OBJECT('id',id) FROM knowledge_objects WHERE source_id='${raceTableSource}' AND kind='table'`)[0].id;
 raceTableEdited=false;
 // 先落一次人工覆盖（override层不含引用，依赖指纹与无覆盖时同形），制造
 // "再次覆盖只推进版本、指纹不变"的窗口。
 assert.equal((await h.request('/knowledge/'+raceTableObject,{operation_id:randomUUID(),
  expected_version:'1',entry_id:'description',value:'人工首次改写的表描述'},'alice','PATCH')).status,200,'首次人工覆盖落地');
 const tableCallsBefore=calls;
 await h.resumeWorker();
 await until(async()=>{const row=preparation(raceTableSource,1);return row&&row.status==='ready'&&row.call===null?row:false;},'同修订内按新版本重开批到ready',120000);
 assert.ok(raceTableEdited,'表对象人工二次覆盖确实发生在批次在途窗口');
 const tableRaceBatches=batches.filter(m=>m.source?.id===raceTableSource&&!m.draft);
 assert.ok(tableRaceBatches.length>=2,'指纹不变的版本推进必须重开批，不能沿用旧版本目标');
 assert.equal(tableRaceBatches.at(-1).objects.find(o=>o.id===raceTableObject).version,'3','重开批材料携带对象当前版本');
 const tableObject=(await h.request('/knowledge/'+raceTableObject)).value;
 // 版本链：建对象v1→首次覆盖v2→在途二次覆盖v3→重开批apply落建议v4。
 assert.equal(tableObject.version,'4','竞态窗口后对象版本如实推进');
 const tableDescription=tableObject.entries.find(e=>e.path==='description');
 assert.ok(tableDescription.effective_value.includes('人工在途二次改写的表描述'),'人工覆盖不被整理覆盖');
 assert.ok(tableDescription.suggestion.statements.length>=1,'重开批成果落地陈述');
 assert.ok(tableDescription.suggestion.statements.every(s=>s.citations.every(c=>c.source.id===raceTableSource&&c.revision==='1')),'同修订重开批成果绑定原修订');
 assert.equal(calls-tableCallsBefore,4,'被取代批次与重开批次各一次分析一次复核');
 const raceFinalLedger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 assert.equal(raceFinalLedger.calls,calls);
 assert.equal(raceFinalLedger.reserved,unknownReserved,'竞态窗口不新增未决预留，仅保留阶段二的不确定调用');
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state='settled'")[0].n,calls-1,'除结果不确定的那一次外全部如实结算');
 raceTableSource=raceTableObject=undefined;
 checks.push('依赖指纹不变的对象版本推进按新版本重开批，不把version_conflict当永久失败');

 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0,calls}));
}finally{release?.();if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-source-preparation.json',JSON.stringify({passed,checks,officialRequests:0,calls},null,2));}
