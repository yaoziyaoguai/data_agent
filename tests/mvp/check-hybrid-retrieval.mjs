import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {harness,until} from './harness.mjs';

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
const targets=[
 ['fund_returns','订单行的成功退款累计金额；已分摊到商品行，以整数分保存。','顾客付的钱退回多少？'],
 ['buyers_monthly','月支付客户数：按整月customer_id去重，一个顾客多次购买只计一个，匿名客户不合并成统一客户。','同一顾客这个月买了三次应该算几位顾客？'],
 ['revenue_period','支付归属净收入用首次成功付款时刻paid_at归属月份，不用下单日期order_date，月底创建的订单可能于下个月付款。','月底创建的订单为何收入算下个月？'],
 ['buyer_labels','客户标签是一对多，一个客户有VIP及订阅标签。筛选这些标签用EXISTS避免同一订单金额重复累加。','为客户打多种标记会不会让订单金额被算两次？'],
];
const topics=['库存快照，仓库与商品日粒度，数量为当前在库件数。','物流配送流水，一行一个包裹，配送路线与预计签收时刻。','对账批次摘要，一行一个结算批次，累计账单总额包含税费。','营销曝光记录，一行一次广告展示，点击记录单独保存。','客户基本信息，当前快照地区与注册时刻，没有购买历史地区。','退货申请记录，一行一次申请，审批尚未完成，不代表退款成功。'];
const table=(id,comment)=>({id,name:id,platform_version:'1',comment,ddl:`CREATE TABLE ${id} (record_id INTEGER);`,columns:[{id:'record_id',name:'record_id',data_type:'INTEGER',nullable:false,comment:'记录技术编号'}],node:null});
const tables=[...targets.map(([id,text])=>table(id,text)),...Array.from({length:1200},(_,i)=>table('synthetic_catalog_'+String(i).padStart(4,'0'),topics[i%topics.length]))];
const token=(await readFile('.local/infra/milvus-root-password','utf8')).trim();
const milvus=async(path,body)=>{
 const response=await fetch('http://127.0.0.1:19531/v2/vectordb/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer root:'+token},body:JSON.stringify({dbName:'default',collectionName:collection,...body})});
 const result=await response.json();assert.equal(result.code,0);return result.data;
};
const query=async text=>{const start=performance.now();const response=await h.request('/knowledge?q='+encodeURIComponent(text));latencies.push(performance.now()-start);assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
const states=()=>h.sql("SELECT JSON_OBJECT('pending',SUM(vector_state IN ('pending','sending','unknown')),'failed',SUM(vector_state='failed'),'indexed',SUM(vector_state='indexed')) FROM knowledge_index_jobs")[0];
const waitCurrentIndex=async label=>{
 await until(async()=>{
  const state=states();assert.equal(state.failed,0);if(state.pending!==0)return false;
  // 批次间没有pending不代表目标代次已全部重建；由正式API核对当前代次覆盖。
  const response=await h.request('/knowledge?q=synthetic_catalog_1199');assert.equal(response.status,200);
  const coverage=response.value.search_coverage;
  indexObservations.push({stage:label,pending:state.pending,indexState:coverage.index_state,vectorState:coverage.vector_state});
  return coverage.index_state==='current'&&coverage.vector_state==='available';
 },label,360000);
};
try{
 h=await harness({startWorker:false,env:{DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+proxy.address().port,DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
 await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-scale',authoritative:true,tables}));
 const start=performance.now();assert.equal((await h.request('/source-syncs',{operation_id:randomUUID()})).status,200);
 const imported=h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_objects WHERE source_id LIKE 'catalog-%'")[0].n;assert.equal(imported,2408);
 await h.resumeWorker();
 await waitCurrentIndex('应用千表索引全部完成');
 created=true;buildSeconds=(performance.now()-start)/1000;
 for(const [id,_text,question] of targets){
  let result;await until(async()=>{result=await query(question);return result.search_coverage.vector_state==='available';},'本地问句模型准备',15000);
  assert.equal(result.retrieval_mode,'hybrid_authoritative');assert.equal(result.search_coverage.index_state,'current');
  assert.ok(result.objects.slice(0,6).some(o=>o.name===id),JSON.stringify({question,names:result.objects.map(o=>o.name)}));
 }
 checks.push({name:'1204张接口表和2408个新对象的真实应用索引；四种中文问法命中独立目标',imported,buildSeconds});
 const exact=await query('synthetic_catalog_1199');assert.equal(exact.objects[0].name,'synthetic_catalog_1199');
 checks.push({name:'目录末尾精确名称优先，不受对象枚举前5000条限制'});

 await h.pauseWorker();await milvus('collections/drop',{});
 const newObject=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成自动恢复说明',body:'当前新增对象触发丢库后的完整索引恢复。',source_url:null,related_ids:[]});assert.equal(newObject.status,200);
 await h.resumeWorker();
 await waitCurrentIndex('丢库后新增对象自动重排全体索引');
 for(const [id,_text,question] of targets){let result;await until(async()=>{result=await query(question);return result.search_coverage.vector_state==='available';},'自动重建后召回',15000);assert.ok(result.objects.slice(0,6).some(o=>o.name===id));assert.equal(result.search_coverage.index_state,'current');}
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
 for(const [id,_text,question] of targets){let result;await until(async()=>{result=await query(question);return result.search_coverage.vector_state==='available';},'重建后查询',15000);assert.ok(result.objects.slice(0,6).some(o=>o.name===id));assert.equal(result.search_coverage.index_state,'current');}
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
 await new Promise(r=>proxy.close(r));
 await writeFile('.local/checks/mvp-hybrid-retrieval.json',JSON.stringify({passed,checks,buildSeconds,latencies,indexObservations,officialRequests:0,temporaryCollectionRemoved:true},null,2));
}
