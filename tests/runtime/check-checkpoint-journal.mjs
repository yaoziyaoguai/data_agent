import assert from 'node:assert/strict';
import fs, {readFileSync,writeFileSync,lstatSync,unlinkSync,symlinkSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {restoreCheckpoint,restoreAdoptedSteps,exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {taskProjection} from '../../apps/agent/session/task-projection.ts';
import {createDeliveryServer} from '../../apps/agent/transport/server.ts';
import {appendLongHistory} from './checkpoint-fixture.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createConnection} from 'node:net';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {mkdirSync} from 'node:fs';

const failureChecks=[];
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(content,stopReason='stop')=>({role:'assistant',content,api:'openai-completions',provider:'local_mock',model:'task_demo',usage,stopReason,timestamp:1});

// 故障只注入原生文件边界；SessionManager和deliver均执行正式实现。
for(const failure of ['append','first_flush','sync']){
 const loaded=restoreCheckpoint('/synthetic/data-agent',null);
 let confirmed=null;
 if(failure!=='first_flush'){
  loaded.appendMessage({role:'user',content:'宿主已确认的合成输入',timestamp:1});
  confirmed=exportCheckpoint(loaded);
 }
 const file=loaded.getSessionFile();
 const originalAppend=fs.appendFileSync,originalWrite=fs.writeFileSync,originalSync=fs.fsyncSync;
 let injected=0,thrown;
 try{
  if(failure==='append')fs.appendFileSync=function(target,...args){if(target===file){injected++;throw new Error('synthetic_append_failed');}return originalAppend.call(this,target,...args);};
  if(failure==='first_flush')fs.writeFileSync=function(target,data,...args){if(typeof target==='number'&&String(data).includes('"type":"message"')){injected++;throw new Error('synthetic_first_flush_failed');}return originalWrite.call(this,target,data,...args);};
  syncBuiltinESMExports();
  if(failure==='sync'){
   loaded.appendMessage({role:'user',content:'内存与文件已有但尚未由宿主确认的新条目',timestamp:2});
   fs.fsyncSync=function(){injected++;throw new Error('synthetic_sync_failed');};
   syncBuiltinESMExports();
   assert.throws(()=>exportCheckpoint(loaded),/synthetic_sync_failed/);
  }else{
   try{loaded.appendMessage({role:'user',content:'不得发布未落盘的内存leaf',timestamp:2});}catch(error){thrown=error;}
   assert.match(thrown?.message??'',new RegExp('synthetic_'+failure+'_failed'));
   assert.ok(loaded.getLeafId());
   assert.notEqual(loaded.getLeafId(),confirmed?.leaf_id);
   assert.equal(loaded.isPersisted(),true,'isPersisted只表示模式，不能充当当前leaf已落盘证据');
  }
 }finally{fs.appendFileSync=originalAppend;fs.writeFileSync=originalWrite;fs.fsyncSync=originalSync;syncBuiltinESMExports();}
 if(failure!=='sync')assert.throws(()=>exportCheckpoint(loaded,undefined,undefined,true),/checkpoint_(leaf_unavailable|storage_invalid)/);
 if(confirmed){
  const restored=restoreCheckpoint('/synthetic/data-agent',confirmed);
  assert.equal(restored.getSessionId(),loaded.getSessionId());
  assert.equal(restored.getLeafId(),confirmed.leaf_id);
 }
 assert.equal(injected,1);
 failureChecks.push({failure,passed:true,confirmedLeafPreserved:Boolean(confirmed)});
}

let finishes=0;
const host=createServer(async(request,response)=>{
 let raw='';for await(const chunk of request)raw+=chunk;
 const input=JSON.parse(raw);
 const value=request.url==='/internal/model/issue'?{state:'issued'}:
  request.url==='/internal/model/settle'?{state:'settled'}:
  request.url==='/internal/outputs'?{chunk_seq:input.chunk_seq}:
  request.url==='/internal/finish'?(finishes++,{state:'finished',output_id:'synthetic-output'}):null;
 response.writeHead(value?200:404,{'content-type':'application/json'}).end(JSON.stringify(value));
});
await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
try{
 for(const failure of ['append','first_flush','sync']){
  const loaded=restoreCheckpoint('/synthetic/data-agent',null);
  loaded.appendMessage({role:'user',content:'仅合成确认输入',timestamp:1});
  loaded.appendMessage(assistant([{type:'toolCall',id:'synthetic-original-call',name:'update_analysis_task',arguments:{action:'create_task',goal:'合成任务'}}],'toolUse'));
  loaded.appendMessage({role:'toolResult',toolCallId:'synthetic-original-call',toolName:'update_analysis_task',content:[{type:'text',text:'{"task_id":"synthetic-task","condition_version":"1"}'}],isError:false,timestamp:1});
  const confirmed=exportCheckpoint(loaded),file=loaded.getSessionFile();
  const originalAppend=fs.appendFileSync,originalWrite=fs.writeFileSync,originalSync=fs.fsyncSync;
  let injected=0,error;
  const run={request_id:'synthetic-request',run_id:'synthetic-run',conversation_id:'synthetic-conversation',recovery_chain_id:'synthetic-chain',lease_epoch:'1',budget_scope_id:'synthetic-budget',output_id:'synthetic-output',attempt_id:'synthetic-attempt',message_id:'synthetic-message',text:'沿原合成任务说明结果',checkpoint:failure==='first_flush'?null:confirmed,model_profile:null,...(failure!=='first_flush'?{resume_same_input:true}:{})};
  try{
   if(failure==='append')fs.appendFileSync=function(target,data,...args){if(target===file&&String(data).includes('"role":"assistant"')&&injected===0){injected++;throw new Error('synthetic_append_failed');}return originalAppend.call(this,target,data,...args);};
   if(failure==='first_flush')fs.writeFileSync=function(target,data,...args){if(typeof target==='number'&&String(data).includes('"type":"message"')&&injected===0){injected++;throw new Error('synthetic_first_flush_failed');}return originalWrite.call(this,target,data,...args);};
   if(failure==='sync')fs.fsyncSync=function(){injected++;throw new Error('synthetic_sync_failed');};
   syncBuiltinESMExports();
   try{await deliver(run,'http://127.0.0.1:'+host.address().port,'synthetic-token','');}catch(caught){error=caught;}
  }finally{fs.appendFileSync=originalAppend;fs.writeFileSync=originalWrite;fs.fsyncSync=originalSync;syncBuiltinESMExports();}
  assert.ok(injected>0);
  assert.ok(error instanceof Error,'存储故障必须沿正式deliver出口报告失败');
  if(failure==='append'){
   assert.equal(error.message,'model_run_failed','错误出口导出失败不能替换原SDK持久化失败');
   assert.equal(error.checkpoint,undefined,'坏文件不能导出指向内存leaf的引用');
   assert.throws(()=>restoreCheckpoint('/synthetic/data-agent',confirmed),/checkpoint_storage_invalid/,'SDK在缺失父条目后写下的坏尾部仍严格拒绝，不修补');
  }
  if(failure==='sync')assert.match(error.message,/synthetic_sync_failed/);
  assert.equal(finishes,0,'写盘/同步失败不得提交finish或替换宿主确认引用');
  if(failure!=='append')assert.equal(restoreCheckpoint('/synthetic/data-agent',confirmed).getLeafId(),confirmed.leaf_id);
  failureChecks.push({failure:'deliver_'+failure,passed:true,error:failure==='first_flush'?error.code:error.message,checkpointPublished:Boolean(error.checkpoint)});
 }
}finally{await new Promise(resolve=>host.close(resolve));}

// 真实Pi在成功回答后自动压缩；仅在JSONL追加边界注入故障。
const compactionChecks=[];
for(const failure of ['none','summary','compaction_append']){
 const loaded=restoreCheckpoint('/synthetic/data-agent',null);
 for(let index=0;index<8;index++){
  loaded.appendMessage({role:'user',content:'合成压缩背景'+index+'。'.repeat(400),timestamp:1});
  loaded.appendMessage(assistant([{type:'text',text:'合成既有结论。'.repeat(100)}]));
 }
 const confirmed=exportCheckpoint(loaded),file=loaded.getSessionFile();
 let injected=0,finishes=0,error;
 const requests=[],published=[];
 const local=createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  const input=JSON.parse(raw);
  if(request.url==='/chat/completions'){
   const summary=!input.tools?.length;requests.push({summary});
   if(summary&&failure==='summary'){
    response.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'synthetic_summary_unavailable',type:'server_error'}}));return;
   }
   response.writeHead(200,{'content-type':'text/event-stream'});
   response.write('data: '+JSON.stringify({id:'synthetic-journal-compaction',choices:[{index:0,delta:{role:'assistant',content:summary?'合成压缩摘要。':'合成任务已说明。'},finish_reason:'stop'}]})+'\n\n');
   // 正常回答的真实usage触发Pi threshold；不调用私有压缩接口。
   const tokens=summary?500:63500;
   response.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:tokens,completion_tokens:30,total_tokens:tokens+30}})+'\n\n');
   response.end('data: [DONE]\n\n');return;
  }
  const value=request.url==='/internal/model/reserve'?{state:'reserved',send_allowed:false}:
   request.url==='/internal/model/send'?{state:'issued',send_allowed:true}:
   request.url==='/internal/model/finalize'?{state:input.usage?'settled':'unknown',send_allowed:false}:
   request.url==='/internal/outputs'?{chunk_seq:input.chunk_seq}:
   request.url==='/internal/finish'?(finishes++,published.push(input.checkpoint),{state:'finished',output_id:'synthetic-output'}):null;
  response.writeHead(value?200:404,{'content-type':'application/json'}).end(JSON.stringify(value));
 });
 await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));
 const originalAppend=fs.appendFileSync;
 const previous=new Map(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST'].map(name=>[name,process.env[name]]));
 try{
  process.env.DEEPSEEK_API_KEY='synthetic-only';process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+local.address().port;process.env.DATA_AGENT_PROVIDER_TEST='1';
  if(failure==='compaction_append')fs.appendFileSync=function(target,data,...args){if(target===file&&String(data).includes('"type":"compaction"')){injected++;throw new Error('synthetic_compaction_append_failed');}return originalAppend.call(this,target,data,...args);};
  syncBuiltinESMExports();
  const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'synthetic-trial',price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:2048,payload_bytes_limit:131072,request_call_limit:24,toolset:'data',thinking_level:'off'};
  const run={request_id:'synthetic-request',run_id:'synthetic-run',conversation_id:'synthetic-conversation',recovery_chain_id:'synthetic-chain',lease_epoch:'1',budget_scope_id:'synthetic-budget',output_id:'synthetic-output',attempt_id:'synthetic-attempt',message_id:'synthetic-message',text:'说明当前合成任务',checkpoint:confirmed,model_profile:profile,workspace_context:{tasks:[],recent_messages:[],selected_skills:[],memories:[],query_observations:[],authority_revision:'synthetic-authority'}};
  try{await deliver(run,'http://127.0.0.1:'+local.address().port,'synthetic-token','');}catch(caught){error=caught;}
 }finally{
  fs.appendFileSync=originalAppend;syncBuiltinESMExports();
  for(const[name,value]of previous){if(value===undefined)delete process.env[name];else process.env[name]=value;}
  local.closeAllConnections();await new Promise(resolve=>local.close(resolve));
 }
 assert.ok(requests.some(value=>value.summary),'成功回答后的真实Pi threshold必须执行摘要：'+JSON.stringify({failure,requests,finishes,injected,error:error?{message:error.message,code:error.code}:null}));
 assert.equal(requests.filter(value=>!value.summary).length,1,'自动压缩不增加普通模型请求');
 if(failure==='compaction_append'){
  assert.equal(injected,1);
  assert.equal(finishes,0,'Pi吞掉compaction追加失败后仍不得发布未落盘leaf或提交finish');
  assert.ok(error instanceof Error);
  assert.equal(error.checkpoint,undefined);
  assert.equal(restoreCheckpoint('/synthetic/data-agent',confirmed).getLeafId(),confirmed.leaf_id,'完整旧文件仍可沿宿主确认leaf恢复');
 }else{
  if(error)throw error;
  assert.equal(finishes,1);
  const restored=restoreCheckpoint('/synthetic/data-agent',published[0]);
  assert.equal(restored.getSessionId(),loaded.getSessionId());
  assert.equal(restored.getBranch().some(entry=>entry.type==='compaction'),failure==='none','摘要服务失败未损坏日志时仍能交付已完成回答');
 }
 compactionChecks.push({failure,injected,finishes,requests,error:error?.message??null,passed:true});
}
console.log(JSON.stringify({compactionChecks}));

