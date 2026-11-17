import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {planForProfile} from '../../packages/contracts/capacity.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness,until} from './harness.mjs';

export async function checkConfiguredRecovery(provider) {
  const previousTest=process.env.DATA_AGENT_PROVIDER_TEST;
  process.env.DATA_AGENT_PROVIDER_TEST='1';
  const h=await harness({capture:true,protocolProviderUrl:provider.url,env:{DATA_AGENT_LEASE_MS:'120000'}});
  const abort=new AbortController();let pending,earlyError,diagnosticCid;
  const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
  try {
    const service={id:'responses',name:'Synthetic recovery',provider_id:'compatible',api:'openai-responses',base_url:provider.url+'/recovery/v1',api_key:'synthetic-original-key',enabled:true,expected_version:'0'};
    ok(await h.request('/model-services',service));
    const definition={id:'responses-model',service_id:service.id,model_id:'synthetic/recovery-responses',label:'Synthetic recovery model',thinking_levels:['off'],reasoning_supported:false,default_thinking:'off',context_window:160000,input_limit:128000,output_limit:16000,payload_bytes_limit:262144,request_timeout_ms:90000,capability_source:'admin_declared',input_rate:'0',output_rate:'0',enabled:true,expected_version:'0'};
    const configuration=ok(await h.request('/model-definitions',definition));
    ok(await h.request('/model-configuration/default',{model_id:definition.id,expected_version:configuration.version}));
    const cid=await h.create();diagnosticCid=cid;const original=await h.capture(cid,'恢复Responses工具检查点');await h.pauseWorker();
    const start=provider.requests.length;provider.holdAfterTool();
    pending=deliver(original,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'',abort.signal).then(()=>null,error=>(earlyError=error));
    await until(()=>{if(earlyError)throw earlyError;return provider.blocked();},'Responses工具回执后中断');
    const tools=()=>h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'sdk',sdk_tool_call_id) FROM tool_calls WHERE conversation_id='${cid}'`);
    const initialTools=tools();assert.equal(initialTools.length,1);assert.ok(initialTools[0].sdk.includes('|'));
    ok(await h.request('/model-services',{...service,api_key:'synthetic-new-key',expected_version:'1'}));
    ok(await h.request('/model-definitions',{...definition,model_id:'synthetic/new-model',expected_version:'1'}));
    abort.abort();assert.equal((await pending).code,'run_cancelled');provider.release();h.releaseRun(original.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${original.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${original.message_id}';`);
    await h.resumeWorker();
    const resumed=await until(()=>h.captured.find(run=>run.message_id===original.message_id&&run.run_id!==original.run_id),'Responses原请求恢复');await h.pauseWorker();
    assert.equal(resumed.resume_same_input,true);
    for(const key of ['message_id','budget_scope_id','recovery_chain_id'])assert.equal(resumed[key],original[key]);
    assert.deepEqual(resumed.model_profile,original.model_profile);
    // 固定模型脚本：恢复回执后给正式回答；不把恢复提示当作新任务再造一个工具调用。
    provider.answerNext();
    await deliver(resumed,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(resumed.run_id);
    assert.deepEqual(tools(),initialTools,'复合SDK ID恢复不新建副作用身份');
    assert.equal(provider.requests.length-start,3);
    assert.ok(provider.requests.at(-1).body.input.some(item=>item.type==='function_call_output'&&item.call_id===initialTools[0].sdk.split('|')[0]),'原工具回执随恢复请求交付');
    assert.ok(provider.requests.slice(start).every(request=>request.body.model===definition.model_id&&request.key==='Bearer synthetic-original-key'));
    assert.equal((await h.snapshot(cid)).runs.filter(run=>run.state==='finished').length,1);
    const attempts=h.sql(`SELECT JSON_OBJECT('state',state) FROM model_call_attempts WHERE budget_scope_id='${original.budget_scope_id}'`);
    assert.equal(attempts.filter(attempt=>attempt.state==='unknown').length,1);
    const legacyCheck=await checkLegacyProfileRecovery(h,provider);
    return 'Responses复合工具ID原生检查点恢复：原消息/预算/模型/密钥与operation身份保持，未知调用不补额重做；'+legacyCheck;
  } catch(error) {
    if(diagnosticCid)await writeFile(h.directory+'/model-profile-recovery-failure.json',JSON.stringify({
      error:error.message,
      jobs:h.sql(`SELECT JSON_OBJECT('id',id,'message',message_id,'kind',kind,'schema',schema_version,'state',state,'attempts',attempts,'seq',dispatch_seq,'leaseOwner',lease_owner,'leaseEpoch',lease_epoch,'leaseUntil',CAST(lease_until AS CHAR),'due',COALESCE(lease_until<=UTC_TIMESTAMP(3),1)) FROM background_jobs WHERE conversation_id='${diagnosticCid}' ORDER BY dispatch_seq`),
      runs:h.sql(`SELECT JSON_OBJECT('id',id,'message',message_id,'state',state,'epoch',lease_epoch) FROM agent_runs WHERE conversation_id='${diagnosticCid}'`),
      conversation:h.sql(`SELECT JSON_OBJECT('owner',lease_owner,'until',CAST(lease_until AS CHAR),'epoch',lease_epoch) FROM conversations WHERE id='${diagnosticCid}'`),
      logs:h.logs,
    },null,2));
    throw error;
  } finally {
    abort.abort();provider.release();await pending;await h.close();
    if(previousTest===undefined)delete process.env.DATA_AGENT_PROVIDER_TEST;else process.env.DATA_AGENT_PROVIDER_TEST=previousTest;
  }
}

