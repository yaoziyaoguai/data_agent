import assert from 'node:assert/strict';
import {guardedModelStream} from '../../apps/agent/provider/controlled.ts';
import {providerEndpoint,publicAddress} from '../../apps/agent/provider/endpoint.ts';
import {providerUsage} from '../../apps/agent/provider/usage.ts';
import {modelProtocolFixture} from './model-protocol-fixture.mjs';
import {checkConfiguredCapabilities} from './configured-model-capabilities.mjs';
import {decodeContract} from '../../packages/contracts/validate.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {normalizeContext} from '@earendil-works/pi-ai';
import {getModel} from '@earendil-works/pi-ai/compat';
const provider=await modelProtocolFixture();const checks=[];
try {
 checks.push(await checkConfiguredCapabilities());
 // 已有Responses目录型号的1.4声明位于additional_tools；协议替身也必须执行同一工具回合。
 {
  const model={...getModel('openai','gpt-6.1-sol'),baseUrl:provider.url+'/gateway/v1'};
  const profile={provider_id:'openai',model_id:model.id,trial_id:'synthetic',price_version:'configured:responses:1',context_window:1050000,input_limit:900000,output_limit:128000,payload_bytes_limit:8388608,toolset:'data',thinking_level:'high',configured_model:{id:'model',version:'1',service_id:'service',service_version:'1',api:'openai-responses',input_rate:'0',output_rate:'0'}};
  const transport={run:{run_id:'synthetic-native-responses'},binding:()=>({run_id:'synthetic-native-responses',lease_epoch:'1'}),post:async(path,_name,value)=>({state:path.endsWith('/finalize')?(value.usage?'settled':'unknown'):path.endsWith('/send')?'issued':'reserved',send_allowed:path.endsWith('/send')})};
  const context=normalizeContext({tools:[{name:'update_analysis_task',description:'合成任务工具',parameters:{type:'object',properties:{}}}],messages:[{role:'user',content:'合成Responses原生工具声明回归',timestamp:1}]});
  const result=await guardedModelStream(transport,profile,{api:'openai-responses',apiKey:'synthetic-only',baseUrl:model.baseUrl,protocolTest:true},new AbortController().signal)(model,context).result();
  assert.equal(result.stopReason,'toolUse','替身须识别实际additional_tools声明并返回原工具调用');
  assert.equal(result.content.find(part=>part.type==='toolCall')?.name,'update_analysis_task');
  checks.push('原生Responses additional_tools声明在实际本地HTTP触发同一任务工具，无官方调用');
 }
 for(const address of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.1.5','169.254.169.254','100.100.100.200','224.0.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(address),false,address);
 for(const address of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
 for(const url of ['http://example.com','https://127.0.0.1','https://[::1]','https://foo.local','https://user:password@example.com','https://example.com?api_key=synthetic'])assert.throws(()=>providerEndpoint(url,false));
 checks.push('连接器拒绝非公网IP与本地/含凭据端点，不信任DNS响应中的私有地址');
 for(const api of ['openai-completions','openai-responses','anthropic-messages']) {
  const profile={provider_id:'compatible',model_id:'synthetic/native',trial_id:'synthetic',price_version:'configured:model:1',input_limit:128000,output_limit:16000,payload_bytes_limit:262144,request_call_limit:24,budget_mode:'request',toolset:'data',thinking_level:'off',configured_model:{id:'model',version:'1',service_id:'service',service_version:'1',api,input_rate:'0',output_rate:'0'}};
  const model={id:profile.model_id,name:'Synthetic',api,provider:'compatible',baseUrl:provider.url+(api==='anthropic-messages'?'/gateway':'/gateway/v1'),input:['text'],reasoning:false,contextWindow:128000,maxTokens:16000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  async function call() {
    const posts=[];const transport={run:{run_id:'synthetic'},binding:()=>({run_id:'synthetic',lease_epoch:'1'}),post:async(path,name,value)=>{posts.push({path,value});return decodeContract('ModelCallReceipt',{state:path.endsWith('/finalize')?(value.usage?'settled':'unknown'):path.endsWith('/send')?'issued':'reserved',send_allowed:path.endsWith('/send')});}};
    const events=[],diagnostics=[],originalError=console.error;
    try{console.error=line=>diagnostics.push(JSON.parse(line));for await(const event of guardedModelStream(transport,profile,{api,apiKey:'synthetic-only',baseUrl:model.baseUrl,protocolTest:true},new AbortController().signal)(model,{messages:[{role:'user',content:'Synthetic request',timestamp:1}]}))events.push(event);}finally{console.error=originalError;}
    return {posts,events,diagnostics};
  }
  provider.setUsage(true);let result=await call();assert.equal(result.events.at(-1).type,'done',JSON.stringify(result.events.at(-1)));assert.equal(result.posts.at(-1).value.usage.input_tokens,100);assert.equal(result.posts.at(-1).value.usage.output_tokens,25);
  provider.setUsage(false);result=await call();assert.equal(result.events.at(-1).type,'error');assert.equal(result.posts.at(-1).value.usage,null);assert.equal(result.posts.at(-1).value.outcome,'permanent_error');
  provider.setUsage(true);provider.setStatus(503);result=await call();assert.equal(result.posts.at(-1).value.outcome,'transient_error');assert.equal(result.events.at(-1).error.errorMessage,'model_service_unavailable');assert.equal(result.posts.filter(p=>p.path.endsWith('/send')).length,1);assert.equal(result.diagnostics.length,1);assert.equal(result.diagnostics[0].stage,'provider');assert.equal(result.diagnostics[0].http_status,503);assert.equal(result.diagnostics[0].reason,'model_service_unavailable');assert.equal(result.diagnostics[0].call_attempt_id,result.posts[0].value.call_attempt_id);provider.setStatus(200);
  checks.push(api+'：实际SDK流、缓存用量、缺usage失败关闭、503临时分类与SDK不额外重发');
 }
 // 容量接线：冻结超时按修订校验，摘要请求按本次maxTokens收敛，端点上限压低实际输出cap。
 {
  const capacityProfile={provider_id:'compatible',model_id:'synthetic/capacity',trial_id:'synthetic',price_version:'configured:model:2',input_limit:128000,output_limit:16000,payload_bytes_limit:262144,request_call_limit:24,budget_mode:'request',toolset:'data',thinking_level:'off',configured_model:{id:'model',version:'1',service_id:'service',service_version:'1',api:'openai-completions',input_rate:'0',output_rate:'0'}};
  const capacityModel={id:capacityProfile.model_id,name:'Synthetic',api:'openai-completions',provider:'compatible',baseUrl:provider.url+'/gateway/v1',input:['text'],reasoning:false,contextWindow:128000,maxTokens:16000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const syntheticTransport=()=>{const posts=[];return{posts,transport:{run:{run_id:'synthetic'},binding:()=>({run_id:'synthetic',lease_epoch:'1'}),post:async(path,name,value)=>{posts.push({path,value});return decodeContract('ModelCallReceipt',{state:path.endsWith('/finalize')?(value.usage?'settled':'unknown'):path.endsWith('/send')?'issued':'reserved',send_allowed:path.endsWith('/send')});}}};};
  async function capacityRun(connection,options){
    const t=syntheticTransport();const events=[];for await(const event of guardedModelStream(t.transport,capacityProfile,connection,new AbortController().signal)(capacityModel,{messages:[{role:'user',content:'Synthetic request',timestamp:1}]},options))events.push(event);
    return{posts:t.posts,events};
  }
  const localConnection={api:'openai-completions',apiKey:'synthetic-only',baseUrl:capacityModel.baseUrl,protocolTest:true};
  const frozenConnection={...localConnection,protocolTest:false};
  // 构造期即按冻结/环境超时校验：600s在范围内，700s与protocolTest环境600001都拒绝。
  assert.doesNotThrow(()=>guardedModelStream(syntheticTransport().transport,{...capacityProfile,request_timeout_ms:600000},frozenConnection,new AbortController().signal));
  assert.throws(()=>guardedModelStream(syntheticTransport().transport,{...capacityProfile,request_timeout_ms:700000},frozenConnection,new AbortController().signal),/provider_configuration_invalid/);
  process.env.DATA_AGENT_MODEL_TIMEOUT_MS='600001';
  try{assert.throws(()=>guardedModelStream(syntheticTransport().transport,capacityProfile,localConnection,new AbortController().signal),/provider_configuration_invalid/);}finally{delete process.env.DATA_AGENT_MODEL_TIMEOUT_MS;}
  provider.setUsage(true);
  const reserveOf=posts=>posts.find(p=>p.path.endsWith('/reserve')).value.output_tokens_max;
  // 摘要请求按本次maxTokens收敛：金额预留与实际payload都是5000，不按冻结上限16000放大。
  const summaryCall=await capacityRun(localConnection,{maxTokens:5000});
  assert.equal(summaryCall.events.at(-1).type,'done',JSON.stringify(summaryCall.events.at(-1)));
  assert.equal(reserveOf(summaryCall.posts),5000);
  assert.equal(provider.requests.at(-1).body.max_tokens??provider.requests.at(-1).body.max_completion_tokens,5000);
  // 已知端点上限压低实际输出cap；SDK未显式给maxTokens的常规轮同样被压到端点上限。
  const cappedCall=await capacityRun({...localConnection,endpointOutputLimit:8000},{maxTokens:9000});
  assert.equal(cappedCall.events.at(-1).type,'done');
  assert.equal(reserveOf(cappedCall.posts),8000);
  assert.equal(provider.requests.at(-1).body.max_tokens??provider.requests.at(-1).body.max_completion_tokens,8000);
  const plainCall=await capacityRun({...localConnection,endpointOutputLimit:8000});
  assert.equal(plainCall.events.at(-1).type,'done');
  assert.equal(reserveOf(plainCall.posts),8000);
  assert.equal(provider.requests.at(-1).body.max_tokens??provider.requests.at(-1).body.max_completion_tokens,8000);
  checks.push('容量接线：冻结/环境超时600s内可用、超范围构造即拒；摘要cap按本次maxTokens=5000收敛预留与payload；端点上限8000压低常规轮与显式请求');
 }
 // 经真实宿主HTTP适配和Pi错误转换观察诊断，不改原对外码或重试策略。
 for(const sample of [
  {stage:'reserve',reason:'timeout',httpStatus:null},
  {stage:'send',reason:'model_receipt_unknown',httpStatus:409},
  {stage:'send',reason:'stale_context',httpStatus:409},
  {stage:'reserve',reason:'budget_exhausted',httpStatus:409},
  {stage:'finalize',reason:'invalid_response',httpStatus:200},
  {stage:'finalize',reason:'invalid_response',httpStatus:200,providerStatus:503},
 ]) {
  const posts=[],diagnostics=[];const originalFetch=globalThis.fetch,originalError=console.error;
  const sentinel='SYNTHETIC_PRIVATE_CONTENT_DO_NOT_LOG';
  const profile={provider_id:'compatible',model_id:'synthetic/dispatch',trial_id:'synthetic',price_version:'configured:dispatch:1',input_limit:128000,output_limit:16000,payload_bytes_limit:262144,request_call_limit:24,budget_mode:'request',toolset:'data',thinking_level:'off',configured_model:{id:'model',version:'1',service_id:'service',service_version:'1',api:'openai-completions',input_rate:'0',output_rate:'0'}};
  const model={id:profile.model_id,name:'Synthetic',api:'openai-completions',provider:'compatible',baseUrl:provider.url+'/gateway/v1',input:['text'],reasoning:false,contextWindow:128000,maxTokens:16000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const before=provider.requests.length;
  provider.setStatus(sample.providerStatus??200);
  try {
   globalThis.fetch=async(url,init)=>{
    const path=new URL(url).pathname;posts.push({path,input:JSON.parse(init.body)});
    if(path==='/internal/model/'+sample.stage) {
     if(sample.reason==='timeout')throw new DOMException(sentinel,'TimeoutError');
     if(sample.reason==='invalid_response')return new Response('{'+sentinel,{status:200});
     return Response.json({code:sample.reason,message:sentinel,request_id:'synthetic',retryable:false},{status:sample.httpStatus});
    }
    assert.ok(['/internal/model/reserve','/internal/model/send'].includes(path));return Response.json({state:path.endsWith('/send')?'issued':'reserved',send_allowed:path.endsWith('/send')});
   };
   console.error=(line)=>diagnostics.push(JSON.parse(line));
   const transport=new RustTransport({run_id:'synthetic-dispatch',lease_epoch:'1'},'http://127.0.0.1:1',sentinel);
   const events=[];
   for await(const event of guardedModelStream(transport,profile,{api:'openai-completions',apiKey:sentinel,baseUrl:model.baseUrl,protocolTest:true},new AbortController().signal)(model,{messages:[{role:'user',content:sentinel,timestamp:1}]}))events.push(event);
   assert.equal(events.at(-1).type,'error');
   const result=events.at(-1).error;
   // Pi在error事件即结束流；本地直接HTTP回执的清理微任务结束后再撤销fetch替身。
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(result.errorMessage,sample.stage==='finalize'?'model_finalize_unconfirmed':sample.reason==='budget_exhausted'?'model_budget_exhausted':sample.reason==='stale_context'?'stale_context':'model_request_failed');
   assert.equal(provider.requests.length-before,sample.stage==='finalize'?1:0,'仅结算失败发生于真实provider请求之后');
   assert.equal(diagnostics.length,sample.providerStatus?2:1,'各失败阶段应各有一条受控诊断，不能吞掉结算失败');
   if(sample.providerStatus){
    assert.equal(diagnostics[0].stage,'provider');assert.equal(diagnostics[0].http_status,503);
    assert.equal(diagnostics[0].reason,'model_service_unavailable');
   }
   const diagnostic=diagnostics.at(-1);
   assert.equal(diagnostic.event,'model_dispatch_failed');assert.equal(diagnostic.stage,sample.stage);
   assert.equal(diagnostic.run_id,'synthetic-dispatch');assert.equal(diagnostic.call_attempt_id,posts[0].input.call_attempt_id);
   assert.equal(diagnostic.path,'/internal/model/'+sample.stage);assert.equal(diagnostic.reason,sample.reason);
   assert.equal(diagnostic.http_status,sample.httpStatus);assert.equal(diagnostic.reserved,sample.stage!=='reserve');assert.equal(diagnostic.sent,sample.stage==='finalize');
   assert.ok(Number.isInteger(diagnostic.elapsed_ms)&&diagnostic.elapsed_ms>=0);
   assert.ok(!JSON.stringify(diagnostics).includes(sentinel),'诊断不能包含异常原文、token、正文或模型密钥');
   assert.equal(posts.filter(p=>p.path.endsWith('/send')).length,sample.stage!=='reserve'?1:0);
   const settlements=posts.filter(p=>p.path.endsWith('/finalize'));
   if(sample.stage==='finalize'){
    assert.ok(settlements.length>=2);for(const post of settlements)assert.deepEqual(post.input,settlements[0].input,'丢失回执只重送原结算');
   }else assert.equal(settlements.length,0,'未确认发送不伪造结算');
  }finally{globalThis.fetch=originalFetch;console.error=originalError;provider.setStatus(200);}
 }
 checks.push('真实RustTransport/Pi错误边界：reserve超时、宿主预算拒绝、send许可未知与结算坏回执各有原调用阶段诊断；无敏感原文、模型重发或伪结算');
 const usage=providerUsage('anthropic-messages');usage.accept({type:'message_start',message:{usage:{input_tokens:30,cache_read_input_tokens:20,cache_creation_input_tokens:10}}});usage.accept({type:'message_delta',usage:{input_tokens:40,cache_creation_input_tokens:20,output_tokens:8}});assert.deepEqual(usage.read(),{input_tokens:80,output_tokens:8});
 assert.deepEqual(provider.errors,[]);console.log(JSON.stringify({passed:true,checks,requests:provider.requests.length,officialRequests:0}));
}finally{await provider.close();}
// 同一派发验收入口继续覆盖真实Bridge的宿主finish错误边界。
await import('./check-bridge.mjs');
