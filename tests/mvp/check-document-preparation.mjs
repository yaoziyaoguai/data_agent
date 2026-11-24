import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';

// 文档保存原子登记语义准备：创建/改版响应返回即登记整理作业；独立文档以知识条目
// 定位，普通原文召回只用平台来源，保存不登记原文向量目标；
// 整理成果只登记建议，人工正文与原文修订保持不变；成果引用绑定当次修订。
const checks=[];let passed=false,calls=0,h;
const materials=[];
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 calls++;assert.ok(Buffer.byteLength(raw)<=65536);
 const request=JSON.parse(raw);assert.equal(request.model,'deepseek-flash');
 assert.equal(request.tools.length,1);assert.equal(request.tools[0].function.name,'submit_semantic_preparation');
 const material=JSON.parse(request.messages[1].content);
 assert.equal(material.source.kind,'document','本库只应整理文档来源');
 materials.push(material);
 const output=documentOutput(material);
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_preparation',arguments:JSON.stringify(output)}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));

function documentOutput(material){
 const document=material.objects.find(o=>o.kind==='document');
 const segment=material.segments[0];
 const cite={source:material.source,revision:material.revision,locator:{offset:segment.citation.locator.offset,length:Math.min(24,segment.citation.locator.length)}};
 if(!document)return {statements:[],relations:[],unresolved:['材料缺少文档对象'],semantic_status:'partial'};
 return {statements:[{key:'doc-interpretation',
  target:{object_id:document.id,version:document.version,path:'body'},
  text:`合成文档陈述：${document.name}的可解释口径`,scope_text:'适用范围：文档语义整理验收',
  citations:[cite],supports:[]}],
 relations:[],unresolved:[],semantic_status:material.coverage.final_batch?'ready':'partial'};
}

