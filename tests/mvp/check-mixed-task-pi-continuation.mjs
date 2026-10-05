import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness,until} from './harness.mjs';

let calls=0,continuationCalls=0,phase='original',active,cancelled,h,passed=false;
const conditions={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
const provider=createServer(async(req,res)=>{
 try{
 let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;const body=JSON.parse(raw);calls++;
 let action;
 if(phase==='original'){
  if(calls===3)return; // 在两次已持久提交的工具之后保持模型请求未完成。
  action={name:'update_analysis_task',args:{action:'create',goal:calls===1?'金额解释':'时间解释',conditions,options:[]}};
 }else{
  continuationCalls++;
  if(!raw.includes('input_task_ids')||!raw.includes(cancelled.id)||!raw.includes('cancelled')){
   await writeFile('.local/checks/mvp-mixed-task-pi-payload-diagnostic.json',JSON.stringify(body,null,2));
   throw new Error('synthetic-current-context-missing');
  }
  action=continuationCalls===1?{name:'read_analysis_task',args:{task_id:active.id}}:
   continuationCalls===2?{name:'update_analysis_task',args:{action:'route',task_id:active.id,expected_version:active.condition_version,goal:'',options:[]}}:null;
 }
 res.writeHead(200,{'content-type':'text/event-stream'});
 const delta=action?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]}:{role:'assistant',content:'剩余时间目标已沿用原任务完成，金额目标已取消。'};
 res.write('data: '+JSON.stringify({id:'synthetic-mixed-continuation',choices:[{index:0,delta,finish_reason:action?'tool_calls':'stop'}]})+'\n\n');
 res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}})+'\n\n');res.end('data: [DONE]\n\n');
 }catch{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":{"message":"synthetic-protocol-assertion-failed"}}');}
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const previous=Object.fromEntries(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST'].map(k=>[k,process.env[k]]));
try{
 const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:20,trial_cost_micros:'300000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
 h=await harness({capture:true,profile,env:{DATA_AGENT_LEASE_MS:'120000'}});
 process.env.DEEPSEEK_API_KEY='synthetic-protocol-key';process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+provider.address().port;process.env.DATA_AGENT_PROVIDER_TEST='1';
 const cid=await h.create(),original=await h.capture(cid,'分别解释合成金额和时间，这是两项独立目标。');await h.pauseWorker();
 const abort=new AbortController();
 const interrupted=deliver(original,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'',abort.signal).then(()=>null,e=>e);
 const snapshot=await until(async()=>{const s=await h.snapshot(cid);return s.tasks.length===2&&calls===3?s:false;},'Pi已实际创建两个任务');
 cancelled=snapshot.tasks.find(t=>t.goal==='金额解释');active=snapshot.tasks.find(t=>t.goal==='时间解释');assert.ok(cancelled&&active);
 const checkpoint=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${original.recovery_chain_id}'`)[0];assert.ok(restoreCheckpoint('/synthetic/data-agent',checkpoint).getBranch().length>0);
 assert.equal((await h.request(`/conversations/${cid}/tasks/${cancelled.id}/cancel`,{operation_id:randomUUID(),expected_version:cancelled.condition_version})).status,200);
 abort.abort();assert.equal((await interrupted).code,'run_cancelled');h.releaseRun(original.run_id);
 phase='continuation';await h.resumeWorker();
 const resumed=await until(()=>h.captured.find(r=>r.message_id===original.message_id&&r.run_id!==original.run_id),'原输入剩余目标续接');await h.pauseWorker();
 assert.equal(resumed.recovery_chain_id,original.recovery_chain_id);assert.equal(resumed.budget_scope_id,original.budget_scope_id);assert.equal(resumed.request_id,original.request_id);
 assert.deepEqual(new Set(resumed.workspace_context.input_task_ids),new Set([cancelled.id,active.id]));
 await deliver(resumed,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(resumed.run_id);
 const completed=await h.snapshot(cid);assert.equal(completed.tasks.length,2);assert.equal(completed.tasks.find(t=>t.id===cancelled.id).lifecycle,'cancelled');assert.equal(completed.tasks.find(t=>t.id===active.id).phase,'answered');
 const attempts=h.sql(`SELECT JSON_OBJECT('state',state,'scope',budget_scope_id) FROM model_call_attempts`);assert.equal(attempts.length,6);assert.equal(attempts.filter(a=>a.state==='unknown').length,1);assert.ok(attempts.every(a=>a.scope===original.budget_scope_id));
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE tool_name='update_analysis_task' AND state='succeeded'`)[0].n,3);
 passed=true;console.log(JSON.stringify({passed,calls,checks:['真实Pi创建双目标、取消中断、从持久检查点沿原链恢复；当前上下文包含取消状态，只续接剩余任务，工具无重复副作用，未知请求保留原账本'],officialRequests:0}));
}finally{
 if(h)await h.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));
 for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 await writeFile('.local/checks/mvp-mixed-task-pi-continuation.json',JSON.stringify({passed,calls,officialRequests:0},null,2));
}
