import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {harness, replayEvents, until} from './harness.mjs';

// 真实SQLite查询结果经Rust核值，A来源答案冻结后B仍自然输出；中断使用原业务账本。
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',
  input_limit:65536,output_limit:4096,trial_call_limit:100,trial_cost_micros:'1000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const conditions={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const secondAnswer='合成乙独立完成概念解释，无需引用甲的查询结果。';
const firstAnswer='合成甲原始金额9007199254740993.01分。';
const mode=process.argv.includes('--natural-recovery')?'natural-recovery':process.argv.includes('--registered')?'registered':process.argv.includes('--committed')?'committed':'normal';
const olderQuery=process.argv.includes('--older-query');
const mixedOwner=process.argv.includes('--mixed-owner');
const historyPermissions=process.argv.includes('--history-permissions');
const firstTitle='合成甲金额'+(historyPermissions?'🧮':'');
const secondTitle='合成乙概念'+(historyPermissions?'📚':'');
const firstBody=firstAnswer+(historyPermissions?'\n\n---\n\n甲正文内的分隔符与中文🧮。':'');
// v2两步答案：prepare只登记绑定，正文以{{amount}}引用后由宿主渲染成firstBody。
const firstTemplate='合成甲原始金额{{amount}}分。'+(historyPermissions?'\n\n---\n\n甲正文内的分隔符与中文🧮。':'');
const secondBody=secondAnswer+(historyPermissions?'\n\n---\n\n乙正文内的分隔符与中文📚。':'');
const artifactDirectory='.local/checks/answer-state-contract/task-query-'+mode+(olderQuery?'-older-query':'')+'-'+randomUUID();
await mkdir(artifactDirectory,{recursive:true});
let h,run,taskA,taskB,query,result,controller,providerFailure,naturalAttempt,passed=false,interrupted=false,recovering=false,calls=0,historyPermissionChecked=false;
const posts=[],finishRequests=[],refreshRequests=[];
const originalPost=RustTransport.prototype.post;
RustTransport.prototype.post=async function(path,name,input,...rest){
  if(path==='/internal/finish'){
    finishRequests.push({recovering,input:structuredClone(input),workspace:structuredClone(this.run.workspace_context)});
    await writeFile(artifactDirectory+'/finish-requests.json',JSON.stringify(finishRequests,null,2)+'\n');
  }
  const refresh=path==='/internal/context/refresh'?{input:structuredClone(input),facts:h.sql(`SELECT JSON_OBJECT('run_authority',r.authority_snapshot,'frozen',(SELECT JSON_ARRAYAGG(answer_handoff) FROM tool_calls WHERE recovery_chain_id=r.recovery_chain_id AND state='succeeded' AND answer_part_sequence IS NOT NULL)) FROM agent_runs r WHERE r.id='${input.run_id}'`)}:null;
  if(refresh)refreshRequests.push(refresh);
  let receipt;
  try{receipt=await originalPost.call(this,path,name,input,...rest);}catch(error){
    if(refresh){refresh.error=error.message;await writeFile(artifactDirectory+'/refresh-requests.json',JSON.stringify(refreshRequests,null,2)+'\n');}
    throw error;
  }
  if(refresh){
    refresh.receipt=receipt;await writeFile(artifactDirectory+'/refresh-requests.json',JSON.stringify(refreshRequests,null,2)+'\n');
    if(historyPermissions)for(const key of ['query_results','source_query_results'])
      assert.ok(!receipt.authority_snapshot[key].some(pair=>pair[0]===query.id),'冻结甲的通知覆盖证明不得进入乙的活动模型来源');
  }
  if(input.sdk_tool_call_id==='finalize-query-a'){
    const persistedReference=path==='/internal/data/tools'
      ?h.sql(`SELECT JSON_EXTRACT(answer_handoff,'$.reference') FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='finalize-query-a'`)[0]:undefined;
    posts.push({path,recovering,input,receipt,persistedReference});
    if(['registered','committed'].includes(mode)&&!recovering&&!interrupted&&path===(mode==='registered'?'/internal/data/tool-calls':'/internal/data/tools')){
      interrupted=true;controller.abort();throw new Error('synthetic_query_handoff_interrupted');
    }
  }
  return receipt;
};
const provider=createServer(async(request,response)=>{
  try{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw)<=profile.payload_bytes_limit);assert.ok(body.tools?.length);
    calls++;assert.ok(calls<=5,'不增加来源补救或模型汇总回合');
    let action,text='';
    if(calls===1)action={id:'read-query-a',name:'get_query',arguments:{query_id:query.id}};
    else if(calls===2){
      const read=JSON.parse(body.messages.findLast(message=>message.role==='tool').content);result=read.results;
      assert.ok(result?.result_ref);
      action={id:'prepare-query-a',name:'prepare_analysis_answer',arguments:{
        sources:[{query_id:query.id,result_ref:result.result_ref,columns:['amount']}],
        values:[{name:'amount',kind:'cell',query_id:query.id,column:'amount',row_index:0}]}};
    }else if(calls===3){
      // prepare回执给bindings；本条正文以{{amount}}引用并同消息route冻结（route在message_end后执行）。
      assert.deepEqual(JSON.parse(body.messages.findLast(message=>message.role==='tool').content).bindings,{amount:'9007199254740993.01'});
      text=firstTemplate;
      action={id:'finalize-query-a',name:'update_analysis_task',arguments:{action:'route',task_id:taskB.task_id,
        expected_version:taskB.condition_version,options:[],finalize_current_answer:true}};
    }else if(calls===4){
      if(historyPermissions){
        assert.ok(!JSON.stringify(body.messages).includes(firstAnswer),'乙实际provider输入不得保留甲来源答案');
        assert.ok(JSON.stringify(body.messages).includes(taskB.task_id),'来源重置后的实际输入仍指向乙任务');
      }else assert.equal(JSON.parse(body.messages.findLast(message=>message.role==='tool').content).task_id,taskB.task_id);
      const firstRoute=posts.find(item=>item.path==='/internal/data/tools');
      assert.ok(firstRoute,'必须取得首次真实Rust route回执');
      assert.equal(firstRoute.receipt.data.task_id,taskB.task_id);
      assert.deepEqual(firstRoute.receipt.answer_parts[0],firstRoute.persistedReference,'首次route回执须与同事务持久引用一致');
      assert.deepEqual(firstRoute.receipt.answer_parts[0].source_query_ids,[query.id],'定稿引用须保留实际采用的查询来源');
      action={id:'read-natural-b',name:'read_analysis_task',arguments:{task_id:taskB.task_id}};
    }else text=secondBody;
    response.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason=null)=>response.write('data: '+JSON.stringify({id:'synthetic-query-handoff',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    emit({role:'assistant',content:text});
    if(action)emit({tool_calls:[{index:0,id:action.id,type:'function',function:{name:action.name,arguments:JSON.stringify(action.arguments)}}]});
    emit({},action?'tool_calls':'stop');
    response.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}})+'\n\n');
    response.end('data: [DONE]\n\n');
  }catch(error){providerFailure??=error;if(!response.headersSent)response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'synthetic_query_handoff_assertion'}}));}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const previous=process.env.DATA_AGENT_PROVIDER_TEST;process.env.DATA_AGENT_PROVIDER_TEST='1';