const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:100,trial_cost_micros:'5000000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
try{
 h=await harness({keep:process.env.KEEP==='1',env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();
 const jobs=(kind,id,version)=>h.sql(`SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE kind='${kind}' AND resource_id='document-${id}' AND resource_version=${version}`);
 const rawTargets=id=>h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id='${id}'`)[0].n;
 const preparation=(id,revision)=>h.sql(`SELECT JSON_OBJECT('status',semantic_status,'call',call_state,'error',error_code,'segments',segments_read) FROM source_preparations WHERE source_id='document-${id}' AND revision=${revision}`)[0];

 // 阶段一：创建响应返回即原子登记；整理到ready只登记建议，人工正文与修订不变。
 const body='# 唤醒口径指南\n\n## 请求入口\n\n正式语音请求从会话入口发起，取消请求不计入识别率分母。\n\n## 统计口径\n\n成功计数只包含返回完整答复的请求。';
 const created=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成唤醒口径指南',body,related_ids:[]})).value;
 assert.equal(created.version,'1');
 assert.equal(jobs('prepare_source',created.id,1).length,1,'创建返回即已登记语义准备作业');
 assert.equal(jobs('prepare_source',created.id,1)[0].state,'queued');
 assert.equal(rawTargets(created.id),0,'创建文档不登记原文向量目标');

 const empty=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成空正文文档',body:'',related_ids:[]})).value;
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE resource_id='document-${empty.id}'`)[0].n,0,'空正文没有可整理内容，不登记作业');
 const emptyStatus=(await h.request('/knowledge/'+empty.id)).value.preparation_status;
 assert.ok(!emptyStatus,'空正文未登记整理，准备状态如实为空');

 // 准备状态与预填状态分开表达：排队期回退到真实作业态，不冒充进度。
 const queuedStatus=(await h.request('/knowledge/'+created.id)).value;
 assert.equal(queuedStatus.preparation_status.state,'queued','无准备记录时回退到待办作业的真实排队状态');
 assert.equal(queuedStatus.preparation_status.source_id,'document-'+created.id);
 assert.equal(queuedStatus.preparation_status.revision,'1');
 assert.ok(!queuedStatus.prefill_status,'文档没有对象级预填，预填状态不得因整理存在而冒充');

 await h.resumeWorker();
 await until(async()=>{const row=preparation(created.id,1);return row&&row.status==='ready'&&row.call===null?row:false;},'文档首版整理到ready',120000);
 await until(async()=>{const r=h.sql(`SELECT JSON_OBJECT('total',COUNT(*),'finished',SUM(state='finished')) FROM background_jobs WHERE kind='prepare_source' AND resource_id='document-${created.id}'`)[0];return Number(r.total)===Number(r.finished)?r:false;},'首版整理作业到达终态',60000);
 assert.equal(rawTargets(created.id),0,'整理完成不登记原文向量目标');

 const first=materials.filter(m=>m.source.id===created.id&&m.revision==='1');
 assert.ok(first.length>=1,'首版必须实际送入整理材料');
 assert.ok(first.every(m=>m.objects.some(o=>o.id===created.id&&o.kind==='document'&&o.entries.some(e=>e.path==='body'))),'材料必须携带文档对象及其正文条目');
 assert.ok(first.some(m=>m.segments.some(s=>s.text.includes('请求入口'))),'正文内容必须进入分批材料');
 assert.equal(first.at(-1).coverage.final_batch,true,'首版覆盖完成');

 const knowledge=(await h.request('/knowledge/'+created.id)).value;
 const entry=knowledge.entries.find(e=>e.path==='body');
 assert.equal(knowledge.preparation_status.state,'ready','整理完成后准备状态如实到达ready');
 assert.equal(knowledge.preparation_status.revision,'1');
 assert.equal(entry.effective_value,body,'整理不得改动人工正文');
 assert.equal(entry.review_state,'confirmed','人工确认状态保持');
 const statements=entry.suggestion.statements;
 assert.ok(statements.length>=1,'整理成果必须登记为建议陈述');
 for(const statement of statements){
  assert.equal(statement.origin,'model_inference');
  assert.ok(statement.citations.every(c=>c.source.kind==='document'&&c.source.id===created.id&&c.revision==='1'),'陈述引用必须绑定文档来源与首版修订');
 }
 assert.equal(knowledge.version,'1','登记派生陈述不得推进原文修订');
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 assert.equal(ledger.calls,calls);assert.equal(ledger.reserved,0);
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state='settled'")[0].n,calls);
 checks.push('文档创建原子登记语义准备且不登记原文向量目标；成果登记建议、保留人工正文、不推进修订并结算预算');

 // 阶段二：改版按新修订重新登记；引用绑定新修订；整理仍不推进修订。
 await h.pauseWorker();
 const current=(await h.request('/knowledge/'+created.id+'/document')).value;
 assert.equal(current.parts[0].version,'1','整理登记不得推进原文修订');
 const secondBody=body+'\n\n## 第二版补充\n\n第二版新增口径：撤销订单不计入成功率。';
 const edited=(await h.request('/knowledge/'+created.id+'/document',{operation_id:randomUUID(),body:secondBody,parts:current.parts.map(p=>({id:p.id,expected_version:p.version}))},'alice','PATCH')).value;
 assert.equal(edited.parts[0].version,'2','正文改版推进到第2版');
 assert.equal(jobs('prepare_source',created.id,2)[0].state,'queued','保存第2版即登记该修订的整理作业');
 assert.equal(rawTargets(created.id),0,'保存第2版不登记原文向量目标');

 await h.resumeWorker();
 await until(async()=>{const row=preparation(created.id,2);return row&&row.status==='ready'&&row.call===null?row:false;},'第2版整理到ready',120000);
 const second=materials.filter(m=>m.source.id===created.id&&m.revision==='2');
 assert.ok(second.some(m=>m.segments.some(s=>s.text.includes('第二版新增口径'))),'新正文必须实际进入分批材料');
 const secondRead=(await h.request('/knowledge/'+created.id)).value;
 assert.ok(secondRead.entries.find(e=>e.path==='body').suggestion.statements.some(s=>s.citations.every(c=>c.revision==='2')),'第2版成果必须绑定第2版修订');

 // 元数据修订同样推进版本：引用绑定修订，修订推进即旧引用失效，新修订须重新登记整理。
 await h.pauseWorker();
 const meta=(await h.request('/knowledge/'+created.id+'/document',{operation_id:randomUUID(),body:secondBody,source_url:'https://example.invalid/wake-guide',parts:edited.parts.map(p=>({id:p.id,expected_version:p.version}))},'alice','PATCH')).value;
 assert.equal(meta.parts[0].version,'3','元数据修订同样推进版本');
 assert.equal(jobs('prepare_source',created.id,3).length,1,'修订推进须重新登记整理');
 await h.resumeWorker();
 await until(async()=>{const row=preparation(created.id,3);return row&&row.status==='ready'&&row.call===null?row:false;},'第3版整理到ready',120000);
 await until(async()=>{const r=h.sql(`SELECT JSON_OBJECT('total',COUNT(*),'finished',SUM(state='finished')) FROM background_jobs WHERE kind='prepare_source' AND resource_id='document-${created.id}'`)[0];return Number(r.total)===Number(r.finished)?r:false;},'全部整理作业到达终态',60000);

 const refreshed=(await h.request('/knowledge/'+created.id)).value;
 assert.equal(refreshed.version,'3','整理登记不得推进原文修订');
 const refreshedStatements=refreshed.entries.find(e=>e.path==='body').suggestion.statements;
 assert.ok(refreshedStatements.length>=1);
 assert.ok(refreshedStatements.every(s=>s.citations.every(c=>c.source.id===created.id&&['2','3'].includes(c.revision))),'成果引用必须绑定当前修订');
 assert.ok(refreshedStatements.some(s=>s.citations.every(c=>c.revision==='3')),'最新修订成果必须落地');
 assert.equal(refreshed.entries.find(e=>e.path==='body').effective_value,secondBody,'人工正文保持第2版保存值');
 const stable=calls;await new Promise(r=>setTimeout(r,1500));assert.equal(calls,stable,'整理完成后不得继续发起新调用');
 const finalLedger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 assert.equal(finalLedger.calls,calls);assert.equal(finalLedger.reserved,0);
 checks.push('文档改版按修订重新登记整理，成果绑定新修订且原文修订不被整理推进');

 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0,calls}));
}finally{if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-document-preparation.json',JSON.stringify({passed,checks,officialRequests:0,calls},null,2));}
