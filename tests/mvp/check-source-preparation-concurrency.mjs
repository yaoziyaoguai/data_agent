import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';

// 来源整理的多Worker专项：多个消费者并发领取互斥（一个作业只被一个Worker推进，
// 账目与HTTP次数一致、无重复调用）；真实进程在分析在途中被终止后，存活的Worker
// 按新代次领取，过期在途调用转unknown终态且不换ID重发；复核成果已落库
// （applying）的批次在Worker死亡后由存活Worker恢复应用，不重发模型调用。
let calls=0,h,passed=false,blocked=false,release;
const workerErrors=[];
let resumeSource,resumeArrived,resumeRelease;
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 calls++;
 const request=JSON.parse(raw);
 assert.equal(request.tools[0].function.name,'submit_semantic_preparation');
 const material=JSON.parse(request.messages[1].content);
 if(!material.draft&&blocked){blocked=false;await new Promise(r=>release=r);}
 // 阶段三钩子：复核调用在途时挂起，制造"成果已落库、应用前Worker死亡"的窗口。
 // 材料里的来源身份是裸对象id，不带source_preparations的document-前缀。
 if(resumeSource&&material.source?.id===resumeSource&&material.draft){
  resumeSource=undefined;resumeArrived?.();
  await new Promise(r=>resumeRelease=r);
 }
 const segment=material.segments[0];
 const cite={source:material.source,revision:material.revision,locator:{offset:segment.citation.locator.offset,length:Math.min(24,segment.citation.locator.length)}};
 const document=material.objects.find(o=>o.kind==='document');
 const output=material.draft??{statements:[{key:'concurrent-'+document.id,
  target:{object_id:document.id,version:document.version,path:'body'},
  text:'并发整理合成陈述：'+document.name,scope_text:'适用范围：多Worker整理验收',
  citations:[cite],supports:[]}],
  relations:[],unresolved:[],semantic_status:'ready'};
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_preparation',arguments:JSON.stringify(output)}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const spawnWorker=()=>{const child=spawn(process.cwd()+'/target/debug/data-agent-worker',{env:h.env,stdio:['ignore','pipe','pipe']});const log='';child.stderr.on('data',v=>workerErrors.push(v.toString()));child.stdout.on('data',v=>workerErrors.push(v.toString()));child.debugLog=log;return child;};

