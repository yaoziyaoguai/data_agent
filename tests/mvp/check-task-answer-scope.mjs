import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

// 互斥来源沿真实Pi投影与原工具账本恢复；组合正文仅用于用户交付。
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',
  input_limit:65536,output_limit:4096,trial_call_limit:100,trial_cost_micros:'1000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const conditions={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const sourceA='SYNTHETIC_SCOPE_A_PRIVATE_BODY：甲按入口记录请求。';
const sourceB='SYNTHETIC_SCOPE_B_PRIVATE_BODY：乙按结果记录完成。';
const summaryA='SYNTHETIC_SCOPE_A_PRIVATE_SUMMARY：原甲任务调查摘要。';
const firstAnswer='SYNTHETIC_SCOPE_A_FINAL：甲任务按入口逐次记录请求。🌱';
const secondAnswer='SYNTHETIC_SCOPE_B_FINAL：乙任务按结果分别记录完成。';
const newTask=process.argv.find(arg=>arg.startsWith('--new-task='))?.split('=')[1];
if(newTask)assert.ok(['clarify','revise'].includes(newTask));
const nullTask=process.argv.includes('--null-task');
const pendingSdk=newTask?'create-scope-c':'read-scope-b';
const questionC='合成丙需要按入口还是完成记录解释？';
const answerC=newTask==='clarify'?questionC:'合成丙是原输入中的独立目标，沿自己的材料完成解释。';
// D1控制交付：丙等待开放澄清时，正式正文=甲冻结正文+宿主控制投影；未核验的模型末条不进入交付，
// 澄清问题由任务卡opened_clarification承担（投影形态由check-waiting-task-delivery的d1/d2权威锁定）。
const controlTextC='本轮控制状态：\n任务「合成丙解释」：仍在等待您补充已保存的问题。';
const registeredB=process.argv.includes('--cancel-b-registered')||Boolean(newTask);
const unknownB=process.argv.includes('--cancel-b-unknown');
const cancelB=process.argv.includes('--cancel-b')||registeredB||unknownB;
const expected='## 合成甲解释\n\n'+firstAnswer+(newTask==='clarify'?'\n\n---\n\n'+controlTextC:newTask?'\n\n---\n\n## 合成丙解释\n\n'+answerC:cancelB?'':'\n\n---\n\n## 合成乙解释\n\n'+secondAnswer);
const invalidate=process.argv.includes('--invalidate');
const publicIndex=process.argv.includes('--public-index');
const upgrade=process.argv.includes('--upgrade');
const collection=publicIndex?'data_agent_test_'+randomUUID().replaceAll('-',''):undefined;
const legacyGoal='合成升级前解释',legacyAnswer='SYNTHETIC_LEGACY_V1_FINAL：升级前的独立目标已完成。🌿';
const legacySdk='read-legacy-task';
let embedding,vectorToken,preparedCollection=false;
let h,run,taskA,taskB,docA,docB,controller,providerFailure,platformFault,platformRequests=0,interrupted=false,recovering=false,nextRound=false,nextCalls=0,calls=0,summaries=0,passed=false;
let legacyPhase=false,legacyCalls=0,legacyRun,legacyTask,legacyBefore,legacyCheckpoint,legacyEntries,upgradeEvidence;
const checks=[],errors=[],requests=[],posts=[];
const originalPost=RustTransport.prototype.post;
RustTransport.prototype.post=async function(path,name,input,...rest){
  posts.push({path,input});
  const receipt=await originalPost.call(this,path,name,input,...rest);
  if(!nextRound&&!recovering&&!interrupted&&path===((registeredB||unknownB)?'/internal/data/tool-calls':'/internal/data/tools')&&input.sdk_tool_call_id===pendingSdk){
    interrupted=true;controller.abort();throw new Error('synthetic_scope_b_interrupted');
  }
  return receipt;
};
const provider=createServer(async(request,response)=>{
  try{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw);requests.push(raw);
    assert.ok(Buffer.byteLength(raw)<=profile.payload_bytes_limit);
    if(!body.tools?.length){summaries++;assert.ok(!raw.includes(sourceA)&&!raw.includes(summaryA)&&!raw.includes(firstAnswer),'摘要派发不得带甲正文');throw new Error('unexpected_summary');}
    if(legacyPhase)legacyCalls++;else calls++;
    let action,text='';
    if(legacyPhase){
      assert.equal(run.tool_contract_version,1);assert.ok(legacyCalls<=3,'旧v1一轮只允许建任务、读取和自然final三次请求');
      const read=body.tools.find(tool=>tool.function?.name==='read_knowledge')?.function.parameters;
      const route=body.tools.find(tool=>tool.function?.name==='update_analysis_task')?.function.parameters;
      assert.ok(read?.properties.object_id);assert.equal(read.properties.items,undefined);
      assert.equal(route?.properties.finalize_current_answer,undefined,'旧消息不能使用v2定稿字段');
      if(legacyCalls===1)action={id:'create-legacy-task',name:'update_analysis_task',arguments:{action:'create',goal:legacyGoal,conditions,options:[]}};
      else if(legacyCalls===2){
        legacyTask=run.workspace_context.active_task_ref;assert.ok(legacyTask?.task_id);
        action={id:legacySdk,name:'read_analysis_task',arguments:{task_id:legacyTask.task_id}};
      }else{
        const receipt=JSON.parse(body.messages.findLast(message=>message.role==='tool'&&message.tool_call_id===legacySdk).content);
        assert.equal(receipt.id,legacyTask.task_id);assert.equal(receipt.goal,legacyGoal);assert.equal(receipt.condition_version,legacyTask.condition_version);
        text=legacyAnswer;
      }
    }else if(nextRound){
      assert.ok(!raw.includes(sourceA)&&!raw.includes(summaryA)&&!raw.includes(firstAnswer),'下一轮不能回灌甲正文或组合文本');
      assert.ok(!raw.includes(expected));
      nextCalls++;assert.ok(nextCalls<=2);
      if(nextCalls===1)action={id:'route-next-scope-b',name:'update_analysis_task',arguments:{action:'route',task_id:taskB.task_id,expected_version:taskB.condition_version,options:[]}};
      else text='乙任务保持原来的完成解释。';
    }else if(calls===1){
      if(upgrade){
        const read=body.tools.find(tool=>tool.function?.name==='read_knowledge')?.function.parameters;
        const route=body.tools.find(tool=>tool.function?.name==='update_analysis_task')?.function.parameters;
        assert.equal(run.tool_contract_version,2);assert.ok(read?.properties.items);assert.equal(read.properties.object_id,undefined);
        assert.ok(route?.properties.finalize_current_answer,'配置切换后的新消息公开v2定稿能力');
      }
      assert.ok(raw.includes(sourceA)&&raw.includes(summaryA),'甲确实从原正文与Pi摘要调查');
      text=firstAnswer;action={id:'finalize-scope-a',name:'update_analysis_task',arguments:{action:'route',task_id:taskB.task_id,
        expected_version:taskB.condition_version,options:[],finalize_current_answer:true}};
    }else if(calls===2){
      assert.ok(!raw.includes(sourceA)&&!raw.includes(summaryA)&&!raw.includes(firstAnswer),'切乙后的实际provider不见甲正文/摘要/答案');
      action=newTask
        ?{id:pendingSdk,name:'update_analysis_task',arguments:{action:newTask,...(nullTask?{task_id:null,expected_version:null}:{}),
          goal:'合成丙解释',conditions:{...conditions,source_limits:{allowed_sources:[{kind:'document',id:docB.id}],origin_message_ids:[run.message_id]}},
          ...(newTask==='clarify'?{question:questionC,options:['入口记录','完成记录']}:{options:[]})}}
        :unknownB?{id:pendingSdk,name:'validate_sql',arguments:{sql:'SELECT 1',parameters:{},target_id:'synthetic-sqlite'}}
        :{id:pendingSdk,name:'read_knowledge',arguments:{items:[{kind:'knowledge',ref:{object_id:docB.id,version:docB.version,path:'body'}}]}};
    }else{
      assert.equal(calls,3);assert.equal(recovering,true);
      assert.ok(!raw.includes(sourceA)&&!raw.includes(summaryA)&&!raw.includes(firstAnswer),'乙中断恢复后的实际provider不见甲正文');
      if(newTask){
        const current=run.workspace_context.tasks.find(task=>task.goal==='合成丙解释');
        assert.ok(current,'普通续答前先接回原登记并建立丙任务');
        assert.deepEqual(run.workspace_context.active_task_ref,{task_id:current.id,condition_version:current.condition_version});
        assert.ok(raw.includes(pendingSdk),'原SDK调用控制身份保留');
        if(newTask==='clarify'){assert.equal(current.phase,'waiting_clarification');assert.equal(current.clarification.question,questionC);assert.ok(raw.includes(questionC));}
        text=answerC;
      }else{
        if(cancelB)throw new Error('已定稿甲与已取消乙无需新增模型调用');
        assert.ok(raw.includes(sourceB),'乙已接回原读取回执');text=secondAnswer;
      }
    }
    response.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(delta,finish_reason=null)=>response.write('data: '+JSON.stringify({id:'synthetic-answer-scope',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    emit({role:'assistant',content:text});
    if(action)emit({tool_calls:[{index:0,id:action.id,type:'function',function:{name:action.name,arguments:JSON.stringify(action.arguments)}}]});
    emit({},action?'tool_calls':'stop');
    response.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}})+'\n\n');response.end('data: [DONE]\n\n');
  }catch(error){providerFailure??=error;if(!response.headersSent)response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'synthetic_scope_assertion'}}));}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const previous=process.env.DATA_AGENT_PROVIDER_TEST;process.env.DATA_AGENT_PROVIDER_TEST='1';