// 通过真实usage分别触发新prompt前和工具后轮间压缩，不调用SDK私有入口。
const compactionPositionChecks=[];
for(const position of ['before_prompt','after_tools'])for(const failure of ['none','compaction_append']){
 const loaded=restoreCheckpoint('/synthetic/data-agent',null);
 for(let index=0;index<8;index++){
  loaded.appendMessage({role:'user',content:'合成压缩位置背景'+index+'。'.repeat(400),timestamp:1});
  const message=assistant([{type:'text',text:'合成既有结论。'.repeat(100)}]);
  if(position==='before_prompt'&&index===7)Object.assign(message,{provider:'controlled_deepseek',model:'deepseek-flash',timestamp:Date.now(),usage:{...usage,input:63500,output:30,totalTokens:63530}});
  loaded.appendMessage(message);
 }
 const confirmed=exportCheckpoint(loaded),file=loaded.getSessionFile();
 const requests=[],hostRequests=[],hostErrors=[],appendsAfterFailure=[],published=[];
 let injected=0,finishes=0,toolExecutions=0,error,failedEntry,beforeFailure,atFailure;
 const local=createServer(async(request,response)=>{
  try{
   let raw='';for await(const chunk of request)raw+=chunk;
   const input=JSON.parse(raw);
   if(request.url==='/chat/completions'){
    const summary=!input.tools?.length;
    requests.push({summary,afterFailure:injected>0});
    const firstTool=position==='after_tools'&&!summary&&requests.filter(value=>!value.summary).length===1;
    const delta=firstTool?{role:'assistant',tool_calls:[{index:0,id:'synthetic-compaction-call',type:'function',function:{name:'cancel_query',arguments:'{"query_id":"synthetic-query"}'}}]}:
     {role:'assistant',content:summary?'合成压缩摘要，沿原任务继续。':'合成压缩位置核对已完成。'};
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.write('data: '+JSON.stringify({id:'synthetic-journal-position',choices:[{index:0,delta,finish_reason:firstTool?'tool_calls':'stop'}]})+'\n\n');
    const tokens=firstTool?63500:500;
    response.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:tokens,completion_tokens:30,total_tokens:tokens+30}})+'\n\n');
    response.end('data: [DONE]\n\n');return;
   }
   hostRequests.push({path:request.url,afterFailure:injected>0});
   let value;
   if(request.url==='/internal/model/reserve')value={state:'reserved',send_allowed:false};
   else if(request.url==='/internal/model/send')value={state:'issued',send_allowed:true};
   else if(request.url==='/internal/model/finalize')value={state:input.usage?'settled':'unknown',send_allowed:false};
   else if(request.url==='/internal/outputs')value={chunk_seq:input.chunk_seq};
   else if(request.url==='/internal/data/tool-calls'){
    assert.equal(input.tool_name,'cancel_query');assert.equal(input.sdk_tool_call_id,'synthetic-compaction-call');
    assert.deepEqual(input.arguments,{query_id:'synthetic-query'});value={operation_id:'synthetic-compaction-operation'};
   }else if(request.url==='/internal/data/tools'){
    assert.equal(input.tool_name,'cancel_query');assert.equal(input.sdk_tool_call_id,'synthetic-compaction-call');
    assert.deepEqual(input.arguments,{query_id:'synthetic-query'});toolExecutions++;
    value={operation_id:'synthetic-compaction-operation',tool_name:'cancel_query',data:{query_id:'synthetic-query',execution_state:'cancelled',cancellation_state:'confirmed'}};
   }else if(request.url==='/internal/finish'){finishes++;published.push(input.checkpoint);value={state:'finished',output_id:'synthetic-output'};}
   assert.ok(value,'未预期的本地宿主请求：'+request.url);
   response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));
  }catch(caught){hostErrors.push(caught.message);response.writeHead(500,{'content-type':'application/json'}).end('{"error":"synthetic_host_failed"}');}
 });
 await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));
 const originalAppend=fs.appendFileSync;
 const previous=new Map(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST'].map(name=>[name,process.env[name]]));
 try{
  process.env.DEEPSEEK_API_KEY='synthetic-only';process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+local.address().port;process.env.DATA_AGENT_PROVIDER_TEST='1';
  fs.appendFileSync=function(target,data,...args){
   if(target===file){
    const entry=JSON.parse(String(data));
    if(failure==='compaction_append'&&entry.type==='compaction'&&injected===0){
     beforeFailure=readFileSync(file);failedEntry={id:entry.id,parentId:entry.parentId};
     const restoredBeforeFailure=restoreCheckpoint('/synthetic/data-agent',confirmed);
     const persisted=beforeFailure.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
     atFailure={confirmedLeafRecoverable:restoredBeforeFailure.getSessionId()===loaded.getSessionId()&&restoredBeforeFailure.getLeafId()===confirmed.leaf_id,
      normalRequests:requests.filter(value=>!value.summary).length,toolExecutions,
      currentInputPersisted:persisted.some(value=>value.type==='message'&&value.message.role==='user'&&JSON.stringify(value.message.content).includes('核对本轮合成压缩位置')),
      toolResultPersisted:persisted.some(value=>value.type==='message'&&value.message.role==='toolResult'&&value.message.toolCallId==='synthetic-compaction-call')};
     injected++;throw new Error('synthetic_compaction_append_failed');
    }
    if(injected)appendsAfterFailure.push({type:entry.type,id:entry.id,parentId:entry.parentId,role:entry.message?.role});
   }
   return originalAppend.call(this,target,data,...args);
  };
  syncBuiltinESMExports();
  const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'synthetic-trial',price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:2048,payload_bytes_limit:131072,request_call_limit:24,toolset:'data',thinking_level:'off'};
  const run={request_id:'synthetic-request',run_id:'synthetic-run',conversation_id:'synthetic-conversation',recovery_chain_id:'synthetic-chain',lease_epoch:'1',budget_scope_id:'synthetic-budget',output_id:'synthetic-output',attempt_id:'synthetic-attempt',message_id:'synthetic-message',text:'核对本轮合成压缩位置',checkpoint:confirmed,model_profile:profile,workspace_context:{tasks:[],recent_messages:[],selected_skills:[],memories:[],query_observations:[],authority_revision:'synthetic-authority'}};
  try{await deliver(run,'http://127.0.0.1:'+local.address().port,'synthetic-token','');}catch(caught){error=caught;}
 }finally{
  fs.appendFileSync=originalAppend;syncBuiltinESMExports();
  for(const[name,value]of previous){if(value===undefined)delete process.env[name];else process.env[name]=value;}
  local.closeAllConnections();await new Promise(resolve=>local.close(resolve));
 }
 const summaryCount=requests.filter(value=>value.summary).length;
 const normalCount=requests.length-summaryCount;
 assert.ok(summaryCount>0,'指定位置必须实际执行Pi摘要：'+JSON.stringify({position,failure,requests,hostErrors,error:error?.message}));
 assert.equal(toolExecutions,position==='after_tools'?1:0,'真实工具只在工具后场景执行一次');
 assert.equal(requests[0].summary,position==='before_prompt','新prompt前摘要与工具后摘要必须来自不同真实位置');
 assert.equal(hostRequests.filter(value=>value.path==='/internal/model/send').length,requests.length,'发送许可与真实provider请求逐次对应');
 assert.deepEqual(hostErrors,[]);
 let recovery='confirmed_leaf';
 if(failure==='compaction_append'){
  assert.equal(injected,1);assert.ok(error instanceof Error);assert.equal(error.checkpoint,undefined,'坏内存leaf不能发布为checkpoint');
  assert.equal(finishes,0,'压缩追加失败不得finish');
  assert.equal(normalCount,position==='before_prompt'?0:1,'追加失败后不能额外发送普通模型请求');
  assert.equal(requests.some(value=>value.afterFailure),false,'追加失败后不能再次派发provider');
  assert.equal(hostRequests.some(value=>value.afterFailure&&['/internal/model/reserve','/internal/model/send','/internal/data/tool-calls','/internal/data/tools'].includes(value.path)),false,'追加失败后不领模型许可或执行新工具');
  assert.deepEqual(atFailure,{confirmedLeafRecoverable:true,normalRequests:position==='before_prompt'?0:1,toolExecutions:position==='after_tools'?1:0,currentInputPersisted:position==='after_tools',toolResultPersisted:position==='after_tools'},'故障切点须在新输入前或已持久工具结果后，且此前文件完整');
  const bytes=readFileSync(file);
  assert.deepEqual(bytes.subarray(0,beforeFailure.length),beforeFailure,'已有完整前缀不能被覆盖或修补');
  let restored;
  try{restored=restoreCheckpoint('/synthetic/data-agent',confirmed);}catch(caught){
   assert.equal(caught.message,'checkpoint_storage_invalid');
   assert.ok(appendsAfterFailure.some(entry=>entry.parentId===failedEntry.id),'严格拒绝须有实际缺父尾部证据');
   assert.equal(bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line)).some(entry=>entry.id===failedEntry.id),false);
   recovery='damaged_journal_rejected';
  }
  if(restored){assert.equal(restored.getSessionId(),loaded.getSessionId());assert.equal(restored.getLeafId(),confirmed.leaf_id);}
 }else{
  if(error)throw error;
  assert.equal(finishes,1);assert.equal(normalCount,position==='before_prompt'?1:2);
  const restored=restoreCheckpoint('/synthetic/data-agent',confirmed);
  assert.equal(restored.getSessionId(),loaded.getSessionId());assert.equal(restored.getLeafId(),confirmed.leaf_id);
  assert.ok(restored.getEntries().some(entry=>entry.type==='compaction'));
  const finished=restoreCheckpoint('/synthetic/data-agent',published[0]);
  assert.equal(finished.getSessionId(),loaded.getSessionId());assert.equal(finished.getLeafId(),published[0].leaf_id,'正常finish发布的leaf确已持久化');
 }
 compactionPositionChecks.push({position,failure,injected,finishes,toolExecutions,requests,atFailure,appendsAfterFailure,recovery,error:error?.message??null,checkpointError:error?.checkpointError?.message??null,passed:true});
 console.log(JSON.stringify({compactionPositionCheck:compactionPositionChecks.at(-1)}));
}
mkdirSync('.local/checks',{recursive:true});
writeFileSync('.local/checks/checkpoint-persistence.json',JSON.stringify({passed:true,failureChecks,compactionChecks,compactionPositionChecks,officialRequests:0})+'\n');

