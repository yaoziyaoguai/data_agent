import assert from 'node:assert/strict';
import {guardedDeepSeekStream} from '../../apps/agent/provider/deepseek.ts';
let requests=0;
const original=globalThis.fetch;
globalThis.fetch=async()=>{requests++;throw new Error('unexpected_network');};
try {
 const transport={binding:()=>({run_id:'synthetic',lease_epoch:'1'}),post:async()=>{throw new Error('budget_exhausted');}};
 const profile={toolset:'data',model_id:'deepseek-flash',output_limit:1024,input_limit:32768,payload_bytes_limit:65536};
 const model={id:'deepseek-flash',name:'synthetic',api:'openai-completions',provider:'controlled_deepseek',baseUrl:'http://127.0.0.1:1',contextWindow:32768,maxTokens:1024,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false,supportsStore:false,supportsUsageInStreaming:true,maxTokensField:'max_tokens'}};
 const stream=guardedDeepSeekStream(transport,profile,{apiKey:'synthetic-protocol-key',baseUrl:'http://127.0.0.1:1',protocolTest:true},new AbortController().signal)(model,{messages:[{role:'user',content:'合成额度拒绝',timestamp:1}],tools:[]});
 const result=await stream.result();assert.equal(result.stopReason,'error');assert.equal(result.errorMessage,'model_budget_exhausted');assert.equal(requests,0);
 const boundaryChecks=[];
 for(const [limit,length,expected] of [[65536,70000,'request_too_large: model_input_limit'],[131072,70000,'model_budget_exhausted'],[131072,131072,'request_too_large: model_input_limit']]){
  let admissions=0;
  const bounded={...transport,post:async()=>{admissions++;throw new Error('budget_exhausted');}};
  const candidate=guardedDeepSeekStream(bounded,{...profile,payload_bytes_limit:limit},{apiKey:'synthetic-protocol-key',baseUrl:'http://127.0.0.1:1',protocolTest:true},new AbortController().signal)(model,{messages:[{role:'user',content:'x'.repeat(length),timestamp:1}],tools:[]});
  const outcome=await candidate.result();assert.equal(outcome.errorMessage,expected);assert.equal(admissions,expected==='model_budget_exhausted'?1:0);assert.equal(requests,0);
  boundaryChecks.push({payloadLimit:limit,contentBytes:length,reason:outcome.errorMessage,admissions});
 }
 console.log(JSON.stringify({passed:true,reason:result.errorMessage,boundaryChecks,networkRequests:requests}));
}finally{globalThis.fetch=original;}