const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
// 比对已成功旧链的正式账本和确认leaf；后续session可追加，但不能回写旧成功事实。
const legacyState=()=>({
  runs:h.sql(`SELECT JSON_OBJECT('id',id,'conversation',conversation_id,'message',message_id,'chain',recovery_chain_id,'budget',budget_scope_id,'version',tool_contract_version,'state',state,'output',output_id,'attempt',attempt_id,'commit',commit_id,'fingerprint',commit_fingerprint) FROM agent_runs WHERE recovery_chain_id='${legacyRun.recovery_chain_id}' ORDER BY id`),
  tools:h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'sdk',sdk_tool_call_id,'chain',recovery_chain_id,'version',tool_contract_version,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE recovery_chain_id='${legacyRun.recovery_chain_id}' ORDER BY operation_id`),
  budget:h.sql(`SELECT JSON_OBJECT('id',id,'message',message_id,'calls',issued_calls,'limit',call_limit,'profile',model_profile) FROM budget_scopes WHERE id='${legacyRun.budget_scope_id}'`)[0],
  attempts:h.sql(`SELECT JSON_OBJECT('id',id,'run',run_id,'scope',budget_scope_id,'purpose',purpose,'state',state,'fingerprint',parameters_fingerprint,'reserved',CAST(reserved_micros AS CHAR),'actual',CAST(actual_micros AS CHAR),'usage',usage_json) FROM model_call_attempts WHERE budget_scope_id='${legacyRun.budget_scope_id}' ORDER BY id`),
  outputs:h.sql(`SELECT JSON_OBJECT('output',output_id,'attempt',attempt_id,'run',run_id,'state',state,'text',final_text) FROM assistant_outputs WHERE run_id='${legacyRun.run_id}' ORDER BY attempt_id`),
  chunks:h.sql(`SELECT JSON_OBJECT('seq',chunk_seq,'text',body) FROM output_chunks WHERE attempt_id='${legacyRun.attempt_id}' ORDER BY chunk_seq`),
  checkpoint:h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${legacyRun.recovery_chain_id}'`)[0],
});
let browser;
try{
  if(publicIndex){
    embedding=await embeddingProvider();
    vectorToken=(await readFile('.local/infra/milvus-root-password','utf8')).trim();
  }
  h=await harness({capture:true,web:!invalidate&&!unknownB,profile,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port,env:{DATA_AGENT_LEASE_MS:'120000',
    ...(publicIndex?{...embedding.env,DATA_AGENT_TOOL_CONTRACT_VERSION:'2',DATA_AGENT_PREFILL_PROFILE:'',
      DATA_AGENT_VECTOR_URL:'http://127.0.0.1:19531',DATA_AGENT_VECTOR_COLLECTION:collection,
      DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}:{}),
    ...(upgrade?{DATA_AGENT_TOOL_CONTRACT_VERSION:'1',DATA_AGENT_PREFILL_PROFILE:''}:{})}});
  if(publicIndex){ok(await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()}));preparedCollection=true;}
  docA=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成甲专用材料',body:sourceA,related_ids:[]}));
  docB=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成乙专用材料',body:sourceB,related_ids:[]}));
  if(publicIndex)await until(()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE object_id IN ('${docA.id}','${docB.id}') AND vector_state='indexed'`)[0].n===2,'两份文档的知识窗口进入本次公共集合',120000);
  const cid=await h.create();
  if(upgrade){
    legacyPhase=true;run=await h.capture(cid,'升级前先建立并解释一个独立合成目标，不使用外部材料。');await h.pauseWorker();
    assert.equal(run.tool_contract_version,1,'升级前消息由真实配置取得v1，不修改run/tool版本');
    try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}catch(error){throw providerFailure??error;}
    if(providerFailure)throw providerFailure;assert.equal(legacyCalls,3);legacyRun=run;
    legacyBefore=legacyState();legacyCheckpoint=legacyBefore.checkpoint;
    assert.equal(legacyBefore.runs.length,1);assert.equal(legacyBefore.runs[0].version,1);assert.equal(legacyBefore.runs[0].state,'finished');
    assert.equal(legacyBefore.tools.length,2);assert.ok(legacyBefore.tools.every(tool=>tool.version===1&&tool.state==='succeeded'&&tool.origin===run.run_id));
    const read=legacyBefore.tools.find(tool=>tool.sdk===legacySdk);
    assert.ok(read);assert.equal(read.receipt.tool_contract_version,1);assert.equal(read.receipt.operation_id,read.operation);
    assert.equal(read.receipt.data.id,legacyTask.task_id);assert.equal(read.receipt.data.goal,legacyGoal);
    assert.equal(read.receipt.data.condition_version,legacyTask.condition_version);
    assert.equal(legacyBefore.budget.calls,3);assert.equal(legacyBefore.budget.limit,24);
    assert.equal(legacyBefore.attempts.length,3);assert.ok(legacyBefore.attempts.every(attempt=>attempt.purpose==='agent'&&attempt.state==='settled'&&attempt.run===run.run_id));
    assert.equal(legacyBefore.outputs.length,1);assert.equal(legacyBefore.outputs[0].text,legacyAnswer);
    assert.equal(legacyBefore.chunks.map(chunk=>chunk.text).join(''),legacyAnswer);
    assert.equal(legacyCheckpoint.storage.kind,'pi_session');
    const history=restoreCheckpoint('/synthetic/data-agent',legacyCheckpoint);legacyEntries=structuredClone(history.getEntries());
    assert.ok(legacyEntries.some(entry=>entry.type==='message'&&entry.message.role==='user'&&
      (entry.message.content===run.text||Array.isArray(entry.message.content)&&entry.message.content.some(part=>part.type==='text'&&part.text===run.text))));
    assert.ok(legacyEntries.some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolCallId===legacySdk&&entry.message.details.tool_contract_version===1));
    assert.ok(legacyEntries.some(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.content.some(part=>part.type==='text'&&part.text===legacyAnswer)));
    const snapshot=await h.snapshot(cid);
    assert.equal(snapshot.messages.filter(message=>message.role==='assistant'&&message.committed&&message.text===legacyAnswer).length,1);
    assert.equal(snapshot.events.filter(event=>event.type==='assistant_committed'&&event.payload.output_id===run.output_id).length,1);
    assert.equal(snapshot.tasks.find(task=>task.id===legacyTask.task_id).phase,'answered');
    h.releaseRun(run.run_id);legacyPhase=false;
    h.env.DATA_AGENT_TOOL_CONTRACT_VERSION='2';await h.restartApi();await h.resumeWorker();
    checks.push('真实Pi完成原v1消息及旧任务读取回执，随后显式配置重启启用新消息v2');
  }
  run=await h.capture(cid,'甲只用合成甲专用材料；乙只用合成乙专用材料，分别完成解释。'+(newTask?'另有独立丙目标，只用合成乙专用材料；先保存丙需要的澄清，不能因取消乙而丢掉丙。':''));await h.pauseWorker();
  if(publicIndex||upgrade)assert.equal(run.tool_contract_version,2,'显式切换的专用环境真实启用新消息合同2');
  else{h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id='${run.run_id}'`);run.tool_contract_version=2;}
  // 升级仅打开宿主交回的原生session/确认leaf；既有模式仍使用原初始化方式。
  const manager=upgrade?restoreCheckpoint('/synthetic/data-agent',run.checkpoint):SessionManager.inMemory('/synthetic/data-agent'),sessionId=manager.getSessionId();
  if(upgrade){
    assert.deepEqual(run.checkpoint,legacyCheckpoint,'切换配置不替换原会话确认引用');
    assert.equal(sessionId,legacyCheckpoint.storage.session_id);assert.equal(manager.getLeafId(),legacyCheckpoint.leaf_id);
    assert.deepEqual(manager.getEntries(),legacyEntries);
    assert.equal(run.conversation_id,legacyRun.conversation_id);assert.equal(run.resume_same_input,false);
    for(const key of ['message_id','run_id','recovery_chain_id','budget_scope_id','output_id','attempt_id'])assert.notEqual(run[key],legacyRun[key],'新消息使用自己的请求身份，旧链不能被改版或补额');
    assert.deepEqual(legacyState(),legacyBefore);
  }
  let searchA;
  const invoke=async(name,args)=>{
    const sdk=randomUUID();manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name,arguments:args}],api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
    const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};
    ok(await h.internal('/internal/data/tool-calls',input));const receipt=ok(await h.internal('/internal/data/tools',input));
    manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:name,content:[{type:'text',text:JSON.stringify(receipt.data)}],details:receipt,isError:false,timestamp:Date.now()});
    if(receipt.context_reset){
      manager.appendCompaction('初始化任务范围。',null,0,{},true);
      run.workspace_context=ok(await h.internal('/internal/context/refresh',{run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,checkpoint:exportCheckpoint(manager)}));
    }
    return receipt.data;
  };
  const scoped=doc=>({...conditions,source_limits:{allowed_sources:[{kind:'document',id:doc.id}],origin_message_ids:[run.message_id]}});
  taskB=await invoke('update_analysis_task',{action:'create',goal:'合成乙解释',conditions:scoped(docB),options:[]});
  taskA=await invoke('update_analysis_task',{action:'create',goal:'合成甲解释',conditions:scoped(docA),options:[]});
  if(publicIndex){
    searchA=await invoke('search_knowledge',{query:'SYNTHETIC_SCOPE_A_PRIVATE_BODY',kinds:['document']});
    assert.ok(searchA.hits.some(hit=>hit.record_kind==='knowledge_entry'?hit.ref.object_id===docA.id:hit.citation.source.id===docA.id),'正式v2公共检索必须交付甲当前内容');
    assert.ok(!JSON.stringify(searchA).includes(sourceB),'甲来源检索不能交付乙正文');
  }
  await invoke('read_knowledge',{items:[{kind:'knowledge',ref:{object_id:docA.id,version:docA.version,path:'body'}}]});
  manager.appendCompaction(summaryA+'\n'+sourceA,null,100,{},true);
  run.checkpoint=exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
  controller=new AbortController();
  await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'',controller.signal),/run_cancelled|model_run_failed/);
  if(providerFailure)throw providerFailure;assert.equal(interrupted,true);assert.equal(calls,2);
  const frozen=h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'sequence',answer_part_sequence,'handoff',answer_handoff) FROM tool_calls WHERE conversation_id='${cid}' AND sdk_tool_call_id='finalize-scope-a'`)[0];
  assert.equal(frozen.sequence,1);assert.ok(frozen.handoff.authority.knowledge.some(pair=>pair[0]===docA.id));
  assert.ok(!frozen.handoff.authority.knowledge.some(pair=>pair[0]===docB.id),'甲part只绑定甲实际来源');
  if(upgrade){
    assert.equal(frozen.origin,run.run_id);assert.equal(frozen.handoff.handoff.assistant.attempt_id,run.attempt_id);
    assert.equal(frozen.handoff.handoff.assistant.text_sha256,createHash('sha256').update(firstAnswer).digest('hex'));
    assert.equal(h.sql(`SELECT JSON_OBJECT('text',body) FROM output_chunks WHERE attempt_id='${run.attempt_id}' ORDER BY chunk_seq`).map(chunk=>chunk.text).join(''),firstAnswer,'原attempt逐片完整保存甲正文');
  }
  if(unknownB){
    await h.pausePlatform();
    platformFault=createServer(async(request,response)=>{
      for await(const _ of request){}
      platformRequests++;assert.equal(request.url,'/validate');response.destroy();
    });
    await new Promise(resolve=>platformFault.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',resolve));
    const pending=posts.findLast(post=>post.path==='/internal/data/tool-calls'&&post.input.sdk_tool_call_id===pendingSdk).input;
    const response=await h.internal('/internal/data/tools',pending);
    assert.equal(response.value.code,'outcome_unknown','实际平台请求断连不能伪造明确拒绝');
    assert.equal(platformRequests,1);
  }
  const interruptedTool=h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${cid}' AND sdk_tool_call_id='${pendingSdk}'`)[0];
  assert.equal(interruptedTool.state,(registeredB||unknownB)?'registered':'succeeded');
  if(upgrade){
    assert.equal(interruptedTool.origin,run.run_id);
    if(!registeredB&&!unknownB){
      assert.equal(interruptedTool.receipt.tool_contract_version,2);
      assert.equal(interruptedTool.receipt.operation_id,interruptedTool.operation);
      assert.equal(interruptedTool.receipt.data.items[0].state,'ok');
      assert.equal(interruptedTool.receipt.data.items[0].content,sourceB,'中断前真实v2批量回执已成功保存');
    }
  }
  if(registeredB||unknownB){
    assert.equal(interruptedTool.receipt,null);assert.equal(posts.filter(post=>post.path==='/internal/data/tools'&&post.input.sdk_tool_call_id===pendingSdk).length,0);
    const registration=h.sql(`SELECT JSON_OBJECT('task',task_id,'version',CAST(task_condition_version AS CHAR),'started',execution_started) FROM tool_calls WHERE conversation_id='${cid}' AND sdk_tool_call_id='${pendingSdk}'`)[0];
    if(!newTask)assert.deepEqual(registration,{task:taskB.task_id,version:taskB.condition_version,started:unknownB?1:0});
  }
  const prior=run,captured=h.captured.length;h.releaseRun(prior.run_id);
  if(cancelB)ok(await h.request(`/conversations/${cid}/tasks/${taskB.task_id}/cancel`,{operation_id:randomUUID(),expected_version:taskB.condition_version}));
  else h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${prior.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${prior.message_id}';`);
  await h.resumeWorker();run=await until(()=>h.captured.slice(captured).find(value=>value.message_id===prior.message_id),'互斥任务B原输入恢复',40000);await h.pauseWorker();recovering=true;
  for(const key of ['conversation_id','message_id','recovery_chain_id','budget_scope_id','output_id'])assert.equal(run[key],prior[key]);
  if(upgrade){
    assert.equal(run.resume_same_input,true);assert.equal(run.tool_contract_version,2);
    assert.notEqual(run.run_id,prior.run_id);assert.notEqual(run.attempt_id,prior.attempt_id);
    assert.deepEqual(run.model_profile,prior.model_profile,'恢复沿原冻结profile和预算配置');
    assert.equal(run.checkpoint.storage.session_id,sessionId);assert.equal(run.checkpoint.storage.file,legacyCheckpoint.storage.file);
    assert.deepEqual(legacyState(),legacyBefore,'Worker新run不改旧v1链/回执/预算/输出');
  }
  const remainingTask=cancelB?taskA:taskB;
  assert.deepEqual(run.workspace_context.active_task_ref,{task_id:remainingTask.task_id,condition_version:remainingTask.condition_version});
  assert.equal(run.answer_parts.length,1);
  if(newTask){
    const preserved=h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${cid}' AND sdk_tool_call_id='${pendingSdk}'`)[0];
    assert.deepEqual(preserved,interruptedTool,'取消乙不能将独立丙新建操作伪记task_inactive');
    assert.deepEqual(h.sql(`SELECT JSON_OBJECT('task',task_id,'version',task_condition_version,'started',execution_started) FROM tool_calls WHERE operation_id='${interruptedTool.operation}'`)[0],{task:null,version:null,started:0});
    assert.equal(h.sql(`SELECT JSON_OBJECT('state',disposition) FROM conversation_messages WHERE id='${prior.message_id}'`)[0].state,'pending');
  }
  if(invalidate)ok(await h.request(`/knowledge/${docA.id}/disable`,{operation_id:randomUUID(),expected_version:docA.version}));
  if(unknownB){
    await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''),/version_conflict|outcome_unknown/);
    assert.deepEqual(h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${cid}' AND sdk_tool_call_id='read-scope-b'`)[0],interruptedTool,'取消不得改写实际在途后未知的原操作');
    assert.equal((await h.snapshot(cid)).events.filter(event=>event.type==='assistant_committed'&&event.payload.output_id===run.output_id).length,0);
    assert.equal(platformRequests,1,'冻结引用提交不重发未知操作');assert.equal(calls,2);
    checks.push('乙真实平台请求断连后仍未结算，取消不伪拒绝、不重放且最终提交继续拒绝');
  }else if(invalidate){
    await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''),/stale_context|not_available|forbidden/);
    if(providerFailure)throw providerFailure;
    const snapshot=await h.snapshot(cid);
    assert.equal(snapshot.events.filter(event=>event.type==='assistant_committed'&&event.payload.output_id===run.output_id).length,0,'失效甲不能静默省略后提交乙');
    checks.push('冻结甲来源停用后，整条交付明确拒绝且无部分成功');
  }else{
    try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}catch(error){throw providerFailure??error;}
    const snapshot=await h.snapshot(cid);
    assert.equal(snapshot.messages.findLast(message=>message.role==='assistant'&&message.committed)?.text,expected);
    assert.equal(snapshot.events.filter(event=>event.type==='assistant_committed'&&event.payload.output_id===run.output_id).length,1);
    assert.equal(calls,newTask==='clarify'?2:newTask?3:cancelB?2:3);
    if(cancelB){
      assert.equal(snapshot.tasks.find(task=>task.id===taskB.task_id).lifecycle,'cancelled');
      assert.equal(snapshot.tasks.find(task=>task.id===taskA.task_id).phase,'answered');
      assert.equal(snapshot.runs.find(value=>value.run_id===prior.run_id).state,'cancelled');
      // 澄清控制交付不写answer_parts（SQL NULL须包JSON_OBJECT再经h.sql按行JSON.parse）；甲冻结引用保持在原工具账本。
      const outputParts=h.sql(`SELECT JSON_OBJECT('parts',answer_parts) AS j FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0].parts;
      if(newTask){
        const taskC=snapshot.tasks.find(task=>task.goal==='合成丙解释');
        assert.ok(taskC);assert.equal(taskC.lifecycle,'active');assert.equal(taskC.phase,newTask==='clarify'?'waiting_clarification':'answered');
        if(newTask==='clarify'){
          assert.equal(snapshot.events.findLast(event=>event.type==='task_changed'&&event.payload.task_id===taskC.id).payload.opened_clarification.question,questionC);
          assert.equal(outputParts,null,'澄清控制交付只交冻结引用加宿主投影，不提交新part');
        }else assert.deepEqual(outputParts.map(part=>part.task_ref.task_id),[taskA.task_id,taskC.id]);
        assert.equal(posts.filter(post=>post.path==='/internal/data/tools'&&post.input.sdk_tool_call_id===pendingSdk).length,1,'丙新建沿原SDK只执行一次');
      }else assert.deepEqual(outputParts,run.answer_parts);
      const settled=h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${cid}' AND sdk_tool_call_id='${pendingSdk}'`)[0];
      for(const key of ['operation','origin','fingerprint'])assert.equal(settled[key],interruptedTool[key],'取消恢复必须接回原操作身份');
      if(newTask){
        assert.equal(settled.state,'succeeded');assert.equal(settled.receipt.data.task_id,snapshot.tasks.find(task=>task.goal==='合成丙解释').id);
        assert.equal(settled.receipt.data.error,undefined);
      }else if(registeredB){
        assert.equal(settled.state,'rejected','已取消乙的原登记必须保存明确拒绝，不能执行乙业务后冒充完成');
        assert.equal(settled.receipt.data.error,'task_inactive');
        assert.ok(!JSON.stringify(settled.receipt).includes(sourceB),'拒绝回执不能带取消乙正文');
      }else assert.deepEqual(settled,interruptedTool,'已经成功的原乙回执不因取消改写');
      assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE recovery_chain_id='${prior.recovery_chain_id}' AND state NOT IN ('succeeded','rejected')`)[0].n,0);
      checks.push(newTask==='clarify'?'取消乙保留独立丙的原新建操作，恢复一次并交付甲原文及丙等待澄清控制投影':newTask?'取消乙保留独立丙的原新建操作，恢复一次并交付甲原文及丙解释':registeredB?'乙登记未执行即正式取消，沿原身份保存拒绝后只交原甲，无新模型请求':'甲已定稿后正式取消乙，恢复仅交付原甲且不发新模型请求');
    }else checks.push('甲定稿后乙工具中断恢复，两份原文一次组合，原三次请求');
    browser=await chromium.launch();const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
    await page.getByPlaceholder('继续提问，或补充、纠正刚才的内容…').waitFor();
    await page.evaluate(id=>localStorage.setItem('data-agent.conversation.["demo","alice"]',id),cid);
    for(let reload=0;reload<2;reload++){
      await page.reload();const answer=page.locator('.message.assistant').filter({hasText:firstAnswer});await answer.waitFor();
      assert.equal(await answer.count(),1);
      if(cancelB)assert.ok(!(await answer.innerText()).includes(secondAnswer));
      else assert.ok((await answer.innerText()).includes(secondAnswer));
      // 浏览器渲染把投影内的软换行归一，浏览器断言用不含换行的子串（同check-waiting-task-delivery的d2做法）。
      if(newTask==='clarify'){assert.ok((await answer.innerText()).includes('任务「合成丙解释」：仍在等待您补充已保存的问题。'),'工作台可见丙等待澄清的控制投影');assert.ok(!(await answer.innerText()).includes(answerC),'未核验的模型末条不进入正式交付');}
      else if(newTask)assert.ok((await answer.innerText()).includes(answerC));
      if(upgrade){
        const history=page.locator('.message.assistant').filter({hasText:legacyAnswer});await history.waitFor();
        assert.equal(await history.count(),1,'升级前旧v1答案两次刷新均只显示一次');
        assert.deepEqual(legacyState(),legacyBefore);
      }
    }
    checks.push('正式工作台两次刷新，每份答案各一次且完整');
    if(!cancelB){
      const completed=run;
      h.releaseRun(run.run_id);nextRound=true;await h.resumeWorker();run=await h.capture(cid,'继续核对乙任务的解释。');await h.pauseWorker();
      assert.equal(run.checkpoint.storage.session_id,sessionId);
      if(upgrade){
        assert.equal(run.tool_contract_version,2);assert.equal(run.conversation_id,prior.conversation_id);assert.equal(run.resume_same_input,false);
        for(const key of ['message_id','recovery_chain_id','budget_scope_id','output_id'])assert.notEqual(run[key],completed[key]);
        assert.deepEqual(legacyState(),legacyBefore);
      }
      try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}catch(error){throw providerFailure??error;}
      if(upgrade){
        assert.equal(nextCalls,2);
        assert.deepEqual(h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0],{calls:2,limit:24});
        const attempts=h.sql(`SELECT JSON_OBJECT('purpose',purpose,'state',state) FROM model_call_attempts WHERE budget_scope_id='${run.budget_scope_id}'`);
        assert.equal(attempts.length,2);assert.ok(attempts.every(attempt=>attempt.purpose==='agent'&&attempt.state==='settled'));
        const nextSnapshot=await h.snapshot(cid);
        assert.equal(nextSnapshot.messages.findLast(message=>message.role==='assistant'&&message.committed).text,'乙任务保持原来的完成解释。');
        assert.equal(nextSnapshot.messages.filter(message=>message.role==='assistant'&&message.committed&&message.text===expected).length,1);
        assert.equal(nextSnapshot.events.filter(event=>event.type==='assistant_committed'&&event.payload.output_id===prior.output_id).length,1);
      }
      checks.push('下一轮沿原Pi会话，未注入甲正文/摘要或无范围组合');
    }
  }
  const after=h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'sequence',answer_part_sequence,'handoff',answer_handoff) FROM tool_calls WHERE conversation_id='${cid}' AND sdk_tool_call_id='finalize-scope-a'`)[0];
  assert.deepEqual(after,frozen,'恢复或失效均不重写原冻结引用/operation');
  assert.equal(posts.filter(post=>post.path==='/internal/data/tools'&&post.input.sdk_tool_call_id==='finalize-scope-a').length,1);
  const saved=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${prior.recovery_chain_id}'`)[0];
  assert.equal(restoreCheckpoint('/synthetic/data-agent',saved).getSessionId(),sessionId);
  const budget=h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit) FROM budget_scopes WHERE id='${prior.budget_scope_id}'`)[0];
  const attempts=h.sql(`SELECT JSON_OBJECT('purpose',purpose,'state',state) FROM model_call_attempts WHERE budget_scope_id='${prior.budget_scope_id}'`);
  const generatedCalls=newTask==='clarify'?2:newTask?3:cancelB?2:3,totalCalls=generatedCalls+(publicIndex?1:0);
  assert.equal(attempts.filter(attempt=>attempt.purpose==='agent').length,generatedCalls,'已持久澄清与冻结交付不再补模型确认，普通解释仍保三次生成');
  assert.equal(attempts.filter(attempt=>attempt.purpose==='knowledge_embedding').length,publicIndex?1:0,'正式检索Embedding计入原消息预算');
  assert.ok(attempts.every(attempt=>attempt.state==='settled'),'生成与检索Embedding均沿原attempt收尾');
  assert.equal(attempts.length,totalCalls);assert.deepEqual(budget,{calls:totalCalls,limit:24});assert.equal(summaries,0);assert.deepEqual(errors,[]);
  if(publicIndex){assert.ok(embedding.requests.length>0);assert.ok(searchA.hits.length>0);checks.push('本次公共集合完成raw/知识索引，新消息v2经正式检索、定稿、恢复和工作台完整交付');}
  if(upgrade){
    assert.deepEqual(legacyState(),legacyBefore,'升级全程保旧run/tool版本、成功回执、输出与已结算预算');
    const restored=restoreCheckpoint('/synthetic/data-agent',saved);
    assert.ok(restored.getBranch().some(entry=>entry.id===legacyCheckpoint.leaf_id),'原v1确认leaf仍在同一已确认分支');
    for(const entry of legacyEntries)assert.deepEqual(restored.getEntry(entry.id),entry,'原生session追加后，旧Pi条目与确认分支不被重建或修改');
    if(!registeredB&&!unknownB){
      assert.deepEqual(h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE operation_id='${interruptedTool.operation}'`)[0],interruptedTool,'恢复只接回原B成功回执，不改内容或副作用身份');
      assert.equal(posts.filter(post=>post.path==='/internal/data/tools'&&post.input.sdk_tool_call_id===pendingSdk&&post.input.run_id===prior.run_id).length,1);
      assert.equal(posts.filter(post=>post.path==='/internal/data/tools'&&post.input.sdk_tool_call_id===pendingSdk&&post.input.run_id!==prior.run_id).length,1,'恢复只接回一次原成功工具');
    }
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${cid}' AND recovery_chain_id='${prior.recovery_chain_id}' AND sdk_tool_call_id='${pendingSdk}'`)[0].n,1);
    const runs=h.sql(`SELECT JSON_OBJECT('id',id,'message',message_id,'chain',recovery_chain_id,'budget',budget_scope_id,'output',output_id,'version',tool_contract_version) FROM agent_runs WHERE recovery_chain_id='${prior.recovery_chain_id}' ORDER BY id`);
    assert.equal(runs.length,2);assert.ok(runs.every(value=>value.message===prior.message_id&&value.chain===prior.recovery_chain_id&&value.budget===prior.budget_scope_id&&value.output===prior.output_id&&value.version===2));
    const tools=h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'version',tool_contract_version,'origin',origin_run_id) FROM tool_calls WHERE recovery_chain_id='${prior.recovery_chain_id}'`);
    assert.ok(tools.length>=5);assert.ok(tools.every(tool=>tool.version===2));
    assert.equal(tools.filter(tool=>tool.sdk==='finalize-scope-a'&&tool.origin===prior.run_id).length,1);
    assert.equal(tools.filter(tool=>tool.sdk===pendingSdk&&tool.origin===prior.run_id).length,1);
    assert.equal(h.sql(`SELECT JSON_OBJECT('text',body) FROM output_chunks WHERE attempt_id='${prior.attempt_id}' ORDER BY chunk_seq`).map(chunk=>chunk.text).join(''),firstAnswer,'恢复与后续新消息不重写甲原attempt全文');
    assert.equal(legacyCalls,3);assert.equal(calls,generatedCalls+nextCalls);
    checks.push('同原session先v1后新消息v2，旧链/旧工具/成功回执/费用不变；A原正文、B原operation/origin与恢复chain/output/budget均保持');
    upgradeEvidence={session_id:sessionId,file:legacyCheckpoint.storage.file,legacy:{run_id:legacyRun.run_id,
      message_id:legacyRun.message_id,recovery_chain_id:legacyRun.recovery_chain_id,budget_scope_id:legacyRun.budget_scope_id,
      output_id:legacyRun.output_id,attempt_id:legacyRun.attempt_id,tool_contract_version:1,leaf_id:legacyCheckpoint.leaf_id,
      operation_id:legacyBefore.tools.find(tool=>tool.sdk===legacySdk).operation,calls:legacyCalls},
      current:{run_id:prior.run_id,message_id:prior.message_id,recovery_chain_id:prior.recovery_chain_id,budget_scope_id:prior.budget_scope_id,
        output_id:prior.output_id,attempt_id:prior.attempt_id,tool_contract_version:2,operation_id:interruptedTool.operation,
        origin_run_id:interruptedTool.origin,answer_sha256:createHash('sha256').update(firstAnswer).digest('hex'),calls:totalCalls},next_calls:nextCalls};
  }
  passed=true;
}finally{
  RustTransport.prototype.post=originalPost;if(previous===undefined)delete process.env.DATA_AGENT_PROVIDER_TEST;else process.env.DATA_AGENT_PROVIDER_TEST=previous;
  await browser?.close();if(platformFault){platformFault.closeAllConnections();await new Promise(resolve=>platformFault.close(resolve));}if(h){if(run)h.releaseRun(run.run_id);await h.close();}
  if(preparedCollection){
    const response=await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer root:'+vectorToken},body:JSON.stringify({dbName:'default',collectionName:collection})});
    assert.equal((await response.json()).code,0,'只清理本次专用公共集合');
  }
  await embedding?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  const report={passed,invalidate,publicIndex,upgrade,cancelB,registeredB,unknownB,newTask,newTaskIdentity:newTask?(nullTask?'null':'omitted'):undefined,checks,calls,legacyCalls,totalProviderCalls:calls+legacyCalls,summaries,errors,platformRequests,officialRequests:0,...(upgrade?{evidence:{pi:'1.3.0',storage:'isolated_synthetic_MySQL',provider:'local_protocol',web:!invalidate&&!unknownB?'workbench_two_refreshes':'not_run'},upgradeEvidence}:{})};await writeFile('.local/checks/task-answer-scope'+(upgrade?'-upgrade':'')+(newTask?'-cancelled-b-new-'+newTask+(nullTask?'-null':'-omitted'):unknownB?'-cancelled-b-unknown':registeredB?'-cancelled-b-registered':cancelB?'-cancelled-b':'')+(invalidate?'-invalidated':publicIndex?'-public-index':'')+'.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
