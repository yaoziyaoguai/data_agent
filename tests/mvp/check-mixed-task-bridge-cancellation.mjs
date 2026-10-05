import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness,until} from './harness.mjs';

let calls=0,continuationCalls=0,phase='original',active,cancelled,h,passed=false,providerDisconnected=false;
const checks=[];
const previous=Object.fromEntries(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST'].map(key=>[key,process.env[key]]));
const conditions={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
const provider=createServer(async(req,res)=>{
  try{
    let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;
    calls++;
    let action;
    if(phase==='original'){
      // 不用测试手动release或abort：只让正式Worker和Bridge处理取消。
      if(calls===3){res.on('close',()=>{providerDisconnected=true;});return;}
      action={name:'update_analysis_task',args:{action:'create',goal:calls===1?'金额解释':'时间解释',conditions,options:[]}};
    }else{
      continuationCalls++;
      assert.ok(raw.includes('input_task_ids')&&raw.includes(cancelled.id)&&raw.includes('cancelled'));
      action=continuationCalls===1?{name:'read_analysis_task',args:{task_id:active.id}}:
        continuationCalls===2?{name:'update_analysis_task',args:{action:'route',task_id:active.id,expected_version:active.condition_version,goal:'',options:[]}}:null;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    const delta=action?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]}:{role:'assistant',content:'金额目标已取消，剩余时间目标已沿原输入完成。'};
    res.write('data: '+JSON.stringify({id:'synthetic-cancel-bridge',choices:[{index:0,delta,finish_reason:action?'tool_calls':'stop'}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}})+'\n\n');
    res.end('data: [DONE]\n\n');
  }catch{
    res.writeHead(500,{'content-type':'application/json'});
    res.end('{"error":{"message":"synthetic-protocol-assertion-failed"}}');
  }
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
try{
 for(const delayed of [false,true]){
  calls=0;continuationCalls=0;phase='original';providerDisconnected=false;
  const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:20,trial_cost_micros:'300000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
  const deliveryDispatch=delayed?async(...args)=>{
    try{await deliver(...args);}catch(error){
      // 模型已中止，但Pi派生工作仍在收尾；Bridge继续持有原会话以复现409窗口。
      if(args[4].aborted)await new Promise(resolve=>setTimeout(resolve,2300));
      throw error;
    }
  }:undefined;
  h=await harness({profile,deliveryDispatch,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port,env:{DATA_AGENT_LEASE_MS:'1500'}});
  if(delayed){process.env.DEEPSEEK_API_KEY='synthetic-protocol-key';process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+provider.address().port;process.env.DATA_AGENT_PROVIDER_TEST='1';}
  const cid=await h.create();
  const message=await h.send(cid,'分别解释合成金额和时间，这是两个独立目标。');
  const snapshot=await until(async()=>{const s=await h.snapshot(cid);return s.tasks.length===2&&calls===3?s:false;},'正式桥中模型请求保持未完成');
  cancelled=snapshot.tasks.find(task=>task.goal==='金额解释');
  active=snapshot.tasks.find(task=>task.goal==='时间解释');
  assert.ok(cancelled&&active);
  const original=snapshot.runs.find(run=>run.state==='running');
  const identity=h.sql(`SELECT JSON_OBJECT('message_id',message_id,'chain',recovery_chain_id,'scope',budget_scope_id) FROM agent_runs WHERE id='${original.run_id}'`)[0];
  assert.equal(identity.message_id,message.message_id);
  if(delayed)h.sql(`UPDATE background_jobs SET attempts=3 WHERE message_id='${message.message_id}'`);
  phase='continuation';
  const started=performance.now();
  assert.equal((await h.request(`/conversations/${cid}/tasks/${cancelled.id}/cancel`,{operation_id:randomUUID(),expected_version:cancelled.condition_version})).status,200);
  const completed=await until(async()=>{
    const s=await h.snapshot(cid);
    assert.ok(!s.events.some(event=>event.type==='run_failed'),'取消不得耗尽剩余目标的交付');
    return s.runs.some(run=>run.state==='finished')?s:false;
  },'无需手动释放，Pi中止旧请求并续接剩余目标',12000);
  assert.equal(providerDisconnected,true,'旧provider请求须实际中止');
  assert.equal(completed.tasks.length,2);
  assert.equal(completed.tasks.find(task=>task.id===cancelled.id).lifecycle,'cancelled');
  assert.equal(completed.tasks.find(task=>task.id===active.id).phase,'answered');
  const runs=h.sql("SELECT JSON_OBJECT('message_id',message_id,'chain',recovery_chain_id,'scope',budget_scope_id,'state',state) FROM agent_runs");
  assert.equal(runs.filter(run=>run.state==='finished').length,1);
  assert.equal(runs.filter(run=>run.state==='cancelled').length,1);
  if(delayed)assert.ok(runs.some(run=>run.state==='interrupted'),'实际覆盖Bridge未接纳的409窗口');
  else assert.equal(runs.length,2,'旧运行失权后只创建一次合法续接');
  assert.ok(runs.every(run=>run.message_id===identity.message_id&&run.chain===identity.chain&&run.scope===identity.scope));
  assert.ok(runs.every(run=>['cancelled','finished','interrupted'].includes(run.state)));
  const attempts=h.sql("SELECT JSON_OBJECT('state',state,'scope',budget_scope_id) FROM model_call_attempts");
  assert.equal(attempts.length,6);assert.equal(calls,6);
  assert.equal(attempts.filter(attempt=>attempt.state==='unknown').length,1);
  assert.ok(attempts.every(attempt=>attempt.scope===identity.scope));
  assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE tool_name='update_analysis_task' AND state='succeeded'")[0].n,3);
  assert.equal(h.sql(`SELECT JSON_OBJECT('attempts',attempts) FROM background_jobs WHERE message_id='${message.message_id}'`)[0].attempts,delayed?3:1);
  checks.push({name:delayed?'Pi中止后延迟收尾，Bridge409仅退本次尝试，保留两次历史失败及原账本':'正式Worker/Bridge/Pi中止未返回模型请求，剩余目标自动续接，不手动release或abort',calls,continuationMs:Math.round(performance.now()-started),runs:runs.length,passed:true});
  await h.close();h=null;
 }
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{
  if(h)await h.close();
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await writeFile('.local/checks/mvp-mixed-task-bridge-cancellation.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}