const cwd='/synthetic/data-agent';
const manager=restoreCheckpoint(cwd,null);
const history=await appendLongHistory(manager);
const checkpoint=exportCheckpoint(manager);
assert.equal(checkpoint.storage.kind,'pi_session');assert.deepEqual(checkpoint.entries,[]);
const path=manager.getSessionFile(),journal=readFileSync(path);
assert.ok(journal.length>512*1024);assert.ok(Buffer.byteLength(JSON.stringify(checkpoint))<2048);
assert.equal(lstatSync(path).mode&0o777,0o600);
const entryLines=new Set(journal.toString('utf8').trimEnd().split('\n').slice(1));
const parse=JSON.parse;
let restoredEntryParses=0;
let restored;
try {
 JSON.parse=function(source,...args){if(entryLines.has(source))restoredEntryParses++;return parse.call(this,source,...args);};
 restored=restoreCheckpoint(cwd,checkpoint);
} finally {JSON.parse=parse;}
assert.equal(restoredEntryParses,manager.getEntries().length,'Pi 恢复时每条 JSONL 正文只解析一次');
assert.equal(restored.getSessionId(),manager.getSessionId());assert.equal(restored.getLeafId(),checkpoint.leaf_id);
assert.deepEqual(restored.getEntries(),manager.getEntries());
assert.equal(restored.getEntries().filter(e=>e.type==='compaction').length,10);
const projected=restored.buildSessionContext();
const originalLeaf=restored.getLeafId();
const tail=restored.appendMessage({role:'user',content:'未由MySQL确认的尾部分支',timestamp:Date.now()});
const beforeRecovery=readFileSync(path);
const recovered=restoreCheckpoint(cwd,checkpoint);
assert.equal(recovered.getLeafId(),originalLeaf);assert.deepEqual(recovered.buildSessionContext(),projected);
assert.ok(recovered.getEntry(tail),'原始分支保留在Pi日志');
const empty=restoreCheckpoint(cwd,{...checkpoint,leaf_id:null});assert.equal(empty.getLeafId(),null);assert.equal(empty.buildSessionContext().messages.length,0);
let dispatches=0;const token='synthetic-token';
const server=createDeliveryServer('http://127.0.0.1:1',token,async(run)=>{dispatches++;assert.equal(run.checkpoint.storage.session_id,manager.getSessionId());});
const body=Buffer.from(JSON.stringify({run_id:'run-1',conversation_id:'conversation-1',recovery_chain_id:'chain-1',lease_epoch:'1',budget_scope_id:'scope-1',output_id:'output-1',attempt_id:'attempt-1',message_id:'message-1',request_id:'request-1',text:'继续原长期会话',checkpoint,model_profile:null}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/resume-and-deliver',{
  method:'POST',headers:{authorization:'Bearer '+token},body,
 });
 assert.equal(response.status,200);assert.equal(await response.text(),'finished');assert.equal(dispatches,1);
} finally { await new Promise(resolve=>server.close(resolve)); }
const dispatchStarted = Promise.withResolvers();
const finishDispatch = Promise.withResolvers();
let duringDrain = 0;
const draining = createDeliveryServer('http://127.0.0.1:1',token,async()=>{
 duringDrain++;
 dispatchStarted.resolve();
 await finishDispatch.promise;
});
await new Promise(resolve=>draining.listen(0,'127.0.0.1',resolve));
const packet = content => Buffer.concat([Buffer.from(
 `POST /resume-and-deliver HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${content.length}\r\n\r\n`,
),content]);
const pooled = createConnection(draining.address().port,'127.0.0.1');
const idle = createConnection(draining.address().port,'127.0.0.1');
let received = '';
pooled.on('data',chunk=>{received+=chunk;});
const disconnected = once(pooled,'close',{signal:AbortSignal.timeout(4000)});
try {
 const health = once(idle,'data',{signal:AbortSignal.timeout(4000)});
 idle.write('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n');
 const [healthy] = await health;
 assert.match(healthy.toString(),/HTTP\/1\.1 200 OK/);
 const idleDisconnected = once(idle,'close',{signal:AbortSignal.timeout(4000)});
 pooled.write(packet(body));
 await dispatchStarted.promise;
 const stopped = once(draining,'close',{signal:AbortSignal.timeout(4000)});
 draining.drain();
 await idleDisconnected;
 const next = {...JSON.parse(body),conversation_id:'next-conversation'};
 const refused = once(draining,'request',{signal:AbortSignal.timeout(4000)});
 pooled.write(packet(Buffer.from(JSON.stringify(next))));
 const [,response] = await refused;
 assert.equal(response.statusCode,409,'已接入的池连接在停机后也要明确拒绝新派发');
 finishDispatch.resolve();
 await Promise.all([stopped,disconnected]);
 assert.equal(duringDrain,1,'停机中的池连接不能接纳下一次派发');
 assert.match(received,/HTTP\/1\.1 200 OK/);
 assert.match(received,/connection: close/i);
 assert.match(received,/finished/);
} finally {
 finishDispatch.resolve();
 pooled.destroy();
 idle.destroy();
 draining.close();
 draining.closeAllConnections();
}
const inline=exportCheckpoint(SessionManager.inMemory(cwd));
const legacy=SessionManager.inMemory(cwd,undefined,[manager.getHeader(),...manager.getEntries()]);legacy.branch(checkpoint.leaf_id);
const migrated=restoreCheckpoint(cwd,exportCheckpoint(legacy));
assert.equal(migrated.getSessionId(),manager.getSessionId());assert.equal(migrated.getLeafId(),checkpoint.leaf_id);assert.deepEqual(migrated.getEntries(),manager.getEntries());
assert.equal(exportCheckpoint(migrated).storage.kind,'pi_session');
const migratedPath=migrated.getSessionFile();assert.notEqual(migratedPath,path);
const faults=[
 ['empty',Buffer.alloc(0)],
 ['broken_json',Buffer.concat([beforeRecovery,Buffer.from('{broken\n')])],
 ['invalid_utf8',Buffer.concat([beforeRecovery,Buffer.from([0xff,0x0a])])],
 ['duplicate_id',Buffer.concat([beforeRecovery,Buffer.from(JSON.stringify(manager.getEntries()[0])+'\n')])],
 ['missing_parent',Buffer.concat([beforeRecovery,Buffer.from(JSON.stringify({type:'message',id:'orphan-id',parentId:'missing-parent',message:{role:'user',content:'坏父节点'}})+'\n')])],
 ];
