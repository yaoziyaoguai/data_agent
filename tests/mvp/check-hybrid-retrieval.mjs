import {synchronizeSources} from './source-sync.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {harness,until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';
import {targets,topics,table} from './shared-retrieval-fixture.mjs';
const provider=await embeddingProvider();

const collection='da_app_'+randomUUID().replaceAll('-','');
const legacyCollection=collection+'_legacy';
let unavailable=false,loseUpsert=false,upserts=0,queries=0,h,passed=false,created=false,buildSeconds=null;
const checks=[],latencies=[],indexObservations=[];
const proxy=createServer(async(req,res)=>{
 try{
  if(unavailable){res.writeHead(503,{'content-type':'application/json'});res.end('{"code":1}');return;}
  let body='';req.setEncoding('utf8');for await(const part of req)body+=part;
  if(req.url.endsWith('/upsert'))upserts++;if(req.url.endsWith('/query'))queries++;
  const remote=await fetch('http://127.0.0.1:19531'+req.url,{method:'POST',headers:{'content-type':'application/json',authorization:req.headers.authorization},body});
  const result=await remote.text();
  if(req.url.endsWith('/upsert')&&loseUpsert){loseUpsert=false;res.destroy();return;}
  res.writeHead(remote.status,{'content-type':'application/json'});res.end(result);
 }catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"code":1}');}
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const tables=[...targets.map(([id,text])=>table(id,text)),...Array.from({length:1200},(_,i)=>table('synthetic_catalog_'+String(i).padStart(4,'0'),topics[i%topics.length]))];
// 末尾对象（存储顺序最后）带多词高相关标记：不仅测精确名称，含义词也要召回末尾项。
tables[tables.length-1].comment+='。末尾校准锚点：极光漂移多词高相关专用标记。';
const token=(await readFile('.local/infra/milvus-root-password','utf8')).trim();
const milvus=async(path,body)=>{
 const response=await fetch('http://127.0.0.1:19531/v2/vectordb/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer root:'+token},body:JSON.stringify({dbName:'default',collectionName:collection,...body})});
 const result=await response.json();assert.equal(result.code,0);return result.data;
};
const call0=async(path,body)=>{ // 按显式集合名直连（代次集合核对用）
 const response=await fetch('http://127.0.0.1:19531/v2/vectordb/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer root:'+token},body:JSON.stringify({dbName:'default',...body})});
 return (await response.json()).data;
};
const query=async text=>{const start=performance.now();const response=await h.request('/knowledge?q='+encodeURIComponent(text));latencies.push(performance.now()-start);assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
const states=()=>h.sql("SELECT JSON_OBJECT('pending',SUM(vector_state IN ('pending','sending','unknown')),'failed',SUM(vector_state='failed'),'indexed',SUM(vector_state='indexed')) FROM knowledge_index_jobs")[0];
const waitCurrentIndex=async label=>{
 await until(async()=>{
  const state=states();assert.equal(state.failed,0);if(state.pending!==0){await new Promise(r=>setTimeout(r,500));return false;}
  // 批次间没有pending不代表目标代次已全部重建；由正式API核对当前代次覆盖。
  const response=await h.request('/knowledge?q=synthetic_catalog_1199');assert.equal(response.status,200);
  const coverage=response.value.search_coverage;
  indexObservations.push({stage:label,pending:state.pending,indexState:coverage.index_state,vectorState:coverage.vector_state});
  return coverage.index_state==='current'&&coverage.vector_state==='available';
 },label,1500000);
};
try{
 // 独立保留一个旧形状集合；测试显式配置并准备新目标，普通查询不得换库。
 const legacySchema={dimension:1024,idType:'VarChar',autoID:false,primaryFieldName:'id',
  vectorFieldName:'vector',metricType:'COSINE',consistencyLevel:'Strong',
  params:{max_length:'128','enableDynamicField':true}};
 await milvus('collections/create',{...legacySchema,collectionName:legacyCollection});
 h=await harness({startWorker:false,env:{...provider.env,DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+proxy.address().port,DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
 const prepared=await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()});assert.equal(prepared.status,200,JSON.stringify(prepared.value));
 await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-scale',authoritative:true,tables}));
 const start=performance.now();assert.equal((await synchronizeSources(h)).value.status, 'completed');
 const imported=h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_objects WHERE source_id LIKE 'catalog-%'")[0].n;assert.equal(imported,2408);
 // 中文含义词与否定区分样本：原文无需等待整理即可进入索引并按BM25通道召回。
 const unpaid=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'unpaid_refund_rule',body:'未付款订单不产生退款，首次申请免费处理，最终解释以协议为准。',source_url:null,related_ids:[]});assert.equal(unpaid.status,200,JSON.stringify(unpaid.value));
 const paid=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'paid_refund_rule',body:'已付款订单可以申请退款，最终退款扣除手续费，运费除外。',source_url:null,related_ids:[]});assert.equal(paid.status,200,JSON.stringify(paid.value));
 // 原文目标的夹具是平台来源：文档保存不登记原文向量目标。夹具按登记入口写入的
 // 待办行直接登记，与导入的平台来源同经统一消费者入索引。
 const registerPlatformRaw=(id,body)=>{
  h.sql(`INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES('${id}','demo',1,'synthetic');`);
  h.sql(`INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES('${id}','demo','synthetic','platform','hybrid-retrieval','${id}',1,'${body}',1,'{}','synthetic','synthetic','exact',TRUE,'{}');`);
  h.sql(`INSERT INTO knowledge_index_jobs(target_kind,source_kind,object_id,version,space_id,origin_job_id,vector_attempts) VALUES('source_excerpt','platform','${id}',1,'demo',NULL,0);`);
 };
 const ruleSource='unpaid-refund-rule-raw';
 registerPlatformRaw(ruleSource,'未付款订单不产生退款，首次申请免费处理，最终解释以协议为准。');
 await h.resumeWorker();
 await waitCurrentIndex('应用千表索引全部完成');
 created=true;buildSeconds=(performance.now()-start)/1000;
 for(const [id,_text,question] of targets){
  let result;await until(async()=>{result=await query(id);return result.search_coverage.vector_state==='available';},'协议向量索引可查询',15000);
  assert.equal(result.retrieval_mode,'hybrid_authoritative');assert.equal(result.search_coverage.index_state,'current');
  assert.ok(result.objects.slice(0,6).some(o=>o.name===id),JSON.stringify({question,names:result.objects.map(o=>o.name)}));
 }
 checks.push({name:'1204张接口表和2408个新对象的真实应用索引；协议向量与精确通道可用（中文语义质量另做真实百炼小样）',imported,buildSeconds});
 // 两个明确集合互不代替；索引和读取只使用配置的目标。
 const legacyHas=(await milvus('collections/has',{collectionName:legacyCollection})).has;
 const hybridHas=(await call0('collections/has',{collectionName:collection})).has;
 const legacyRows=await milvus('entities/query',{collectionName:legacyCollection,filter:'object_id != ""',outputFields:['id'],limit:1,consistencyLevel:'Strong'});
 assert.ok(legacyHas&&hybridHas,'旧形状集合保留且显式目标集合已建立');
 assert.equal(legacyRows.length,0,'旧集合不被写入（统一切换按08，不长期双写）');
 checks.push({name:'显式准备chinese+BM25+dense测试集合；旧集合零写入且保留，不自动选择目标'});
 // BM25通道中文否定区分：未付款原文必须排在已付款原文之前，不能丢否定。
 // 查询含未付款规则独有的含义词（首次申请免费），BM25分差须压过dense伪向量的随机序。
 const negation=await query('未付款订单首次申请免费处理吗');
 const names=negation.objects.map(o=>o.name);
 const unpaidAt=names.indexOf('unpaid_refund_rule'),paidAt=names.indexOf('paid_refund_rule');
 assert.ok(unpaidAt>=0,'未付款规则必须可召回: '+JSON.stringify(names));
 if(paidAt>=0)assert.ok(unpaidAt<paidAt,'否定区分：未付款在已付款前 '+JSON.stringify(names));
 checks.push({name:'BM25通道经chinese分析器保留否定区分（未付款规则先于已付款规则召回）'});
 // 首次/最终/除外限定词与同词异义：限定词参与区分，同词异义靠共现词消歧——
 // 两条规则同含“最终”，查询“协议解释”须召回未付款、“手续费/除外”须召回已付款。
 const firstOnly=await query('首次申请免费处理吗');
 assert.ok(firstOnly.objects.slice(0,6).some(o=>o.name==='unpaid_refund_rule'),'首次限定词可召回: '+JSON.stringify(firstOnly.objects.map(o=>o.name).slice(0,6)));
 const exclusion=await query('已付款订单运费除外吗');
 const exNames=exclusion.objects.map(o=>o.name);
 const exPaid=exNames.indexOf('paid_refund_rule'),exUnpaid=exNames.indexOf('unpaid_refund_rule');
 assert.ok(exPaid>=0,'除外限定词可召回已付款规则: '+JSON.stringify(exNames));
 if(exUnpaid>=0)assert.ok(exPaid<exUnpaid,'除外区分：已付款在未付款前');
 const ambiguity=await query('最终解释以协议为准');
 const amNames=ambiguity.objects.map(o=>o.name);
 const amUnpaid=amNames.indexOf('unpaid_refund_rule'),amPaid=amNames.indexOf('paid_refund_rule');
 assert.ok(amUnpaid>=0,'最终+协议组合可召回未付款规则: '+JSON.stringify(amNames));
 if(amPaid>=0)assert.ok(amUnpaid<amPaid,'同词异义：同含“最终”，协议解释先于退款手续费');
 checks.push({name:'限定词（首次/最终/除外）参与区分；同词“最终”靠共现词消歧（协议解释vs退款手续费）'});
 // 05切片3：统一公共索引消费者——平台原文不等整理即入代次索引（kind=source_excerpt带
 // source_kind/修订/位置），文档不登记原文目标，v1知识检索不把摘录冒充知识对象。
 let excerptRows=[];
 await until(async()=>{
  excerptRows=await call0('entities/query',{collectionName:collection,filter:`kind == "source_excerpt" && source_kind == "platform" && object_id == "${ruleSource}"`,outputFields:['id','source_kind','object_version','char_offset','char_length','text'],limit:16,consistencyLevel:'Strong'});
  return excerptRows.length>0;
 },'raw摘录已入索引',60000);
 assert.ok(excerptRows.some(r=>(r.text||'').includes('未付款订单不产生退款')),'摘录正文含否定原文');
 for(const row of excerptRows){assert.equal(row.source_kind,'platform');assert.ok(Number(row.object_version)>=1);assert.ok(Number(row.char_length)>0);}
 // 原文尾部：长文把专有标记放到正文末尾，登记后末块必须入索引且覆盖推进到正文终点。
 const tailBody='开头说明。'+Array.from({length:400},(_,i)=>'第'+i+'行常规填充内容，用于把标记推到原文末尾。').join('')+'末尾专有标记：尾部锚点漂移校准专用词。';
 const tailDoc=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'long_tail_marker',body:tailBody,source_url:null,related_ids:[]});assert.equal(tailDoc.status,200,JSON.stringify(tailDoc.value));
 const tailSource='long-tail-marker-raw';registerPlatformRaw(tailSource,tailBody);
 let tailRows=[];
 await until(async()=>{
  tailRows=await call0('entities/query',{collectionName:collection,filter:`kind == "source_excerpt" && object_id == "${tailSource}"`,outputFields:['id','char_offset','char_length','text'],limit:64,consistencyLevel:'Strong'});
  // 等标记本身出现：摘录按批次推进，首批落地不代表末尾批次已到。
  return tailRows.some(r=>(r.text||'').includes('尾部锚点漂移校准'));
 },'长文末尾标记入摘录索引',120000);
 const tailCovered=Math.max(...tailRows.map(r=>Number(r.char_offset)+Number(r.char_length)));
 assert.ok(tailCovered>=tailBody.length-64,'末块覆盖推进到正文终点: '+tailCovered+'/'+tailBody.length
   +' rows='+tailRows.length+' tail='+JSON.stringify(tailRows.map(r=>[Number(r.char_offset),Number(r.char_length)]).slice(-3)));
 await until(()=>{
  const job=h.sql(`SELECT JSON_OBJECT('open',SUM(vector_state IN ('pending','sending','unknown')),'failed',SUM(vector_state='failed')) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${tailDoc.value.id}'`)[0];
  return Number(job.open||0)===0&&Number(job.failed||0)===0;
 },'长文知识条目索引收尾',60000);
 checks.push({name:'原文尾部：长文末尾标记入索引，末块覆盖到正文终点（cursor处理到末尾）'});
 const platformExcerpts=await call0('entities/query',{collectionName:collection,filter:'kind == "source_excerpt" && source_kind == "platform"',outputFields:['id','object_id','object_version'],limit:4,consistencyLevel:'Strong'});
 assert.ok(platformExcerpts.length>0,'平台来源原文同样不等整理即入摘录索引');
 const rawGuard=await query('未付款订单首次申请免费处理吗');
 assert.ok(rawGuard.objects.length>0&&rawGuard.objects.every(o=>o.kind!=='source_excerpt'),'v1知识检索不冒充raw摘录');
 // 作业如实收尾：夹具的原文目标结算、全库原文目标无失败（1204个平台来源目标量大，
 // 不要求在断言时限内全部完成，剩余保持真实pending由worker继续推进）。
 await until(()=>{
  const fixtureJobs=h.sql(`SELECT JSON_OBJECT('open',SUM(vector_state IN ('pending','sending','unknown')),'failed',SUM(vector_state='failed')) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='platform' AND object_id IN ('${ruleSource}','${tailSource}')`)[0];
  return Number(fixtureJobs.open||0)===0&&Number(fixtureJobs.failed||0)===0;
 },'平台raw作业收尾',60000);
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document'")[0].n,0,'文档保存不登记原文向量目标');
 const rawFailed=h.sql("SELECT JSON_OBJECT('failed',SUM(vector_state='failed')) FROM knowledge_index_jobs WHERE target_kind='source_excerpt'")[0].failed;
 assert.equal(Number(rawFailed||0),0,'raw作业不得失败');
 checks.push({name:'统一索引消费者：平台原文不等整理即入代次索引（kind=source_excerpt带source_kind/修订/位置/正文），文档不登记原文目标，作业如实收尾，v1不冒充raw'});
 // 整理状态≠索引滞后：pending与failed是两个独立夹具，各自有可查知识索引且状态如实，
 // 已完成索引照常召回，覆盖回执不因整理状态误报index_state未就绪。本电池不配置
 // 整理模型（没有真实模型授权），两个夹具按整理消费者写库的同一行形状显式建立：
 // 真实文档来源、真实知识索引目标、明确的semantic_status与error_code，不用“有行才
 // failed、否则pending”的分支冒充双覆盖。
 await h.pauseWorker();
 const prepState=source=>h.sql(`SELECT JSON_OBJECT('status',semantic_status,'error',error_code) FROM source_preparations WHERE source_id='${source}' ORDER BY method_version DESC LIMIT 1`)[0];
 const entryRowsOf=source=>{
  // 整理来源身份对文档带document-前缀，公共索引目标用裸对象id。
  const bare=source.startsWith('document-')?source.slice('document-'.length):source;
  return h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${bare}'`)[0].n;
 };
 const fixtures=[
  {source:`document-${unpaid.value.id}`,revision:unpaid.value.version,status:'pending',error:null},
  {source:`document-${paid.value.id}`,revision:paid.value.version,status:'failed',error:'model_fault'},
 ];
 for(const fixture of fixtures){
  h.sql(`INSERT INTO source_preparations(source_id,space_id,revision,method_version,input_fingerprint,dependency_fingerprint,semantic_status,error_code,unresolved) VALUES('${fixture.source}','demo',${fixture.revision},'semantic-preparation-2','fixture-input','fixture-dependency','${fixture.status}',${fixture.error===null?'NULL':`'${fixture.error}'`},CAST('[]' AS JSON)) ON DUPLICATE KEY UPDATE semantic_status=VALUES(semantic_status),error_code=VALUES(error_code),frozen_batch=NULL,pending_draft=NULL,call_state=NULL,issued_until=NULL`);
  assert.deepEqual(prepState(fixture.source),{status:fixture.status,error:fixture.error},`${fixture.status}夹具状态如实`);
  assert.ok(Number(entryRowsOf(fixture.source))>0,`${fixture.status}夹具仍有可查知识索引目标`);
 }
 const afterState=await query('未付款订单首次申请免费处理吗');
 assert.equal(afterState.search_coverage.index_state,'current','pending/failed整理状态都不误报索引未就绪');
 assert.ok(afterState.objects.some(o=>o.name==='unpaid_refund_rule'),'已完成索引照常召回');
 // 状态经正式对象读取路径可见，证明夹具落在真实读链上而不是旁表诱饵。
 const pendingRead=await h.request('/knowledge/'+unpaid.value.id);
 assert.equal(pendingRead.status,200,JSON.stringify(pendingRead.value));
 const failedRead=await h.request('/knowledge/'+paid.value.id);
 assert.equal(failedRead.status,200,JSON.stringify(failedRead.value));
 const pendingObject=pendingRead.value;
 const failedObject=failedRead.value;
 assert.equal(pendingObject.preparation_status?.state,'pending',JSON.stringify(pendingObject.preparation_status));
 assert.equal(failedObject.preparation_status?.state,'failed',JSON.stringify(failedObject.preparation_status));
 assert.equal(failedObject.preparation_status?.error_code,'model_fault');
 // 移除夹具行：它们只证明整理状态与索引覆盖分离，不改变本电池后续消费。
 for(const fixture of fixtures)h.sql(`DELETE FROM source_preparations WHERE source_id='${fixture.source}' AND method_version='semantic-preparation-2' AND input_fingerprint='fixture-input'`);
 await h.resumeWorker();
 checks.push({name:'整理状态≠索引滞后：pending与failed两个独立夹具各有可查知识索引目标且状态如实，index_state仍current，已完成索引照常召回'});
 // 同千表集合保留原门控回环；其余raw反例在check-source-recall专用协议环境完整执行。
 await h.pauseWorker();
 const queriesBeforeRecall=queries;
 let recallOutput='';
 await new Promise((resolve,reject)=>{
  const child=spawn(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--test','source_excerpt_recall','gated_raw_source_round_trip_recalls_revision_and_reports_lag','--','--exact','--test-threads=1'],{env:{...h.env,DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+proxy.address().port,DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'},stdio:['ignore','pipe','inherit']});
  child.stdout.on('data',chunk=>{recallOutput+=chunk;process.stdout.write(chunk);});
  child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('source excerpt recall exited '+code)));
 });
 assert.match(recallOutput,/test result: ok\. 1 passed; 0 failed/);
 assert.ok(queries>queriesBeforeRecall,'子测试运行期间父HTTP服务完成了真实Milvus查询');
 await h.resumeWorker();
 checks.push({name:'Rust门控集成：raw摘录双通道召回→门控回源→升版滞后如实报告（隔离库+专用集合）'});
 const exact=await query('synthetic_catalog_1199');assert.equal(exact.objects[0].name,'synthetic_catalog_1199');
 checks.push({name:'目录末尾精确名称优先，不受对象枚举前5000条限制'});
 // 1200对象末尾多词高相关项：不用精确名称，仅凭含义词组合召回存储顺序最末的对象；
 // 高分对象在末尾也按相关性返回，不能用1000候选限额解释排序前误截断。
 const tailWords=await query('极光漂移多词高相关校准');
 assert.ok(tailWords.objects.slice(0,6).some(o=>o.name==='synthetic_catalog_1199'),
   '末尾对象须按多词含义召回: '+JSON.stringify(tailWords.objects.map(o=>o.name).slice(0,6)));
 checks.push({name:'1200对象末尾多词高相关项召回（不仅测精确名称）'});

 await h.pauseWorker();await milvus('collections/drop',{});
 const newObject=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成自动恢复说明',body:'当前新增对象触发丢库后的完整索引恢复。',source_url:null,related_ids:[]});assert.equal(newObject.status,200);
 assert.equal((await query('synthetic_catalog_1199')).search_coverage.vector_state,'unavailable');
 assert.equal((await milvus('collections/has')).has,false,'读取不创建缺失集合');
 const recovered=await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()});assert.equal(recovered.status,200);
 await h.resumeWorker();
 await waitCurrentIndex('显式重建配置集合后重排全体索引');
 for(const [id,_text,question] of targets){let result;await until(async()=>{result=await query(id);return result.search_coverage.vector_state==='available';},'自动重建后召回',15000);assert.ok(result.objects.slice(0,6).some(o=>o.name===id));assert.equal(result.search_coverage.index_state,'current');}
 checks.push({name:'同名集合丢失后查询不重建；显式维护创建新代次并重排全部旧对象，不能把局部新库报成完整'});

 await h.pauseWorker();
 const stranded=(await query('synthetic_catalog_1199')).objects[0];
 h.sql(`UPDATE knowledge_index_jobs SET vector_state='sending',vector_attempts=3,lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE object_id='${stranded.id}' AND version=${stranded.version}`);
 await h.resumeWorker();
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE object_id='${stranded.id}' AND version=${stranded.version}`)[0].state==='failed','耗尽领取崩溃明确收尾',15000);
 assert.equal(h.sql(`SELECT JSON_OBJECT('error',vector_error) FROM knowledge_index_jobs WHERE object_id='${stranded.id}' AND version=${stranded.version}`)[0].error,'vector_receipt_unknown');
 await h.pauseWorker();
 await milvus('collections/drop',{});
 assert.equal((await query('synthetic_catalog_1199')).search_coverage.vector_state,'unavailable');
 assert.equal((await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()},'bob')).status,403);
 const rebuildKey=randomUUID();const rebuild=await h.request('/knowledge-index/rebuilds',{operation_id:rebuildKey});assert.equal(rebuild.status,200);
 const epoch=h.sql(`SELECT JSON_OBJECT('epoch',lease_epoch) FROM knowledge_index_jobs WHERE object_id='${stranded.id}' AND version=${stranded.version}`)[0].epoch;
 assert.deepEqual((await h.request('/knowledge-index/rebuilds',{operation_id:rebuildKey})).value,rebuild.value);
 assert.equal(h.sql(`SELECT JSON_OBJECT('epoch',lease_epoch) FROM knowledge_index_jobs WHERE object_id='${stranded.id}' AND version=${stranded.version}`)[0].epoch,epoch);
 assert.equal((await query('synthetic_catalog_1199')).search_coverage.index_state,'incomplete');
 await h.resumeWorker();
 await waitCurrentIndex('保持原MySQL重建丢失的collection');
 for(const [id,_text,question] of targets){let result;await until(async()=>{result=await query(id);return result.search_coverage.vector_state==='available';},'重建后查询',15000);assert.ok(result.objects.slice(0,6).some(o=>o.name===id));assert.equal(result.search_coverage.index_state,'current');}
 assert.equal((await h.request('/knowledge/'+stranded.id)).value.version,stranded.version);
 checks.push({name:'第3次领取崩溃明确失败；原MySQL不重建，受控幂等排队恢复丢失collection和失败索引，正文版本不变'});

 const found=(await query('fund_returns')).objects.find(o=>o.name==='fund_returns');assert.ok(found);
 loseUpsert=true;const initialUpserts=upserts;
 const changed=await h.request('/knowledge/'+found.id,{operation_id:randomUUID(),expected_version:found.version,entry_id:'description',value:'成功资金退回的累计金额，按商品行保存为整数分。人工更新的独立解释。'},'alice','PATCH');assert.equal(changed.status,200);
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE object_id='${found.id}' AND version=${changed.value.version}`)[0].state==='unknown','向量回执丢失保留未知',15000);
 const queryCount=queries;
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE object_id='${found.id}' AND version=${changed.value.version}`)[0].state==='indexed','查证已写向量后收尾',15000);
 assert.equal(upserts,initialUpserts+1);assert.ok(queries>queryCount);
 checks.push({name:'Milvus实际写入但HTTP回执丢失，未知任务查证后完成，没有重复向量写入'});
 const current=(await query('fund_returns')).objects.find(o=>o.id===found.id);assert.equal(current.version,changed.value.version);
 const prior=await milvus('entities/query',{filter:`object_id == "${found.id}"`,outputFields:['id','object_version','kind','space_id','model','vector'],limit:128,consistencyLevel:'Strong'});
 const late={...prior[0],id:'late-old-'+randomUUID(),object_version:Number(found.version)};await milvus('entities/upsert',{data:[late]});
 assert.equal((await query('fund_returns')).objects.find(o=>o.id===found.id).version,changed.value.version);
 assert.equal((await h.request('/knowledge/'+found.id+'/disable',{operation_id:randomUUID(),expected_version:changed.value.version})).status,200);
 assert.ok((await query('顾客付的钱退回多少？')).objects.every(o=>o.id!==found.id));
 checks.push({name:'晚到旧版本不能覆盖新版；正式停用后立即过滤旧向量命中'});

 const privateAsset=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'私有词条hybrid_private_marker',body:'仅本人合成偏好',scope:'本人分析',verified:true,source_text:'用户输入',dependencies:[]});assert.equal(privateAsset.status,200);
 const privateRows=await milvus('entities/query',{filter:`object_id == "asset-${privateAsset.value.id}"`,outputFields:['object_id'],limit:1});assert.equal(privateRows.length,0);
 checks.push({name:'个人记忆未写入共享向量索引'});
 unavailable=true;const fallback=await query('synthetic_catalog_1199');
 assert.equal(fallback.retrieval_mode,'lexical_authoritative');
 assert.equal(fallback.search_coverage.vector_state,'unavailable');
 // 30个主内容已足够时停止扩深；服务故障不等于1000候选或五轮已耗尽。
 assert.equal(fallback.search_coverage.state,'bounded');
 assert.equal(fallback.search_coverage.candidate_limit,1000);
 assert.ok(Number.isInteger(fallback.search_coverage.candidate_count)&&fallback.search_coverage.candidate_count>0&&fallback.search_coverage.candidate_count<=1000);
 assert.ok(fallback.search_coverage.channels.lexical.completed>0);
 assert.ok(fallback.search_coverage.channels.lexical.rounds>=1&&fallback.search_coverage.channels.lexical.rounds<=5);
 assert.equal(fallback.objects[0].name,'synthetic_catalog_1199');
 assert.equal(fallback.objects[0].entries.find(entry=>entry.path==='description')?.effective_value,tables[tables.length-1].comment);
 checks.push({name:'向量服务故障明确降级，当前精确/关键词通道仍能使用'});unavailable=false;
 // 零候选也要表达覆盖滞后：worker暂停下保存新知识（作业pending），向量故障
 // 降级的零候选查询必须按当前覆盖报告index_state=incomplete，不得以零结果
 // 冒充索引就绪（semantic_status与索引滞后是两回事）。
 await h.pauseWorker();
 unavailable=true;
 const pendingDoc=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'pending_lag_probe',body:'覆盖滞后探针正文，索引作业保持未完成。',source_url:null,related_ids:[]});assert.equal(pendingDoc.status,200,JSON.stringify(pendingDoc.value));
 const lag=await query('氍毹魍魉绮语');
 assert.equal(lag.objects.length,0,'零候选：词法与精确通道都不命中');
 assert.equal(lag.search_coverage.vector_state,'unavailable');
 assert.equal(lag.search_coverage.index_state,'incomplete','零候选仍须表达index_lag');
 checks.push({name:'零候选覆盖滞后：pending作业使index_state=incomplete如实上报'});
 passed=true;console.log(JSON.stringify({passed,checks,latencyMs:{max:Math.max(...latencies),median:[...latencies].sort((a,b)=>a-b)[Math.floor(latencies.length/2)]},milvusQueries:queries,milvusUpserts:upserts,officialRequests:0}));
}finally{
 if(h)await h.close();
 if(created||(await milvus('collections/has',{})).has){await milvus('collections/drop',{});assert.equal((await milvus('collections/has',{})).has,false);}
 if((await milvus('collections/has',{collectionName:legacyCollection})).has)await milvus('collections/drop',{collectionName:legacyCollection});
 await new Promise(r=>proxy.close(r));await provider.close();
 await writeFile('.local/checks/mvp-hybrid-retrieval.json',JSON.stringify({passed,checks,buildSeconds,latencies,indexObservations,milvusQueries:queries,milvusUpserts:upserts,officialRequests:0,temporaryCollectionRemoved:true},null,2));
}