const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
try{
  h=await harness({capture:true,profile,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port,
    env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'0.1'}});
  const docB=historyPermissions?ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成乙概念资料',body:'合成乙独立完成概念解释。',related_ids:[]})):null;
  const cid=await h.create();run=await h.capture(cid,'准备合成甲金额查询和乙概念解释。'+(historyPermissions?'乙只使用本轮新建的合成乙概念资料，不使用甲的查询结果。':''));await h.pauseWorker();
  const manager=SessionManager.inMemory('/synthetic/data-agent'),sessionId=manager.getSessionId();
  const invoke=async(name,args)=>{
    const sdk=randomUUID();manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name,arguments:args}],
      api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
    const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};
    ok(await h.internal('/internal/data/tool-calls',input));const receipt=ok(await h.internal('/internal/data/tools',input));
    manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:name,content:[{type:'text',text:JSON.stringify(receipt.data)}],details:receipt,isError:false,timestamp:Date.now()});return receipt.data;
  };
  const finishSetup=async text=>{
    ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text}));
    ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:text,
      checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)}));
    h.releaseRun(run.run_id);
  };
  const conditionsB=historyPermissions?{...conditions,source_limits:{allowed_sources:[{kind:'document',id:docB.id}],origin_message_ids:[run.message_id]}}:conditions;
  taskB=await invoke('update_analysis_task',{action:'create',goal:secondTitle,conditions:conditionsB,options:[]});
  if(historyPermissions){
    // 两个限源范围不能共用一条无份数绑定的前置答复，分别建立任务再验原通知的组合交付。
    await finishSetup('合成乙任务和使用范围已保存。');
    await h.resumeWorker();run=await h.capture(cid,'继续准备合成甲的金额草稿。');await h.pauseWorker();
    manager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});
  }
  taskA=await invoke('update_analysis_task',{action:'create',goal:firstTitle,conditions,options:[]});
  query=await invoke('request_query',{task_id:taskA.task_id,condition_version:taskA.condition_version,
    sql:"SELECT '9007199254740993.01' AS amount",parameters:{},target_id:'synthetic-sqlite',summary:'合成精确金额',knowledge_refs:[],replaces_query_id:null});
  if(olderQuery){
    for(let index=0;index<12;index++)await invoke('request_query',{task_id:taskB.task_id,condition_version:taskB.condition_version,
      sql:'SELECT 7 AS count_value',parameters:{},target_id:'synthetic-sqlite',summary:'合成较新草稿',knowledge_refs:[],replaces_query_id:null});
    await invoke('update_analysis_task',{action:'route',task_id:taskA.task_id,expected_version:taskA.condition_version,options:[]});
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE conversation_id='${cid}' AND id<>'${query.id}'`)[0].n,12);
    // 构造既有Pi摘要后的旧查询通知；窗口边界不依赖十二份完整草稿正文。
    manager.appendCompaction('甲查询等待原结果解释；乙的合成草稿尚未执行。',null,0,{},true);
  }
  const otherQuery=mixedOwner?await invoke('request_query',{task_id:taskB.task_id,condition_version:taskB.condition_version,
    sql:'SELECT 7 AS amount',parameters:{},target_id:'synthetic-sqlite',summary:'合成乙金额',knowledge_refs:[],replaces_query_id:null}):null;
  if(mixedOwner)await invoke('update_analysis_task',{action:'route',task_id:taskA.task_id,expected_version:taskA.condition_version,options:[]});
  await finishSetup('合成查询草稿已准备。');
  if(otherQuery){
    ok(await h.request('/queries/'+otherQuery.id+'/confirm',{operation_id:randomUUID(),draft_version:otherQuery.draft_version,condition_version:otherQuery.condition_version}));
    await h.resumeWorker();
    await until(async()=>ok(await h.request('/queries/'+otherQuery.id)).execution_state==='succeeded','乙真实查询完成',40000);
    const otherRun=await until(()=>h.captured.find(value=>value.workspace_context?.result_notification?.query_id===otherQuery.id),'乙原结果通知',40000);
    await h.pauseWorker();
    h.sql(`UPDATE agent_runs SET state='failed' WHERE id='${otherRun.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE message_id='${otherRun.message_id}';UPDATE conversation_messages SET disposition='failed' WHERE id='${otherRun.message_id}';`);
    h.releaseRun(otherRun.run_id);
  }
  ok(await h.request('/queries/'+query.id+'/confirm',{operation_id:randomUUID(),draft_version:query.draft_version,condition_version:query.condition_version}));
  await h.resumeWorker();
  await until(async()=>ok(await h.request('/queries/'+query.id)).execution_state==='succeeded','合成金额查询完成',40000);
  run=await until(()=>h.captured.find(value=>value.conversation_id===cid&&value.workspace_context?.result_notification?.query_id===query.id),'合成金额结果输入',40000);
  await h.pauseWorker();h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id='${run.run_id}'`);run.tool_contract_version=2;
  assert.deepEqual(run.workspace_context.active_task_ref,{task_id:taskA.task_id,condition_version:taskA.condition_version});
  if(mixedOwner){
    const a=await invoke('get_query',{query_id:query.id}),b=await invoke('get_query',{query_id:otherQuery.id});
    const answerInput={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:'mixed-owner-answer',tool_name:'present_analysis_answer',
      arguments:{template:'甲金额{{a}}，乙金额{{b}}。',sources:[{query_id:query.id,result_ref:a.results.result_ref,columns:['amount']},{query_id:otherQuery.id,result_ref:b.results.result_ref,columns:['amount']}],
        values:[{name:'a',kind:'cell',query_id:query.id,column:'amount',row_index:0},{name:'b',kind:'cell',query_id:otherQuery.id,column:'amount',row_index:0}]},
      checkpoint:exportCheckpoint(manager)};
    // v2目录不再登记present；本例保留旧present回执形态，升级前的登记按实际运行预写后接回。
    await h.legacyAnswerRegistration(run,answerInput.sdk_tool_call_id,answerInput.arguments);
    ok(await h.internal('/internal/data/tool-calls',answerInput));
    const answer=ok(await h.internal('/internal/data/tools',answerInput));
    assert.equal(answer.data.answer_text,'甲金额9007199254740993.01，乙金额7。');
    const freezeInput={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:'mixed-owner-freeze',tool_name:'update_analysis_task',
      arguments:{action:'route',task_id:taskB.task_id,expected_version:taskB.condition_version,options:[],finalize_current_answer:true},
      answer_handoff:{assistant:{entry_id:'mixed-owner-entry',attempt_id:run.attempt_id,stop_reason:'toolUse',tool_call_ids:['mixed-owner-freeze'],text_sha256:createHash('sha256').update('').digest('hex')},answer_sdk_tool_call_id:'mixed-owner-answer'},
      checkpoint:exportCheckpoint(manager)};
    ok(await h.internal('/internal/data/tool-calls',freezeInput));
    const frozenResponse=await h.internal('/internal/data/tools',freezeInput);
    await writeFile(artifactDirectory+'/mixed-owner-receipts.json',JSON.stringify({answer,frozenResponse},null,2)+'\n');
    const frozen=ok(frozenResponse);
    assert.equal(frozen.data.error,undefined,'合法混源答案应按原登记甲owner冻结；真实Rust回执: '+JSON.stringify(frozen));
    assert.deepEqual(frozen.answer_parts[0].task_ref,{task_id:taskA.task_id,condition_version:taskA.condition_version});
    assert.deepEqual(frozen.answer_parts[0].source_query_ids.sort(),[query.id,otherQuery.id].sort());
    assert.deepEqual(answer.answer_task_ref,{task_id:taskA.task_id,condition_version:taskA.condition_version});
    const where=`conversation_id='${cid}' AND sdk_tool_call_id='mixed-owner-answer' AND state='succeeded'`;
    const original=h.sql(`SELECT JSON_OBJECT('bytes',HEX(CAST(receipt AS CHAR CHARACTER SET utf8mb4))) FROM tool_calls WHERE ${where}`)[0];
    try{
      const wrong=Buffer.from(JSON.stringify({task_id:taskB.task_id,condition_version:taskB.condition_version})).toString('hex');
      h.sql(`UPDATE tool_calls SET receipt=JSON_SET(receipt,'$.answer_task_ref',CAST(CONVERT(0x${wrong} USING utf8mb4) AS JSON)) WHERE ${where}`);
      const conflict=await h.internal('/internal/data/tools',answerInput);
      assert.equal(conflict.status,409);assert.equal(conflict.value.code,'invalid_evidence','候选字段与首次登记矛盾必须拒绝');
    }finally{
      h.sql(`UPDATE tool_calls SET receipt=CONVERT(0x${original.bytes} USING utf8mb4) WHERE ${where}`);
    }
    assert.deepEqual(h.sql(`SELECT JSON_OBJECT('bytes',HEX(CAST(receipt AS CHAR CHARACTER SET utf8mb4))) FROM tool_calls WHERE ${where}`)[0],original);
    assert.deepEqual(ok(await h.internal('/internal/data/tools',answerInput)),answer,'成功旧答案回执按当前读权重放');
    // 撤权后同一重放按实时结果权限拒绝且不带回执正文；恢复后仍回原回执。
    const permissions=h.directory+'/platform/permissions.json';
    try{
      await writeFile(permissions,JSON.stringify({denied_query_users:['alice']}));
      const revoked=await h.internal('/internal/data/tools',answerInput);
      assert.equal(revoked.status,409);assert.equal(revoked.value.code,'stale_context');
      assert.equal(revoked.value.data?.answer_text,undefined);
    }finally{
      await unlink(permissions);
    }
    assert.deepEqual(ok(await h.internal('/internal/data/tools',answerInput)),answer);
  }else{
  controller=new AbortController();
  if(mode==='normal'){
    try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}catch(error){throw providerFailure??error;}
  }else if(mode==='natural-recovery'){
    h.env.DATA_AGENT_FAULT='after_output_checkpoint';await h.restartApi();
    await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''),/unavailable/);
    if(providerFailure)throw providerFailure;
    delete h.env.DATA_AGENT_FAULT;await h.restartApi();
    const prior=run,captured=h.captured.length;
    naturalAttempt=prior.attempt_id;
    const saved=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${prior.recovery_chain_id}'`)[0];
    const published=restoreCheckpoint('/synthetic/data-agent',saved);
    const location=published.getBranch().findLast(entry=>entry.type==='custom'&&entry.customType==='data_agent_output_binding');
    assert.equal(location.data.task_ref.task_id,taskB.task_id);
    assert.equal(location.data.output_binding.attempt_id,prior.attempt_id);
    assert.equal(published.buildSessionContext().messages.findLast(message=>message.role==='assistant').content.filter(part=>part.type==='text').map(part=>part.text).join(''),secondBody);
    assert.equal(h.sql(`SELECT JSON_OBJECT('commit',commit_id) FROM agent_runs WHERE id='${prior.run_id}'`)[0].commit,null);
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${prior.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${prior.message_id}';`);
    await h.resumeWorker();run=await until(()=>h.captured.slice(captured).find(value=>value.message_id===prior.message_id),'组合自然末项原绑定恢复',40000);await h.pauseWorker();
    for(const key of ['conversation_id','message_id','recovery_chain_id','budget_scope_id','output_id'])assert.equal(run[key],prior[key]);
    assert.equal(run.resume_same_input,true);assert.notEqual(run.attempt_id,prior.attempt_id);
    const before=calls;recovering=true;
    try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}catch(error){throw providerFailure??error;}
    assert.equal(calls,before,'组合自然末项按原输出绑定零模型恢复');
    const read=h.sql(`SELECT read_binding FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0];
    assert.equal(read.units[1].chunk_range.attempt_id,prior.attempt_id);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM output_chunks WHERE attempt_id='${run.attempt_id}'`)[0].n,0,'恢复不重新广播旧正文delta');
  }else{
    await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'',controller.signal),/run_cancelled|model_run_failed/);
    if(providerFailure)throw providerFailure;assert.equal(interrupted,true);assert.equal(calls,3);
    const prior=run,captured=h.captured.length;h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${prior.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${prior.message_id}';`);
    await h.resumeWorker();run=await until(()=>h.captured.slice(captured).find(value=>value.message_id===prior.message_id),'恢复查询答案交接',40000);await h.pauseWorker();
    for(const key of ['conversation_id','message_id','recovery_chain_id','budget_scope_id','output_id'])assert.equal(run[key],prior[key]);
    assert.equal(run.resume_same_input,true);
    if(mode==='committed')assert.deepEqual(run.workspace_context.active_task_ref,{task_id:taskB.task_id,condition_version:taskB.condition_version},'A已冻结后恢复不得重新绑定到原查询A');
    if(olderQuery)assert.ok(!run.workspace_context.query_observations.some(value=>value.id===query.id),'原通知查询确实已落出最近十二条观察');
    recovering=true;
    try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}catch(error){throw providerFailure??error;}
    assert.ok(posts.filter(item=>item.recovering).every(item=>item.input.answer_handoff===undefined));
  }
  if(providerFailure)throw providerFailure;
  const snapshot=await h.snapshot(cid),expected='## '+firstTitle+'\n\n'+firstBody+'\n\n---\n\n## '+secondTitle+'\n\n'+secondBody;
  assert.equal(snapshot.messages.findLast(message=>message.role==='assistant'&&message.committed)?.text,expected);
  assert.equal(snapshot.events.filter(event=>event.type==='assistant_committed'&&event.payload.output_id===run.output_id).length,1);
  const chunks=h.sql(`SELECT JSON_OBJECT('text',body) FROM output_chunks WHERE attempt_id='${naturalAttempt??run.attempt_id}' ORDER BY chunk_seq`);
  // v2渲染定稿({{amount}}替换后)与自然尾项共用同一attempt输出流；中断恢复模式定稿沿原绑定恢复、不重播chunks，只剩自然尾项。
  const expectedChunks=(mode==='registered'||mode==='committed')?secondBody:firstBody+secondBody;
  assert.equal(chunks.map(chunk=>chunk.text).join(''),expectedChunks,'A的成功查询通知不抑制B自然正文');
  const ledger=h.sql(`SELECT JSON_OBJECT('n',COUNT(*),'origin',MIN(origin_run_id),'sequence',MIN(answer_part_sequence)) FROM tool_calls WHERE sdk_tool_call_id='finalize-query-a' AND conversation_id='${cid}'`)[0];
  assert.equal(ledger.n,1);assert.equal(ledger.sequence,1);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE tool_name='prepare_analysis_answer' AND recovery_chain_id='${run.recovery_chain_id}'`)[0].n,1);
  const budget=h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0];
  assert.deepEqual(budget,{calls:5,limit:24});assert.equal(calls,5);
  const saved=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
  const restored=restoreCheckpoint('/synthetic/data-agent',saved);
  if(historyPermissions){
    const context=JSON.stringify(restored.buildSessionContext().messages);
    assert.ok(!context.includes(firstAnswer),'恢复后仍不向独立乙回灌甲正文');
    assert.ok(context.includes(taskB.task_id),'恢复后保留乙任务上下文');
  }else assert.equal(restored.getSessionId(),sessionId);
  assert.ok(!JSON.stringify(restored.buildSessionContext().messages).includes(expected),'组合正文不回填Pi');
  if(historyPermissions&&mode==='normal'&&!olderQuery){
    for(const field of ['query_results','source_query_results'])assert.ok(!saved.authority_snapshot[field].some(pair=>pair[0]===query.id),'独立乙的末端来源必须不含冻结甲查询');
    const permissions=h.directory+'/platform/permissions.json',denied=JSON.stringify({denied_query_users:['alice']});
    let created=false;
    try{
      await writeFile(permissions,denied,{flag:'wx'});created=true;
      assert.equal((await h.request('/queries/'+query.id+'/results')).status,403);
      const restricted=await h.snapshot(cid);
      await writeFile(artifactDirectory+'/history-projection.json',JSON.stringify({snapshot:restricted,authority:saved.authority_snapshot},null,2)+'\n');
      const answer=restricted.messages.findLast(message=>message.role==='assistant'&&message.committed);
      assert.ok(answer?.text.includes(secondAnswer),'冻结甲撤权不能隐藏有独立来源的乙正文');
      assert.ok(!answer.text.includes(firstAnswer),'甲来源只在冻结handoff时仍须检查当前结果读取权');
      assert.equal(answer.text,'部分内容因来源不可读而隐藏。\n\n---\n\n## '+secondTitle+'\n\n'+secondBody,'撤甲权只隐藏甲的整份标题和正文，乙的中文、emoji及正文内分隔符逐字保留');
      assert.equal(answer.output_id,run.output_id);
      assert.ok(!restricted.events.some(event=>['assistant_delta','assistant_committed'].includes(event.type)&&event.payload.text?.includes(firstAnswer)));
      const readableDeltas=restricted.events.filter(event=>event.type==='assistant_delta'&&event.payload.attempt_id===run.attempt_id).map(event=>event.payload.text).join('');
      assert.ok(readableDeltas.includes(secondAnswer),'同attempt的乙持久片段仍可读');
      assert.equal(readableDeltas,'部分内容因来源不可读而隐藏。'+secondBody,'同attempt的甲片段按unit权限替换为隐藏提示，乙持久片段仍逐字保留完整中文、emoji与正文内分隔符');
      const events=await replayEvents(h.env.DATA_AGENT_API_URL+`/conversations/${cid}/events?after_seq=0`,{authorization:'Bearer '+h.tokens.alice});
      assert.ok(!events.some(event=>['assistant_delta','assistant_committed'].includes(event.type)&&event.payload.text?.includes(firstAnswer)),'SSE不能重放冻结甲的受限结果');
      assert.ok(events.some(event=>event.type==='assistant_committed'&&event.payload.text?.includes(secondAnswer)),'SSE保留乙的合法正文');
      assert.equal(events.findLast(event=>event.type==='assistant_committed'&&event.payload.output_id===run.output_id)?.payload.text,answer.text,'SSE与snapshot使用同一份逐份权限投影原文');
    }finally{
      if(created){assert.equal(await readFile(permissions,'utf8'),denied);await unlink(permissions);}
    }
    assert.equal((await h.snapshot(cid)).messages.findLast(message=>message.role==='assistant'&&message.committed)?.text,expected,'恢复后读回同一个组合原文');
    // 结果TTL与撤权不同，沿现有历史语义保留已提交原文。
    execFileSync('python3',['-I','-c',"import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('UPDATE submissions SET expires_at=0 WHERE id=?',(sys.argv[2],)); d.commit()",h.directory+'/platform/submissions.sqlite',query.id]);
    assert.equal((await h.request('/queries/'+query.id+'/results')).value.code,'result_expired');
    assert.equal((await h.snapshot(cid)).messages.findLast(message=>message.role==='assistant'&&message.committed)?.text,expected,'仅结果到期仍可读取历史组合正文');
    assert.equal(calls,5,'历史权限读取不追加模型回合');
    // 只改本夹具已成功冻结的标题，权限及来源不动；公开读取应使用提交原文。
    const frozenWhere=`conversation_id='${cid}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='finalize-query-a' AND state='succeeded' AND answer_part_sequence=1`;
    const frozen=h.sql(`SELECT answer_handoff FROM tool_calls WHERE ${frozenWhere}`);
    assert.equal(frozen.length,1,'标题接缝只命中本夹具的一份成功冻结handoff');
    const handoff=frozen[0],changedTitle='提交后替换的合成甲标题🧪';
    assert.equal(handoff.title,firstTitle);
    try{
      h.sql(`UPDATE tool_calls SET answer_handoff=JSON_SET(answer_handoff,'$.title','${changedTitle}') WHERE ${frozenWhere}`);
      assert.deepEqual(h.sql(`SELECT answer_handoff FROM tool_calls WHERE ${frozenWhere}`)[0],{...handoff,title:changedTitle},'接缝只改变冻结标题，不改变authority、来源或结果依赖');
      const reread=await h.snapshot(cid);
      assert.equal(reread.messages.findLast(message=>message.role==='assistant'&&message.committed)?.text,expected,'成功冻结handoff标题事后改变，snapshot仍逐字返回已提交组合原文');
      assert.equal(reread.events.findLast(event=>event.type==='assistant_committed'&&event.payload.output_id===run.output_id)?.payload.text,expected,'snapshot提交事件也不得从工具回执重组标题');
    }finally{
      h.sql(`UPDATE tool_calls SET answer_handoff=CONVERT(0x${Buffer.from(JSON.stringify(handoff),'utf8').toString('hex')} USING utf8mb4) WHERE ${frozenWhere}`);
    }
    assert.equal((await h.snapshot(cid)).messages.findLast(message=>message.role==='assistant'&&message.committed)?.text,expected,'标题接缝恢复原handoff后仍读回同一个组合原文');
    assert.equal(calls,5,'标题接缝的公开读取不追加模型回合');
    historyPermissionChecked=true;
  }
  }
  passed=true;
}catch(error){
  if(h&&run){
    const facts=h.sql(`SELECT JSON_OBJECT('authority',r.authority_snapshot,'output_parts',(SELECT answer_parts FROM assistant_outputs WHERE attempt_id=r.attempt_id),'task_bindings',(SELECT JSON_ARRAYAGG(task_id) FROM conversation_message_tasks WHERE message_id=r.message_id),'routed_task',m.routed_task_id,'active_task',c.active_task_id,'parts',(SELECT JSON_ARRAYAGG(JSON_OBJECT('sdk',sdk_tool_call_id,'sequence',answer_part_sequence,'reference',JSON_EXTRACT(answer_handoff,'$.reference'))) FROM tool_calls WHERE recovery_chain_id=r.recovery_chain_id AND answer_part_sequence IS NOT NULL)) FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id JOIN conversation_messages m ON m.id=r.message_id WHERE r.id='${run.run_id}'`);
    await writeFile(artifactDirectory+'/failure.json',JSON.stringify(facts,null,2)+'\n');
  }
  throw error;
}finally{
  RustTransport.prototype.post=originalPost;
  if(previous===undefined)delete process.env.DATA_AGENT_PROVIDER_TEST;else process.env.DATA_AGENT_PROVIDER_TEST=previous;
  if(h){if(run)h.releaseRun(run.run_id);await h.close();await writeFile(artifactDirectory+'/service-logs.json',JSON.stringify(h.logs,null,2)+'\n');}provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  await writeFile(artifactDirectory+'/route-receipts.json',JSON.stringify(posts.map(({path,recovering,receipt,persistedReference})=>({path,recovering,receipt,persistedReference})),null,2)+'\n');
  const report={passed,mode,olderQuery,mixedOwner,historyPermissions,calls,historyPermissionChecked,officialRequests:0,databaseUsed:Boolean(h),platform:'executable synthetic SQLite',provider:'loopback OpenAI protocol',artifactDirectory};await writeFile(artifactDirectory+'/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
