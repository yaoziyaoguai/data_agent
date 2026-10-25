import {synchronizeSources} from './source-sync.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {harness,until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';
import {targets,topics,table} from './shared-retrieval-fixture.mjs';
const provider=await embeddingProvider();

const collection='da_app_'+randomUUID().replaceAll('-','');
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
 },label,900000);
};
try{
 // 05切片2前置：先用旧形状（仅dense、无sparse/text）占用配置名集合，模拟生产既有集合；
 // 新代码必须自动落到_h1代次新形状集合，旧集合不删不改、行数保持为0。
 const legacySchema={dimension:1024,idType:'VarChar',autoID:false,primaryFieldName:'id',
  vectorFieldName:'vector',metricType:'COSINE',consistencyLevel:'Strong',
  params:{max_length:'128','enableDynamicField':true}};
 await milvus('collections/create',legacySchema);
 h=await harness({startWorker:false,env:{...provider.env,DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+proxy.address().port,DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
 await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-scale',authoritative:true,tables}));
 const start=performance.now();assert.equal((await synchronizeSources(h)).value.status, 'completed');
 const imported=h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_objects WHERE source_id LIKE 'catalog-%'")[0].n;assert.equal(imported,2408);
 // 中文含义词与否定区分样本：原文无需等待整理即可进入索引并按BM25通道召回。
 const unpaid=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'unpaid_refund_rule',body:'未付款订单不产生退款，首次申请免费处理，最终解释以协议为准。',source_url:null,related_ids:[]});assert.equal(unpaid.status,200,JSON.stringify(unpaid.value));
 const paid=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'paid_refund_rule',body:'已付款订单可以申请退款，最终退款扣除手续费，运费除外。',source_url:null,related_ids:[]});assert.equal(paid.status,200,JSON.stringify(paid.value));
 await h.resumeWorker();
 await waitCurrentIndex('应用千表索引全部完成');
 created=true;buildSeconds=(performance.now()-start)/1000;
 for(const [id,_text,question] of targets){
  let result;await until(async()=>{result=await query(id);return result.search_coverage.vector_state==='available';},'协议向量索引可查询',15000);
  assert.equal(result.retrieval_mode,'hybrid_authoritative');assert.equal(result.search_coverage.index_state,'current');
  assert.ok(result.objects.slice(0,6).some(o=>o.name===id),JSON.stringify({question,names:result.objects.map(o=>o.name)}));
 }
 checks.push({name:'1204张接口表和2408个新对象的真实应用索引；协议向量与精确通道可用（中文语义质量另做真实百炼小样）',imported,buildSeconds});
 // 旧形状集合共存：全部索引落在_h1代次集合，旧集合保持零写入且未被删除。
 const legacyHas=(await milvus('collections/has',{})).has;
 const hybridHas=(await call0('collections/has',{collectionName:collection+'_h1'})).has;
 const legacyRows=await milvus('entities/query',{filter:'object_id != ""',outputFields:['id'],limit:1,consistencyLevel:'Strong'});
 assert.ok(legacyHas&&hybridHas,'旧形状集合保留且_h1代次集合已建立');
 assert.equal(legacyRows.length,0,'旧集合不被写入（统一切换按08，不长期双写）');
 checks.push({name:'旧形状集合不能原地升级：自动落到_h1代次（chinese分析器+BM25+dense），旧集合零写入且保留'});
 // BM25通道中文否定区分：未付款原文必须排在已付款原文之前，不能丢否定。
 // 查询含未付款规则独有的含义词（首次申请免费），BM25分差须压过dense伪向量的随机序。
 const negation=await query('未付款订单首次申请免费处理吗');
 const names=negation.objects.map(o=>o.name);
 const unpaidAt=names.indexOf('unpaid_refund_rule'),paidAt=names.indexOf('paid_refund_rule');
 assert.ok(unpaidAt>=0,'未付款规则必须可召回: '+JSON.stringify(names));
 if(paidAt>=0)assert.ok(unpaidAt<paidAt,'否定区分：未付款在已付款前 '+JSON.stringify(names));
 checks.push({name:'BM25通道经chinese分析器保留否定区分（未付款规则先于已付款规则召回）'});
 // 05切片3：raw_source_index消费者——文档与平台原文不等整理即入代次索引
 // （kind=source_excerpt带source_kind/修订/位置），v1知识检索不把摘录冒充知识对象。
 let excerptRows=[];
 await until(async()=>{
  excerptRows=await call0('entities/query',{collectionName:collection+'_h1',filter:`kind == "source_excerpt" && object_id == "${unpaid.value.id}"`,outputFields:['id','source_kind','object_version','char_offset','char_length','text'],limit:16,consistencyLevel:'Strong'});
  return excerptRows.length>0;
 },'raw摘录已入索引',60000);
 assert.ok(excerptRows.some(r=>(r.text||'').includes('未付款订单不产生退款')),'摘录正文含否定原文');
 for(const row of excerptRows){assert.equal(row.source_kind,'document');assert.ok(Number(row.object_version)>=1);assert.ok(Number(row.char_length)>0);}
 const platformExcerpts=await call0('entities/query',{collectionName:collection+'_h1',filter:'kind == "source_excerpt" && source_kind == "platform"',outputFields:['id','object_id','object_version'],limit:4,consistencyLevel:'Strong'});
 assert.ok(platformExcerpts.length>0,'平台来源原文同样不等整理即入摘录索引');
 const rawGuard=await query('未付款订单首次申请免费处理吗');
 assert.ok(rawGuard.objects.length>0&&rawGuard.objects.every(o=>o.kind!=='source_excerpt'),'v1知识检索不冒充raw摘录');
 // 作业如实收尾：文档作业结算、全库raw作业无失败（1204个平台来源作业量大，
 // 不要求在断言时限内全部完成，剩余保持真实queued由worker继续推进）。
 await until(()=>{
  const docJobs=h.sql(`SELECT JSON_OBJECT('open',SUM(state IN ('queued','running')),'failed',SUM(state='failed')) FROM background_jobs WHERE kind='raw_source_index' AND resource_id IN ('document-${unpaid.value.id}','document-${paid.value.id}')`)[0];
  return Number(docJobs.open||0)===0&&Number(docJobs.failed||0)===0;
 },'文档raw作业收尾',60000);
 const rawFailed=h.sql("SELECT JSON_OBJECT('failed',SUM(state='failed')) FROM background_jobs WHERE kind='raw_source_index'")[0].failed;
 assert.equal(Number(rawFailed||0),0,'raw作业不得失败');
 checks.push({name:'raw_source_index消费者：文档与平台原文不等整理即入代次索引（kind=source_excerpt带source_kind/修订/位置/正文），作业如实收尾，v1不冒充raw'});
 // Rust门控集成：同隔离库+同专用集合跑完整raw回环（写入→双通道召回→门控回源→升版滞后）。
 execFileSync(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--lib','--','--exact','use_cases::knowledge_sources::raw_recall_tests::gated_raw_source_round_trip_recalls_revision_and_reports_lag'],{env:{...h.env,DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+proxy.address().port,DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'},stdio:'inherit'});
 checks.push({name:'Rust门控集成：raw摘录双通道召回→门控回源→升版滞后如实报告（隔离库+专用集合）'});
 const exact=await query('synthetic_catalog_1199');assert.equal(exact.objects[0].name,'synthetic_catalog_1199');
 checks.push({name:'目录末尾精确名称优先，不受对象枚举前5000条限制'});

 await h.pauseWorker();await milvus('collections/drop',{});
 const newObject=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成自动恢复说明',body:'当前新增对象触发丢库后的完整索引恢复。',source_url:null,related_ids:[]});assert.equal(newObject.status,200);
 await h.resumeWorker();
 await waitCurrentIndex('丢库后新增对象自动重排全体索引');
 for(const [id,_text,question] of targets){let result;await until(async()=>{result=await query(id);return result.search_coverage.vector_state==='available';},'自动重建后召回',15000);assert.ok(result.objects.slice(0,6).some(o=>o.name===id));assert.equal(result.search_coverage.index_state,'current');}
 checks.push({name:'同名collection丢失后新增对象，实际collection代次变化自动重建全部旧对象，不能把局部新库报成完整'});

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
 unavailable=true;const fallback=await query('synthetic_catalog_1199');assert.equal(fallback.retrieval_mode,'lexical_authoritative');assert.equal(fallback.search_coverage.vector_state,'unavailable');assert.equal(fallback.search_coverage.state,'candidate_limit');assert.equal(fallback.search_coverage.candidate_limit,2200);assert.equal(fallback.objects[0].name,'synthetic_catalog_1199');
 checks.push({name:'向量服务故障明确降级，当前精确/关键词通道仍能使用'});unavailable=false;
 passed=true;console.log(JSON.stringify({passed,checks,latencyMs:{max:Math.max(...latencies),median:[...latencies].sort((a,b)=>a-b)[Math.floor(latencies.length/2)]},officialRequests:0}));
}finally{
 if(h)await h.close();
 if(created||(await milvus('collections/has',{})).has){await milvus('collections/drop',{});assert.equal((await milvus('collections/has',{})).has,false);}
 await call0('collections/drop',{collectionName:collection+'_h1'}).catch(()=>{}); // 清理代次集合
 await new Promise(r=>proxy.close(r));await provider.close();
 await writeFile('.local/checks/mvp-hybrid-retrieval.json',JSON.stringify({passed,checks,buildSeconds,latencies,indexObservations,officialRequests:0,temporaryCollectionRemoved:true},null,2));
}