try {
 for(const [name,bytes]of faults){writeFileSync(path,bytes);assert.throws(()=>restoreCheckpoint(cwd,checkpoint),/checkpoint_storage_invalid/,name);assert.deepEqual(readFileSync(path),bytes,'失败不修补或覆盖原文件');}
 writeFileSync(path,beforeRecovery);assert.throws(()=>restoreCheckpoint(cwd,{...checkpoint,leaf_id:'missing-leaf'}),/checkpoint_leaf_unavailable/);
 assert.throws(()=>restoreCheckpoint(cwd,{...checkpoint,storage:{...checkpoint.storage,session_id:inline.entries[0].id}}),/checkpoint_storage_invalid/);
 assert.throws(()=>restoreCheckpoint(cwd,{...checkpoint,storage:{...checkpoint.storage,file:'../private.jsonl'}}));
 unlinkSync(path);assert.throws(()=>restoreCheckpoint(cwd,checkpoint),/checkpoint_storage_missing/);assert.equal(lstatSync(migratedPath).isFile(),true);
 symlinkSync(migratedPath,path);assert.throws(()=>restoreCheckpoint(cwd,checkpoint),/checkpoint_storage_invalid/);unlinkSync(path);
}finally{writeFileSync(path,beforeRecovery,{mode:0o600});}
const short=restoreCheckpoint(cwd,null);
short.appendMessage({role:'user',content:'同一合成尾部',timestamp:1});
const exportCosts=[];
for(const [size,loaded]of [['short',short],['long',manager]]){
 const originalRead=fs.readFileSync,originalParse=JSON.parse;
 let reads=0,readBytes=0,parses=0;
 fs.readFileSync=function(...args){const result=originalRead.apply(this,args);reads++;readBytes+=Buffer.byteLength(result);return result;};
 JSON.parse=function(...args){parses++;return originalParse.apply(this,args);};
 syncBuiltinESMExports();
 const started=performance.now();
 try{
  for(let call=0;call<4;call++){
   const reference=exportCheckpoint(loaded);
   assert.equal(reference.storage.session_id,loaded.getSessionId());
   assert.equal(reference.leaf_id,loaded.getLeafId());
  }
 }finally{fs.readFileSync=originalRead;JSON.parse=originalParse;syncBuiltinESMExports();}
 exportCosts.push({size,exports:4,reads,readBytes,parses,durationMs:performance.now()-started});
}
console.log(JSON.stringify({exportCosts}));
assert.ok(exportCosts.every(cost=>cost.reads===0&&cost.parses===0),'已加载会话健康导出不能反复整读或解析JSONL');
const tool = id => assistant([{type:'toolCall',id,name:'search_knowledge',arguments:{query:'合成资料'}}], 'toolUse');
short.appendMessage(tool('old-branch'));
short.resetLeaf();
short.appendMessage({role:'user',content:'按新来源继续同一输入',timestamp:2});
short.appendCustomMessageEntry('data_agent_current_input','已切换来源',false,
 {message_id:'same-input',sdk_tool_call_id:'switch-scope'});
