import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint,restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness,until} from './harness.mjs';
// 门槛随工具契约增长重校准：64KB校准于固定开销≈45KB时代（最大请求65185B、余量351B）；
// 80KB校准于固定开销≈54.7KB时代。现固定开销≈70.4KB（工具目录53.3KB+系统提示17.1KB），
// 近16KB合法工作区+记忆参考的无历史请求实测≈86.4KB，24轮历史压缩后的最小完整请求
// （系统+工具+工作区+摘要+尾部+正文）实测≈93.5KB，80KB已结构性装不下。取96KB：
// 压缩前估算≈166KB仍经字节预检强制Pi原生压缩，压缩后请求<96KB放行，仍低于生产128KB
// 保持压力属性；64KB拒绝行为由check-request-context覆盖。
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:48,trial_cost_micros:'300000',request_call_limit:12,toolset:'data',payload_bytes_limit:98304};
const manager=SessionManager.inMemory('/synthetic/data-agent');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const historicalMarker='SYNTHETIC_SAVED_VOICE_SQL';
let run,mode,calls=0,compactions=0,mixedSummaries=0,checkpoint=exportCheckpoint(manager),passed=false;const payloadBytes=[];
// 组6接缝：伪造§4.2落地前的旧结构化search回执——content带长游标、details带operation_id。
// 同一旧分支在普通请求与Pi原生压缩摘要请求中都只能看到rc1短引用；原entry/内容/排序不变。
const legacyOperation='op-legacy-'+randomUUID();
const legacyCursor='H4sIAAAAAAAAAlegacy_'+('x'.repeat(600));
const legacyHit='旧回执原始命中正文必须原样保留。';
let legacyRequests=0,legacySummaries=0,legacyOriginal;
const provider=createServer(async(req,res)=>{let raw='';req.setEncoding('utf8');for await(const c of req)raw+=c;payloadBytes.push(Buffer.byteLength(raw));assert.ok(Buffer.byteLength(raw)<=98304);calls++;const body=JSON.parse(raw);
 const summary=!body.tools?.length;if(summary)compactions++;
 const rawAll=JSON.stringify(body.messages);
 if(rawAll.includes(legacyHit)){
  assert.ok(!rawAll.includes(legacyCursor),'旧search回执长游标不得进入普通或摘要请求');
  assert.ok(rawAll.includes('rc1:'+legacyOperation),'旧search回执的模型可见投影必须是rc1短引用');
  if(summary)legacySummaries++;else legacyRequests++;
 }
 const messageText=v=>typeof v.content==='string'?v.content:(v.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
 const references=body.messages.filter(v=>messageText(v).startsWith('个人记忆参考：'));
 // v2§6.1：来源未裁决的请求（source_context_ready:false，轮首route前）不注入记忆参考；裁决后请求仍恰好一条。
 const workspaceReference=body.messages.filter(v=>messageText(v).startsWith('当前宿主事实：')).at(-1);
 const narrowedNow=workspaceReference!==undefined&&messageText(workspaceReference).includes('"source_context_ready":false');
 if(summary)assert.equal(references.length,0,'原生摘要不接收临时记忆参考');
 else {assert.equal(references.length,narrowedNow?0:1);if(references.length===1){assert.equal(references[0].role,'user');assert.match(messageText(references[0]),/合成压缩记忆/);assert.ok(!body.messages.filter(v=>v.role==='system').some(v=>JSON.stringify(v).includes('合成压缩记忆')));}}
 let delta;if(summary){const text=JSON.stringify(body.messages),mixed=text.includes(historicalMarker)&&text.includes('table-demo_order_detail');if(mixed)mixedSummaries++;delta={role:'assistant',content:mixed?'合成历史摘要：当前资料table-demo_order_detail仍须按当前版本核验；历史查询'+historicalMarker+'仅复述保存时SQL和条件，不授予当前口径或执行权限。通过read_conversation找回原文，read_analysis_task补查条件。':'合成历史摘要：同一会话有多个订单分析问题。通过read_conversation找回原文，read_analysis_task补查条件。'};}
 else if(mode==='route'){mode='answer';delta={role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'update_analysis_task',arguments:JSON.stringify({action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]})}}]};}
 else delta={role:'assistant',content:'可以继续这个对话。'};
 const tool=!!delta.tool_calls;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'synthetic',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\n');res.write('data: '+JSON.stringify({id:'synthetic',choices:[],usage:{prompt_tokens:Math.ceil(Buffer.byteLength(raw)/3),completion_tokens:50}})+'\n\n');res.end('data: [DONE]\n\n');});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const h=await harness({capture:true,profile,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_TOOL_CONTRACT_VERSION:'2'}});
