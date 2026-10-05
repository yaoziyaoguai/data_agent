import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint,restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

// 保留最近一组工具的原文；历史摘要与重试交由Pi，不剪掉工具回执来伪装成功。
const checks=[];
for(const oversized of [false,true]){
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:8192,trial_call_limit:24,trial_cost_micros:'300000',request_call_limit:12,toolset:'data',payload_bytes_limit:131072,thinking_level:'high'};
const h=await harness({capture:true,profile,env:{DATA_AGENT_LEASE_MS:'120000'}});
let step=0,summaries=0,run;const ids=[],bodies=[],payloadBytes=[];
const sdkIds=()=>['context-task',...ids.map((_,index)=>'context-read-'+index)];
const verifyResults=(tools,calls)=>{
  assert.deepEqual(tools.map(tool=>tool.id).sort(),sdkIds().sort());
  assert.deepEqual(calls.map(call=>call.id).sort(),sdkIds().sort());
  for(let index=0;index<ids.length;index++){
    const tool=tools.find(tool=>tool.id==='context-read-'+index),value=JSON.parse(tool.text);
    assert.equal(value.id,ids[index]);const body=value.entries.find(entry=>entry.entry_id==='body').effective_value;
    const difference=[...body].findIndex((c,i)=>c!==bodies[index][i]);
    assert.equal(body.length,8192,JSON.stringify({length:body.length,chars:[...body].length,difference,around:body.slice(difference-5,difference+12),expected:bodies[index].slice(difference-5,difference+12)}));assert.equal(body,bodies[index]);
    const call=calls.find(call=>call.id===tool.id);assert.equal(call.name,'read_knowledge');assert.equal(call.arguments.object_id,ids[index]);
  }
  assert.equal(calls.find(call=>call.id==='context-task').name,'update_analysis_task');
};
const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString('utf8');
  payloadBytes.push(Buffer.byteLength(raw));assert.ok(Buffer.byteLength(raw)<=profile.payload_bytes_limit);
  const body=JSON.parse(raw);const summary=!body.tools?.length;if(summary)summaries++;
  let delta;
  if(summary)delta={role:'assistant',content:'合成历史摘要：原输入及工具已登记，保留原回执并完成说明。'};
  else if(step++===0){
    delta={role:'assistant',reasoning_content:'合成推断'.repeat(1000),tool_calls:[
      {index:0,id:'context-task',type:'function',function:{name:'update_analysis_task',arguments:JSON.stringify({action:'create',goal:'解释合成长文资料',conditions:{time_start:'2026-01-01T00:00:00Z',time_end:'2026-02-01T00:00:00Z',timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},question:null,options:[]})}},
      ...ids.map((id,index)=>({index:index+1,id:'context-read-'+index,type:'function',function:{name:'read_knowledge',arguments:JSON.stringify({object_id:id,version:'1',offset:0,limit:8192})}})),
    ]};
  }else{
    assert.equal(oversized,false,'最小工具组超限的续答应在网络发送前终止');
    const tools=body.messages.filter(m=>m.role==='tool');
    assert.equal(tools.length,3,'压缩后最近一组工具仍完整保留');
    verifyResults(tools.map(m=>({id:m.tool_call_id,text:m.content})),body.messages.flatMap(m=>(m.tool_calls??[]).map(c=>({id:c.id,name:c.function.name,arguments:JSON.parse(c.function.arguments)}))));
    delta={role:'assistant',content:'已按原任务读取两份合成资料，可以继续这个对话。'};
  }
  const tool=!!delta.tool_calls;res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'large-context',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\n');
  res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}})+'\n\n');res.end('data: [DONE]\n\n');
});await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const keys=['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST'];const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
Object.assign(process.env,{DEEPSEEK_API_KEY:'synthetic-protocol-key',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+provider.address().port,DATA_AGENT_PROVIDER_TEST:'1'});
try{
  for(let index=0;index<(oversized?6:2);index++){
    const full=('合成长文内容'+String.fromCharCode(0x4e00+index)).repeat(2000);bodies.push(full.slice(0,8192));
    const doc=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'大回执合成文档'+index,body:full,related_ids:[],source_url:null});assert.equal(doc.status,200);ids.push(doc.value.id);
  }
  if(oversized)assert.ok(bodies.reduce((bytes,body)=>bytes+Buffer.byteLength(body),0)>profile.payload_bytes_limit);
  const cid=await h.create();run=await h.capture(cid,'继续调查合成长文');await h.pauseWorker();
  const manager=SessionManager.inMemory('/synthetic/data-agent');const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  for(let index=0;index<24;index++){
    manager.appendMessage({role:'user',content:'合成旧资料'.repeat(140),timestamp:Date.now()});
    manager.appendMessage({role:'assistant',content:[{type:'text',text:'已记录。'}],api:'openai-completions',provider:'controlled_deepseek',model:'deepseek-flash',stopReason:'stop',usage,timestamp:Date.now()});
  }
  run.checkpoint=exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
  let checkpoint;
  if(oversized){
    let failure;try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}catch(error){failure=error;}
    assert.ok(failure);assert.equal(failure.message,'model_run_failed');assert.equal(failure.code,'request_too_large: model_input_limit');checkpoint=failure.checkpoint;
  }else{
    await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');
    checkpoint=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
  }
  h.releaseRun(run.run_id);
  const entries=restoreCheckpoint('/synthetic/data-agent',checkpoint).getBranch();
  assert.ok(summaries>=1&&summaries<=2);assert.equal(entries.filter(e=>e.type==='compaction').length,1);
  assert.equal(entries.filter(e=>e.type==='message'&&e.message.errorMessage==='request_too_large: model_input_limit').length,oversized?2:1);
  const projected=restoreCheckpoint('/synthetic/data-agent',checkpoint).buildSessionContext().messages;
  verifyResults(projected.filter(m=>m.role==='toolResult').map(m=>({id:m.toolCallId,text:m.content.find(c=>c.type==='text').text})),projected.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall')));
  assert.ok(payloadBytes.some(bytes=>bytes>65536));assert.equal(step,oversized?1:2);
  const tools=h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'state',state,'operation',operation_id,'origin',origin_run_id,'chain',recovery_chain_id) FROM tool_calls WHERE conversation_id='${cid}'`);
  assert.equal(tools.length,ids.length+1);assert.deepEqual(tools.map(tool=>tool.sdk).sort(),sdkIds().sort());assert.equal(new Set(tools.map(tool=>tool.operation)).size,ids.length+1);
  assert.ok(tools.every(tool=>tool.state==='succeeded'&&tool.origin===run.run_id&&tool.chain===run.recovery_chain_id));
  const snapshot=await h.snapshot(cid);assert.equal(snapshot.tasks.length,1);
  if(oversized){assert.notEqual(snapshot.tasks[0].phase,'answered');assert.equal(snapshot.messages.filter(m=>m.role==='assistant'&&m.committed).length,0);assert.equal(snapshot.runs.filter(r=>r.state==='finished').length,0);}
  else assert.equal(snapshot.tasks[0].phase,'answered');
  const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
  assert.equal(ledger.calls,payloadBytes.length);assert.equal(ledger.calls,step+summaries);assert.equal(ledger.reserved,0);
  const attempts=h.sql(`SELECT JSON_OBJECT('id',a.id,'scope',a.budget_scope_id,'run',a.run_id,'state',a.state,'chain',r.recovery_chain_id) FROM model_call_attempts a JOIN agent_runs r ON a.run_id=r.id WHERE a.budget_scope_id='${run.budget_scope_id}'`);
  assert.equal(attempts.length,payloadBytes.length);assert.equal(new Set(attempts.map(a=>a.id)).size,payloadBytes.length);
  assert.ok(attempts.every(a=>a.run===run.run_id&&a.scope===run.budget_scope_id&&a.chain===run.recovery_chain_id&&a.state==='settled'));
  checks.push({name:oversized?'六份8192字正文原生压缩后仍超128KiB：有限失败、0正式答复、完整工具组与原身份保留、超限请求未发送':'两份8192字正文真实溢出后原生压缩续答：逐字正文及SDK配对完整、一次续答、原操作不重复',payloadBytes,summaries,calls:ledger.calls,settledAttempts:attempts.length});
}finally{
  for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await h.close();await new Promise(resolve=>provider.close(resolve));
}
}
console.log(JSON.stringify({passed:true,checks,officialRequests:0}));
