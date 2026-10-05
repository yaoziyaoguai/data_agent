import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';

const checks=[],requests=[],providerErrors=[];
let passed=false,h;
const provider=createServer(async(req,res)=>{
 try{
  let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;
  const body=JSON.parse(raw),input=JSON.parse(body.messages[1].content);
  requests.push({object:input.object.id,review:!!input.draft});
  const source=input.sources[0];
  const entries=input.object.entries.map(entry=>({entry_id:entry.entry_id,value:'回环维护建议，实际含义需独立验证',gaps:['本回环不评价真实业务语义'],evidence:[{source_id:source.source_id,version:source.version,location:'原文开头',quote:source.body.slice(0,50)}]}));
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries})}}]}}],usage:{prompt_tokens:100,completion_tokens:80}}));
 }catch(error){providerErrors.push(error.message);res.writeHead(500);res.end('synthetic_protocol_failure');}
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:22,trial_cost_micros:'300000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
const column=id=>({id,name:id,data_type:'INTEGER',nullable:false,comment:'合成整数字段'});
const table=(id,name=id,version='1',extra=false)=>({id,name,platform_version:version,comment:'完全虚构的维护范围样例',ddl:`CREATE TABLE ${name}(record_id INTEGER,amount INTEGER);`,columns:[column('record_id'),column('amount'),...(extra?[column('new_value')]:[])],node:{id:'load-'+id,sql:`INSERT INTO ${name} SELECT record_id,amount FROM synthetic_input;`,upstream_ids:['synthetic_input']}});
const record=name=>h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'").find(v=>v.name===name);
const get=id=>h.request('/knowledge/'+id);
const configure=(id,input,user='alice')=>h.request('/knowledge/'+id+'/analysis-preference',input,user);
const counts=()=>h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM prefill_attempts")[0].n;
const sync=async tables=>{
 await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-analysis-preference',authoritative:true,tables}));
 assert.equal((await h.request('/source-syncs',{operation_id:randomUUID()})).status,200);
};
const wait=async(id,state)=>until(async()=>{const r=await get(id);return r.value.prefill_status?.state===state?r.value:false;},'维护范围 '+state,40000);
try{
 h=await harness({env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();
 await sync([table('ordinary'),table('frequent')]);
 const ordinary=record('ordinary'),frequent=record('frequent'),ordinaryField=record('ordinary.amount');
 assert.equal(counts(),0);
 for(const object of [ordinary,frequent,ordinaryField]){
  const value=(await get(object.id)).value;assert.equal(value.analysis_preference.preferred,false);assert.equal(value.analysis_preference.version,'1');
  assert.ok((await h.request('/knowledge?q='+encodeURIComponent(object.name))).value.objects.some(v=>v.id===object.id));
 }
 checks.push('普通表首次只导入基础事实，表和全部字段立即可读可检索，未等待或触发模型');

 const on={operation_id:randomUUID(),expected_version:'1',preferred:true};
 assert.equal((await configure(frequent.id,on,'bob')).status,403);
 assert.equal((await configure(ordinaryField.id,on)).status,400);
 assert.equal(counts(),0);
 const requested=await h.request('/knowledge/'+ordinaryField.id+'/reanalyze',{operation_id:randomUUID(),expected_version:ordinaryField.version});assert.equal(requested.status,200);
 assert.equal(counts(),1);
 const outcomes=await Promise.all([configure(frequent.id,on),configure(frequent.id,on)]);
 assert.ok(outcomes.every(v=>v.status===200));assert.deepEqual(outcomes[0].value,outcomes[1].value);
 const preference=outcomes[0].value;assert.equal(preference.version,'2');assert.equal(counts(),4);
 for(let batch=0;batch<5;batch++){
  const replayed=await Promise.all(Array.from({length:6},()=>configure(frequent.id,on)));
  assert.ok(replayed.every(v=>v.status===200),JSON.stringify(replayed.map(v=>({status:v.status,value:v.value}))));
  assert.ok(replayed.every(v=>JSON.stringify(v.value)===JSON.stringify(preference)));assert.equal(counts(),4);
 }
 assert.equal((await configure(frequent.id,{...on,preferred:false})).value.code,'idempotency_conflict');
 assert.equal((await configure(ordinary.id,on)).value.code,'idempotency_conflict');
 assert.equal((await configure(frequent.id,{...on,operation_id:randomUUID()})).value.code,'version_conflict');
 assert.equal((await get(frequent.id)).value.version,frequent.version);
 const inherited=(await get(record('frequent.amount').id)).value.analysis_preference;
 assert.deepEqual(inherited,preference);
 checks.push('维护权限、表级范围、独立配置版本和并发重传幂等；字段继承范围，正文版本不变');

 await h.restartApi();assert.deepEqual((await get(frequent.id)).value.analysis_preference,preference);assert.equal(counts(),4);
 await h.resumeWorker();
 const commonIds=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'").filter(o=>o.id===frequent.id||o.related_ids.includes(frequent.id)).map(o=>o.id);
 for(const id of [...commonIds,ordinaryField.id])await wait(id,'succeeded');
 assert.equal(requests.length,8);assert.ok(requests.slice(0,6).every(r=>commonIds.includes(r.object)));assert.ok(requests.slice(6).every(r=>r.object===ordinaryField.id));
 assert.ok(commonIds.every(id=>requests.filter(r=>r.object===id).length===2));
 checks.push('API重启保留配置；新排的常用表及字段实际先分析、复核，早排的普通按需任务随后完成');

 await h.pauseWorker();
 const beforeDisable=(await get(frequent.id)).value;
 const competing=await Promise.all(Array.from({length:6},()=>configure(frequent.id,{operation_id:randomUUID(),expected_version:'2',preferred:false})));
 assert.equal(competing.filter(v=>v.status===200).length,1,JSON.stringify(competing));assert.ok(competing.filter(v=>v.status!==200).every(v=>v.status===409&&v.value.code==='version_conflict'),JSON.stringify(competing));
 const off=competing.find(v=>v.status===200);assert.equal(off.value.version,'3');
 const afterDisable=(await get(frequent.id)).value;
 assert.equal(afterDisable.version,beforeDisable.version);assert.deepEqual(afterDisable.entries,beforeDisable.entries);
 const manual=(await get(ordinaryField.id)).value;
 assert.equal((await h.request('/knowledge/'+ordinaryField.id,{operation_id:randomUUID(),expected_version:manual.version,entry_id:'meaning',value:'人工保留的字段说明'},'alice','PATCH')).status,200);
 await sync([table('ordinary','ordinary','2',true),table('frequent','frequent_renamed','2')]);
 assert.equal(record('frequent_renamed').id,frequent.id);
 assert.deepEqual((await get(frequent.id)).value.analysis_preference,off.value);
 const ordinaryCurrent=(await get(ordinaryField.id)).value;
 assert.equal(ordinaryCurrent.entries.find(e=>e.entry_id==='meaning').effective_value,'人工保留的字段说明');assert.equal(ordinaryCurrent.entries.find(e=>e.entry_id==='meaning').review_state,'needs_review');
 assert.equal(ordinaryCurrent.prefill_status.state,'queued');
 assert.equal((await get(record('ordinary.new_value').id)).value.prefill_status.state,'queued');
 assert.equal((await get(frequent.id)).value.prefill_status.state,'queued');
 checks.push('关闭常用不删除知识，稳定ID改名保留配置；所有来源改版及新字段仍自动重分析，人工值保留待复核');

 const queuedBefore=counts();const reenabled=await configure(frequent.id,{operation_id:randomUUID(),expected_version:'3',preferred:true});assert.equal(reenabled.status,200);assert.equal(counts(),queuedBefore);
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM prefill_attempts WHERE table_id='${frequent.id}' AND state='queued' AND priority=1`)[0].n,3);
 const start=requests.length;
 await h.resumeWorker();
 const active=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%' AND state='enabled'");
 for(const object of active)await wait(object.id,'succeeded');
 assert.equal(requests.length-start,14);assert.ok(requests.slice(start,start+6).every(r=>commonIds.includes(r.object)));
 assert.equal((await get(ordinaryField.id)).value.entries.find(e=>e.entry_id==='meaning').effective_value,'人工保留的字段说明');
 checks.push('重新开启优先范围提升既有queued任务而不重复排队；改版批次再次先完成常用，人工保护延续');

 const noBudget=(await get(ordinaryField.id)).value;assert.equal((await h.request('/knowledge/'+ordinaryField.id+'/reanalyze',{operation_id:randomUUID(),expected_version:noBudget.version})).status,200);await wait(ordinaryField.id,'budget_unavailable');
 assert.equal(requests.length,22);assert.deepEqual(providerErrors,[]);
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];assert.deepEqual(ledger,{calls:22,reserved:0});
 checks.push('普通范围仍可按需发起；额度耗尽保留明确状态、零额外HTTP，22次分析/复核全部结算');
 passed=true;console.log(JSON.stringify({passed,checks,calls:requests.length,officialRequests:0}));
}finally{
 if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-analysis-preference.json',JSON.stringify({passed,checks,requests,providerErrors,officialRequests:0},null,2));
}
