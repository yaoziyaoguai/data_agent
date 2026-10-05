import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { exportCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { harness, until } from './harness.mjs';

const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:40,trial_cost_micros:'1000000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
const h = await harness({capture:true,profile,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'0'}});
const manager = SessionManager.inMemory('/synthetic/data-agent');
const checks = [];
let run, passed = false, platformFixture, releaseValidation, lockHolder;
const conditions = {time_start:'2026-01-01T00:00:00Z',time_end:'2026-02-01T00:00:00Z',timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
const checkpoint = () => exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const invoke = async (tool_name,args) => {
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name,arguments:args,checkpoint:checkpoint()};
  const registered=await h.internal('/internal/data/tool-calls',input);
  assert.equal(registered.status,200,JSON.stringify(registered.value));
  return h.internal('/internal/data/tools',input);
};
const ok = async (name,args) => {const r=await invoke(name,args);assert.equal(r.status,200,JSON.stringify(r.value));return r.value.data;};
const update = extra => {const args={action:'create',task_id:null,expected_version:null,goal:'可靠性查询',conditions,question:null,options:[],...extra};if(args.action==='route')delete args.conditions;return ok('update_analysis_task',args);};
const draft = (task,sql,replaces_query_id=null,knowledge_refs=[]) => ok('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql,parameters:{},target_id:'synthetic-sqlite',replaces_query_id,summary:'合成验证',knowledge_refs});
const finish = async () => {
  await update({action:'route'});
  assert.equal((await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text:'合成验证已记录'})).status,200);
  assert.equal((await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:'合成验证已记录',checkpoint:checkpoint()})).status,200);
  h.releaseRun(run.run_id);
};
const start = async cid => {await h.resumeWorker();run=await h.capture(cid,'继续合成可靠性验证');await h.pauseWorker();};
const confirm = q => h.request('/queries/'+q.id+'/confirm',{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version});
const read = async q => (await h.request('/queries/'+q.id)).value;
const withdrawResults = async cid => {
  for (const m of h.sql(`SELECT JSON_OBJECT('id',id) FROM conversation_messages WHERE conversation_id='${cid}' AND client_key LIKE 'server:query-result:%' AND disposition='pending'`)) {
    assert.equal((await h.request(`/conversations/${cid}/messages/${m.id}/withdraw`,{operation_id:randomUUID()})).status,200);
    for(const r of h.captured.filter(v=>v.message_id===m.id))h.releaseRun(r.run_id);
  }
};
const holdConversation=async cid=>{
  const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();
  assert.match(container,/^[a-f0-9]+$/);
  const database=new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);assert.match(database,/^data_agent_test_[a-f0-9]+$/);
  lockHolder=spawn('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--unbuffered','--skip-column-names'],{stdio:['pipe','pipe','pipe']});
  let output='';lockHolder.stdout.on('data',chunk=>output+=chunk);
  lockHolder.stdin.write(`USE ${database};\nSTART TRANSACTION;\nSELECT id FROM conversations WHERE id='${cid}' FOR UPDATE;\nSELECT 'held';\n`);
  await until(()=>output.includes('held'),'MySQL会话锁已持有');
  return ()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(DISTINCT w.REQUESTING_THREAD_ID)) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA='${database}' AND l.OBJECT_NAME='conversations'`)[0].n;
};
const releaseConversation=async()=>{
  const child=lockHolder;lockHolder=undefined;const closed=new Promise(r=>child.once('exit',r));child.stdin.end('COMMIT;\n');assert.equal(await closed,0);
};
try {
  const cid=await h.create();await start(cid);
  const task=await update({});
  const wrongRoute={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'update_analysis_task',arguments:{action:'route',task_id:task.task_id,expected_version:task.condition_version,goal:'',question:null,options:[],condition_patch:{set:{channel:'app'},unset:[]}},checkpoint:checkpoint()};
  const refusedRoute=await h.internal('/internal/data/tool-calls',wrongRoute);
  assert.equal(refusedRoute.status,400);assert.equal(refusedRoute.value.code,'invalid_input');
  const wrongFullRoute={...wrongRoute,sdk_tool_call_id:randomUUID(),arguments:{...wrongRoute.arguments,condition_patch:undefined,conditions:{...conditions,channel:'app'}}};
  const refusedFullRoute=await h.internal('/internal/data/tool-calls',wrongFullRoute);
  assert.equal(refusedFullRoute.status,400);assert.equal(refusedFullRoute.value.code,'invalid_input');
  const unchanged=h.sql(`SELECT JSON_OBJECT('version',t.condition_version,'conditions',c.body) FROM analysis_tasks t JOIN condition_revisions c ON c.task_id=t.id AND c.version=t.condition_version WHERE t.id='${task.task_id}'`)[0];
  assert.equal(String(unchanged.version),task.condition_version);assert.equal(unchanged.conditions.channel,null);
  checks.push({id:'IA01',name:'route不能吞掉条件补丁；错误请求被拒绝且任务版本与渠道保持原值',passed:true});
  const old=await draft(task,'SELECT 1 AS amount');
  const independent=await draft(task,'SELECT 9 AS other_amount');
  const guardCandidate=await draft(task,'SELECT 8 AS other_amount');
  await update({action:'route',task_id:task.task_id,expected_version:task.condition_version,replaces_query_id:old.id});
  assert.equal((await read(old)).confirmation_state,'superseded');
  assert.equal((await confirm(old)).value.code,'version_conflict');
  assert.equal((await read(independent)).confirmation_state,'awaiting_confirmation');
  const revised=await draft(task,'SELECT 2 AS amount',old.id);
  assert.equal(revised.condition_version,old.condition_version);
  assert.equal((await read(old)).confirmation_state,'superseded');
  assert.equal((await read(independent)).confirmation_state,'awaiting_confirmation');
  const stale=await invoke('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT 3',parameters:{},target_id:'synthetic-sqlite',replaces_query_id:old.id,summary:'重复祖先修订',knowledge_refs:[]});
  assert.equal(stale.value.code,'version_conflict');
  const bad=await draft(task,'SELECT FROM',revised.id);
  assert.equal(bad.check_state,'rejected');assert.ok(bad.error_details.message);
  assert.equal((await read(revised)).confirmation_state,'superseded');
  await finish();
  assert.equal((await confirm(old)).value.code,'version_conflict');
  assert.equal((await confirm(revised)).value.code,'version_conflict');
  assert.equal((await confirm(independent)).status,200);
  await h.resumeWorker();await until(async()=>(await read(independent)).execution_state==='succeeded','独立查询收尾');await h.pauseWorker();await withdrawResults(cid);
  checks.push({id:'IA01',name:'同条件修订和失败修订均拒绝旧稿；多个独立查询仍可确认，不能修订已有后继的祖先',passed:true});

  await start(cid);await update({action:'route'});
  const replayAncestor=await draft(task,'SELECT 31 AS replay_original');
  const replayInput={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'request_query',arguments:{task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT 32 AS replay_revision',parameters:{},target_id:'synthetic-sqlite',replaces_query_id:replayAncestor.id,summary:'相同修订并发重传',knowledge_refs:[]},checkpoint:checkpoint()};
  assert.equal((await h.internal('/internal/data/tool-calls',replayInput)).status,200);
  assert.equal((await h.internal('/internal/data/tool-rejections',replayInput)).value.code,'not_available');
  const concurrentRevisions=await Promise.all(Array.from({length:process.argv.includes('--revision-interleaving-probe')?1:24},()=>h.internal('/internal/data/tools',replayInput)));
  assert.ok(concurrentRevisions.every(r=>r.status===200),JSON.stringify(concurrentRevisions.filter(r=>r.status!==200)));
  for(const receipt of concurrentRevisions)assert.deepEqual(receipt.value,concurrentRevisions[0].value);
  assert.equal((await h.internal('/internal/data/tool-rejections',replayInput)).value.code,'not_available');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE replaces_query_id='${replayAncestor.id}'`)[0].n,1);
  await finish();
  checks.push({id:'IA01',name:`${concurrentRevisions.length}个相同SQL修订调用均接回原回执，仅保存一个后继草稿`,passed:true});

  await start(cid);await update({action:'route'});
  const interleavedAncestor=await draft(task,'SELECT 33 AS interleaved_original');
  const interleavedInput={...replayInput,run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),arguments:{...replayInput.arguments,sql:'SELECT 34 AS interleaved_revision',replaces_query_id:interleavedAncestor.id},checkpoint:checkpoint()};
  assert.equal((await h.internal('/internal/data/tool-calls',interleavedInput)).status,200);
  await h.pausePlatform();let validationCount=0,arrivedAtValidation;
  const validationArrived=new Promise(r=>arrivedAtValidation=r),validationHeld=new Promise(r=>releaseValidation=r);
  platformFixture=createServer(async(req,res)=>{for await(const _part of req){};validationCount++;arrivedAtValidation();await validationHeld;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({state:'passed',target_id:'synthetic-sqlite',target_version:'1',dialect:'SQLite',read_only:true}));});
  await new Promise(r=>platformFixture.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',r));
  const firstRevision=h.internal('/internal/data/tools',interleavedInput);await validationArrived;
  const waitingLocks=await holdConversation(cid);
  const retransmittedRevision=h.internal('/internal/data/tools',interleavedInput);
  await until(()=>waitingLocks()===1,'B首次回执事务先排队');
  releaseValidation();await until(()=>waitingLocks()===2,'A保存事务随后排队');
  // InnoDB锁队列使B先读空回执，再由已排队A保存，B第二事务才取得锁。
  await releaseConversation();
  const [firstReceipt,retransmittedReceipt]=await Promise.all([firstRevision,retransmittedRevision]);
  assert.equal(firstReceipt.status,200);assert.equal(retransmittedReceipt.status,200,JSON.stringify(retransmittedReceipt.value));assert.deepEqual(retransmittedReceipt.value,firstReceipt.value);
  assert.equal(validationCount,1,'B在第二事务接回回执，不再请求平台检查');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE replaces_query_id='${interleavedAncestor.id}'`)[0].n,1);
  await finish();await new Promise(r=>platformFixture.close(r));platformFixture=undefined;await h.resumePlatform();
  checks.push({id:'IA01',name:'MySQL锁队列固定B首次空回执、A提交后继、B第二事务的交错，重传同回执且只一次平台检查',passed:true});

  await start(cid);
  await h.pausePlatform();
  let arrived;
  const reached=new Promise(r=>arrived=r), held=new Promise(r=>releaseValidation=r);
  platformFixture=createServer(async(req,res)=>{for await(const _part of req){};arrived();await held;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({state:'passed',target_id:'synthetic-sqlite',target_version:'1',dialect:'SQLite',read_only:true}));});
  await new Promise(r=>platformFixture.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',r));
  const revision=draft(task,'SELECT 10 AS other_amount',guardCandidate.id);
  await reached;
  assert.equal((await confirm(guardCandidate)).value.code,'version_conflict');
  releaseValidation();const guarded=await revision;await finish();
  await new Promise(r=>platformFixture.close(r));platformFixture=undefined;await h.resumePlatform();
  assert.equal((await confirm(guarded)).status,200);
  await h.resumeWorker();await until(async()=>(await read(guarded)).execution_state==='succeeded','原已确认查询收尾');await h.pauseWorker();await withdrawResults(cid);
  checks.push({id:'IA01',name:'新消息直接修订在外部校验等待期间已失效旧稿，不存在校验前可执行窗口',passed:true});

  await start(cid);await update({action:'route'});
  const next=await draft(task,'SELECT 11 AS other_amount',guarded.id);
  const overflow=await draft(task,'SELECT ABS(-9223372036854775808) AS amount');
  const interruptedFailure=await draft(task,'SELECT ABS(-9223372036854775808) AS amount');
  const timeout=await draft(task,'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT SUM(x) FROM n');
  const outOfRange=await ok('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT :v AS n',parameters:{v:'9223372036854775808'},target_id:'synthetic-sqlite',replaces_query_id:null,summary:'字符串参数保持字符串',knowledge_refs:[]});
  assert.equal(outOfRange.check_state,'passed');
  const overflowingInteger=JSON.parse('{"v":9223372036854775808}');
  const invalidParameter=await ok('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT :v AS n',parameters:overflowingInteger,target_id:'synthetic-sqlite',replaces_query_id:null,summary:'绑定整数越界',knowledge_refs:[]});
  assert.equal(invalidParameter.check_state,'rejected');assert.equal(invalidParameter.error_details.code,'parameter_out_of_range');
  await finish();
  assert.equal((await read(guarded)).confirmation_state,'confirmed');
  assert.equal((await read(next)).execution_state,'not_submitted');
  assert.equal((await confirm(interruptedFailure)).status,200);
  const platformCall=async(path,body)=>{const r=await fetch(h.env.DATA_AGENT_PLATFORM_URL+path,{method:'POST',headers:{authorization:'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const platformPacket={query_id:interruptedFailure.id,owner_id:'alice',sql:interruptedFailure.sql,parameters:{},target_id:'synthetic-sqlite',target_version:'1'};
  await platformCall('/submit',platformPacket);
  assert.equal((await platformCall('/lookup',{query_id:interruptedFailure.id,owner_id:'alice'})).state,'failed');
  // 平台已失败，模拟Worker在保存观察前退出；取消查证应保留失败诊断。
  h.sql(`UPDATE query_requests SET execution_state='submission_unknown',submission_attempts=1 WHERE id='${interruptedFailure.id}'`);
  assert.equal((await h.request('/queries/'+interruptedFailure.id+'/cancel',{operation_id:randomUUID()})).status,200);
  await confirm(overflow);await confirm(timeout);await h.resumeWorker();
  await until(async()=>(await read(timeout)).execution_state==='failed'&&(await read(overflow)).execution_state==='failed'&&(await read(interruptedFailure)).execution_state==='failed'&&(await read(guarded)).execution_state==='succeeded','平台诊断与原查询收尾',30000);
  await h.pauseWorker();
  assert.equal((await read(guarded)).execution_state,'succeeded');
  assert.match((await read(overflow)).error_details.message,/overflow/);
  assert.match((await read(interruptedFailure)).error_details.message,/overflow/);
  assert.equal((await read(timeout)).error_details.code,'query_timeout');
  await withdrawResults(cid);
  checks.push({id:'IA07',name:'语法、执行溢出及超时诊断贯穿平台与API；已确认原查询独立收尾，新修订等待确认',passed:true});

  const created=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'人工业务说明',body:'合成口径正文',related_ids:['table-demo_order_detail'],source_url:'https://example.org/synthetic'});
  assert.equal(created.status,200);const doc=created.value;
  const clear={operation_id:randomUUID(),expected_version:doc.version,entry_id:'body',value:'',clear_override:true};
  const cleared=await h.request('/knowledge/'+doc.id,clear,'alice','PATCH');
  assert.equal(cleared.status,200);assert.equal(cleared.value.entries[0].effective_value,'');
  assert.equal((await h.request('/knowledge/'+doc.id)).status,200);
  assert.equal((await h.request('/knowledge')).status,200);
  assert.equal((await h.request('/knowledge/'+doc.id+'?version=1')).value.entries[0].effective_value,'合成口径正文');
  const edit={...clear,operation_id:randomUUID(),expected_version:cleared.value.version,clear_override:false,value:'再次补充正文'};
  const edited=await h.request('/knowledge/'+doc.id,edit,'alice','PATCH');assert.equal(edited.status,200);
  const invalid=await h.request('/knowledge/'+doc.id,{...edit,operation_id:randomUUID(),expected_version:edited.value.version,value:null},'alice','PATCH');assert.equal(invalid.status,400);
  assert.equal((await h.request('/knowledge/'+doc.id)).value.version,edited.value.version);
  checks.push({id:'IA02',name:'人工文档清除后可读列表、可再编辑，历史正文保留；非法编辑不会提交版本',passed:true});

  await start(cid);await update({action:'route'});const reference=[{object_id:doc.id,version:edited.value.version,path:'body'}];
  const based=await draft(task,'SELECT 7 AS amount',null,reference);
  const terminal=await draft(task,'SELECT 17 AS old_terminal_amount',null,reference);await finish();
  assert.equal((await h.request('/queries/'+terminal.id+'/cancel',{operation_id:randomUUID()})).status,200);
  assert.equal((await h.request('/knowledge/'+doc.id+'/disable',{operation_id:randomUUID(),expected_version:edited.value.version})).status,200);
  await start(cid);
  const rejectedInput={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'get_query',arguments:{query_id:based.id},checkpoint:checkpoint()};
  assert.equal((await h.internal('/internal/data/tool-calls',rejectedInput)).status,200);
  const rejected=await h.internal('/internal/data/tools',rejectedInput);assert.ok(rejected.status>=400);assert.ok(!JSON.stringify(rejected.value).includes('SELECT 7'));
  const durableRejection=await h.internal('/internal/data/tool-rejections',rejectedInput);assert.equal(durableRejection.status,200);assert.equal(durableRejection.value.data.error,rejected.value.code);
  assert.equal((await h.internal('/internal/data/tool-rejections',{...rejectedInput,arguments:{query_id:terminal.id}})).value.code,'idempotency_conflict');
  for(const query of [based,terminal]){
    const cancellationInput={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'cancel_query',arguments:{query_id:query.id},checkpoint:checkpoint()};
    assert.equal((await h.internal('/internal/data/tool-calls',cancellationInput)).status,200);
    const cancelled=await h.internal('/internal/data/tools',cancellationInput);
    assert.equal(cancelled.status,200,'依据失效仍允许安全取消收尾');
    assert.deepEqual(Object.keys(cancelled.value.data).sort(),['cancel_state','condition_version','execution_state','id','task_id']);
    assert.equal(cancelled.value.data.id,query.id);
    assert.equal(cancelled.value.data.execution_state,'cancelled');
    assert.ok(!JSON.stringify(cancelled.value).includes(query.sql));
    assert.deepEqual((await h.internal('/internal/data/tools',cancellationInput)).value,cancelled.value);
    // 模拟升级前的旧持久取消回执；重传也不能带回旧SQL及失效口径。
    for(const error of [null,'sql_execution_failed']){
      const legacyReceipt={...cancelled.value,data:{...query,error}};
      h.sql(`UPDATE tool_calls SET receipt=CAST(CONVERT(UNHEX('${Buffer.from(JSON.stringify(legacyReceipt)).toString('hex')}') USING utf8mb4) AS JSON) WHERE operation_id='${cancelled.value.operation_id}'`);
      const replayed=await h.internal('/internal/data/tools',cancellationInput);
      assert.equal(replayed.status,200);assert.deepEqual(Object.keys(replayed.value.data).sort(),['cancel_state','condition_version','execution_state','id','task_id']);
      assert.ok(!JSON.stringify(replayed.value).includes(query.sql));
    }
  }
  await finish();
  checks.push({id:'IA03',name:'失效依据经get_query不能读回正文，cancel_query对待执行及终态都仅返回控制状态并允许收尾',passed:true});

  const asset=async name=>(await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'skill',name,body:'合成分析方法',scope:'订单分析',verified:false,source_text:'本人保存',dependencies:[]})).value;
  const a=await asset('分析方法A'),b=await asset('分析方法B'),other=await h.create();
  const selection={operation_id:randomUUID(),asset_id:a.id,version:a.version};
  const chosen=await h.request(`/conversations/${cid}/skill-selections`,selection);assert.equal(chosen.status,200);
  assert.deepEqual((await h.request(`/conversations/${cid}/skill-selections`,selection)).value,chosen.value);
  for(const [target,input]of [[cid,{...selection,asset_id:b.id,version:b.version}],[other,selection]])assert.equal((await h.request(`/conversations/${target}/skill-selections`,input)).value.code,'idempotency_conflict');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*),'asset',MAX(asset_id)) FROM skill_selections WHERE owner_id='alice' AND conversation_id='${cid}'`)[0].n,1);
  const simultaneous={...selection,operation_id:randomUUID()};
  const simultaneousResults=await Promise.all([h.request(`/conversations/${cid}/skill-selections`,simultaneous),h.request(`/conversations/${other}/skill-selections`,simultaneous)]);
  assert.deepEqual(simultaneousResults.map(r=>r.status).sort(),[200,409]);
  assert.equal(simultaneousResults.find(r=>r.status===409).value.code,'idempotency_conflict');
  const changed=await h.request('/assets',{operation_id:randomUUID(),id:a.id,expected_version:a.version,kind:'skill',name:a.name,body:'修订后的方法',scope:a.scope,verified:false,source_text:'本人修订',dependencies:[]});assert.equal(changed.status,200);
  assert.deepEqual((await h.request(`/conversations/${cid}/skill-selections`,selection)).value,chosen.value);
  await start(cid);assert.equal(run.workspace_context.selected_skills.length,0);await finish();
  checks.push({id:'IA09',name:'同操作同参返回原回执，跨资产/会话异参拒绝；重传旧回执不重新激活已改版Skill',passed:true});

  await h.pausePlatform();
  let submits=0,lookups=0,mode='reject';
  platformFixture=createServer(async(req,res)=>{
    for await(const _part of req){};
    assert.equal(req.headers.authorization,'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN);
    if(req.url==='/submit')submits++;if(req.url==='/lookup')lookups++;
    const code=req.url==='/submit'?(mode==='reject'?'sql_not_supported':'outcome_unknown'):'not_available';
    res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code}));
  });
  await new Promise(r=>platformFixture.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',r));
  assert.equal((await confirm(next)).status,200);await h.resumeWorker();
  await until(async()=>(await read(next)).execution_state==='failed','明确拒绝终态');await h.pauseWorker();
  assert.equal(submits,1);assert.equal(lookups,0);assert.equal((await read(next)).error,'sql_not_supported');await withdrawResults(cid);
  checks.push({id:'IA06',name:'平台检查后明确拒绝提交进入失败，只提交一次',passed:true});
  await new Promise(r=>platformFixture.close(r));platformFixture=undefined;await h.resumePlatform();
  await start(cid);await update({action:'route'});const missing=await draft(task,'SELECT 44');await finish();await h.pausePlatform();
  mode='unknown';submits=0;lookups=0;
  platformFixture=createServer(async(req,res)=>{for await(const _part of req){};if(req.url==='/submit')submits++;else lookups++;res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:req.url==='/submit'?'outcome_unknown':'not_available'}));});
  await new Promise(r=>platformFixture.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',r));
  await confirm(missing);await h.resumeWorker();await until(async()=>(await read(missing)).execution_state==='failed','未知查证有界',30000);await h.pauseWorker();
  assert.equal(submits,3);assert.equal(lookups,3);assert.equal((await read(missing)).error,'submission_retry_exhausted');await withdrawResults(cid);
  checks.push({id:'IA06',name:'真正未知先查证，连续确认缺失最多三次提交后失败',passed:true});

  const deleted=await h.create();await start(deleted);
  const binding={run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID(),parameters_fingerprint:'a'.repeat(64)};
  assert.equal((await h.internal('/internal/model/reserve',{...binding,input_tokens_upper:32768,output_tokens_max:2048})).status,200);
  assert.equal((await h.internal('/internal/model/send',binding)).value.send_allowed,true);
  assert.equal((await h.request('/conversations/'+deleted,{operation_id:randomUUID()},'alice','DELETE')).status,200);
  const final={...binding,usage:{input_tokens:300,output_tokens:40,elapsed_ms:100}};
  assert.equal((await h.internal('/internal/model/finalize',final)).value.state,'settled');
  assert.equal((await h.internal('/internal/model/finalize',final)).status,200);
  assert.equal((await h.internal('/internal/model/finalize',{...final,usage:{...final.usage,output_tokens:41}})).value.code,'idempotency_conflict');
  assert.ok((await h.internal('/internal/model/reserve',{...binding,call_attempt_id:randomUUID(),input_tokens_upper:32768,output_tokens_max:2048})).status>=400);
  assert.ok((await h.internal('/internal/model/send',binding)).status>=400);
  assert.equal(h.sql(`SELECT JSON_OBJECT('reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0].reserved,0);
  h.releaseRun(run.run_id);
  checks.push({id:'IA08',name:'会话删除后原调用可靠usage幂等结算释放预留；异参拒绝且不能新发请求',passed:true});
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  releaseValidation?.();
  if(lockHolder){lockHolder.stdin.end('ROLLBACK;\n');await new Promise(r=>lockHolder.once('exit',r));}
  if(platformFixture)await new Promise(r=>platformFixture.close(r));
  await writeFile('.local/checks/mvp-workflow-reliability.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
  await h.close();
}