short.appendMessage(tool('adopted'));
short.appendMessage({role:'user',content:'[宿主恢复原输入] 继续原请求',timestamp:3});
short.appendMessage(tool('recovered'));
assert.deepEqual(exportCheckpoint(short).branch_tool_call_ids,['recovered','adopted','switch-scope']);
short.appendCustomMessageEntry('data_agent_current_input','旧范围切换',false,{message_id:'same-input'});
short.appendMessage(tool('legacy-current'));
assert.equal(exportCheckpoint(short).branch_tool_call_ids,undefined,'旧切换标记用原记录回退');

const scoped = SessionManager.inMemory('/synthetic/data-agent');
scoped.appendMessage({role:'user',content:'按两个来源分别回答',timestamp:1});
const root = scoped.getLeafId();
scoped.appendMessage(tool('discarded-branch'));
scoped.branch(root);
const result = (id,details) => scoped.appendMessage({role:'toolResult',toolCallId:id,
  toolName:'update_analysis_task',content:[{type:'text',text:'合成操作完成'}],details,isError:false,timestamp:2});
const frozenParts = [{finalized_by_sdk_tool_call_id:'freeze-first',
  task_ref:{task_id:'first',condition_version:'1'},scope_fingerprint:'a'.repeat(64)}];
for (const id of ['search-first','read-first','freeze-first']) {
  scoped.appendMessage(tool(id));
  result(id,id==='freeze-first'?{data:{},answer_parts:frozenParts}:{data:{}});
}
const workspace = {selected_skills:[]};
const transport = {run:{text:'按两个来源分别回答',message_id:'same-input',workspace_context:workspace,
  answer_parts:frozenParts},
  async post(){return workspace;},binding(){return {};}};
