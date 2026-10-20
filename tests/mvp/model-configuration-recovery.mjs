import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness,until} from './harness.mjs';

export async function checkConfiguredRecovery(provider) {
  const previousTest=process.env.DATA_AGENT_PROVIDER_TEST;
  process.env.DATA_AGENT_PROVIDER_TEST='1';
  const h=await harness({capture:true,protocolProviderUrl:provider.url,env:{DATA_AGENT_LEASE_MS:'120000'}});
  const abort=new AbortController();let pending,earlyError;
  const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
  try {
    const service={id:'responses',name:'Synthetic recovery',provider_id:'compatible',api:'openai-responses',base_url:provider.url+'/recovery/v1',api_key:'synthetic-original-key',enabled:true,expected_version:'0'};
    ok(await h.request('/model-services',service));
    const definition={id:'responses-model',service_id:service.id,model_id:'synthetic/recovery-responses',label:'Synthetic recovery model',thinking_levels:['off'],reasoning_supported:false,default_thinking:'off',input_limit:128000,output_limit:16000,payload_bytes_limit:262144,input_rate:'0',output_rate:'0',enabled:true,expected_version:'0'};
    const configuration=ok(await h.request('/model-definitions',definition));
    ok(await h.request('/model-configuration/default',{model_id:definition.id,expected_version:configuration.version}));
    const cid=await h.create();const original=await h.capture(cid,'恢复Responses工具检查点');await h.pauseWorker();
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
    return 'Responses复合工具ID原生检查点恢复：原消息/预算/模型/密钥与operation身份保持，未知调用不补额重做';
  } finally {
    abort.abort();provider.release();await pending;await h.close();
    if(previousTest===undefined)delete process.env.DATA_AGENT_PROVIDER_TEST;else process.env.DATA_AGENT_PROVIDER_TEST=previousTest;
  }
}