const before={DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY,DEEPSEEK_BASE_URL:process.env.DEEPSEEK_BASE_URL,DATA_AGENT_PROVIDER_TEST:process.env.DATA_AGENT_PROVIDER_TEST};Object.assign(process.env,{DEEPSEEK_API_KEY:'synthetic-protocol-key',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+provider.address().port,DATA_AGENT_PROVIDER_TEST:'1'});
try{
 const cid=await h.create();
 const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
 const invoke=async(name,args,session=manager)=>{
  const sdk=randomUUID();
  session.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name,arguments:args}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:name,arguments:args,checkpoint:exportCheckpoint(session)};
  ok(await h.internal('/internal/data/tool-calls',input));const data=ok(await h.internal('/internal/data/tools',input)).data;
  session.appendMessage({role:'toolResult',toolCallId:sdk,toolName:name,content:[{type:'text',text:JSON.stringify(data)}],isError:false,timestamp:Date.now()});
  return data;
 };
 const historySource=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'保存时语音说明',body:'保存时一个会话可含多个语音轮次。',related_ids:[]}));
 const seed=SessionManager.inMemory('/synthetic/data-agent');
 run=await h.capture(cid,'先保存合成历史SQL，不执行。');await h.pauseWorker();
 assert.equal(run.tool_contract_version,2,'组6旧回执投影属v2合同行为，rc1只解析合同2回执');
 const historicalTask=await invoke('update_analysis_task',{action:'create',goal:'保存时语音轮次',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null},options:[]},seed);
 const historicalQuery=await invoke('request_query',{task_id:historicalTask.task_id,condition_version:historicalTask.condition_version,sql:'SELECT 7 AS voice_turns',parameters:{},target_id:'synthetic-sqlite',summary:historicalMarker,knowledge_refs:[{object_id:historySource.id,version:historySource.version,path:'body'}],replaces_query_id:null},seed);
 const seedText='已保存合成历史SQL。';
 ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text:seedText}));
 ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:seedText,checkpoint:exportCheckpoint(seed)}));
 h.releaseRun(run.run_id);
 let historyVersion=ok(await h.request('/knowledge/'+historySource.id,{operation_id:randomUUID(),expected_version:historySource.version,entry_id:'body',value:'现行说明新增轮次定义，旧SQL只能作历史阅读。',clear_override:false},'alice','PATCH')).version;
 await h.resumeWorker();
 assert.equal((await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'合成压缩记忆',body:'合成压缩记忆：金额展示用元',scope:'仅合成订单分析',verified:false,source_text:'本人明确保存',dependencies:[]})).status,200);
 for(let i=0;i<6;i++){
  run=await h.capture(cid,'继续第'+i+'轮：'+ '合成中文业务补充'.repeat(100));await h.pauseWorker();
  if(i===0){
   manager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});
   // v2合同：新消息的run先route接回历史任务获得任务上下文，才能读取正文（与组4同前提）。
   await invoke('update_analysis_task',{action:'route',task_id:historicalTask.task_id,expected_version:historicalTask.condition_version,options:[]});
   const historical=await invoke('get_query',{query_id:historicalQuery.id});
   assert.equal(historical.historical_analysis.kind,'query');assert.ok(historical.content_text.includes(historicalMarker));
   // v2合同read_knowledge以items+EvidenceRef读取；表描述是知识对象的一处entry。
   const tableKnowledge=(await h.request('/knowledge/table-demo_order_detail')).value;
   await invoke('read_knowledge',{items:[{kind:'knowledge',ref:{object_id:'table-demo_order_detail',version:String(tableKnowledge.version),path:'description'}}]});
   // 不经Rust登记的旧分支entry：投影断言只要求宿主能按details.operation_id准确关联成功回执；
   // rc1解析边界由组4的cursor-boundaries/continuation接缝证明。
   for(let n=0;n<24;n++){manager.appendMessage({role:'user',content:[{type:'text',text:'合成语义说明'.repeat(167)}],timestamp:Date.now()});manager.appendMessage({role:'assistant',content:[{type:'text',text:'已记录。'}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'stop',usage,timestamp:Date.now()});}
   checkpoint=exportCheckpoint(manager);
  }
  if(i===1){
   // 轮0首次全量投影必然超限先压缩，常规请求结构上拿不到轮0旧回执；旧回执在轮0压缩后追加：
   // 轮1常规请求体量内可完整携带rc1投影（约93.5KB<96KB），轮3/5再压缩时进入摘要头，
   // 普通与摘要两种请求类型在同一分支上核验同一rc1投影。
   const round1=restoreCheckpoint('/synthetic/data-agent',checkpoint);
   round1.appendMessage({role:'assistant',content:[{type:'toolCall',id:'legacy-search-call',name:'search_knowledge',arguments:{query:'合成旧口径',limit:2,kinds:['term']}}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
   round1.appendMessage({role:'toolResult',toolCallId:'legacy-search-call',toolName:'search_knowledge',
    content:[{type:'text',text:JSON.stringify({query:'合成旧口径',hits:[{record_kind:'knowledge_entry',definition:legacyHit}],search_coverage:{delivered_hits:1,total_hits:1,next:legacyCursor}})}],
    details:{operation_id:legacyOperation,tool_name:'search_knowledge',data:{query:'合成旧口径',search_coverage:{delivered_hits:1,total_hits:1,next:legacyCursor}}},isError:false,timestamp:Date.now()});
   legacyOriginal=structuredClone(round1.getBranch().at(-1));
   checkpoint=exportCheckpoint(round1);
  }
  run.checkpoint=checkpoint;
  // 宿主工作区上限16KB、goal最多240字；用接近上限的合法条件测试，而不是绕过裁剪的18KB目标。
  run.workspace_context.tasks=[{id:'large-context-task',goal:'合成宿主任务',condition_version:'1',lifecycle:'active',phase:'investigating',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''}}];
  const visibleBytes=()=>Buffer.byteLength(JSON.stringify({...run.workspace_context,authority_snapshot:undefined,authority_revision:undefined}));
  while(visibleBytes()<15500)run.workspace_context.tasks[0].conditions.notes+='合成宿主条件';
  assert.ok(visibleBytes()>=15500&&visibleBytes()<=16000);
  mode='route';await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');
  checkpoint=h.sql(`SELECT JSON_OBJECT('checkpoint',checkpoint) FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0].checkpoint;
  if(i===1||i===2){
   // 原entry与其长游标保持不变，投影恰好一条context edit；下一轮恢复不重复追加。
   const savedRound=restoreCheckpoint('/synthetic/data-agent',checkpoint);
   const legacyEntry=savedRound.getBranch().find(e=>e.id===legacyOriginal.id);
   assert.ok(legacyEntry,'压缩及恢复后的同一分支必须保留原search条目');
   assert.deepEqual(legacyEntry,legacyOriginal,'context edit只改模型投影，原entry及完整content保持不变');
   assert.equal(savedRound.getBranch().filter(e=>e.type==='context_edit'&&e.targetId===legacyEntry.id).length,1,'旧回执投影恰好一条context edit且跨轮不重复');
  }
  h.releaseRun(run.run_id);await h.resumeWorker();
  if(i===0)historyVersion=ok(await h.request('/knowledge/'+historySource.id,{operation_id:randomUUID(),expected_version:historyVersion,entry_id:'body',value:'历史来源再次正常改版，旧SQL正文仍按保存时阅读。',clear_override:false},'alice','PATCH')).version;
 }
 const restored=restoreCheckpoint('/synthetic/data-agent',checkpoint);assert.ok(compactions>=1);assert.ok(restored.getBranch().some(e=>e.type==='compaction'));assert.equal(restored.getHeader().id,manager.getHeader().id);
 assert.ok(legacyRequests>=1&&legacySummaries>=1,'同一旧分支在普通请求与原生压缩摘要请求中都只看到rc1短引用',);
 assert.ok(mixedSummaries>=1,'真实原生摘要请求必须同时包含当前用途与历史投影');
 assert.ok(restored.getBranch().some(e=>e.type==='compaction'&&e.summary.includes(historicalMarker)&&e.summary.includes('table-demo_order_detail')));
 assert.ok(checkpoint.authority_snapshot.knowledge.some(v=>v[0]==='table-demo_order_detail'));
 assert.ok(!checkpoint.authority_snapshot.knowledge.some(v=>v[0]===historySource.id),'历史来源不混入当前知识桶');
 assert.ok(checkpoint.authority_snapshot.historical_analyses.some(entry=>entry.reference.query_id===historicalQuery.id));
 const mixedCheckpoint=structuredClone(checkpoint),mixedChain=run.recovery_chain_id;
 h.sql(`CREATE TABLE synthetic_query_restore LIKE query_requests;INSERT INTO synthetic_query_restore SELECT * FROM query_requests WHERE id='${historicalQuery.id}'`);
 const historyRecovery=[];
 try{
  for(const state of ['changed','deleted']){
   run=await h.capture(cid,'混合摘要的历史投影'+state+'后恢复原输入');await h.pauseWorker();
   const pending=run,captured=h.captured.length;
   assert.ok(pending.checkpoint);const pendingSession=restoreCheckpoint('/synthetic/data-agent',pending.checkpoint);
   assert.equal(pendingSession.getSessionId(),restored.getSessionId());
   // v2合同：该run同样先route接回历史任务再读历史投影（直调不经provider，不影响calls断言）。
   await invoke('update_analysis_task',{action:'route',task_id:historicalTask.task_id,expected_version:historicalTask.condition_version,options:[]},pendingSession);
   const historical=await invoke('get_query',{query_id:historicalQuery.id},pendingSession);
   assert.equal(historical.historical_analysis.kind,'query');
   if(state==='changed')h.sql(`UPDATE query_requests SET summary='SYNTHETIC_CHANGED_SAVED_SQL' WHERE id='${historicalQuery.id}'`);
   else h.sql(`DELETE FROM query_requests WHERE id='${historicalQuery.id}'`);
   const beforeDispatch=calls;
   assert.equal((await h.internal('/internal/model/reserve',{run_id:pending.run_id,lease_epoch:pending.lease_epoch,call_attempt_id:randomUUID(),parameters_fingerprint:'b'.repeat(64),input_tokens_upper:profile.input_limit,output_tokens_max:profile.output_limit})).value.code,'stale_context');
   h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${pending.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${pending.message_id}'`);
   h.releaseRun(pending.run_id);await h.resumeWorker();
   await until(()=>h.sql(`SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE message_id='${pending.message_id}'`).some(job=>job.state==='failed'),'历史投影'+state+'后的原输入保守拒绝',40000);
   await h.pauseWorker();
   const failed=(await h.snapshot(cid)).events.find(event=>event.type==='run_failed'&&event.payload.message_id===pending.message_id);
   assert.equal(failed?.payload.code,'stale_context');assert.equal(calls,beforeDispatch,'失效历史摘要不能进入provider');
   assert.ok(!h.captured.slice(captured).some(value=>value.message_id===pending.message_id),'原输入不能换SDK历史绕过历史投影失效');
   assert.deepEqual(h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${mixedChain}'`)[0],mixedCheckpoint,'安全拒绝不能改写原已确认摘要和历史正文');
   historyRecovery.push({state,code:failed.payload.code,providerCalls:0,passed:true});
   h.sql(`DELETE FROM query_requests WHERE id='${historicalQuery.id}';INSERT INTO query_requests SELECT * FROM synthetic_query_restore`);
   await h.resumeWorker();
  }
 }finally{
  h.sql(`DELETE FROM query_requests WHERE id='${historicalQuery.id}';INSERT INTO query_requests SELECT * FROM synthetic_query_restore;DROP TABLE synthetic_query_restore`);
 }
 assert.deepEqual(checkpoint,mixedCheckpoint);
 run=await h.capture(cid,'压缩后继续调查');await h.pauseWorker();
 const consumed=(await h.request('/knowledge/table-demo_order_detail')).value;
 assert.equal((await h.request('/knowledge/'+consumed.id+'/disable',{operation_id:randomUUID(),expected_version:consumed.version})).status,200);
 assert.equal((await h.internal('/internal/model/reserve',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID(),parameters_fingerprint:'a'.repeat(64),input_tokens_upper:profile.input_limit,output_tokens_max:profile.output_limit})).value.code,'stale_context');
 assert.equal((await h.request('/conversations/'+cid+'/messages/'+run.message_id+'/withdraw',{operation_id:randomUUID()})).status,200);h.releaseRun(run.run_id);await h.resumeWorker();
 const short=SessionManager.inMemory('/synthetic/data-agent');for(let i=0;i<140;i++){short.appendMessage({role:'user',content:[{type:'text',text:'好'}],timestamp:Date.now()});short.appendMessage({role:'assistant',content:[{type:'text',text:'好的'}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'stop',usage,timestamp:Date.now()});}
 const shortCid=await h.create();run=await h.capture(shortCid,'继续这个短消息对话');await h.pauseWorker();run.checkpoint=exportCheckpoint(short);mode='route';await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
 assert.equal((await h.snapshot(shortCid)).runs.filter(r=>r.state==='finished').length,1);
 // 七条主动消息共享本地协议试验总额；逐消息限制保持12，摘要也必须计入原请求。
 const scopes=h.sql(`SELECT JSON_OBJECT('id',b.id,'call_limit',b.call_limit,'issued_calls',b.issued_calls) FROM budget_scopes b JOIN conversation_messages m ON m.id=b.message_id WHERE m.conversation_id IN ('${cid}','${shortCid}')`);
 assert.equal(scopes.filter(scope=>scope.issued_calls>0).length,7);
 assert.ok(scopes.every(scope=>scope.call_limit===12 && scope.issued_calls<=12));
 assert.equal(scopes.reduce((sum,scope)=>sum+scope.issued_calls,0),calls);
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];assert.equal(ledger.calls,calls);assert.equal(ledger.reserved,0);assert.equal((await h.snapshot(cid)).runs.filter(r=>r.state==='finished').length,7);passed=true;
 console.log(JSON.stringify({passed,checks:[{name:'恢复24轮中文历史后，Pi原生压缩衔接近16KB宿主上下文和80KB门槛；继续6轮且保持同SDK会话，压缩请求计原预算；早期当前依赖与历史投影同时进入摘要，历史来源改版可续，当前撤回与历史记录改删均阻止派发',passed:true},{name:'旧结构化search回执经Pi原生context edit只把模型可见长游标短化为rc1引用；普通与摘要请求同一分支一致，原entry/内容不变且跨轮不重复',passed:true}],calls,compactions,mixedSummaries,legacyRequests,legacySummaries,historyRecovery,payloadBytes,shortHistoryMessages:280,officialRequests:0}));
}finally{for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-native-compaction.json',JSON.stringify({passed,calls,compactions,mixedSummaries,legacyRequests,legacySummaries,payloadBytes,shortHistoryMessages:280,officialRequests:0},null,2));}
