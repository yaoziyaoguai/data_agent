import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

const directory='.local/checks/background-query-state';await mkdir(directory,{recursive:true});
const h=await harness({capture:true,env:{DATA_AGENT_QUERY_DELAY_SECONDS:'3600',DATA_AGENT_LEASE_MS:'120000'}});
const manager=SessionManager.inMemory('/synthetic/data-agent');
const checks=[];let passed=false,observations={};
try {
  const cid=await h.create(),run=await h.capture(cid,'检查多个后台查询与分别停止');
  await h.pauseWorker();
  const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
  const invoke=async(name,args,sdk=randomUUID())=>{
    const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:name,arguments:args,checkpoint:checkpoint()};
    assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
    const response=await h.internal('/internal/data/tools',input);assert.equal(response.status,200,JSON.stringify(response.value));
    return response.value.data;
  };
  const task=await invoke('update_analysis_task',{action:'create',task_id:null,expected_version:null,goal:'后台查询边界',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},question:null,options:[]});
  const draft=async(value)=>invoke('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT :value AS value',parameters:{value},target_id:'synthetic-sqlite',replaces_query_id:null,summary:'后台查询 '+value,knowledge_refs:[]});
  const personal=await draft(0),cancelSdk=randomUUID();
  await invoke('cancel_query',{query_id:personal.id},cancelSdk);
  await invoke('cancel_query',{query_id:personal.id},cancelSdk);
  const queued=await draft(1),parallel=[];
  for(let n=2;n<6;n++)parallel.push(await draft(n));
  await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text:'已保存各项查询。'});
  assert.equal((await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:'已保存各项查询。',checkpoint:checkpoint()})).status,200);
  h.releaseRun(run.run_id);
  const confirm=async q=>assert.equal((await h.request('/queries/'+q.id+'/confirm',{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version})).status,200);
  await confirm(queued);
  for(let n=0;n<2;n++)assert.equal((await h.request('/queries/'+queued.id+'/cancel',{operation_id:randomUUID()})).status,200);
  const cancelled=(await h.request('/queries/'+queued.id)).value;
  assert.equal(cancelled.execution_state,'cancelled');
  const notifications=(await h.snapshot(cid)).events.filter(e=>e.type==='query_result');
  observations.localCancellation={draftNotifications:notifications.filter(e=>e.payload.query_id===personal.id).length,queuedNotifications:notifications.filter(e=>e.payload.query_id===queued.id).length};
  for(const q of parallel)await confirm(q);
  await h.resumeWorker();
  let concurrent=false;
  try {
    await until(async()=>{
      const values=(await h.request('/conversations/'+cid+'/queries')).value.queries;
      observations.parallel=parallel.map(q=>({id:q.id,state:values.find(v=>v.id===q.id).execution_state}));
      return observations.parallel.every(q=>q.state==='running');
    },'四项慢查询均被提交而非较新查询饥饿',10000);
    concurrent=true;
  } catch(error) {observations.fairnessError=error.message;}
  await h.pauseWorker();
  assert.equal(observations.localCancellation.draftNotifications,1,'Pi取消未提交草稿产生一次通知');
  assert.equal(observations.localCancellation.queuedNotifications,1,'HTTP重复取消排队查询仅产生一次通知');
  checks.push('未提交和排队查询经Pi工具/HTTP取消都记录唯一终态通知，重放不重复');
  assert.equal(concurrent,true,'四项长查询必须都得到执行机会');
  checks.push('四项查询在同一会话同时运行，后提交查询不因较早查询反复轮询而饥饿');
  assert.equal((await h.request('/queries/'+queued.id+'/cancel',{operation_id:randomUUID()},'bob')).status,404);
  assert.equal((await h.request('/queries/'+queued.id+'/results')).status,409);
  // 本地取消没有被重新提交；同一平台请求身份不会因Worker重启增加。
  for(const q of [personal,queued]) {
    const lookup=await fetch(h.env.DATA_AGENT_PLATFORM_URL+'/lookup',{method:'POST',headers:{authorization:'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({query_id:q.id,owner_id:'alice'})});
    assert.equal(lookup.status,409);
  }
  await h.resumeWorker();
  for(const q of parallel)assert.equal((await h.request('/queries/'+q.id+'/cancel',{operation_id:randomUUID()})).status,200);
  await until(async()=>(await h.request('/conversations/'+cid+'/queries')).value.queries.every(q=>q.execution_state==='cancelled'),'所有目标分别取消');
  await h.pauseWorker();
  const events=(await h.snapshot(cid)).events.filter(e=>e.type==='query_result');
  assert.equal(events.length,6);assert.equal(new Set(events.map(e=>e.payload.query_id)).size,6);
  assert.equal((await h.snapshot(cid)).tasks.find(t=>t.id===task.task_id).phase,'investigating');
  checks.push('取消不提交本地查询、不泄露其他用户数据；全部目标单独收尾，任务释放等待状态');
  passed=true;
} finally {
  await writeFile(directory+'/report.json',JSON.stringify({passed,checks,observations,officialRequests:0},null,2));
  await h.close();console.log(JSON.stringify({passed,checks,observations,officialRequests:0}));
}
