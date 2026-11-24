import {synchronizeSources} from './source-sync.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile,readFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';
import {validateContract} from '../../packages/contracts/validate.ts';

const requests=[],checks=[],payloadBytes=[],draftPayloads=[],inputBudgets=[];
const fieldEvidence=process.argv.includes('--field-evidence');
const expandDraft=draft=>{
 const expanded=structuredClone(draft),catalog=expanded.evidence_catalog;delete expanded.evidence_catalog;
 if(catalog)for(const entry of expanded.entries){entry.evidence=entry.evidence_indices.map(index=>catalog[index]);delete entry.evidence_indices;}
 return expanded;
};
let release,block=false,passed=false,h,supplementSource,providerFailure,coreEvidence;
const provider=createServer(async(req,res)=>{
 try{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 const request=JSON.parse(raw),material=JSON.parse(request.messages[1].content);
 const reference=JSON.parse(execFileSync('.local/tokenizer-reference-venv/bin/python',['-I','tests/mvp/tokenizer-reference.py'],{input:raw,encoding:'utf8',env:{...process.env,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'}}));
 const inputUpper=reference.tokens;
 assert.ok(inputUpper<=profile.input_limit,'同一完整请求含system/展开Schema/draft/supports的公开BPE分片估计不得超过本地输入策略');
 assert.equal(request.max_tokens,profile.output_limit,'实际发送输出cap须等于预留profile');
 const stage=material.draft?'review':'analysis';let callId;
 if(material.source){
  const sourceHex=Buffer.from(JSON.stringify(material.source)).toString('hex'),revisionHex=Buffer.from(material.revision).toString('hex');
  const batches=h.sql(`SELECT JSON_OBJECT('source_id',source_id,'revision',CAST(revision AS CHAR),'method',method_version,'sequence',CAST(batch_sequence AS CHAR)) FROM source_preparations WHERE JSON_EXTRACT(frozen_batch,'$.source')=CAST(CONVERT(0x${sourceHex} USING utf8mb4) AS JSON) AND revision=CAST(CONVERT(0x${revisionHex} USING utf8mb4) AS UNSIGNED) AND call_state='${stage}'`);
  assert.equal(batches.length,1,'来源请求对应自己的冻结版本/阶段批次');const batch=batches[0];
  callId=createHash('sha256').update(`["source-preparation",${JSON.stringify(batch.source_id)},${batch.revision},${JSON.stringify(batch.method)},${batch.sequence}${stage==='review'?',"review"':''}]`).digest('hex');
 }else{
  const objectHex=Buffer.from(material.object.id).toString('hex');
  const versions=sources=>sources.map(source=>[source.source_id,source.version]).sort((a,b)=>a[0].localeCompare(b[0]));
  const delivered=JSON.stringify(versions(material.sources));
  const attempts=h.sql(`SELECT JSON_OBJECT('id',id,'sources',JSON_EXTRACT(input_json,'$.sources')) FROM prefill_attempts WHERE object_id=CONVERT(0x${objectHex} USING utf8mb4) AND state='issued'`).filter(attempt=>JSON.stringify(versions(attempt.sources))===delivered);
  assert.equal(attempts.length,1,'对象请求对应自己的活动attempt与同版来源');
  callId=attempts[0].id+(stage==='review'?':review':'');
 }
 const reservations=h.sql(`SELECT JSON_OBJECT('id',id,'reserved_micros',reserved_micros,'budget',budget_json) FROM maintenance_model_calls WHERE id='${callId}' AND trial_id='${profile.trial_id}' AND state='issued'`);
 assert.equal(reservations.length,1,'按原调用身份关联本次HTTP前已提交的维护预留，其他issued/unknown保持');
 assert.equal(reservations[0].reserved_micros,319488,'官方总窗口1048576输入与本次4096输出按峰值0.3/1.2美元每百万tokens向上取整预留319488微美元');
 assert.deepEqual(reservations[0].budget.profile,profile,'本次实际请求绑定原冻结profile');
 assert.equal(reservations[0].budget.input_tokens_upper,1048576);
 assert.equal(reservations[0].budget.output_tokens_max,request.max_tokens);
 inputBudgets.push({object_id:material.object?.id??material.source?.id,stage,request_sha256:createHash('sha256').update(raw).digest('hex'),request_bytes:Buffer.byteLength(raw),estimated_input_tokens:inputUpper,local_input_limit:profile.input_limit,reference,reserved_input:1048576,max_tokens:request.max_tokens,reserved_output:profile.output_limit,reservation:reservations[0]});
 if(request.tools?.[0]?.function.name==='submit_semantic_preparation'){
  assert.ok(['document','platform'].includes(material.source?.kind));assert.ok(Array.isArray(material.segments));
  // 人工改版可在普通worker运行时排来源整理；按其独立合同回应，不混入对象预填计数。
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_preparation',arguments:JSON.stringify({statements:[],relations:[],unresolved:['此协议端点只验证对象预填，来源整理另有专用验收'],semantic_status:'partial'})}}]}}],usage:{prompt_tokens:50,completion_tokens:10}}));
  return;
 }
 assert.equal(request.tools?.[0]?.function.name,'submit_semantic_prefill');assert.ok(Array.isArray(material.sources));
 requests.push(material);payloadBytes.push(Buffer.byteLength(raw));assert.ok(Buffer.byteLength(raw)<=65536);
 if(material.draft?.evidence_catalog){
  const expanded=structuredClone(material),catalog=expanded.draft.evidence_catalog;delete expanded.draft.evidence_catalog;
  for(const entry of expanded.draft.entries){entry.evidence=entry.evidence_indices.map(index=>catalog[index]);delete entry.evidence_indices;}
  const expandedRequest=JSON.parse(raw);expandedRequest.messages[1].content=JSON.stringify(expanded);
  draftPayloads.push({object_id:material.object.id,actual_bytes:Buffer.byteLength(raw),expanded_bytes:Buffer.byteLength(JSON.stringify(expandedRequest))});
 }
 if(block){block=false;await new Promise(r=>release=r);}
 if(fieldEvidence){
  const type=material.object.metadata.find(entry=>entry.path==='type');
  assert.ok(type?.source_facts.quote,'字段实际类型原句应作为待分析metadata交付');
  const fact=type.source_facts;
  const entries=material.object.entries.map(entry=>({entry_id:entry.entry_id,value:'合成字段说明：'+entry.path,
   gaps:[],evidence:[{source_id:fact.source_id,version:fact.version,location:fact.location,quote:fact.quote},coreEvidence]}));
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries})}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
  return;
 }
 const evidence=material.sources.filter(s=>s.body).map(s=>({source_id:s.source_id,version:s.version,location:'L1',quote:s.body.split('\n')[0].slice(0,60)}));
 const supplemental=material.sources.find(s=>s.source_id===supplementSource);
 const tail='原文尾部例外：退款拒收不计入。';
 const tailVisible=!!supplemental&&[supplemental.body,...(supplemental.supporting_excerpts??[]).map(e=>e.body)].some(body=>body.includes(tail));
 if(material.draft&&tailVisible)evidence.unshift({source_id:supplemental.source_id,version:supplemental.version,location:'原文尾部',quote:tail});
 const entries=material.object.entries.map(e=>({entry_id:e.entry_id,value:`合成解释：${e.path}${material.draft&&tailVisible?'；'+tail:''}`,gaps:['税费规则尚未提供'],evidence:evidence.slice(0,20)}));
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries})}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
 }catch(error){providerFailure??=error;if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic_prefill_material_assertion'}}));}
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
// 纯回环材料夹具需容纳保留的unknown和下一笔319488微美元预留；金额仍遵守原Schema，
// 调用上限40不变。真实试用账本不变，费用拒绝边界另由maintenance-billing验证。
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:4096,trial_call_limit:40,trial_cost_micros:'5000000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
validateContract('ModelProfile',profile);
// 本检查只验证对象级预填材料；文档与来源的整理消费链路分别由check-document-preparation
// 与check-source-preparation单独验收，普通worker暂停时移除本次隔离库的准备待办。
const isolatePreparation=()=>h.sql("DELETE FROM background_jobs WHERE kind='prepare_source'");
const column={id:'amount',name:'amount',data_type:'INTEGER',nullable:false,comment:''};
const table=(id,version='1',upstream=[])=>({id,name:id,platform_version:version,comment:'',columns:[column],ddl:`CREATE TABLE ${id}(amount INTEGER NOT NULL);`,node:{id:'load-'+id,sql:`INSERT INTO ${id} SELECT amount FROM raw_value; -- generation ${version}`,upstream_ids:upstream}});
try{
 let sourceDirectory;
 if(fieldEvidence){
  sourceDirectory=process.cwd()+'/.local/checks/prefill-field-source-'+randomUUID();
  await mkdir(sourceDirectory,{recursive:true});
  for(const entry of await readdir('docs/sources',{withFileTypes:true}))if(entry.isFile())await copyFile('docs/sources/'+entry.name,sourceDirectory+'/'+entry.name);
  const schema=await readFile(sourceDirectory+'/schema.sql','utf8');
  await writeFile(sourceDirectory+'/schema.sql','-- 合成无关结构说明。\n'.repeat(4000)+schema);
  const guide=await readFile(sourceDirectory+'/business-guide.md','utf8');
  await writeFile(sourceDirectory+'/business-guide.md','合成无关资料段落。\n'.repeat(4000)+guide);
 }
 h=await harness({capture:true,startWorker:false,...(sourceDirectory?{sourceDirectory}:{}),env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();
 let validationOutput='';
 const validationCode=await new Promise((resolve,reject)=>{
  const child=spawn(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--lib','modules::ingestion::prefill','--','--include-ignored'],{env:h.env,stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{validationOutput+=chunk;process.stdout.write(chunk);});
  child.once('error',reject);child.once('close',resolve);
 });
 await writeFile(h.directory+'/prefill-validation.log',validationOutput);assert.equal(validationCode,0);assert.match(validationOutput,/test result: ok\. [1-9]\d* passed; 0 failed/);
 checks.push('原预填模块完整检查含两个合法密集输入容量反例，错误修订/伪引文/条目覆盖/坏JSON原断言保持；准备不签发预留或发网络');
 if(fieldEvidence){
  const field=(await h.request('/knowledge/field-paid_amount_cents')).value;
  const meaning=field.entries.find(entry=>entry.path==='meaning').source_facts;
  coreEvidence={source_id:meaning.source_id,version:meaning.version,location:meaning.location,quote:meaning.quote};
  const queued=await h.request('/knowledge/'+field.id+'/reanalyze',{operation_id:randomUUID(),expected_version:field.version});
  assert.equal(queued.status,200,JSON.stringify(queued.value));isolatePreparation();
  await h.resumeWorker();
  const done=await until(async()=>{if(providerFailure)throw providerFailure;const v=(await h.request('/knowledge/'+field.id)).value;
   return v.prefill_status?.state&&!['queued','issued'].includes(v.prefill_status.state)&&v;},'晚位置字段预填终态',45000);
  await h.pauseWorker();
  await writeFile(h.directory+'/field-visible-materials.json',JSON.stringify({requests,status:done.prefill_status,payloadBytes},null,2));
  assert.equal(done.prefill_status.state,'succeeded',JSON.stringify(done.prefill_status));
  assert.equal(requests.length,2,'原句引文可核后进入原分析/复核两阶段，不增加模型回合');
  const original=await readFile(sourceDirectory+'/schema.sql','utf8');
  for(const material of requests){
   const metadata=material.object.metadata.find(entry=>entry.path==='type').source_facts;
   const source=material.sources.find(source=>source.source_id===metadata.source_id&&source.version===metadata.version);
   const portions=[{...source.body_range,body:source.body},...(source.supporting_excerpts??[])];
   assert.ok(portions.some(part=>part.body.includes(metadata.quote)),'实际metadata原句须在同版可引材料内');
   for(const part of portions)assert.equal(Buffer.from(original).subarray(part.start_byte,part.end_byte).toString('utf8'),part.body);
   assert.ok(material.coverage.source_ranges.some(range=>range.source_id===source.source_id),'最终可见范围进入原coverage');
   const core=material.sources.find(source=>source.source_id===coreEvidence.source_id&&source.version===coreEvidence.version);
   assert.ok([core.body,...(core.supporting_excerpts??[]).map(part=>part.body)].some(body=>body.includes(coreEvidence.quote)),
    '语义目标自身原句也必须进入实际材料，不能只优先metadata而挤掉对象定义');
  }
  assert.ok(done.entries.find(entry=>entry.path==='meaning').suggestion.evidence.some(e=>e.quote.includes('paid_amount_cents INTEGER')));
  checks.push('schema后部字段类型原句在同版实际材料/最终coverage/引文白名单中一致，正常进入复核及正式建议，容量保持原上限');
 }else{
 const initialSync=await synchronizeSources(h);assert.equal(initialSync.value.status,'completed');assert.equal(initialSync.status,200,JSON.stringify(initialSync.value));
 // 本检查只验证对象级预填材料；来源整理消费链路由check-source-preparation单独验收。
 h.sql("DELETE FROM background_jobs WHERE kind='prepare_source'");
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
 const sync=async()=>{await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'prefill-materials',authoritative:true,tables:rows}));const r=await synchronizeSources(h);assert.equal(r.value.status,'completed');assert.equal(r.status,200,JSON.stringify(r.value));
 // 本检查只验证对象级预填材料；来源整理消费链路由check-source-preparation单独验收。
 h.sql("DELETE FROM background_jobs WHERE kind='prepare_source'");};
 await sync();
 const objects=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'");
 const target=objects.find(o=>o.name==='derived_values'),upstream=objects.find(o=>o.name==='raw_values');
 const doc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成金额单位说明',body:'amount 以元保存；业务日按 Asia/Shanghai 划分。',related_ids:[target.id,upstream.id],source_url:null})).value;
 const fieldDoc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'上游字段解释',body:'上游 amount 是原始金额，未进行币种换算。',related_ids:[objects.find(o=>o.name==='raw_values.amount').id],source_url:null})).value;
 isolatePreparation();
 const read=async id=>(await h.request('/knowledge/'+id)).value;
 const reanalyze=async()=>{const v=await read(target.id);const r=await h.request('/knowledge/'+target.id+'/reanalyze',{operation_id:randomUUID(),expected_version:v.version});assert.equal(r.status,200);return r.value;};
 const wait=async(state)=>until(async()=>{if(providerFailure)throw providerFailure;const v=await read(target.id);return v.prefill_status?.state===state?v:false;},'资料预填 '+state,45000);
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
 const readDescription=()=>invoke('read_knowledge',{items:[{kind:'knowledge',
  ref:{object_id:target.id,version:current.version,path:'description'}}]});
 const expectedSource='amount 以元保存；业务日按 Asia/Shanghai 划分。';
 const readDocument=()=>invoke('read_source',{citation:{source:{kind:'document',id:doc.id},
  revision:doc.version,locator:{offset:0,length:[...expectedSource].length}}});
 let r=await invoke('search_knowledge',{query:'derived_values',limit:10});assert.equal(r.status,200);assert.ok(JSON.stringify(r.value).includes(target.id));
 r=await readDescription();assert.equal(r.status,200);
 assert.equal(r.value.data.items[0].state,'ok');
 const originalSuggestion=current.entries.find(entry=>entry.path==='description').suggestion;
 assert.ok(originalSuggestion.gaps.includes('税费规则尚未提供'));
 assert.ok(originalSuggestion.evidence.some(e=>e.source_id==='document-'+doc.id));
 r=await readDocument();assert.equal(r.status,200);assert.equal(r.value.data.text,expectedSource);
 checks.push('文档引用在搜索、知识工具正文和来源工具三条路径均可读');

 await h.pauseWorker();
 const human=await h.request('/knowledge/'+target.id,{operation_id:randomUUID(),expected_version:current.version,entry_id:'description',value:'人工有效定义'},'alice','PATCH');assert.equal(human.status,200);
 const priorVersion=current.version;
 await reanalyze();await h.resumeWorker();current=await wait('succeeded');
 assert.equal(current.entries[0].effective_value,'人工有效定义');
 // 封板后不按run新旧整次拒绝：旧run以改版前版本读取仍判失效，按当前版本读到人工生效值。
 r=await invoke('read_knowledge',{items:[{kind:'knowledge',ref:{object_id:target.id,version:priorVersion,path:'description'}}]});
 assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(r.value.data.items[0].state,'stale');
 r=await readDescription();assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(r.value.data.items[0].state,'ok');assert.equal(r.value.data.items[0].content,'人工有效定义');
 await freshReadRun();
 r=await readDescription();assert.equal(r.status,200,JSON.stringify(r.value));
 assert.equal(r.value.data.items[0].state,'ok');
 assert.equal(r.value.data.items[0].content,'人工有效定义');
 const description=current.entries.find(entry=>entry.path==='description');
 assert.equal(description.suggestion.value,'合成解释：description');
 assert.notEqual(description.effective_value,description.suggestion.value);
 checks.push('人工有效值保留，候选解释、候选缺口与依据一起回传并标记未采用');

 block=true;await reanalyze();await until(()=>release,'预填等待文档改版');
 const changed=await h.request('/knowledge/'+doc.id,{operation_id:randomUUID(),expected_version:doc.version,entry_id:'body',value:'amount 以元保存；新版只适用于已支付记录。'},'alice','PATCH');assert.equal(changed.status,200);
 isolatePreparation();
 release();release=undefined;await wait('superseded');await freshReadRun();
 assert.equal((await readDocument()).value.code,'stale_source');
 checks.push('模型进行期间文档改版，旧建议不采用，旧来源版本不可继续读');

 await reanalyze();current=await wait('succeeded');
 assert.equal((await h.request('/knowledge/'+doc.id+'/disable',{operation_id:randomUUID(),expected_version:changed.value.version})).status,200);
 // 封板后按条目核对：人工生效值不采用候选所引文档，仍可读；采用该文档建议的条目判失效。
 await freshReadRun();r=await readDescription();assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(r.value.data.items[0].state,'ok');assert.equal(r.value.data.items[0].content,'人工有效定义');
 r=await invoke('read_knowledge',{items:[{kind:'knowledge',ref:{object_id:target.id,version:current.version,path:'grain'}}]});
 assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(r.value.data.items[0].state,'stale');
 const search=(await h.request('/knowledge?q=derived_values')).value;assert.ok(!search.objects.some(o=>o.id===target.id));
 checks.push('文档停用后采用它的条目无法继续读取，对象不再可检索；人工生效值仍可读');

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
 isolatePreparation();
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
 const terminal=h.sql(`SELECT JSON_OBJECT('input',input_json,'result',result_json) FROM prefill_attempts WHERE object_id='${target.id}' AND state='succeeded' ORDER BY created_at DESC LIMIT 1`)[0];
 const attempt=terminal.result,storedSource=terminal.input.sources.find(s=>s.source_id===supplementSource);
 assert.ok(storedSource);assert.equal(storedSource.version,second.version);assert.equal(storedSource.body_range.total_bytes,Buffer.byteLength(boundedBody));
 assert.ok(!('body' in storedSource)&&!('supporting_excerpts' in storedSource),'终态释放临时来源正文，原来源/修订/范围仍在');
 assert.ok(!('frozen_review_sources' in terminal.input)&&!('entries' in terminal.input.object));
 assert.ok(!('review_input' in attempt),'终态不留复核输入正文');
 assert.deepEqual(attempt.material_coverage,pair[1].coverage,'复核可见与累计范围继续保留');
 assert.deepEqual(attempt.analysis.entries,expandDraft(pair[1].draft).entries,'原分析结果与引文保留');
 assert.ok(attempt.review.entries.some(entry=>entry.evidence.some(e=>e.source_id===supplementSource&&e.quote.includes('原文尾部例外'))),'复核分析结果与尾部引文保留');
 assert.equal(current.entries[0].effective_value,'人工有效定义');
 const suggestion=current.entries.find(e=>e.path==='description').suggestion;
 assert.ok(suggestion.value.includes('原文尾部例外'));assert.ok(suggestion.evidence.some(e=>e.source_id===supplementSource&&e.quote.includes('原文尾部例外')));
 assert.deepEqual(suggestion.material_coverage.source_ranges,pair[1].coverage.source_ranges);
 checks.push('固定两次调用内同版续读尾部、保留草稿引文；字节/行号准确，累计与本轮范围分开；终态释放补料正文并保留分析结果/引用/coverage，人工值不变');
 await h.pauseWorker();
 assert.equal((await h.request('/knowledge/'+bounded.id+'/disable',{operation_id:randomUUID(),expected_version:bounded.version})).status,200);
 supplementSource=undefined;
 const long=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'长合成业务文档',body:'未知税费。'.repeat(6000),related_ids:[target.id],source_url:null})).value;
 isolatePreparation();
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
 }
 if(providerFailure)throw providerFailure;
 passed=true;console.log(JSON.stringify({passed,checks,calls:requests.length,officialRequests:0,maxPayloadBytes:Math.max(...payloadBytes),draftPayloads,inputBudgets}));
}catch(error){throw providerFailure??error;}finally{release?.();if(fieldEvidence&&h)await writeFile(h.directory+'/field-material-requests.json',JSON.stringify({requests,payloadBytes,passed},null,2));if(h){await writeFile(h.directory+'/prefill-budget-state.json',JSON.stringify({trials:h.sql("SELECT JSON_OBJECT('id',id,'state',state,'calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros,'cap',cost_limit_micros) FROM model_trials"),calls:h.sql("SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros,'usage',usage_json) FROM maintenance_model_calls"),attempts:h.sql("SELECT JSON_OBJECT('id',id,'object',object_id,'state',state,'error',error_code) FROM prefill_attempts")},null,2));await h.close();}provider.closeAllConnections();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-prefill-materials.json',JSON.stringify({passed,checks,calls:requests.length,officialRequests:0,maxPayloadBytes:Math.max(...payloadBytes),draftPayloads,inputBudgets},null,2));}
if(!fieldEvidence){
 const {checkMaintenanceBilling}=await import('./check-maintenance-billing.mjs');
 await checkMaintenanceBilling();
}
