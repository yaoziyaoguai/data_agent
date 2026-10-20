import assert from 'node:assert/strict';
import {guardedModelStream} from '../../apps/agent/provider/controlled.ts';
import {providerEndpoint,publicAddress} from '../../apps/agent/provider/endpoint.ts';
import {providerUsage} from '../../apps/agent/provider/usage.ts';
import {modelProtocolFixture} from './model-protocol-fixture.mjs';
import {checkConfiguredCapabilities} from './configured-model-capabilities.mjs';
const provider=await modelProtocolFixture();const checks=[];
try {
 checks.push(await checkConfiguredCapabilities());
 for(const address of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.1.5','169.254.169.254','100.100.100.200','224.0.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(address),false,address);
 for(const address of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
 for(const url of ['http://example.com','https://127.0.0.1','https://[::1]','https://foo.local','https://user:password@example.com','https://example.com?api_key=synthetic'])assert.throws(()=>providerEndpoint(url,false));
 checks.push('连接器拒绝非公网IP与本地/含凭据端点，不信任DNS响应中的私有地址');
 for(const api of ['openai-completions','openai-responses','anthropic-messages']) {
  const profile={provider_id:'compatible',model_id:'synthetic/native',trial_id:'synthetic',price_version:'configured:model:1',input_limit:128000,output_limit:16000,payload_bytes_limit:262144,request_call_limit:24,budget_mode:'request',toolset:'data',thinking_level:'off',configured_model:{id:'model',version:'1',service_id:'service',service_version:'1',api,input_rate:'0',output_rate:'0'}};
  const model={id:profile.model_id,name:'Synthetic',api,provider:'compatible',baseUrl:provider.url+(api==='anthropic-messages'?'/gateway':'/gateway/v1'),input:['text'],reasoning:false,contextWindow:128000,maxTokens:16000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  async function call() {
    const posts=[];const transport={run:{run_id:'synthetic'},binding:()=>({run_id:'synthetic',lease_epoch:'1'}),post:async(path,name,value)=>{posts.push({path,value});return {state:path.endsWith('/finalize')?(value.usage?'settled':'unknown'):path.endsWith('/send')?'issued':'reserved',send_allowed:path.endsWith('/send')};}};
    const events=[];for await(const event of guardedModelStream(transport,profile,{api,apiKey:'synthetic-only',baseUrl:model.baseUrl,protocolTest:true},new AbortController().signal)(model,{messages:[{role:'user',content:'Synthetic request',timestamp:1}]}))events.push(event);
    return {posts,events};
  }
  provider.setUsage(true);let result=await call();assert.equal(result.events.at(-1).type,'done',JSON.stringify(result.events.at(-1)));assert.equal(result.posts.at(-1).value.usage.input_tokens,100);assert.equal(result.posts.at(-1).value.usage.output_tokens,25);
  provider.setUsage(false);result=await call();assert.equal(result.events.at(-1).type,'error');assert.equal(result.posts.at(-1).value.usage,null);assert.equal(result.posts.at(-1).value.outcome,'permanent_error');
  provider.setUsage(true);provider.setStatus(503);result=await call();assert.equal(result.posts.at(-1).value.outcome,'transient_error');assert.equal(result.events.at(-1).error.errorMessage,'model_service_unavailable');assert.equal(result.posts.filter(p=>p.path.endsWith('/send')).length,1);provider.setStatus(200);
  checks.push(api+'：实际SDK流、缓存用量、缺usage失败关闭、503临时分类与SDK不额外重发');
 }
 const usage=providerUsage('anthropic-messages');usage.accept({type:'message_start',message:{usage:{input_tokens:30,cache_read_input_tokens:20,cache_creation_input_tokens:10}}});usage.accept({type:'message_delta',usage:{input_tokens:40,cache_creation_input_tokens:20,output_tokens:8}});assert.deepEqual(usage.read(),{input_tokens:80,output_tokens:8});
 assert.deepEqual(provider.errors,[]);console.log(JSON.stringify({passed:true,checks,requests:provider.requests.length,officialRequests:0}));
}finally{await provider.close();}
