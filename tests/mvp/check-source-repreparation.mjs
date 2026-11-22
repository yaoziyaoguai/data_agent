import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {synchronizeSources} from './source-sync.mjs';
import {harness,until} from './harness.mjs';

// R03：已ready且已应用的来源在原文修订不变、实际依赖变化后由扇出重开整理。
// 新批必须使用新的模型调用与应用身份，旧批成果/账目保留；重开只补一轮分析
// 与复核，不重发unknown或仍在途的原调用。
const checks=[];let passed=false,calls=0,h,analysisCount=0;
const batches=[];
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 calls++;assert.ok(Buffer.byteLength(raw)<=65536);
 const request=JSON.parse(raw);assert.equal(request.model,'deepseek-flash');
 assert.equal(request.tools.length,1);assert.equal(request.tools[0].function.name,'submit_semantic_preparation');
 const material=JSON.parse(request.messages[1].content);
 if(!material.draft){analysisCount++;batches.push(material);}
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
 return {statements:[{key:'s-0',
  target:{object_id:target.id,version:target.version,path:entry.path},
  text:`合成陈述：第${analysisCount}次整理可解释`,scope_text:'适用范围：同修订重开验收',
  citations:[cite],
  supports:support?[{key:'precondition',role:'prerequisite',reference:{kind:'knowledge',ref:{object_id:support.id,version:support.version,path:support.entries.find(writable)?.path??'meaning'}},content:'字段含义是本结论的前提',embedded_in:null}]:[]}],
  relations:[],unresolved:[],semantic_status:material.coverage.final_batch?'ready':'partial'};
}