async function checkLegacyProfileRecovery(h,provider) {
  const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
  const service={id:'legacy-responses',name:'Synthetic legacy recovery',provider_id:'compatible',api:'openai-responses',base_url:provider.url+'/legacy-recovery/v1',api_key:'synthetic-legacy-original-key',enabled:true,expected_version:'0'};
  const definition={id:'legacy-responses-model',service_id:service.id,model_id:'synthetic/legacy-recovery-responses',label:'Synthetic legacy recovery model',thinking_levels:['off'],reasoning_supported:false,default_thinking:'off',context_window:160000,input_limit:128000,output_limit:16000,payload_bytes_limit:262144,request_timeout_ms:90000,capability_source:'admin_declared',input_rate:'0',output_rate:'0',enabled:true,expected_version:'0'};
  const revision={...definition,model_id:'synthetic/legacy-revised-responses',context_window:320000,input_limit:256000,output_limit:32000,payload_bytes_limit:524288,request_timeout_ms:600000,expected_version:'1'};
  const abort=new AbortController();let pending,earlyError;
  const originalRegister=ModelRuntime.prototype.registerProvider,originalTimeout=AbortSignal.timeout;
  const previousTimeout=process.env.DATA_AGENT_MODEL_TIMEOUT_MS;
  const registrations=[],timeouts=[];let observing;
  // 只观测真实注册与timeout入参，原函数仍照常执行；不靠改profile、缩短时钟或替换SDK输出通过。
  ModelRuntime.prototype.registerProvider=function(name,configuration) {
    if(observing)for(const model of configuration.models??[])registrations.push({phase:observing,id:model.id,contextWindow:model.contextWindow,maxTokens:model.maxTokens,catalog:this.getModel(service.provider_id,model.id)!=null});
    return originalRegister.call(this,name,configuration);
  };
  AbortSignal.timeout=function(milliseconds) {
    if(observing)timeouts.push({phase:observing,milliseconds});
    return originalTimeout.call(this,milliseconds);
  };
  // 本地协议允许环境覆盖超时；本例必须走旧profile缺字段的90秒默认。
  delete process.env.DATA_AGENT_MODEL_TIMEOUT_MS;
  const deliverObserved=async(run,phase,signal)=>{
    observing=phase;
    try {return await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'',signal);}
    finally {observing=undefined;}
  };
  const assertObserved=(phase,profile,contextWindow,timeout,count)=>{
    assert.deepEqual(registrations.filter(value=>value.phase===phase),[{phase,id:profile.model_id,contextWindow,maxTokens:profile.output_limit,catalog:false}],'目录外型号只采用冻结值或legacy输入限额，不从目录猜C');
    assert.deepEqual(timeouts.filter(value=>value.phase===phase&&![10000,735000].includes(value.milliseconds)),Array.from({length:count},()=>({phase,milliseconds:timeout})),'逐次provider请求使用冻结超时；排除RustTransport普通请求10000ms和工具执行735000ms');
  };
  try {
    ok(await h.request('/model-services',service));ok(await h.request('/model-definitions',definition));
    const cid=await h.create();
    const accepted=ok(await h.request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text:'旧格式profile的Responses工具恢复',model_selection:{model_id:definition.id,thinking_level:'off'}}));
    const budget=()=>h.sql(`SELECT JSON_OBJECT('id',id,'profile',model_profile,'limit',call_limit,'calls',issued_calls) FROM budget_scopes WHERE message_id='${accepted.message_id}'`)[0];
    const saved=budget();assert.equal(saved.calls,0);assert.equal(saved.limit,null);
    assert.equal(saved.profile.context_window,definition.context_window);assert.equal(saved.profile.request_timeout_ms,definition.request_timeout_ms);
    const {context_window,request_timeout_ms,capability_source,...legacyProfile}=saved.profile;
    assert.equal(legacyProfile.configured_model.version,'1');assert.equal(legacyProfile.configured_model.service_version,'1');
    // 仅向本次合成库装载升级前的持久格式；Worker必须从库重领，不手改已捕获的RunEnvelope。
    h.sql(`UPDATE budget_scopes SET model_profile=JSON_REMOVE(model_profile,'$.context_window','$.request_timeout_ms','$.capability_source') WHERE id='${saved.id}';`);
    assert.deepEqual(budget(),{...saved,profile:legacyProfile});
    await h.resumeWorker();
    const original=await until(()=>h.captured.find(run=>run.message_id===accepted.message_id),'Worker装载旧持久profile');await h.pauseWorker();
    assert.deepEqual(original.model_profile,legacyProfile);assert.equal(original.budget_scope_id,saved.id);
    assert.equal(Object.hasOwn(original.model_profile,'context_window'),false);assert.equal(Object.hasOwn(original.model_profile,'request_timeout_ms'),false);
    assert.equal(planForProfile(original.model_profile),null,'旧profile不按新C公式规划容量');
    const start=provider.requests.length;provider.holdAfterTool();
    pending=deliverObserved(original,'legacy',abort.signal).then(()=>null,error=>(earlyError=error));
    await until(()=>{if(earlyError)throw earlyError;return provider.blocked();},'旧profile工具回执后中断');
    const tools=()=>h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'sdk',sdk_tool_call_id,'state',state) FROM tool_calls WHERE conversation_id='${cid}'`);
    const initialTools=tools();assert.equal(initialTools.length,1);assert.equal(initialTools[0].origin,original.run_id);assert.equal(initialTools[0].state,'succeeded');assert.ok(initialTools[0].sdk.includes('|'));
    const revisedService={...service,base_url:provider.url+'/legacy-revised/v1',api_key:'synthetic-legacy-new-key',expected_version:'1'};
    ok(await h.request('/model-services',revisedService));
    const configuration=ok(await h.request('/model-definitions',revision));
    const current=configuration.models.find(model=>model.id===definition.id);
    assert.equal(current.version,'2');
    for(const key of ['model_id','context_window','input_limit','output_limit','payload_bytes_limit','request_timeout_ms'])assert.equal(current[key],revision[key]);
    assert.equal(configuration.services.find(value=>value.id===service.id).version,'2');
    const beforeRecovery=budget();assert.deepEqual(beforeRecovery,{...saved,profile:legacyProfile,calls:2},'新修订不改已冻结profile和已发额度');
    abort.abort();assert.equal((await pending).code,'run_cancelled');provider.release();h.releaseRun(original.run_id);
    assertObserved('legacy',legacyProfile,legacyProfile.input_limit,90000,2);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${original.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${original.message_id}';`);
    await h.resumeWorker();
    const resumed=await until(()=>h.captured.find(run=>run.message_id===original.message_id&&run.run_id!==original.run_id),'新修订存在时恢复旧profile');await h.pauseWorker();
    assert.equal(resumed.resume_same_input,true);assert.notEqual(resumed.lease_epoch,original.lease_epoch);
    for(const key of ['request_id','message_id','budget_scope_id','recovery_chain_id'])assert.equal(resumed[key],original[key]);
    assert.deepEqual(resumed.model_profile,legacyProfile);assert.equal(planForProfile(resumed.model_profile),null);
    assert.deepEqual(budget(),beforeRecovery,'重领原输入不重置预算');
    provider.answerNext();await deliverObserved(resumed,'resumed');h.releaseRun(resumed.run_id);
    assertObserved('resumed',legacyProfile,legacyProfile.input_limit,90000,1);
    assert.deepEqual(tools(),initialTools,'旧profile恢复保留operation/origin/复合工具ID');
    const recoveredCalls=provider.requests.slice(start);assert.equal(recoveredCalls.length,3);
    assert.ok(recoveredCalls.every(request=>request.path==='/legacy-recovery/v1/responses'&&request.body.model===definition.model_id&&request.body.max_output_tokens===definition.output_limit&&request.key==='Bearer synthetic-legacy-original-key'));
    assert.ok(recoveredCalls.at(-1).body.input.some(item=>item.type==='function_call_output'&&item.call_id===initialTools[0].sdk.split('|')[0]));
    assert.deepEqual(budget(),{...beforeRecovery,calls:3});
    const attempts=h.sql(`SELECT JSON_OBJECT('run',run_id,'state',state,'input',input_tokens_upper,'output',output_tokens_max) FROM model_call_attempts WHERE budget_scope_id='${original.budget_scope_id}'`);
    assert.equal(attempts.length,3);assert.equal(attempts.filter(value=>value.state==='unknown'&&value.run===original.run_id).length,1);
    assert.equal(attempts.filter(value=>value.state==='settled').length,2);assert.equal(attempts.filter(value=>value.run===resumed.run_id).length,1);
    assert.ok(attempts.every(value=>value.input===definition.input_limit&&value.output===definition.output_limit));
    assert.equal((await h.snapshot(cid)).runs.filter(run=>run.state==='finished').length,1);
    const nextMessage=await h.send(cid,'同会话下一条消息采用模型新修订');
    await h.resumeWorker();
    const next=await until(()=>h.captured.find(run=>run.message_id===nextMessage.message_id),'下一条消息装载新修订');await h.pauseWorker();
    assert.equal(next.resume_same_input,false);assert.notEqual(next.message_id,original.message_id);assert.notEqual(next.budget_scope_id,original.budget_scope_id);assert.notEqual(next.recovery_chain_id,original.recovery_chain_id);
    const nextProfile=next.model_profile;
    for(const key of ['model_id','context_window','input_limit','output_limit','payload_bytes_limit','request_timeout_ms'])assert.equal(nextProfile[key],revision[key]);
    assert.equal(nextProfile.configured_model.version,'2');assert.equal(nextProfile.configured_model.service_version,'2');assert.equal(nextProfile.request_call_limit,undefined);
    assert.equal(planForProfile(nextProfile).contextWindow,revision.context_window);
    const nextStart=provider.requests.length;
    await deliverObserved(next,'next');h.releaseRun(next.run_id);
    const nextCalls=provider.requests.slice(nextStart);assert.equal(nextCalls.length,2);
    assert.ok(nextCalls.every(request=>request.path==='/legacy-revised/v1/responses'&&request.body.model===revision.model_id&&request.body.max_output_tokens===revision.output_limit&&request.key==='Bearer synthetic-legacy-new-key'));
    assertObserved('next',nextProfile,revision.context_window,revision.request_timeout_ms,2);
    const nextBudget=h.sql(`SELECT JSON_OBJECT('profile',model_profile,'limit',call_limit,'calls',issued_calls) FROM budget_scopes WHERE id='${next.budget_scope_id}'`)[0];
    assert.deepEqual(nextBudget,{profile:nextProfile,limit:null,calls:2});assert.deepEqual(budget(),{...beforeRecovery,calls:3});
    assert.equal((await h.snapshot(cid)).runs.filter(run=>run.state==='finished').length,2);
    return '旧持久profile缺C/timeout经Worker装载，已有新修订时原输入保旧限额/90秒/预算与工具身份；下一条消息采用新窗口/600秒/端点/密钥，目录外不猜C';
  } finally {
    try {abort.abort();provider.release();await pending;}
    finally {
      observing=undefined;ModelRuntime.prototype.registerProvider=originalRegister;AbortSignal.timeout=originalTimeout;
      if(previousTimeout===undefined)delete process.env.DATA_AGENT_MODEL_TIMEOUT_MS;else process.env.DATA_AGENT_MODEL_TIMEOUT_MS=previousTimeout;
    }
  }
}
