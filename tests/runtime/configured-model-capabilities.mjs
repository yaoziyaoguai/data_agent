import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {InMemoryModelsStore,normalizeContext} from '@earendil-works/pi-ai';
import {streamSimple as completions} from '@earendil-works/pi-ai/api/openai-completions';
import {streamSimple as responses} from '@earendil-works/pi-ai/api/openai-responses';
import {streamSimple as anthropic} from '@earendil-works/pi-ai/api/anthropic-messages';
import {configuredModel} from '../../apps/agent/provider/configured.ts';
import {guardedModelStream} from '../../apps/agent/provider/controlled.ts';

export async function checkConfiguredCapabilities() {
  const runtime=await ModelRuntime.create({credentials:{read:async()=>undefined,list:async()=>[],modify:async()=>{},delete:async()=>{}},modelsPath:null,modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
  let networks=0;
  async function model({provider='compatible',id='synthetic/reasoning',api='openai-responses',level='off',mode,service='a',version='1',output=16000,supported=true}={}) {
    const profile={provider_id:provider,model_id:id,trial_id:'synthetic',price_version:'configured:model:1',input_limit:128000,output_limit:output,payload_bytes_limit:262144,request_call_limit:24,budget_mode:'request',toolset:'data',thinking_level:level,configured_model:{id:'model',version:'1',service_id:service,service_version:version,api,input_rate:'0',output_rate:'0',reasoning_supported:supported,...(mode?{anthropic_thinking_mode:mode}:{})}};
    const connection={api,api_key:'synthetic-only',provider_id:provider,base_url:'https://example.com/v1',runtime_provider:'configured_'+createHash('sha256').update(service+':'+version).digest('hex')};
    const transport={run:{run_id:'synthetic'},binding:()=>({run_id:'synthetic',lease_epoch:'1'}),post:async()=>connection};
    return {model:await configuredModel(runtime,transport,profile,new AbortController().signal),profile};
  }
  const tools=[{name:'update_analysis_task',description:'Synthetic tool',parameters:{type:'object',properties:{},additionalProperties:false}}];
  const context=(messages)=>normalizeContext({systemPrompt:'Synthetic instructions',messages:messages??[{role:'user',content:'Synthetic question',timestamp:1}],tools});
  async function payload(value,messages) {
    let captured;
    const native={'openai-completions':completions,'openai-responses':responses,'anthropic-messages':anthropic}[value.model.api];
    await native(value.model,context(messages),{apiKey:'synthetic-only',maxTokens:value.profile.output_limit,reasoning:value.profile.thinking_level==='off'?undefined:value.profile.thinking_level,onPayload:body=>{captured=body;throw new Error('captured without sending');},fetch:async()=>{networks++;throw new Error('network forbidden');}}).result();
    assert.ok(captured,'native SDK produced a request');return captured;
  }
  for (const level of ['off','high']) {
    const openai=await model({provider:'openai',id:'gpt-5.5',level});
    assert.equal((await payload(openai)).reasoning.effort,level==='off'?'none':level);
    const deepseek=await model({provider:'deepseek',id:'deepseek-flash',api:'openai-completions',level});
    const body=await payload(deepseek);assert.equal(body.thinking.type,level==='off'?'disabled':'enabled');
    if(level!=='off')assert.equal(body.reasoning_effort,level);
    const unknown=await model({api:'anthropic-messages',level,mode:'budget'});
    const a=await payload(unknown);assert.equal(a.thinking.type,level==='off'?'disabled':'enabled');
    if(level!=='off')assert.ok(a.thinking.budget_tokens>=1024&&a.thinking.budget_tokens<a.max_tokens);
  }
  assert.equal((await payload(await model({supported:true}))).reasoning.effort,'none','off-only reasoning capability stays explicit');
  await assert.rejects(model({provider:'openai',id:'gpt-5.5',level:'max'}),/provider_configuration_invalid/);
  await assert.rejects(model({api:'anthropic-messages',level:'max',mode:'budget'}),/provider_configuration_invalid/);
  for(const level of ['high','xhigh','max']) {
    const body=await payload(await model({api:'anthropic-messages',level,mode:'adaptive'}));
    assert.equal(body.thinking.type,'adaptive');assert.equal(body.output_config.effort,level);
  }
  for(const id of ['claude-opus-5-5','claude-fable-5']) {
    assert.ok(runtime.getModel('anthropic',id),'test uses a real locked SDK catalog entry');
    const body=await payload(await model({provider:'anthropic',id,api:'anthropic-messages',level:'high',mode:'adaptive'}));
    assert.equal(body.thinking.type,'adaptive');assert.equal(body.output_config.effort,'high');
    assert.deepEqual(body.tools.map(tool=>tool.name),['update_analysis_task']);
    assert.ok(!body.fallbacks?.length,'no supplier can change frozen model or price');
  }
  const a=await model({service:'account-a'}),b=await model({service:'account-b'}),revision=await model({service:'account-a',version:'2'});
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const signature=JSON.stringify({type:'reasoning',id:'rs_synthetic',summary:[],encrypted_content:'opaque-account-a'});
  const history=[{role:'user',content:'Original question',timestamp:1},{role:'assistant',api:a.model.api,provider:a.model.provider,model:a.model.id,content:[{type:'thinking',thinking:'Synthetic thought',thinkingSignature:signature},{type:'text',text:'Original public answer'},{type:'toolCall',id:'call_synthetic|fc_synthetic',name:'update_analysis_task',arguments:{}}],usage,stopReason:'toolUse',timestamp:2},{role:'toolResult',toolCallId:'call_synthetic|fc_synthetic',toolName:'update_analysis_task',content:[{type:'text',text:'Synthetic tool receipt'}],isError:false,timestamp:3},{role:'user',content:'Follow-up question',timestamp:4}];
  assert.ok(JSON.stringify(await payload(a,history)).includes('opaque-account-a'),'same service keeps its signature');
  for(const value of [b,revision]) {
    const body=JSON.stringify(await payload(value,history));assert.ok(!body.includes('opaque-account-a'));assert.ok(body.includes('Original public answer'));assert.ok(body.includes('Synthetic tool receipt'));
  }
  // Responses会把1抬到16；宿主必须在reserve前拒绝实际载荷越界。
  const tiny=await model({output:1});let posts=0;
  const stream=guardedModelStream({run:{run_id:'synthetic'},binding:()=>({}),post:async()=>{posts++;throw new Error('permit forbidden');}},tiny.profile,{api:'openai-responses',apiKey:'synthetic-only',baseUrl:'https://example.com/v1',protocolTest:false},new AbortController().signal)(tiny.model,context());
  const result=await stream.result();assert.equal(result.errorMessage,'model_output_limit');assert.equal(posts,0);assert.equal(networks,0);
  return '真实SDK目录off/high、未知Anthropic预算/自适应档位、Claude工具集合与无模型回退、同名跨服务/修订签名隔离、输出cap在许可前拒绝（0网络请求）';
}
