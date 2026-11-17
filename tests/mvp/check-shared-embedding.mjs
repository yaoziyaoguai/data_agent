import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';
const provider=await embeddingProvider(),collection='da_embed_'+randomUUID().replaceAll('-','');
const embeddingSpec=JSON.parse(await readFile('infra/embedding-model.json','utf8'));
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'embed_tools_'+randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:200,trial_cost_micros:'1000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const token=(await readFile('.local/infra/milvus-root-password','utf8')).trim();
const milvus=async(action,body={},name=collection)=>{
 const r=await fetch('http://127.0.0.1:19531/v2/vectordb/'+action,{method:'POST',headers:{authorization:'Bearer root:'+token,'content-type':'application/json'},body:JSON.stringify({collectionName:name,dbName:'default',...body})});const v=await r.json();assert.equal(v.code,0);return v.data;
};
let h,run,passed=false;const checks=[],leaseObservations=[];const manager=SessionManager.inMemory('/synthetic/data-agent');
const tool=async(query,sdk=randomUUID())=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:'search_knowledge',arguments:{query,limit:10},checkpoint:exportCheckpoint(manager)};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
 return {input,result:await h.internal('/internal/data/tools',input)};
};
try{
 h=await harness({capture:true,profile,startWorker:false,env:{...provider.env,DATA_AGENT_VECTOR_URL:'http://127.0.0.1:19531',DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
 const prepared=await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()});assert.equal(prepared.status,200,JSON.stringify(prepared.value));
 await h.resumeWorker();
 await until(()=>h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE vector_state<>'indexed'")[0].n===0,'Qwen protocol indexes current knowledge',45000);
 await h.pauseWorker();
 const desc=await milvus('collections/describe');assert.equal(desc.fields.find(f=>f.name==='vector').params.find(p=>p.key==='dim').value,'1024');
 const initial=provider.requests.length;assert.ok(initial>0);
 await milvus('collections/drop');
 await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()});await h.resumeWorker();
 await until(()=>h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE vector_state<>'indexed'")[0].n===0,'rebuild reuses paid vectors',45000);
 await h.pauseWorker();assert.equal(provider.requests.length,initial);
 checks.push('独立1024维集合；丢失集合后重建复用持久向量，未新增模型调用');
 await h.resumeWorker();run=await h.capture(await h.create(),'请查找合成收入指标的定义与统计时间');
 provider.setDelay(2300);const first=await tool('净收入');provider.setDelay(0);
 assert.equal(first.result.status,200);assert.equal(first.result.value.data.search_coverage.vector_state,'available');
 const count=provider.requests.length;assert.equal((await h.internal('/internal/data/tools',first.input)).status,200);assert.equal(provider.requests.length,count);
 const calls=h.sql("SELECT JSON_OBJECT('scope',budget_scope_id,'state',state,'purpose',purpose,'usage',usage_json) FROM model_call_attempts WHERE budget_scope_id IS NOT NULL AND purpose='knowledge_embedding'");
 assert.equal(calls.length,1);assert.equal(calls[0].scope,run.budget_scope_id);assert.equal(calls[0].state,'settled');assert.equal(calls[0].usage.input_tokens,18);
 assert.equal(h.sql(`SELECT JSON_OBJECT('state',state) FROM model_trials WHERE id='${profile.trial_id}'`)[0].state,'active');
 checks.push('短问句包含模板token仍正常结算；超过旧2秒限制仍完成，工具重放不付费且费用归原请求预算');
 const rejectedInput={...first.input,sdk_tool_call_id:randomUUID(),arguments:{query:'合成已拒绝工具',limit:10}};
 const registration=await h.internal('/internal/data/tool-calls',rejectedInput);assert.equal(registration.status,200);
 h.sql(`UPDATE tool_calls SET state='rejected',receipt=JSON_OBJECT('operation_id',operation_id,'tool_name','search_knowledge','data',JSON_OBJECT('error','not_available')) WHERE operation_id='${registration.value.operation_id}'`);
 const rejectedCount=provider.requests.length;await h.internal('/internal/data/tools',rejectedInput);assert.equal(provider.requests.length,rejectedCount);
 checks.push('已拒绝的工具重放不再外发付费向量请求');
 provider.setMode('dimension');const malformed=await tool('合成向量坏维度');
 // 切片五起嵌入失败不再整路清空：词法通道照常执行，降级经state=bounded如实表达。
 assert.equal(malformed.result.value.data.search_coverage.vector_state,'available');
 assert.equal(malformed.result.value.data.search_coverage.state,'bounded');
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE state='settled' AND purpose='knowledge_embedding' AND response_json IS NULL")[0].n,1);
 checks.push('向量维度错误明确降级（词法照常、bounded如实），已收到usage仍结算');
 provider.setMode('lost');const lost=await tool('合成未知回执');const sent=provider.requests.length;
 assert.equal(lost.result.value.data.search_coverage.vector_state,'available');
 assert.equal(lost.result.value.data.search_coverage.state,'bounded');provider.setMode('ok');
 await h.restartApi();await h.internal('/internal/data/tools',lost.input);assert.equal(provider.requests.length,sent);
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE state='unknown' AND purpose='knowledge_embedding'")[0].n,1);
 assert.ok(h.sql(`SELECT JSON_OBJECT('reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0].reserved>0);
 checks.push('云端回执未知保留预留；API重启后同工具不换ID重发');
 provider.setMode('usage');const badUsage=await tool('合成缺少用量');provider.setMode('ok');
 assert.equal(badUsage.result.value.data.search_coverage.vector_state,'available');
 assert.equal(badUsage.result.value.data.search_coverage.state,'bounded');
 const before=provider.requests.length;
 h.sql(`UPDATE model_trials SET state='breached' WHERE id='${profile.trial_id}'`);
 const denied=await tool('预算用尽后的请求');assert.equal(denied.result.value.data.search_coverage.vector_state,'available');
 assert.equal(denied.result.value.data.search_coverage.state,'bounded');
 assert.equal(provider.requests.length,before);
 checks.push('无usage保持未知；额度禁止外发且词法通道可继续使用');
 await h.pauseWorker();
 const longDocument=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成长文分批续租',body:'合成长文说明业务口径。'.repeat(400),source_url:null,related_ids:[]});assert.equal(longDocument.status,200);
 let batches=0;provider.setDelay(300);
 provider.onRequest(request=>{
  // 注入屏障只跟随该知识作业的真实操作身份，不受原文任务请求影响。
  const operation=fingerprint(['knowledge-index','demo',longDocument.value.id,longDocument.value.version,embeddingSpec.version,batches]);
  const parameters=fingerprint([embeddingSpec.version,provider.env.DATA_AGENT_EMBEDDING_URL,request]);
  if(!h.sql(`SELECT JSON_OBJECT('id',id) FROM model_call_attempts WHERE operation_id='${operation}' AND parameters_fingerprint='${parameters}' AND state='issued'`).length)return;
  batches++;
  if(batches===1)h.sql(`UPDATE knowledge_index_jobs SET lease_until=TIMESTAMPADD(SECOND,3,UTC_TIMESTAMP(3)) WHERE target_kind='knowledge_entry' AND object_id='${longDocument.value.id}'`);
  leaseObservations.push({batch:batches,operation,seconds:h.sql(`SELECT JSON_OBJECT('seconds',TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),lease_until)) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${longDocument.value.id}'`)[0].seconds});
 });
 await h.resumeWorker();
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${longDocument.value.id}'`)[0]?.state==='indexed','长文分批有效租约续期',20000);
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id='${longDocument.value.id}'`)[0]?.state==='indexed','原文目标取得完整回执后再进入重建用例',20000);
 await h.pauseWorker();provider.onRequest(()=>{});provider.setDelay(0);assert.ok(batches>=2);
 assert.ok(leaseObservations[1].seconds>110,'next batch renews a still-valid lease');
 checks.push('长文在下一付费批次前续接有效租约，不受原领取剩余时间限制');
 const maintenance=JSON.parse(provider.env.DATA_AGENT_EMBEDDING_PROFILE);
 h.sql(`UPDATE model_trials SET call_limit=allocated_calls+1 WHERE id='${maintenance.trial_id}'`);
 const partial=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成部分索引预算',body:'合成退款业务解释。'.repeat(400),source_url:null,related_ids:[]});assert.equal(partial.status,200);
 await h.resumeWorker();
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${partial.value.id}'`)[0]?.state==='unknown','部分片段成功后原预算耗尽',20000);
 await until(()=>{
  const row=h.sql(`SELECT JSON_OBJECT('state',vector_state,'profile',embedding_profile) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id='${partial.value.id}'`)[0];
  return ['unknown','failed'].includes(row?.state)&&row.profile?.trial_id===maintenance.trial_id;
 },'原文目标实际冻结原预算并耗尽，才更换当前配置',20000);
 await h.pauseWorker();const paid=provider.requests.length;
 const nextProfile={...maintenance,trial_id:'replacement_'+randomUUID()};h.env.DATA_AGENT_EMBEDDING_PROFILE=JSON.stringify(nextProfile);
 await milvus('collections/drop');assert.equal((await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()})).status,200);await h.resumeWorker();
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${partial.value.id}'`)[0]?.state==='failed','集合重建仍沿用原预算',45000);
 await until(()=>{
  const rows=h.sql(`SELECT JSON_OBJECT('id',object_id,'state',vector_state) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id IN ('${partial.value.id}','${longDocument.value.id}')`);
  return rows.find(row=>row.id===longDocument.value.id)?.state==='indexed'&&rows.find(row=>row.id===partial.value.id)?.state==='failed';
 },'重建后的两类原文目标按各自旧回执和冻结预算收敛',45000);
 // 原文目标与知识对象同表后，重建重绑会让原文目标补齐缺回执的分批；预算不变量
 // 是：补调用只记原冻结trial、新trial零使用、知识对象trial不变。
 await h.pauseWorker();const extra=provider.requests.length-paid;
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE trial_id='${nextProfile.trial_id}'`)[0].n,0,'重建补索引不能换trial补额');
 assert.equal(h.sql(`SELECT JSON_OBJECT('profile',embedding_profile) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${partial.value.id}'`)[0].profile.trial_id,maintenance.trial_id);
 const reboundSources=h.sql(`SELECT JSON_OBJECT('obj',object_id,'state',vector_state,'error',vector_error,'profile',embedding_profile) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id IN ('${partial.value.id}','${longDocument.value.id}')`);
 assert.equal(reboundSources.find(row=>row.obj===longDocument.value.id)?.state,'indexed','已有完整回执的原文目标重绑零调用收敛');
 assert.equal(reboundSources.find(row=>row.obj===partial.value.id)?.state,'failed','冻结trial耗尽的原文目标不换trial补批，如实失败');
 assert.equal(reboundSources.find(row=>row.obj===longDocument.value.id)?.profile.trial_id,maintenance.trial_id);
 assert.equal(reboundSources.find(row=>row.obj===partial.value.id)?.profile.trial_id,maintenance.trial_id);
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_trials WHERE id='${nextProfile.trial_id}'`)[0].n,0,'根本不用的当前trial不登记');
 checks.push(`部分索引后重建集合并更换当前配置，原对象预算绑定保留，耗尽不换trial补额；原文目标回执重用零调用、缺回执批次沿用冻结trial如实失败`);
 // 只替换测试集合；正式调用不能静默把既有384维库当成1024维。
 await milvus('collections/drop');await milvus('collections/create',{dimension:384,idType:'VarChar',autoID:false,primaryFieldName:'id',vectorFieldName:'vector',metricType:'COSINE',params:{max_length:'128',enableDynamicField:true}});
 const incompatible=await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()});assert.notEqual(incompatible.status,200);assert.equal(incompatible.value.code,'vector_dimension_mismatch');
 checks.push('错误配置指向384维集合时拒绝，不改旧集合或正式正文');
 // 普通维护配置省略累计调用/费用限制：进程环境在启动时固化，用独立环境实测
 // 不登记累计帽与到期门，实际调用仍沿原身份记账。
 const ordinary={trial_id:'ordinary_maintenance_'+randomUUID()};
 const ordinaryCollection='da_embed_ordinary_'+randomUUID().replaceAll('-','');
 const h2=await harness({capture:true,startWorker:false,env:{...provider.env,DATA_AGENT_EMBEDDING_PROFILE:JSON.stringify(ordinary),DATA_AGENT_VECTOR_URL:'http://127.0.0.1:19531',DATA_AGENT_VECTOR_COLLECTION:ordinaryCollection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
 try{
  const ordinaryDoc=await h2.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成普通维护配置',body:'合成会员权益说明。',source_url:null,related_ids:[]});
  assert.equal(ordinaryDoc.status,200,JSON.stringify(ordinaryDoc.value));
  assert.equal((await h2.request('/knowledge-index/rebuilds',{operation_id:randomUUID()})).status,200);
  await h2.resumeWorker();
  await until(()=>h2.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${ordinaryDoc.value.id}'`)[0]?.state==='indexed','普通维护配置完成索引',45000);
  await h2.pauseWorker();
  const ordinaryTrial=h2.sql(`SELECT JSON_OBJECT('calls',call_limit,'cost',cost_limit_micros,'expires',expires_at,'allocated',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${ordinary.trial_id}'`)[0];
  assert.deepEqual({calls:ordinaryTrial.calls,cost:ordinaryTrial.cost,expires:ordinaryTrial.expires},{calls:null,cost:null,expires:null});
  assert.ok(ordinaryTrial.allocated>0);assert.equal(ordinaryTrial.reserved,0);
  checks.push('普通维护embedding配置省略累计调用/费用与到期门，实际调用照常记账');
 } finally {
  await h2.close();
  if((await milvus('collections/has',{},ordinaryCollection)).has)await milvus('collections/drop',{},ordinaryCollection);
 }
 passed=true;console.log(JSON.stringify({passed,checks,leaseObservations,officialRequests:0}));
}finally{
 await h?.close();if((await milvus('collections/has')).has)await milvus('collections/drop');await provider.close();
 await writeFile('.local/checks/shared-embedding.json',JSON.stringify({passed,checks,leaseObservations,officialRequests:0},null,2));
}
