import assert from 'node:assert/strict';
import {prepareCompaction,compact} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';

export async function appendLongHistory(manager) {
 const model={id:'synthetic',name:'Synthetic',api:'openai-completions',provider:'local_mock',baseUrl:'http://127.0.0.1:1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:2048};
 const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 let summaries=0;
 const stream=async()=>{summaries++;return {result:async()=>({role:'assistant',content:[{type:'text',text:'合成历史摘要，原会话继续。'}],api:model.api,provider:model.provider,model:model.id,usage,stopReason:'stop',timestamp:Date.now()})};};
 for(let turn=1;turn<=40;turn++) {
  manager.appendMessage({role:'user',content:'合成问题'.repeat(1000),timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'答'.repeat(1000)}],api:model.api,provider:model.provider,model:model.id,usage,stopReason:'stop',timestamp:Date.now()});
  if(turn%4===0){
   const preparation=prepareCompaction(manager.getBranch(),{enabled:true,reserveTokens:2048,keepRecentTokens:256});assert.ok(preparation);
   const result=await compact(preparation,model,undefined,undefined,undefined,undefined,'off',stream,undefined,{enabled:false,maxRetries:0,baseDelayMs:1});
   manager.appendCompaction(result.summary,result.firstKeptEntryId,result.tokensBefore,result.details,false,result.usage);
  }
 }
 assert.equal(summaries,10);return {turns:40,summaries};
}