try{
 h=await harness({keep:process.env.KEEP==='1',env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify({provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:100,trial_cost_micros:'5000000',request_call_limit:24,toolset:'data',payload_bytes_limit:65536}),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();

 // 阶段一：四个文档的整理作业由三个Worker并发领取，领取互斥、账目无重复。
 const documents=[];
 for(let index=0;index<4;index++){
  const created=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'并发整理文档'+index,
   body:'# 并发整理\n\n'+index+'号文档的正文内容，包含足够的整理材料。',related_ids:[]})).value;
  documents.push(created.id);
 }
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM background_jobs WHERE kind='prepare_source' AND state='queued'`)[0].n,4,'四个整理作业排队');
 const extra=[spawnWorker(),spawnWorker()];
 await h.resumeWorker();
 await until(async()=>{
  const row=h.sql(`SELECT JSON_OBJECT('total',COUNT(*),'finished',SUM(state='finished')) FROM background_jobs WHERE kind='prepare_source'`)[0];
  return Number(row.total)===4&&Number(row.finished)===4?row:false;
 },'四个作业全部到达终态',120000);
 for(const id of documents){
  const row=h.sql(`SELECT JSON_OBJECT('status',semantic_status,'call',call_state) FROM source_preparations WHERE source_id='document-${id}'`)[0];
  assert.equal(row.status,'ready','并发领取不破坏整理推进：'+id);
  assert.equal(row.call,null,'完成后的准备记录无在途调用');
 }
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials`)[0];
 assert.equal(ledger.calls,calls,'账目与实际HTTP次数一致，没有重复消费');
 assert.equal(calls,8,'四个文档各一次分析一次复核');
 assert.equal(ledger.reserved,0);
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state='settled'")[0].n,8);
 for(const child of extra)child.kill('SIGTERM');
 await Promise.all(extra.map(child=>new Promise(r=>child.once('exit',r))));
 await h.pauseWorker();

 // 阶段二：独占Worker在分析在途中被SIGKILL，存活Worker按新代次领取；
 // 真实租约时间线走完过期，在途调用转unknown终态且不换ID重发。
 const interrupted=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'中断恢复文档',
  body:'# 中断恢复\n\n分析在途中断的文档正文，覆盖多Worker恢复语义。',related_ids:[]})).value;
 blocked=true;
 const doomed=spawnWorker();
 await until(()=>h.sql(`SELECT JSON_OBJECT('call',call_state) FROM source_preparations WHERE source_id='document-${interrupted.id}'`)[0]?.call==='analysis','中断Worker已发起分析调用',60000);
 doomed.kill('SIGKILL');
 await new Promise(r=>doomed.once('exit',r));
 await release?.();
 // 正式租约覆盖整段处理，不能等自然过期：与来源整理检查同一手法，显式把
 // 在途调用与作业租约改写为过期，存活Worker按新代次领取后走真实unknown判定。
 h.sql("UPDATE source_preparations SET issued_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE call_state IN ('analysis','review')");
 h.sql("UPDATE background_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE kind='prepare_source' AND state='running'");
 await h.resumeWorker();
 // 存活Worker先确认不抢在途作业（busy保护），领取后过期在途调用转unknown终态。
 await until(async()=>{
  const row=h.sql(`SELECT JSON_OBJECT('status',semantic_status,'call',call_state,'error',error_code) FROM source_preparations WHERE source_id='document-${interrupted.id}'`)[0];
  return row&&row.status==='failed'&&row.error==='model_unknown'?row:false;
 },'过期在途调用转unknown终态',120000);
 const callsAfterFailure=calls;
 const job=h.sql(`SELECT JSON_OBJECT('state',state,'epochs',lease_epoch) FROM background_jobs WHERE kind='prepare_source' AND resource_id='document-${interrupted.id}'`)[0];
 assert.equal(job.state,'failed','中断作业按unknown终态失败，不无限重试');
 assert.ok(job.epochs>=2,'由新Worker以新代次领取');
 const unsettled=h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state<>'settled'`)[0].n;
 assert.equal(unsettled,1,'中断的分析调用保持issued/unknown，不自动重发');
 assert.equal(callsAfterFailure,9,'中断场景只发生一次分析调用');
 const reserved=h.sql(`SELECT JSON_OBJECT('reserved',reserved_micros) FROM model_trials`)[0].reserved;
 assert.ok(Number(reserved)>0,'未知回执的预算预留不释放');
 await new Promise(r=>setTimeout(r,2000));
 assert.equal(calls,9,'unknown不重发：两秒内没有新的模型调用');
 // 并发apply在近空表上的间隙锁死锁（storage_failure code=40001）是可重试瞬态：
 // 打印允许出现，恢复由上面的终态、调用数与账目断言共同保证；解码错误才是
 // 数据级故障，不允许出现。
 assert.ok(workerErrors.every(text=>!text.includes('storage_decode')),'全程没有数据解码类故障');

 // 阶段三：复核成果已在应用前落库（applying）的Worker死亡——应用事务回滚
 // （死锁、瞬时断库）后的重试走同一路径：存活Worker从已提交成果恢复应用，
 // 不重发任何模型调用。
 await h.pauseWorker();
 const resumable=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'应用恢复文档',
  body:'# 应用恢复\n\n分析完成后在应用前中断的正文。',related_ids:[]})).value;
 resumeSource=resumable.id;
 const resumeStarted=new Promise(r=>resumeArrived=r);
 const doomedResume=spawnWorker();
 // 单Worker处理本批，正常必到复核；有界等待防止作业异常耗尽重试时挂死检查。
 await Promise.race([resumeStarted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('应用恢复场景的复核调用未到达')),90000))]);
 h.sql(`UPDATE source_preparations SET call_state='applying',issued_until=NULL WHERE source_id='document-${resumable.id}'`);
 const callsBeforeResume=calls;
 doomedResume.kill('SIGKILL');
 await new Promise(r=>doomedResume.once('exit',r));
 resumeRelease();
 h.sql("UPDATE background_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE kind='prepare_source' AND state='running'");
 await h.resumeWorker();
 await until(async()=>{
  const row=h.sql(`SELECT JSON_OBJECT('status',semantic_status,'call',call_state) FROM source_preparations WHERE source_id='document-${resumable.id}'`)[0];
  return row&&row.status==='ready'&&row.call===null?row:false;
 },'从已落库成果恢复应用到ready',120000);
 assert.equal(calls,callsBeforeResume,'恢复应用不重发模型调用');
 assert.equal(h.sql(`SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE kind='prepare_source' AND resource_id='document-${resumable.id}'`)[0].state,'finished');
 const applied=(await h.request('/knowledge/'+resumable.id)).value;
 assert.ok(applied.entries.some(e=>e.suggestion?.statements?.some(s=>s.text.includes('并发整理合成陈述'))),'已提交成果确实落地');
 passed=true;
 console.log(JSON.stringify({passed,calls,officialRequests:0,concurrency:'三个Worker并发领取互斥；SIGKILL后新代次领取，在途unknown不重发；applying成果死亡恢复零重发'}));
}catch(error){
 console.error(error);
 console.error('jobs:',JSON.stringify(h?.sql("SELECT JSON_OBJECT('kind',kind,'state',state,'lease',lease_until) FROM background_jobs WHERE kind='prepare_source'")));
 console.error('preparations:',JSON.stringify(h?.sql("SELECT JSON_OBJECT('source',source_id,'status',semantic_status,'call',call_state) FROM source_preparations")));
 console.error('worker output:',workerErrors.join('').slice(-2000));
 throw error;
}finally{
 release?.();
 resumeRelease?.();
 await h?.close();
 await new Promise(r=>provider.close(r));
 await writeFile('.local/checks/mvp-source-preparation-concurrency.json',JSON.stringify({passed,calls,officialRequests:0},null,2));
}