const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:100,trial_cost_micros:'5000000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
try{
 h=await harness({keep:process.env.KEEP==='1',env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();
 const table={id:'reprep_events',name:'reprep_events',platform_version:'1',comment:'同修订重开合成来源',columns:[{id:'amount',name:'amount',data_type:'INTEGER',nullable:false,comment:'合成金额'}],ddl:'CREATE TABLE reprep_events(amount INTEGER NOT NULL);',node:{id:'load-reprep_events',sql:'INSERT INTO reprep_events VALUES (1);',upstream_ids:[]}};
 await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'repreparation-checks',authoritative:true,tables:[table]}));
 assert.equal((await synchronizeSources(h)).value.status,'completed');
 h.sql("DELETE FROM prefill_attempts WHERE state='queued'");
 const source=h.sql("SELECT JSON_OBJECT('source_id',source_id) FROM source_current WHERE external_id='reprep_events'")[0].source_id;
 const preparation=()=>h.sql(`SELECT JSON_OBJECT('status',semantic_status,'call',call_state,'error',error_code,'seq',batch_sequence,'segments',segments_read) FROM source_preparations WHERE source_id='${source}' AND revision=1`)[0];
 const callsNow=()=>h.sql("SELECT JSON_OBJECT('id',id,'state',state) FROM maintenance_model_calls ORDER BY id");
 // 整理应用回执是对象数组；普通编辑回执是单个对象。按回执形状识别应用身份，
 // 不预测内部指纹格式，只核旧批身份保留且新批不再复用同一操作。
 const applyOperations=()=>h.sql("SELECT JSON_OBJECT('operation_id',operation_id) FROM idempotency_receipts WHERE domain='knowledge' AND JSON_TYPE(response_json)='ARRAY' ORDER BY operation_id").map(row=>row.operation_id);

 // 首轮：整理到ready并成功应用，冻结首批调用与应用身份。
 await h.resumeWorker();
 await until(async()=>{const row=preparation();return row&&row.status==='ready'&&row.call===null?row:false;},'同修订来源整理到ready',120000);
 await until(async()=>{const r=h.sql("SELECT JSON_OBJECT('total',COUNT(*),'finished',SUM(state='finished')) FROM background_jobs WHERE kind='prepare_source'")[0];return Number(r.total)===Number(r.finished)?r:false;},'首轮整理作业到达终态',120000);
 assert.equal(preparation().seq,1,'首批使用持久序列1');
 const firstCalls=callsNow();assert.equal(firstCalls.length,2,'首批只有一次分析与复核');
 assert.ok(firstCalls.every(call=>call.state==='settled'));
 const firstApply=applyOperations();assert.equal(firstApply.length,1,'首批应用身份已落地');
 const tableObject=h.sql(`SELECT JSON_OBJECT('id',id,'version',version) FROM knowledge_objects WHERE source_id='${source}' AND kind='table'`)[0];
 const fieldObject=h.sql(`SELECT JSON_OBJECT('id',id,'version',version) FROM knowledge_objects WHERE source_id='${source}' AND kind='field'`)[0];
 const firstStatements=(await h.request('/knowledge/'+tableObject.id)).value.entries.flatMap(entry=>entry.suggestion?.statements??[]);
 assert.ok(firstStatements.some(statement=>statement.text.includes('第1次整理')),'首批陈述已应用');
 checks.push('同修订来源整理到ready并成功应用，首批调用与应用身份固定');

 // 依赖变化：修改首批陈述所依赖的字段对象，扇出应在原文修订不变时重开整理。
 await h.pauseWorker();
 const field=(await h.request('/knowledge/'+fieldObject.id)).value;
 const writable=field.entries.find(entry=>!['ddl','etl','type','lineage'].includes(entry.path));
 assert.ok(writable,'字段对象必须有可人工更新的条目');
 const edited=await h.request('/knowledge/'+fieldObject.id,{operation_id:randomUUID(),expected_version:field.version,entry_id:writable.path,value:'人工更新的字段含义，用于触发依赖变化'},'alice','PATCH');
 assert.equal(edited.status,200,JSON.stringify(edited.value));
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE kind='source_fanout'`)[0].n,1,'依赖保存登记来源扇出作业');
 await h.resumeWorker();
 await until(async()=>{const row=preparation();return row&&row.status==='ready'&&row.call===null&&Number(row.seq)===2?row:false;},'依赖变化后同修订重开并完成新批',120000);
 const reopened=preparation();
 assert.equal(reopened.seq,2,'重开批沿持久序列单调递增，不回到旧批身份');
 const afterCalls=callsNow();
 assert.equal(afterCalls.length,4,'重开只新增一次分析与复核调用');
 assert.ok(afterCalls.every(call=>call.state==='settled'),'新批调用全部结算');
 const firstIds=new Set(firstCalls.map(call=>call.id));
 const added=afterCalls.filter(call=>!firstIds.has(call.id));
 assert.equal(added.length,2,'新批模型调用身份不与旧批相同');
 assert.equal(new Set(afterCalls.map(call=>call.id)).size,4,'旧批调用身份保持独立');
 const applyAfter=applyOperations();
 assert.equal(applyAfter.length,2,'新批应用身份与旧批不同且只应用一次');
 assert.equal(applyAfter.filter(id=>firstApply.includes(id)).length,1,'旧批应用身份原样保留');
 const refreshed=(await h.request('/knowledge/'+tableObject.id)).value;
 const statements=refreshed.entries.flatMap(entry=>entry.suggestion?.statements??[]);
 assert.ok(statements.some(statement=>statement.text.includes('第2次整理')),'重开批成果实际覆盖当前建议');
 assert.ok(!statements.some(statement=>statement.text.includes('第1次整理')),'同身份陈述按新批成果更新');
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 assert.equal(ledger.calls,calls,'模型调用数与账目一致');
 assert.equal(ledger.reserved,0,'重开批不留下未决预留');
 assert.equal(batches.length,2,'重开只产生一轮新整理材料');
 checks.push('依赖变化重开使用新模型调用与应用身份，旧批成果保留且只应用一次');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0,calls}));
}finally{if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/source-repreparation.json',JSON.stringify({passed,checks,officialRequests:0,calls},null,2));}
