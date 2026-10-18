import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

const requests=[],checks=[],payloadBytes=[],draftPayloads=[];
let release,block=false,passed=false,h,supplementSource;
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 const material=JSON.parse(JSON.parse(raw).messages[1].content);requests.push(material);payloadBytes.push(Buffer.byteLength(raw));assert.ok(Buffer.byteLength(raw)<=65536);
 if(material.draft?.evidence_catalog){
  const expanded=structuredClone(material),catalog=expanded.draft.evidence_catalog;delete expanded.draft.evidence_catalog;
  for(const entry of expanded.draft.entries){entry.evidence=entry.evidence_indices.map(index=>catalog[index]);delete entry.evidence_indices;}
  const expandedRequest=JSON.parse(raw);expandedRequest.messages[1].content=JSON.stringify(expanded);
  draftPayloads.push({object_id:material.object.id,actual_bytes:Buffer.byteLength(raw),expanded_bytes:Buffer.byteLength(JSON.stringify(expandedRequest))});
 }
 if(block){block=false;await new Promise(r=>release=r);}
 const evidence=material.sources.filter(s=>s.body).map(s=>({source_id:s.source_id,version:s.version,location:'L1',quote:s.body.split('\n')[0].slice(0,60)}));
 const supplemental=material.sources.find(s=>s.source_id===supplementSource);
 const tail='原文尾部例外：退款拒收不计入。';
 const tailVisible=!!supplemental&&[supplemental.body,...(supplemental.supporting_excerpts??[]).map(e=>e.body)].some(body=>body.includes(tail));
 if(material.draft&&tailVisible)evidence.unshift({source_id:supplemental.source_id,version:supplemental.version,location:'原文尾部',quote:tail});
 const entries=material.object.entries.map(e=>({entry_id:e.entry_id,value:`合成解释：${e.path}${material.draft&&tailVisible?'；'+tail:''}`,gaps:['税费规则尚未提供'],evidence:evidence.slice(0,20)}));
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries})}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:4096,trial_call_limit:40,trial_cost_micros:'500000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
const column={id:'amount',name:'amount',data_type:'INTEGER',nullable:false,comment:''};
const table=(id,version='1',upstream=[])=>({id,name:id,platform_version:version,comment:'',columns:[column],ddl:`CREATE TABLE ${id}(amount INTEGER NOT NULL);`,node:{id:'load-'+id,sql:`INSERT INTO ${id} SELECT amount FROM raw_value; -- generation ${version}`,upstream_ids:upstream}});
try{
 h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();
 const initialSync=await h.request('/source-syncs',{operation_id:randomUUID()});assert.equal(initialSync.status,200,JSON.stringify(initialSync.value));
 const platformObjects=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'");
 const platformTarget=platformObjects.find(o=>o.kind==='table'&&o.name==='demo_order_detail');assert.ok(platformTarget);assert.notEqual(platformTarget.id,'table-demo_order_detail');
 const platformRead=(await h.request('/knowledge/'+platformTarget.id)).value;
 assert.equal((await h.request('/knowledge/'+platformTarget.id+'/reanalyze',{operation_id:randomUUID(),expected_version:platformRead.version})).status,200);
 const platformInput=h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${platformTarget.id}' ORDER BY created_at DESC LIMIT 1`)[0];
 const expectedUpstreams=['raw_order_lines','raw_payments','dim_customers'];
 for(const name of expectedUpstreams){
  const upstreamObject=platformObjects.find(o=>o.kind==='table'&&o.name===name);assert.ok(upstreamObject);
  const source=platformInput.sources.find(s=>s.source_id===upstreamObject.source_id);assert.ok(source,`${name} 直接上游资料缺失`);assert.ok(source.body.includes('CREATE TABLE '+name));
 }
 const guideDocuments=h.sql("SELECT body FROM knowledge_objects WHERE kind='document' AND source_id='business-guide'");
 assert.ok(guideDocuments.length>0);
 assert.ok(guideDocuments.some(document=>document.related_ids.includes(platformTarget.id)),'业务文档应关联平台稳定身份');
 assert.ok(guideDocuments.some(document=>platformInput.sources.some(source=>source.source_id==='document-'+document.id&&source.version===document.version&&source.body.trim())),'平台对象的预填材料应实际含业务文档');
 checks.push('实际合成平台稳定身份的预填输入包含业务文档，以及订单行、支付、客户三个上游DDL');
 // 下游位于首个目录页，上游在末页；其余表只是分页填充。
 const rows=[table('derived_values','1',['raw_values']),...Array.from({length:49},(_,i)=>table('filler_'+i)),table('raw_values')];
 const sync=async()=>{await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'prefill-materials',authoritative:true,tables:rows}));const r=await h.request('/source-syncs',{operation_id:randomUUID()});assert.equal(r.status,200,JSON.stringify(r.value));};
 await sync();
 const objects=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'");
 const target=objects.find(o=>o.name==='derived_values'),upstream=objects.find(o=>o.name==='raw_values');
 const doc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成金额单位说明',body:'amount 以元保存；业务日按 Asia/Shanghai 划分。',related_ids:[target.id,upstream.id],source_url:null})).value;
 const fieldDoc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'上游字段解释',body:'上游 amount 是原始金额，未进行币种换算。',related_ids:[objects.find(o=>o.name==='raw_values.amount').id],source_url:null})).value;
 const read=async id=>(await h.request('/knowledge/'+id)).value;
 const reanalyze=async()=>{const v=await read(target.id);const r=await h.request('/knowledge/'+target.id+'/reanalyze',{operation_id:randomUUID(),expected_version:v.version});assert.equal(r.status,200);return r.value;};
 const wait=async(state)=>until(async()=>{const v=await read(target.id);return v.prefill_status?.state===state?v:false;},'资料预填 '+state,45000);
 await reanalyze();await h.resumeWorker();let current=await wait('succeeded');
 assert.ok(draftPayloads.some(p=>p.object_id===platformTarget.id&&p.actual_bytes<p.expanded_bytes),'复核原引用只做无损去重以留出补料空间');
 const platformAttempt=h.sql(`SELECT JSON_OBJECT('state',state,'error_code',error_code) FROM prefill_attempts WHERE object_id='${platformTarget.id}' ORDER BY created_at DESC LIMIT 1`)[0];assert.equal(platformAttempt.state,'succeeded',JSON.stringify(platformAttempt));
 const input=requests.find(r=>r.object.id===target.id&&!r.draft);
 assert.ok(input.sources.some(s=>s.source_id===upstream.source_id&&s.body.includes('CREATE TABLE raw_values')));
 assert.ok(input.sources.some(s=>s.source_id==='document-'+doc.id&&s.version===doc.version&&s.body.includes('以元保存')));
 assert.ok(input.sources.some(s=>s.source_id==='document-'+fieldDoc.id&&s.body.includes('未进行币种换算')));
 assert.equal(input.coverage.state,'complete');assert.ok(input.object.entries.length>3);
 assert.ok(current.entries.filter(e=>!['ddl','etl','lineage','type'].includes(e.path)).every(e=>e.suggestion.gaps.includes('税费规则尚未提供')));
 assert.deepEqual(requests.find(r=>r.object.id===target.id&&r.draft).sources,input.sources);
 checks.push('普通目录多条目分析带齐同批上游及关联文档；两阶段固定同版资料并保存缺口');

 const cid=await h.create();let run=await h.capture(cid,'解释这张合成表');
 const manager=SessionManager.inMemory('/synthetic/data-agent');
 const freshReadRun=async()=>{assert.equal((await h.request('/conversations/'+run.conversation_id+'/cancel-run',{run_id:run.run_id,lease_epoch:run.lease_epoch})).status,200);h.releaseRun(run.run_id);run=await h.capture(await h.create(),'读取当前有效的合成资料');};
 const invoke=async(name,args)=>{
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
  assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
  return h.internal('/internal/data/tools',input);
 };
 let r=await invoke('search_knowledge',{query:'derived_values',limit:10});assert.equal(r.status,200);assert.ok(JSON.stringify(r.value).includes(target.id));
 r=await invoke('read_knowledge',{object_id:target.id,version:current.version,entry_id:'description'});assert.equal(r.status,200);
 let details=JSON.parse(r.value.data.entries[0].suggestion.details);assert.ok(details.gaps.includes('税费规则尚未提供'));assert.ok(details.evidence.some(e=>e.source_id==='document-'+doc.id));
 r=await invoke('read_source',{source_id:'document-'+doc.id,version:doc.version});assert.equal(r.status,200);assert.equal(r.value.data.body,'amount 以元保存；业务日按 Asia/Shanghai 划分。');
 checks.push('文档引用在搜索、知识工具正文和来源工具三条路径均可读');

 await h.pauseWorker();
 const human=await h.request('/knowledge/'+target.id,{operation_id:randomUUID(),expected_version:current.version,entry_id:'description',value:'人工有效定义'},'alice','PATCH');assert.equal(human.status,200);
 await reanalyze();await h.resumeWorker();current=await wait('succeeded');
 assert.equal(current.entries[0].effective_value,'人工有效定义');
 r=await invoke('read_knowledge',{object_id:target.id,version:current.version,entry_id:'description'});assert.equal(r.value.code,'stale_context');
 await freshReadRun();
 r=await invoke('read_knowledge',{object_id:target.id,version:current.version,entry_id:'description'});assert.equal(r.status,200,JSON.stringify(r.value));
 details=JSON.parse(r.value.data.entries[0].suggestion.details);assert.equal(details.value,'合成解释：description');assert.equal(r.value.data.entries[0].suggestion.application,'pending_review');
 checks.push('人工有效值保留，候选解释、候选缺口与依据一起回传并标记未采用');

 block=true;await reanalyze();await until(()=>release,'预填等待文档改版');
 const changed=await h.request('/knowledge/'+doc.id,{operation_id:randomUUID(),expected_version:doc.version,entry_id:'body',value:'amount 以元保存；新版只适用于已支付记录。'},'alice','PATCH');assert.equal(changed.status,200);
 release();release=undefined;await wait('superseded');await freshReadRun();
 assert.equal((await invoke('read_source',{source_id:'document-'+doc.id,version:doc.version})).value.code,'stale_knowledge');
 checks.push('模型进行期间文档改版，旧建议不采用，旧来源版本不可继续读');

 await reanalyze();current=await wait('succeeded');
 assert.equal((await h.request('/knowledge/'+doc.id+'/disable',{operation_id:randomUUID(),expected_version:changed.value.version})).status,200);
 await freshReadRun();r=await invoke('read_knowledge',{object_id:target.id,version:current.version});assert.equal(r.value.code,'stale_knowledge');
 const search=(await h.request('/knowledge?q=derived_values')).value;assert.ok(!search.objects.some(o=>o.id===target.id));
 checks.push('文档停用后引用它的知识无法继续用于读取或检索');

 // 自动重分析的下游先入库，上游在第二页更新；冻结时必须使用第二页新版本。
 await h.pauseWorker();rows[0]=table('derived_values','2',['raw_values']);rows[50]=table('raw_values','2');await sync();await h.resumeWorker();current=await wait('succeeded');
 const auto=requests.filter(r=>r.object.id===target.id&&!r.draft).at(-1);
 assert.ok(auto.sources.some(s=>s.source_id===upstream.source_id&&s.version==='2'&&s.body.includes('generation 2')));
 checks.push('同批目录后续页上游改版进入自动预填，不使用首个页面时的旧版本');

 await h.pauseWorker();
 const sourceDocument=h.sql("SELECT body FROM knowledge_objects WHERE kind='document' AND source_id IS NOT NULL ORDER BY id LIMIT 1")[0];
 assert.ok(sourceDocument);
 const queuedDoc=await h.request('/knowledge/'+sourceDocument.id+'/reanalyze',{operation_id:randomUUID(),expected_version:sourceDocument.version});assert.equal(queuedDoc.status,200);
 const material=h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${sourceDocument.id}' ORDER BY created_at DESC LIMIT 1`)[0];assert.ok(!material.sources.some(s=>s.source_id==='document-'+sourceDocument.id));
 await h.resumeWorker();await until(async()=>{const v=await read(sourceDocument.id);return v.prefill_status?.state==='succeeded';},'文档重分析完成',45000);
 assert.ok((await h.request('/knowledge?q='+encodeURIComponent(sourceDocument.name))).value.objects.some(o=>o.id===sourceDocument.id));
 checks.push('重分析有来源文档后仍可检索，不将其自身旧正文作为依据');
 await h.pauseWorker();
 const boundedBody='首部规则：金额以元保存。\n'+'普通说明。\n'.repeat(1000)+'中段规则：按付款日归属。\n'+'普通说明。\n'.repeat(1000)+'原文尾部例外：退款拒收不计入。\n';
 const bounded=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'可续读合成规则',body:boundedBody,related_ids:[target.id],source_url:null})).value;
 supplementSource='document-'+bounded.id;
 const beforeSupplement=requests.length;
 await reanalyze();await h.resumeWorker();current=await wait('succeeded');
 const pair=requests.slice(beforeSupplement).filter(r=>r.object.id===target.id);
 assert.equal(pair.length,2,'补料仍只有分析/复核两次调用');
 const first=pair[0].sources.find(s=>s.source_id===supplementSource),second=pair[1].sources.find(s=>s.source_id===supplementSource);
 assert.ok(first.body.includes('首部规则'));assert.ok(first.body.includes('中段规则'));assert.ok(!first.body.includes('原文尾部例外'));
 const visible=[{...second.body_range,body:second.body},...(second.supporting_excerpts??[])];
 assert.ok(visible.some(p=>p.body.includes('原文尾部例外')),'第二阶段真正获得首阶段缺失的尾部原文');
 assert.ok(visible.some(p=>p.body.includes('首部规则')),'草稿原引文仍在复核可见材料');
 assert.ok(!visible.some(p=>p.body.includes('中段规则')),'累计看过的中段不冒充本轮可见');
 for(const part of visible){
  assert.equal(Buffer.from(boundedBody).subarray(part.start_byte,part.end_byte).toString('utf8'),part.body);
  assert.equal(part.start_line,Buffer.from(boundedBody).subarray(0,part.start_byte).toString('utf8').split('\n').length);
 }
 for(const stage of pair)assert.ok(stage.sources.reduce((sum,s)=>sum+Buffer.byteLength(s.body)+(s.supporting_excerpts??[]).reduce((n,p)=>n+Buffer.byteLength(p.body),0),0)<=24576);
 const coverage=pair[1].coverage.source_ranges.find(s=>s.source_id===supplementSource);
 assert.deepEqual(coverage.seen_byte_ranges,[{start:0,end:Buffer.byteLength(boundedBody)}]);
 assert.equal(coverage.visible_byte_ranges.length,2);assert.equal(second.complete,false);assert.equal(pair[1].coverage.state,'incomplete');
 const attempt=h.sql(`SELECT result_json FROM prefill_attempts WHERE object_id='${target.id}' AND state='succeeded' ORDER BY created_at DESC LIMIT 1`)[0];
 const storedSource=attempt.review_input.sources.find(s=>s.source_id===supplementSource);
 assert.equal(storedSource.body,second.body);assert.deepEqual(storedSource.supporting_excerpts,second.supporting_excerpts);
 assert.equal(current.entries[0].effective_value,'人工有效定义');
 const suggestion=current.entries.find(e=>e.path==='description').suggestion;
 assert.ok(suggestion.value.includes('原文尾部例外'));assert.ok(suggestion.evidence.some(e=>e.source_id===supplementSource&&e.quote.includes('原文尾部例外')));
 assert.deepEqual(suggestion.material_coverage.source_ranges,pair[1].coverage.source_ranges);
 checks.push('固定两次调用内同版续读尾部、保留草稿引文；字节/行号准确，累计与本轮范围分开，最终新引用校验和补料输入持久保存且人工值不变');
 await h.pauseWorker();
 assert.equal((await h.request('/knowledge/'+bounded.id+'/disable',{operation_id:randomUUID(),expected_version:bounded.version})).status,200);
 supplementSource=undefined;
 const long=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'长合成业务文档',body:'未知税费。'.repeat(6000),related_ids:[target.id],source_url:null})).value;
 await reanalyze();const queued=h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${target.id}' ORDER BY created_at DESC LIMIT 1`)[0];
 assert.equal(queued.coverage.state,'incomplete');const longSource=queued.sources.find(s=>s.source_id==='document-'+long.id);assert.equal(longSource.complete,false);assert.ok(longSource.body.length>0);assert.ok(queued.coverage.gaps.some(g=>g.reason==='body_limit'));
 assert.ok(queued.sources.reduce((n,s)=>n+Buffer.byteLength(s.body),0)<=24576);
 checks.push('资料超限保留明确缺口和非空文档片段，未将截断当全文');
 rows[0]=table('derived_values','3',['raw_values']);rows[0].ddl+='\n-- '+ '长DDL说明'.repeat(6000);await sync();await h.resumeWorker();await wait('succeeded');
 const large=requests.filter(r=>r.object.id===target.id&&!r.draft).at(-1);
 const largeReview=requests.filter(r=>r.object.id===target.id&&r.draft).at(-1);
 assert.equal(largeReview.coverage.state,'incomplete');
 assert.ok(largeReview.coverage.source_ranges.some(s=>s.seen_byte_ranges.at(-1).end<s.total_bytes),'两阶段仍读不完的超长资料继续保留未读范围');
 assert.equal(large.coverage.state,'incomplete');assert.ok(large.object.metadata.filter(e=>['ddl','etl'].includes(e.path)).every(e=>!('quote' in e.source_facts)&&!('value' in e.source_facts)));
 assert.ok(payloadBytes.every(n=>n<=65536));
 checks.push('长DDL与长文档的重复正文不藏在metadata，分析/复核请求均受完整请求体上限约束');
 passed=true;console.log(JSON.stringify({passed,checks,calls:requests.length,officialRequests:0,maxPayloadBytes:Math.max(...payloadBytes),draftPayloads}));
}finally{release?.();if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-prefill-materials.json',JSON.stringify({passed,checks,calls:requests.length,officialRequests:0,maxPayloadBytes:Math.max(...payloadBytes),draftPayloads},null,2));}
