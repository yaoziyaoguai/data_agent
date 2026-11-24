import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

const h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'0.1',DATA_AGENT_TOOL_CONTRACT_VERSION:'1'}});
const manager=SessionManager.inMemory('/synthetic/data-agent');
const evidence={passed:false,officialRequests:0,samples:[],requests:[]};
let run,query,held,heldExit,lockOutput='',lockError='',proxyFailure;
const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const tool=async(name,args)=>{
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:checkpoint()};
  ok(await h.internal('/internal/data/tool-calls',input));return ok(await h.internal('/internal/data/tools',input)).data;
};
const finish=async()=>{
  const body={run_id:run.run_id,lease_epoch:run.lease_epoch},text='合成查询控制已完成。';
  ok(await h.internal('/internal/outputs',{...body,chunk_seq:'1',text}));
  ok(await h.internal('/internal/finish',{...body,commit_id:run.output_id,final_text:text,checkpoint:checkpoint()}));h.releaseRun(run.run_id);
};
const state=()=>h.sql(`SELECT JSON_OBJECT('id',id,'owner',lease_owner,'epoch',CAST(lease_epoch AS CHAR),'until_ms',UNIX_TIMESTAMP(lease_until)*1000,'now_ms',UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000,'state',execution_state,'attempts',submission_attempts,'error',error_code,'budget',budget_scope_id,'operation',operation_id,'confirmation',confirmation_key,'message',confirmation_message_id) FROM query_requests WHERE id='${query.id}'`)[0];
const platformUrl=h.env.DATA_AGENT_PLATFORM_URL;
// 透明转发原平台，只记录实际请求；不靠平台幂等去重后的账本计数。
const queryProxy=createServer(async(request,response)=>{
  try{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=Buffer.concat(chunks),payload=JSON.parse(body.toString('utf8'));
    if(payload.query_id===query?.id){
      const entry={path:request.url,query_id:payload.query_id,owner_id:payload.owner_id};
      if(request.url==='/submit')entry.claim=state();
      evidence.requests.push(entry);
    }
    const upstream=await fetch(platformUrl+request.url,{method:request.method,headers:{authorization:request.headers.authorization,'content-type':request.headers['content-type']},body,signal:AbortSignal.timeout(5000)});
    const bytes=Buffer.from(await upstream.arrayBuffer());response.writeHead(upstream.status,Object.fromEntries(upstream.headers));response.end(bytes);
  }catch(error){proxyFailure??=error;response.destroy();}
});
try{
  const cid=await h.create();await h.resumeWorker();run=await h.capture(cid,'明确执行这个独立合成查询，慢准备仍沿原授权。');await h.pauseWorker();
  const original=run;
  // 任务须显式声明来源范围（null为不限），草稿登记才视作范围已知。
  const task=await tool('update_analysis_task',{action:'create',goal:'慢准备后仍只提交一次',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null},options:[]});
  query=await tool('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT 17 AS sample_value',parameters:{},target_id:'synthetic-sqlite',summary:'合成慢准备查询',knowledge_refs:[],replaces_query_id:null});
  await tool('execute_query',{query_id:query.id,draft_version:query.draft_version,condition_version:query.condition_version,instruction_quote:run.text});
  await finish();evidence.authorized=state();
  assert.equal(evidence.authorized.state,'queued');assert.equal(evidence.authorized.message,original.message_id);assert.equal(evidence.authorized.budget,original.budget_scope_id);
  const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();
  assert.match(container,/^[a-f0-9]+$/);
  held=spawn('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--unbuffered','--skip-column-names'],{stdio:['pipe','pipe','pipe']});
  heldExit=new Promise(resolve=>held.once('close',(code,signal)=>resolve({code,signal})));
  held.stdout.on('data',chunk=>{lockOutput+=chunk;});held.stderr.on('data',chunk=>{lockError+=chunk;});
  const database=new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
  assert.match(database,/^data_agent_test_[a-f0-9]+$/);
  held.stdin.write(`USE ${database}; START TRANSACTION; SELECT id FROM conversations WHERE id='${cid}' FOR UPDATE; SELECT 'conversation_locked';\n`);
  await until(()=>{if(held.exitCode!==null)throw new Error('lock connection exited: '+lockError);return lockOutput.includes('conversation_locked');},'仅锁本次合成会话行');
  await new Promise((resolve,reject)=>{queryProxy.once('error',reject);queryProxy.listen(0,'127.0.0.1',resolve);});
  h.env.DATA_AGENT_PLATFORM_URL='http://127.0.0.1:'+queryProxy.address().port;await h.resumeWorker();
  const claimed=await until(()=>{const value=state();return value.owner?value:false;},'查询已领取',120000);evidence.claimed=claimed;
  assert.notEqual(claimed.owner,'alice','查询租约owner是Worker身份');assert.equal(claimed.state,'queued');
  let current=claimed;
  while(current.now_ms<=claimed.until_ms+1500){
    await new Promise(resolve=>setTimeout(resolve,750));current=state();evidence.samples.push(current);
    assert.equal(current.owner,claimed.owner);assert.equal(current.epoch,claimed.epoch);assert.equal(current.state,'queued');
    assert.equal(evidence.requests.filter(value=>value.path==='/submit').length,0,'会话锁阻塞准备时零submit');
  }
  assert.ok(current.until_ms>claimed.until_ms,'越过原15秒到期后，同领取必须已经续租');
  assert.ok(current.until_ms>current.now_ms,'被阻塞的准备仍持有效租约');
  assert.equal(current.attempts,0,'准备续租不增加提交次数');
  held.stdin.end('ROLLBACK;\n');assert.deepEqual(await heldExit,{code:0,signal:null});held=undefined;
  await until(()=>{if(proxyFailure)throw proxyFailure;return state().state==='succeeded';},'释放会话锁后原查询完成',120000);
  run=await until(()=>h.captured.find(value=>value.conversation_id===cid&&value.workspace_context.result_notification?.query_id===query.id),'原预算结果通知',120000);await h.pauseWorker();
  const submits=evidence.requests.filter(value=>value.path==='/submit');assert.equal(submits.length,1,'释放后实际平台submit恰好一次');
  assert.equal(submits[0].claim.owner,claimed.owner);assert.equal(submits[0].claim.epoch,claimed.epoch,'首次提交承接原领取；后续正常lookup允许换代');
  assert.ok(submits[0].claim.until_ms>submits[0].claim.now_ms);
  evidence.completed=state();assert.equal(evidence.completed.attempts,1);assert.equal(evidence.completed.id,evidence.authorized.id);
  for(const key of ['budget','operation','confirmation','message'])assert.equal(evidence.completed[key],evidence.authorized[key]);
  assert.equal(run.budget_scope_id,original.budget_scope_id);
  const results=ok(await h.request(`/queries/${query.id}/results`));assert.deepEqual(results.rows,[['17']]);
  evidence.result={query_id:results.query_id,rows:results.rows};await finish();assert.ifError(proxyFailure);
  // 沿同一隔离MySQL fixture调用M07公开操作，验证续租WHERE及事务末尾失效回滚。
  h.sql("CREATE TRIGGER delay_query_submission BEFORE UPDATE ON query_requests FOR EACH ROW DO SLEEP(IF(OLD.summary='synthetic_slow_handoff' AND OLD.execution_state='queued' AND NEW.execution_state='submitting',2,0))");
  let storageOutput='';
  const storage=await new Promise((resolve,reject)=>{
    const child=spawn(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--test','query_preparation_lease','--','--ignored','--test-threads=1','--nocapture'],{env:h.env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{storageOutput+=chunk;});child.stderr.on('data',chunk=>{storageOutput+=chunk;});
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  h.sql('DROP TRIGGER delay_query_submission');
  await writeFile('.local/checks/query-preparation-lease-storage.log',storageOutput+'\nEXIT='+storage.code+'\n');
  evidence.storage=storage;assert.equal(storage.code,0,storageOutput);assert.equal(storage.signal,null);
  assert.match(storageOutput,/test result: ok\. 1 passed; 0 failed/);
  evidence.passed=true;console.log(JSON.stringify({passed:true,officialRequests:0,samples:evidence.samples.length,actualSubmits:submits.length,storage}));
}finally{
  try{
    if(held){held.stdin.end('ROLLBACK;\n');evidence.lockExit=await heldExit;}
    evidence.lockError=lockError;await writeFile('.local/checks/query-preparation-lease.json',JSON.stringify(evidence,null,2)+'\n');
  }finally{
    await h.close();
    if(queryProxy.listening){const closed=new Promise((resolve,reject)=>queryProxy.close(error=>error?reject(error):resolve()));queryProxy.closeAllConnections();await closed;}
  }
}
