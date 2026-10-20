import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';
import {ok} from './skill-fixtures.mjs';
// 真实 API/Worker/MySQL 回环；侧车只替换模型与索引，不发生官方请求。
let h,run,failDisable=true;const requests=[],indexed=new Map();
const server=createServer(async(req,res)=>{try{
 let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);requests.push({path:req.url,input});
 if(req.url!=='/index')throw new Error('unexpected_request');
 if(input.asset.state==='enabled'){
  const call={action:'issue',budget:input.budget,call_attempt_id:randomUUID(),purpose:'memory_embedding',parameters_fingerprint:createHash('sha256').update(raw).digest('hex'),input_tokens_upper:100,output_tokens_max:0,usage:null};
  assert.equal(ok(await h.internal('/internal/memory/model-calls',call)).send_allowed,true);
  ok(await h.internal('/internal/memory/model-calls',{...call,action:'finalize',usage:{input_tokens:10,output_tokens:0,elapsed_ms:1}}));
 }
 if(input.asset.state==='disabled'&&failDisable){failDisable=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'memory_unavailable'}));return;}
 indexed.set(input.asset.id,input.asset);
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({operation_id:input.operation_id,state:input.asset.state==='enabled'?'ready':'removed'}));
}catch(error){console.error(error);res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'memory_unavailable'}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'cleanup_'+randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:20,trial_cost_micros:'5000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072,thinking_level:'high'};
const marker='SYNTHETIC_MEMORY_INDEX_SOURCE';let passed=false;const checks=[];
try {
 const sidecar='http://127.0.0.1:'+server.address().port;
 h=await harness({capture:true,startWorker:false,profile,env:{DATA_AGENT_MEMORY_URL:'',DATA_AGENT_LEASE_MS:'120000'}});
 const source=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'可撤索引来源',body:marker,related_ids:[]}));
 const cid=await h.create();await h.resumeWorker();run=await h.capture(cid,'请记住以后金额使用元。');await h.pauseWorker();
 const manager=SessionManager.inMemory('/synthetic/data-agent');const cp=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
 const tool=async(name,args)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:cp()};ok(await h.internal('/internal/data/tool-calls',input));return ok(await h.internal('/internal/data/tools',input)).data;};
 await tool('read_knowledge',{object_id:source.id});
 const asset=await tool('manage_personal_asset',{action:'save_memory',name:'显示偏好',body:'金额用元 '+marker,scope:'金额显示',instruction_quote:run.text,verified:false,dependencies:[]});
 await tool('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]});
 const final='已保存合成偏好';ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text:final}));ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:final,checkpoint:cp()}));h.releaseRun(run.run_id);
 h.env.DATA_AGENT_MEMORY_URL=sidecar;await h.restartApi();await h.resumeWorker();
 await until(()=>indexed.get(asset.id)?.state==='enabled','initial source-bound index');assert.ok(indexed.get(asset.id).body.includes(marker));
 ok(await h.request(`/knowledge/${source.id}/disable`,{operation_id:randomUUID(),expected_version:source.version}));
 const disabled=ok(await h.request(`/assets/${asset.id}/disable`,{operation_id:randomUUID(),expected_version:asset.version}));assert.equal(disabled.text_unavailable,true);
 await until(()=>indexed.get(asset.id)?.state==='disabled','invalid source still permits disable cleanup');
 const attempts=requests.filter(value=>value.input.asset.state==='disabled');assert.equal(attempts.length,2);assert.equal(attempts[0].input.operation_id,attempts[1].input.operation_id);assert.deepEqual(attempts[0].input.asset,attempts[1].input.asset,'same cleanup retry keeps stable fingerprint inputs');assert.equal(attempts[0].input.extraction_operation_id,attempts[1].input.extraction_operation_id);
 const deleted=ok(await h.request(`/assets/${asset.id}/delete`,{operation_id:randomUUID(),expected_version:disabled.version}));
 await until(()=>indexed.get(asset.id)?.state==='deleted','deleted asset clears sidecar');
 for(const request of requests.filter(value=>value.input.asset.state!=='enabled')){assert.equal(JSON.stringify(request).includes(marker),false);assert.equal(request.input.asset.body,'');assert.deepEqual(request.input.asset.files,[]);}
 assert.equal(deleted.state,'deleted');assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM personal_memory_index_jobs WHERE asset_id='${asset.id}' AND state='indexed'`)[0].n,3);
 checks.push('已索引的模型记忆来源撤回后仍能停用/删除；清理发送固定空正文，失败重试沿原身份与相同payload，无新增embedding');
 passed=true;
} finally {if(run&&h)h.releaseRun(run.run_id);if(h)await h.close();await new Promise(resolve=>server.close(resolve));await writeFile('.local/checks/memory-source-cleanup.json',JSON.stringify({passed,checks,officialRequests:0},null,2));console.log(JSON.stringify({passed,checks,officialRequests:0}));}