const projection = taskProjection(transport,scoped,()=>{});
const switchReceipt = {data:{},context_reset:{task_id:'second',condition_version:'1'}};
scoped.appendMessage(tool('unadopted-read'));
result('unadopted-read',{data:{}});
scoped.appendMessage(tool('route-second'));
result('route-second',switchReceipt);
projection.acceptReceipt(switchReceipt,'route-second');
await projection.apply();
scoped.appendMessage(tool('search-second'));
result('search-second',{data:{}});
const bothParts = [...frozenParts,{finalized_by_sdk_tool_call_id:'freeze-second',
  task_ref:{task_id:'second',condition_version:'1'},scope_fingerprint:'b'.repeat(64)}];
scoped.appendMessage(tool('freeze-second'));
result('freeze-second',{data:{},answer_parts:bothParts});
const adoptedCalls = new Set(['search-first','read-first','freeze-first','route-second','search-second','freeze-second']);
const older = exportCheckpoint(scoped);
assert.deepEqual(new Set(older.branch_tool_call_ids),adoptedCalls);
// 发布过的旧标记保留切换调用 ID，但尚无定稿步骤引用。
delete older.entries.find(entry => entry.type==='custom_message' && entry.customType==='data_agent_current_input').details.adopted_tool_call_ids;
older.branch_tool_call_ids = ['freeze-second','search-second','route-second'];
for (const hasRouteId of [true,false]) {
  const legacy = structuredClone(older);
  const expected = new Set(adoptedCalls);
  if (!hasRouteId) {
    legacy.entries[0].id = SessionManager.inMemory(cwd).getSessionId();
    delete legacy.entries.find(entry => entry.type==='custom_message' && entry.customType==='data_agent_current_input').details.sdk_tool_call_id;
    delete legacy.branch_tool_call_ids;
    expected.delete('route-second');
  }
  const resumed = restoreCheckpoint(cwd,legacy);
  const modelMessages = resumed.buildSessionContext().messages;
  restoreAdoptedSteps(resumed,resumed.getBranch(),'same-input',bothParts);
  const adoptedRestore = restoreCheckpoint(cwd,exportCheckpoint(resumed));
  const restored = exportCheckpoint(adoptedRestore);
  if (hasRouteId) assert.deepEqual(new Set(restored.branch_tool_call_ids),expected);
  else assert.equal(restored.branch_tool_call_ids,undefined,'旧标记缺切换调用 ID 时仍沿用原记录');
  assert.deepEqual(adoptedRestore.buildSessionContext().messages,modelMessages,'已定稿步骤恢复不能把旧正文加回模型输入');
  const entryCount = adoptedRestore.getEntryCount();
  restoreAdoptedSteps(adoptedRestore,adoptedRestore.getBranch(),'same-input',bothParts);
  assert.equal(adoptedRestore.getEntryCount(),entryCount,'恢复同一旧标记不能重复追加');
  const third = taskProjection({...transport,run:{...transport.run,answer_parts:bothParts}},adoptedRestore,()=>{});
  const thirdReceipt = {data:{},context_reset:{task_id:'third',condition_version:'1'}};
  for (const [id,details] of [['unadopted-second-read',{data:{}}],['route-third',thirdReceipt]]) {
    adoptedRestore.appendMessage(tool(id));
    adoptedRestore.appendMessage({role:'toolResult',toolCallId:id,toolName:'update_analysis_task',
      content:[{type:'text',text:'合成操作完成'}],details,isError:false,timestamp:3});
  }
  third.acceptReceipt(thirdReceipt,'route-third');
  await third.apply();
  assert.deepEqual(new Set(exportCheckpoint(adoptedRestore).branch_tool_call_ids),new Set([...expected,'route-third']));
}
console.log(JSON.stringify({passed:true,...history,journalBytes:journal.length,referenceBytes:Buffer.byteLength(JSON.stringify(checkpoint)),envelopeBytes:body.length,nativeSessionPreserved:true,originalLeafPreserved:true,legacyAdoptedStepsPreserved:true,malformedFilesRejected:faults.length,exportCosts,officialRequests:0}));
