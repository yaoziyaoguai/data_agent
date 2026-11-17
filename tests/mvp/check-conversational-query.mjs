import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {taskProjection} from '../../apps/agent/session/task-projection.ts';
import {workspaceContext} from '../../apps/agent/session/workspace-context.ts';
import {harness, until} from './harness.mjs';
import {assetInput, select} from './skill-fixtures.mjs';

// 真实控制入口、MySQL与合成SQLite；主动构造工具输入验证宿主边界，语言意图另测。
const sourceAdmission = process.argv.includes('--source-admission');
const h = await harness({capture:true, env:{DATA_AGENT_LEASE_MS:'120000', DATA_AGENT_QUERY_DELAY_SECONDS:'0.1',
  DATA_AGENT_TOOL_CONTRACT_VERSION:sourceAdmission?'2':'1'}});
const manager = SessionManager.inMemory('/synthetic/data-agent');
const checks = [];
let run, passed = false, projection, sourceTools;
const traces = [];
const conditions = {time_start:'2026-01-01T00:00:00Z',time_end:'2026-02-01T00:00:00Z',timezone:'UTC',metric:'net_revenue',channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',...(sourceAdmission?{source_limits:null}:{})};
const checkpoint = () => exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const bindSourceTools = () => {
  assert.equal(run.tool_contract_version,2);
  manager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});
  const transport = new RustTransport(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN);
  const workspace = workspaceContext(run.workspace_context);
  projection = taskProjection(transport,manager,workspace.replace);
  sourceTools = dataTools(transport,manager,'',(receipt,sdk)=>{workspace.acceptReceipt(receipt);projection.acceptReceipt(receipt,sdk);});
};
const begin = async (cid,text) => {
  await h.resumeWorker();run = await h.capture(cid,text,120000);await h.pauseWorker();
  if(sourceAdmission)bindSourceTools();else assert.equal(run.tool_contract_version,1);
  return run;
};
const tool = async (name,args,expectedError,sdk=randomUUID()) => {
  if(sourceAdmission){
    manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name,arguments:args}],
      api:'openai-completions',provider:'synthetic',model:'source-admission',stopReason:'toolUse',timestamp:Date.now(),
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const receipt = await sourceTools.invokeRecorded(name,sdk,args);
    if(expectedError)assert.equal(receipt.data.error,expectedError,JSON.stringify(receipt));
    else assert.ok(!receipt.data.error,JSON.stringify(receipt));
    manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:name,
      ...await sourceTools.formatResult(name,args,receipt),timestamp:Date.now()});
    const refreshed = await projection.apply();
    traces.push({message:run.message_id,budget:run.budget_scope_id,sdk,receipt,refreshed,ready:run.workspace_context.source_context_ready});
    return {data:receipt.data,receipt,sdk};
  }
  const input = {run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:name,arguments:args,checkpoint:checkpoint()};
  const registered=await h.internal('/internal/data/tool-calls',input);assert.equal(registered.status,200,JSON.stringify(registered.value));
  const response = await h.internal('/internal/data/tools',input);
  if (expectedError) assert.equal(response.value.code,expectedError,JSON.stringify(response.value));
  else assert.equal(response.status,200,JSON.stringify(response.value));
  return {input,data:response.value.data};
};
const createTask = async () => (await tool('update_analysis_task',{action:'create',goal:'合成净收入查询',conditions,options:[]})).data;
const route = async task => tool('update_analysis_task',{action:'route',goal:'',task_id:task.task_id,expected_version:task.condition_version,options:[]});
const draft = async (task,sql='SELECT :start AS start_date',parameters={start:conditions.time_start},replaces=null) => (await tool('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql,parameters,target_id:'synthetic-sqlite',summary:'合成样例查询，参数为绝对日期',knowledge_refs:[],replaces_query_id:replaces})).data;
const executeArgs = q => ({query_id:q.id,draft_version:q.draft_version,condition_version:q.condition_version,instruction_quote:run.text});
const executeBatchArgs = queries => ({queries:queries.map(({id,draft_version,condition_version})=>({query_id:id,draft_version,condition_version})),instruction_quote:run.text});
const read = async q => (await h.request('/queries/'+q.id)).value;
const savedAuthorization = q => h.sql(`SELECT JSON_OBJECT('message',confirmation_message_id,'budget',budget_scope_id,'key',confirmation_key) FROM query_requests WHERE id='${q.id}'`)[0];
const messageRouting = () => h.sql(`SELECT JSON_OBJECT('routing',routing_state,'task',routed_task_id,'applied',applied_to_task,'relations',(SELECT COUNT(*) FROM conversation_message_tasks WHERE message_id=m.id)) FROM conversation_messages m WHERE id='${run.message_id}'`)[0];
const finish = async () => {
  const body = {run_id:run.run_id,lease_epoch:run.lease_epoch};
  assert.equal((await h.internal('/internal/outputs',{...body,chunk_seq:'1',text:'合成控制检查已完成。'})).status,200);
  const response = await h.internal('/internal/finish',{...body,commit_id:run.output_id,final_text:'合成控制检查已完成。',checkpoint:checkpoint()});
  assert.equal(response.status,200,JSON.stringify(response.value));h.releaseRun(run.run_id);
};
try {
  if(sourceAdmission){
    const preference=await h.request('/assets',assetInput({kind:'memory',name:'合成周报展示偏好',
      body:'本人的合成周报用秒展示耗时。',scope:'仅本人合成周报'}));
    assert.equal(preference.status,200,JSON.stringify(preference.value));
    const allowed=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',
      name:'合成统计定义',body:'本次统计采用用户明确给出的月份。',related_ids:[]});
    assert.equal(allowed.status,200,JSON.stringify(allowed.value));
    const scopedCid=await h.create();await begin(scopedCid,'只用合成统计定义，按一月出稿，不执行。');
    assert.equal(run.workspace_context.source_context_ready,false);
    assert.ok(!workspaceContext(run.workspace_context).contents().join('\n').includes(preference.value.body),
      '来源尚未就绪时Pi资源不把个人正文交给模型');
    const scoped=(await tool('update_analysis_task',{action:'create',goal:run.text,options:[],
      conditions:{...conditions,source_limits:{allowed_sources:[{kind:'document',id:allowed.value.id}],
        origin_message_ids:[run.message_id]}}})).data;
    assert.notEqual(scoped.context_complete,false,'用户明确日期不依赖未交付的个人记忆');
    const scopedQuery=await draft(scoped);
    assert.equal((await tool('get_query',{query_id:scopedQuery.id})).data.query.sql,scopedQuery.sql,
      '同范围保存的草稿可立即补读，不应夹带未交付记忆而自我拒绝');
    await finish();
    await begin(scopedCid,'只把统计月份改为二月，来源限制保持，不执行。');
    assert.equal(run.workspace_context.query_observations.find(query => query.id === scopedQuery.id).confirmation_state,
      'awaiting_confirmation', '草稿观察必须同时交付有效性，未提交不能代替可执行状态');
    const revised=(await tool('update_analysis_task',{action:'revise',task_id:scoped.task_id,
      expected_version:scoped.condition_version,options:[],condition_patch:{set:{
        time_start:'2026-02-01T00:00:00Z',time_end:'2026-03-01T00:00:00Z'},unset:[]}}));
    assert.deepEqual(revised.receipt.superseded_query_ids, [scopedQuery.id], '修订回执明确给出本次实际失效的旧稿');
    assert.equal((await read(scopedQuery)).confirmation_state, 'superseded');
    const continued=(await tool('read_analysis_task',{task_id:scoped.task_id})).data;
    assert.notEqual(continued.context_complete,false);
    assert.equal(continued.conditions.time_start,'2026-02-01T00:00:00Z');
    assert.deepEqual(continued.conditions.source_limits.allowed_sources,[{kind:'document',id:allowed.value.id}]);
    assert.equal(revised.data.condition_version,continued.condition_version);await finish();
    checks.push('v2归属前不交付或绑定个人预览；限制来源后日期和草稿可读，跨轮只改月份仍保留原来源');

    const historyCid=await h.create();await begin(historyCid,'先建立允许个人偏好的普通分析。');
    const historyTask=await createTask();
    const adopted=(await tool('read_knowledge',{items:[{kind:'memory',asset_ref:{
      id:preference.value.id,version:preference.value.version},part:'body'}]})).data;
    assert.ok(JSON.stringify(adopted).includes(preference.value.body),
      '来源确认且不受限时先真实读取个人记忆，建立有来源的旧历史');
    await tool('update_analysis_task',{action:'revise',task_id:historyTask.task_id,
      expected_version:historyTask.condition_version,options:[],condition_patch:{
        set:{notes:preference.value.body},unset:[]}});
    const derivedGoal='采用本人合成周报展示偏好核对结果';
    const derived=(await tool('update_analysis_task',{action:'create',goal:derivedGoal,
      conditions,options:[]})).data;
    const directory=(await tool('read_conversation',{after_seq:'0',task_directory:true})).data;
    const title=directory.tasks.find(task=>task.id===derived.task_id);
    assert.equal(title.goal,undefined,'控制目录仍隐藏带来源的派生标题');
    assert.doesNotMatch(title.note,/来源已失效/,'目录省略正文不能宣称真实来源已经失效');
    assert.equal((await tool('read_analysis_task',{task_id:derived.task_id})).data.goal,derivedGoal,
      '来源已就绪时，合法派生正文仍可通过正式任务读取获得');
    await finish();await begin(historyCid,'新建独立分析，只用合成统计定义，不采用之前的个人偏好。');
    const independent=(await tool('update_analysis_task',{action:'create',goal:'独立的合成统计分析',options:[],
      conditions:{...conditions,source_limits:{allowed_sources:[{kind:'document',id:allowed.value.id}],
        origin_message_ids:[run.message_id]}}})).data;
    assert.notEqual(independent.context_complete,false,
      '未归属阶段Pi隐藏的旧检查点正文也不能污染新任务条件');
    const independentDraft=await draft(independent);
    assert.equal((await tool('get_query',{query_id:independentDraft.id})).data.query.sql,independentDraft.sql);
    const oldTask=(await tool('read_analysis_task',{task_id:historyTask.task_id})).data;
    assert.ok(oldTask.unavailable_condition_fields.includes('notes'),
      '旧任务已实际采用的个人正文仍受来源限制，新任务修复不能清洗旧依赖');
    assert.equal(oldTask.conditions.notes,undefined);
    await finish();
    checks.push('已有个人记忆历史的会话新建受限任务：保留检查点授权，新目标和条件不继承未交付旧正文');

    const recoveryCid=await h.create();
    const selected=await h.request('/assets',assetInput({name:'合成计划核对方法',body:'先阅读配套清单，再核对分析计划。',
      files:[{path:'references/guide.md',content:'合成附件：核对统计对象与观察范围；不执行查询。'}]}));
    assert.equal(selected.status,200,JSON.stringify(selected.value));
    assert.equal((await select(h,recoveryCid,selected.value)).status,200);
    await begin(recoveryCid,'按已选方法及附件检查分析计划，先不执行查询。');
    assert.equal(run.workspace_context.source_context_blocker,'input_not_routed');
    assert.equal(run.workspace_context.asset_counts.selected_skills,1,'本条输入尚未归属不撤销明确选用');
    const {source_limits:_unrestricted,...undecidedConditions}=conditions;
    const undecided=await tool('update_analysis_task',{action:'create',goal:'合成计划核对',conditions:undecidedConditions,options:[]});
    assert.equal(undecided.receipt.source_context_ready,false);
    assert.equal(undecided.receipt.source_context_blocker,'source_scope_unknown');
    assert.equal(run.workspace_context.source_context_blocker,'source_scope_unknown','创建后原刷新不能丢失阻断原因');
    assert.equal(run.workspace_context.asset_counts.selected_skills,1,'创建后的刷新保留明确选用事实');
    assert.deepEqual(run.workspace_context.selected_skills,[],'保留选用数量不放开预览或正文');
    const unknownRoute=await route(undecided.data);
    assert.equal(unknownRoute.receipt.data.routed,true);
    assert.equal(unknownRoute.receipt.source_context_blocker,'source_scope_unknown');
    // 旧v2持久回执缺少新原因；实际恢复先经过Rust回源补齐，不能直接拿旧JSON冒充出站回执。
    const routeWhere=`operation_id='${unknownRoute.receipt.operation_id}'`;
    h.sql(`UPDATE tool_calls SET receipt=JSON_REMOVE(receipt,'$.source_context_blocker') WHERE ${routeWhere}`);
    const legacyRoute=h.sql(`SELECT receipt FROM tool_calls WHERE ${routeWhere}`)[0];
    assert.equal(legacyRoute.source_context_ready,false);
    assert.equal(legacyRoute.source_context_blocker,undefined);
    const replayedRoute=await tool('update_analysis_task',{action:'route',goal:'',task_id:undecided.data.task_id,
      expected_version:undecided.data.condition_version,options:[]},undefined,unknownRoute.sdk);
    assert.equal(replayedRoute.receipt.operation_id,unknownRoute.receipt.operation_id);
    assert.deepEqual(replayedRoute.data,unknownRoute.data,'接回原归属操作，不重新修改条件');
    assert.equal(replayedRoute.receipt.source_context_ready,false);
    assert.equal(replayedRoute.receipt.source_context_blocker,'source_scope_unknown');
    assert.equal(run.workspace_context.source_context_blocker,'source_scope_unknown');
    assert.deepEqual(h.sql(`SELECT receipt FROM tool_calls WHERE ${routeWhere}`)[0],legacyRoute,
      '只补当前出站控制事实，不追改历史成功回执');
    const path=`/skills/${selected.value.id}/${selected.value.version}/references/guide.md`;
    await tool('read',{path,limit:30},'task_context_required');
    const declared=await tool('update_analysis_task',{action:'revise',task_id:undecided.data.task_id,
      expected_version:undecided.data.condition_version,condition_patch:{set:{},unset:['source_limits']},options:[]});
    assert.equal(declared.receipt.source_context_ready,true);
    assert.equal(declared.receipt.source_context_blocker,undefined);
    assert.equal(run.workspace_context.source_context_ready,true);
    assert.equal(run.workspace_context.source_context_blocker,undefined,'就绪刷新须移除旧阻断原因');
    assert.ok(run.workspace_context.selected_skills.some(skill=>skill.id===selected.value.id&&skill.version===selected.value.version));
    await tool('read',{path,limit:30});
    const attachment=manager.buildSessionContext().messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read');
    assert.ok(attachment.content.some(part=>part.type==='text'&&part.text.includes('核对统计对象与观察范围')));
    assert.equal((await h.request(`/conversations/${recoveryCid}/queries`)).value.queries.length,0,'恢复只读方法，不生成执行授权或查询');
    await finish();
    checks.push('v2创建遗漏来源与成功route均明确仍未决；原刷新保留原因，显式修订后原选Skill附件可读且无查询副作用');

    const cid=await h.create();await begin(cid,'先保存合成SQL，暂不执行。');
    const task=await createTask(),q=await draft(task,'SELECT 17 AS sample_value',{});
    const draftBudget=run.budget_scope_id;
    const originalTask=(await tool('read_analysis_task',{task_id:task.task_id})).data;
    assert.equal((await read(q)).confirmation_state,'awaiting_confirmation');await finish();
    await begin(cid,'执行刚才保存的合成SQL，保留原条件。');
    const executionMessage=run.message_id,executionBudget=run.budget_scope_id;
    assert.equal(run.workspace_context.source_context_ready,false);
    const before=savedAuthorization(q);
    const blocked=await tool('get_query',{query_id:q.id},'task_context_required');
    assert.match(blocked.data.hint,/source_context_ready=true/);
    assert.match(blocked.data.hint,/继续原请求/);
    assert.equal(blocked.data.recovery.query.query_id,q.id);
    const routed=await route(task);
    assert.equal(routed.receipt.source_context_ready,true);
    assert.match(routed.receipt.control_delivery.text,/已保存，尚未提交执行/,
      '用户已明确执行时，未登记授权的持久状态不能描述成需要用户再次确认');
    assert.doesNotMatch(routed.receipt.control_delivery.text,/等待确认/);
    assert.ok(routed.receipt.control_delivery.facts.some(fact=>fact.query_id===q.id
      &&fact.confirmation_state==='awaiting_confirmation'&&fact.execution_state==='not_submitted'),
      '中性状态文案不提前授权或伪称已提交');
    assert.equal(run.workspace_context.source_context_ready,true,'采用真实宿主回执及必要刷新确认来源就绪');
    assert.equal(projection.hidesSourceContext(),false);
    const currentTask=(await tool('read_analysis_task',{task_id:task.task_id})).data;
    assert.equal(currentTask.condition_version,originalTask.condition_version);
    assert.deepEqual(currentTask.conditions,originalTask.conditions,'route不改条件');
    assert.deepEqual(savedAuthorization(q),before,'来源归属不授权或换预算');
    const admitted=(await tool('get_query',{query_id:q.id})).data.query;
    assert.equal(admitted.sql,q.sql);assert.equal(admitted.draft_version,q.draft_version);
    assert.equal(admitted.confirmation_state,'awaiting_confirmation');
    await tool('execute_query',executeArgs(q));
    const authorized=savedAuthorization(q);
    assert.equal(authorized.message,executionMessage);assert.equal(authorized.budget,executionBudget);assert.notEqual(authorized.budget,draftBudget);
    await finish();await h.resumeWorker();
    await until(async()=>(await read(q)).execution_state==='succeeded','v2单条来源准入后完成');
    run=await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.startsWith('[已确认查询结果事件]')),'v2原结果唤醒');
    await h.pauseWorker();bindSourceTools();
    assert.equal(run.budget_scope_id,executionBudget,'结果通知沿原执行预算');
    assert.deepEqual((await tool('get_query',{query_id:q.id})).data.results.rows,[['17']]);await finish();
    checks.push('v2来源未就绪真实拒绝；route及必要刷新就绪后读当前草稿并确认，条件/草稿版本保持，授权和结果通知沿原执行消息预算');

    const multiCid=await h.create();await begin(multiCid,'准备两份无限制来源的独立合成SQL，不执行。');
    const leftTask=await createTask(),left=await draft(leftTask,'SELECT 31 AS value',{});
    const rightTask=await createTask(),right=await draft(rightTask,'SELECT 37 AS value',{});await finish();
    await begin(multiCid,'分别执行刚才展示的两份合成SQL，保留原条件。');
    const batchMessage=run.message_id,batchBudget=run.budget_scope_id;
    const routedLeft=await route(leftTask);assert.equal(routedLeft.receipt.source_context_ready,true);
    assert.equal(projection.hidesSourceContext(),false);
    for(const query of [left,right]){
      const actual=(await tool('get_query',{query_id:query.id})).data.query;
      assert.equal(actual.id,query.id);assert.equal(actual.sql,query.sql);assert.equal(actual.confirmation_state,'awaiting_confirmation');
    }
    const batchState=async()=>({routing:messageRouting(),relations:h.sql(`SELECT JSON_OBJECT('task',task_id) FROM conversation_message_tasks WHERE message_id='${batchMessage}' ORDER BY task_id`).map(value=>value.task),
      authorizations:[left,right].map(savedAuthorization),queries:await Promise.all([left,right].map(read))});
    const baseline=await batchState();assert.deepEqual(baseline.relations,[leftTask.task_id]);
    assert.ok(baseline.authorizations.every(value=>value.message===null));
    const invalid=executeBatchArgs([left,right]);invalid.queries[1].draft_version='999';
    const rejected=await tool('execute_query',invalid,'version_conflict');
    assert.equal(rejected.data.new_execution_authorized,false);assert.match(rejected.data.hint,/批量确认整体未生效/);
    assert.deepEqual(await batchState(),baseline,'后项失效整批零新增；先前成功route及两份未确认稿/预算保持');
    const accepted=await tool('execute_query',executeBatchArgs([left,right]));
    assert.notEqual(accepted.receipt.operation_id,rejected.receipt.operation_id);
    const after=await batchState();assert.deepEqual(after.relations,[leftTask.task_id,rightTask.task_id].sort());
    assert.ok(after.queries.every(query=>query.confirmation_state==='confirmed'&&query.execution_state==='queued'));
    for(const authorization of after.authorizations){assert.equal(authorization.message,batchMessage);assert.equal(authorization.budget,batchBudget);}
    assert.equal(after.authorizations[0].key,after.authorizations[1].key);
    const routes=traces.filter(trace=>trace.message===batchMessage&&trace.receipt.tool_name==='update_analysis_task');
    assert.equal(routes.length,1,'读取与批量授权不额外route到B');assert.equal(routes[0].receipt.data.task_id,leftTask.task_id);
    await finish();
    const consumed=new Set();
    const notificationEvidence={conversation_id:multiCid,execution_message_id:batchMessage,budget_scope_id:batchBudget,samples:[]};
    const evidencePath=h.directory+'/multi-query-notifications-v2.json';
    console.log('multi_query_notification_evidence '+evidencePath);
    const observe=async(stage,index,details={})=>{
      const started=Date.now();
      const rows=h.sql(`START TRANSACTION READ ONLY;
        SELECT JSON_OBJECT('kind','clock','utc',UTC_TIMESTAMP(3),'buffer_pool_bytes',@@GLOBAL.innodb_buffer_pool_size);
        SELECT JSON_OBJECT('kind','query','id',id,'state',execution_state,'message',confirmation_message_id,'budget',budget_scope_id,
          'submissions',submission_attempts,'notified',result_notified,'lease_owner',lease_owner,'lease_epoch',lease_epoch,'lease_until',lease_until,'error',error_code)
          FROM query_requests WHERE conversation_id='${multiCid}';
        SELECT JSON_OBJECT('kind','job','id',id,'message',message_id,'state',state,'lease_owner',lease_owner,'lease_until',lease_until)
          FROM background_jobs WHERE conversation_id='${multiCid}';
        SELECT JSON_OBJECT('kind','run','id',id,'message',message_id,'budget',budget_scope_id,'state',state,'lease_epoch',lease_epoch)
          FROM agent_runs WHERE conversation_id='${multiCid}'; COMMIT;`);
      const apiStarted=Date.now();await read(left);
      notificationEvidence.samples.push({stage,index,at:new Date(started).toISOString(),sql_process_ms:apiStarted-started,api_read_ms:Date.now()-apiStarted,...details,rows,
        captured:h.captured.filter(r=>r.conversation_id===multiCid).map(r=>({run_id:r.run_id,message_id:r.message_id,budget:r.budget_scope_id,notification:r.workspace_context.result_notification})),
        worker_events:h.logs.filter(log=>log.name.startsWith('worker')).slice(-2).map(log=>({name:log.name,events:log.output.split('\n').filter(line=>/^(run_started |query_worker_failure |delivery_|\[worker)/.test(line)).slice(-8)}))});
      await writeFile(evidencePath,JSON.stringify(notificationEvidence,null,2));
    };
    for(let index=0;index<2;index++){
      await h.resumeWorker();const started=Date.now();await observe('after_resume',index);
      const next=()=>h.captured.find(r=>r.conversation_id===multiCid&&r.text.startsWith('[已确认查询结果事件]')&&!consumed.has(r.run_id));
      // 采样也消耗原20秒，不给诊断动作另加等待额度。
      try{run=await until(next,'v2批量原结果通知',Math.max(0,20000-(Date.now()-started)));}
      catch(error){
        const observationEnd=Date.now()+40000;
        await observe('wait_failed',index,{elapsed_ms:Date.now()-started});
        let late,extraError;
        try{late=await until(next,'v2晚到通知只读观察',Math.max(0,observationEnd-Date.now()));}catch(observationError){extraError=observationError.message;}
        await observe('extra_observation_end',index,{elapsed_ms:Date.now()-started,late_run_id:late?.run_id??null,extra_error:extraError??null});
        throw error;
      }
      await observe('before_pause',index,{elapsed_ms:Date.now()-started,selected_run_id:run.run_id});
      await h.pauseWorker();consumed.add(run.run_id);bindSourceTools();assert.equal(run.budget_scope_id,batchBudget);await finish();
      await observe('after_finish',index);
    }
    for(const query of [q,left,right]){
      assert.equal((await read(query)).execution_state,'succeeded');
      const submissions=JSON.parse(execFileSync('python3',['-c','import json,sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(json.dumps(d.execute("SELECT COUNT(*) FROM submissions WHERE id=?",(sys.argv[2],)).fetchone()[0]))',h.directory+'/platform/submissions.sqlite',query.id],{encoding:'utf8'}));
      assert.equal(submissions,1,'每份查询恰好一次真实合成平台提交');
    }
    checks.push('v2两份未确认稿先非法后项整批零新增，再以同消息/预算新operation合法授权；只route A，未自动并集来源，每查询一次合成平台提交');
  } else {
  const atomicCid=await h.create();await begin(atomicCid,'先保存独立合成SQL');
  const atomicTask=await createTask();const atomicQuery=await draft(atomicTask,'SELECT 17 AS sample_value',{});await finish();
  await begin(atomicCid,'执行刚才保存的合成SQL。');
  assert.deepEqual(messageRouting(),{routing:'pending',task:null,applied:0,relations:0});
  const direct=await tool('execute_query',executeArgs(atomicQuery));
  assert.equal(direct.data.execution_state,'queued','明确执行单一已保存SQL不要求另一次route调用');
  assert.deepEqual(messageRouting(),{routing:'routed',task:atomicTask.task_id,applied:1,relations:1});
  const directAuthorization=savedAuthorization(atomicQuery);
  assert.equal(directAuthorization.message,run.message_id);assert.equal(directAuthorization.budget,run.budget_scope_id);
  assert.deepEqual((await h.internal('/internal/data/tools',direct.input)).value.data,direct.data);
  assert.deepEqual(savedAuthorization(atomicQuery),directAuthorization);
  await finish();await h.resumeWorker();
  await until(async()=>(await read(atomicQuery)).execution_state==='succeeded','自动归属查询完成',120000);
  run=await until(()=>h.captured.find(r=>r.conversation_id===atomicCid&&r.text.startsWith('[已确认查询结果事件]')),'自动归属结果唤醒');
  await h.pauseWorker();await route(atomicTask);await finish();
  checks.push('尚无任务关联的真实执行消息由已保存查询唯一绑定目标，同事务确认及标已应用；同SDK重放不新增执行或预算');

  const longCid = await h.create();const longText = '数'.repeat(32000);
  await begin(longCid,longText);assert.equal(run.text,longText);
  assert.equal((await h.snapshot(longCid)).messages.find(m=>m.role==='user').text,longText);
  const oversized = await h.request(`/conversations/${longCid}/messages`,{client_message_id:randomUUID(),text:longText+'数'});
  assert.equal(oversized.status,400);assert.equal(oversized.value.code,'invalid_input');
  const longTask = await createTask();
  const sqlPrefix = "SELECT '", sqlSuffix = "' AS pasted_value";
  const longSql = sqlPrefix+'数'.repeat(24000-sqlPrefix.length-sqlSuffix.length)+sqlSuffix;
  const longQuery = await draft(longTask,longSql,{});
  assert.equal(longQuery.check_state,'passed');assert.equal(longQuery.sql,longSql);
  await finish();await h.restartApi();
  assert.equal((await h.snapshot(longCid)).messages.find(m=>m.role==='user').text,longText);
  assert.equal((await read(longQuery)).sql,longSql);
  checks.push('32,000个中文字符完整保存、送达运行并在重启后回读；超限在API拒绝；24,000字符多字节SQL通过只读检查、保存及重启回读');

  const cid = await h.create();await begin(cid,'先给SQL，不执行');
  const task = await createTask();const q = await draft(task);
  assert.equal((await read(q)).execution_state,'not_submitted');const draftBudget=run.budget_scope_id;await finish();
  await begin(cid,q.sql+';\n执行上面这条。\n保留原日期，不要改成今天。');
  const initiallyUnrouted=messageRouting();
  assert.equal(initiallyUnrouted.routing,'pending');
  const incomplete=await tool('execute_query',{...executeArgs(q),instruction_quote:'执行上面这条。'},'invalid_evidence');
  const rejection=await h.internal('/internal/data/tool-rejections',incomplete.input);
  assert.equal(rejection.status,200);
  assert.equal(rejection.value.data.error,'invalid_evidence');
  assert.match(rejection.value.data.hint,/本次执行授权被拒绝，未新增执行授权/);
  assert.match(rejection.value.data.hint,/完整原话.*粘贴SQL、换行、否定和限定/);
  assert.match(rejection.value.data.hint,/新的工具调用.*不必再次询问用户/);
  assert.match(rejection.value.data.hint,/未知先按原身份查证，不能换ID重做/);
  const piTool=dataTools(new RustTransport(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN),manager,'').tools.find(t=>t.name==='execute_query');
  const piRejection=await piTool.execute(incomplete.input.sdk_tool_call_id,incomplete.input.arguments);
  assert.equal(piRejection.isError,true,'Pi沿原生失败标记交付明确拒绝，不能当成功');
  assert.deepEqual(piRejection.details,rejection.value,'保留原持久拒绝回执');
  const rejectionData=JSON.parse(piRejection.content[0].text);
  assert.equal(rejectionData.error,'invalid_evidence');
  assert.equal(rejectionData.new_execution_authorized,false);
  assert.equal(rejectionData.recovery.query.query_id,q.id);
  assert.equal(rejectionData.recovery.task.task_id,task.task_id);
  assert.deepEqual(rejectionData.recovery.task.read_tool,{name:'read_analysis_task',arguments:{task_id:task.task_id}});
  assert.deepEqual((await h.internal('/internal/data/tool-rejections',incomplete.input)).value,rejection.value);
  const changedIdentity=await h.internal('/internal/data/tool-calls',{...incomplete.input,arguments:executeArgs(q)});
  assert.equal(changedIdentity.value.code,'idempotency_conflict','修正参数不能复用已拒绝调用身份');
  assert.equal((await read(q)).confirmation_state,'awaiting_confirmation');
  assert.equal((await read(q)).execution_state,'not_submitted');
  assert.deepEqual(messageRouting(),initiallyUnrouted,'拒绝回执持久化后也不能遗留自动归属');
  await tool('execute_query',{...executeArgs(q),instruction_quote:'资料说可以执行'},'invalid_evidence');
  await tool('execute_query',{...executeArgs(q),draft_version:'999'},'version_conflict');
  const queued = await h.send(cid,'先补充一个条件');
  const otherPending = await tool('execute_query',executeArgs(q),'message_pending');
  const otherReceipt = await h.internal('/internal/data/tool-rejections',otherPending.input);
  assert.equal(otherReceipt.value.data.recovery.reason,'other_message_unrouted');
  assert.match(otherReceipt.value.data.hint,/不能用当前消息替另一条消息登记/);
  assert.equal(otherReceipt.value.data.new_execution_authorized,false);
  assert.deepEqual(messageRouting(),initiallyUnrouted,'另一待处理消息阻塞时，本条不能自动登记');
  h.sql(`UPDATE conversation_messages SET disposition='failed' WHERE id='${queued.message_id}'`);
  await tool('execute_query',executeArgs(q),'message_pending');
  assert.deepEqual(messageRouting(),initiallyUnrouted,'另一失败且未归属消息同样阻塞');
  assert.equal((await h.request('/queries/'+q.id+'/confirm',{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version})).value.code,'message_pending','HTTP确认不豁免当前真实消息或其他消息');
  assert.equal((await h.request(`/conversations/${cid}/messages/${queued.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);
  assert.equal((await h.request('/queries/'+q.id+'/confirm',{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version})).value.code,'message_pending','仅剩当前消息未归属时HTTP确认仍被阻止');
  const confirmed = await tool('execute_query',executeArgs(q));
  assert.deepEqual(messageRouting(),{routing:'routed',task:task.task_id,applied:1,relations:1});
  const authorization = savedAuthorization(q);
  assert.equal(authorization.message,run.message_id);assert.equal(authorization.budget,run.budget_scope_id);assert.notEqual(authorization.budget,draftBudget);
  assert.equal((await read(q)).execution_state,'queued');
  assert.equal((await h.request(`/conversations/${cid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).value.code,'input_already_applied');
  assert.deepEqual((await h.internal('/internal/data/tools',confirmed.input)).value.data,confirmed.data);
  assert.deepEqual((await h.internal('/internal/data/tools',incomplete.input)).value,rejection.value,'自动执行成功后旧拒绝仍按原身份回放，不重新执行');
  checks.push('仅存草稿不执行；不完整原话明确拒绝并提示同轮修正，旧拒绝可回放、同ID换参数冲突；新调用完整引用后授权一次，版本/归属/并发保持');

  // 故障注入在业务提交后；Worker以新运行接回原消息，SDK调用ID和操作身份保持。
  const previous=run;h.releaseRun(previous.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${previous.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${previous.message_id}';`);
  await h.restartApi();await h.resumeWorker();
  run=await until(()=>h.captured.find(r=>r.message_id===previous.message_id&&r.run_id!==previous.run_id),'恢复执行消息');await h.pauseWorker();
  assert.equal(run.budget_scope_id,previous.budget_scope_id);
  const replay=await tool('execute_query',confirmed.input.arguments,undefined,confirmed.input.sdk_tool_call_id);
  assert.deepEqual(replay.data,confirmed.data);assert.deepEqual(savedAuthorization(q),authorization);
  await finish();await h.resumeWorker();
  await until(async()=>(await read(q)).execution_state==='succeeded','恢复后查询完成');
  await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.startsWith('[已确认查询结果事件]')),'结果交付已接收');
  await h.pauseWorker();
  assert.deepEqual((await h.request('/queries/'+q.id+'/results')).value.rows,[[conditions.time_start]]);
  const submission=JSON.parse(execFileSync('python3',['-c','import json,sqlite3,sys; d=sqlite3.connect(sys.argv[1]); r=d.execute("SELECT payload FROM submissions WHERE id=?",(sys.argv[2],)).fetchall(); print(json.dumps([json.loads(x[0]) for x in r]))',h.directory+'/platform/submissions.sqlite',q.id],{encoding:'utf8'}));
  assert.equal(submission.length,1);assert.equal(submission[0].sql,q.sql);assert.deepEqual(submission[0].parameters,q.parameters);
  checks.push('业务提交后API重启和新Worker运行恢复同一SDK调用；授权、预算和平台查询身份不变，原绝对日期参数与结果一致');

  await h.resumeWorker();run=await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.startsWith('[已确认查询结果事件]')),'结果唤醒');await h.pauseWorker();
  await route(task);const unconfirmed=await draft(task,'SELECT 9 AS value',{});
  await tool('execute_query',executeArgs(unconfirmed),'invalid_evidence');await finish();
  await begin(cid,'执行上面这条');await tool('execute_query',executeArgs(q));
  assert.deepEqual(savedAuthorization(q),authorization);assert.deepEqual(messageRouting(),{routing:'routed',task:task.task_id,applied:0,relations:1});await finish();
  checks.push('系统结果消息不能授予新执行；后续消息重复执行已确认查询也不转移授权或补预算');

  const revisionCid=await h.create();await begin(revisionCid,'查1月净收入');
  const originalTask=await createTask();const original=await draft(originalTask);await finish();
  await begin(revisionCid,'只看app渠道，再执行');
  const revisedTask=(await tool('update_analysis_task',{action:'revise',goal:'合成净收入查询',task_id:originalTask.task_id,expected_version:originalTask.condition_version,condition_patch:{set:{channel:'app'},unset:[]},options:[]})).data;
  await tool('execute_query',executeArgs(original),'version_conflict');
  const revised=await draft(revisedTask,'SELECT SUM(paid_amount_cents-refunded_amount_cents) AS net_revenue_cents FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>=:start AND paid_at<:end AND channel=:channel',{start:conditions.time_start,end:conditions.time_end,channel:'app'},original.id);
  await tool('execute_query',executeArgs(revised));await finish();await h.resumeWorker();
  await until(async()=>(await read(revised)).execution_state==='succeeded','修改后执行');
  await until(()=>h.captured.find(r=>r.conversation_id===revisionCid&&r.text.startsWith('[已确认查询结果事件]')),'修订结果交付已接收');await h.pauseWorker();
  assert.deepEqual((await h.request('/queries/'+revised.id+'/results')).value.rows,[['1600']]);
  assert.equal((await read(original)).execution_state,'not_submitted');assert.equal((await read(original)).confirmation_state,'superseded');
  checks.push('同条消息修订后执行新SQL，旧稿拒绝；app净收入独立参考1600分');
  await h.resumeWorker();run=await until(()=>h.captured.find(r=>r.conversation_id===revisionCid&&r.text.startsWith('[已确认查询结果事件]')),'修订结果唤醒');await h.pauseWorker();await route(revisedTask);await finish();

  const otherCid=await h.create();await begin(otherCid,'执行另一份SQL');const otherTask=await createTask();
  await tool('execute_query',executeArgs(unconfirmed),'not_available');
  assert.equal((await h.request('/queries/'+revised.id,undefined,'bob')).status,404);
  assert.equal((await h.request('/queries/'+revised.id+'/results',undefined,'bob')).status,404);
  const unrelatedTask=await createTask();const unrelated=await draft(unrelatedTask);await finish();
  await begin(otherCid,'执行原任务SQL');await route(otherTask);
  const originalRouting=messageRouting();await tool('execute_query',executeArgs(unrelated),'not_available');
  assert.deepEqual(messageRouting(),originalRouting,'已有目标不得借执行另一个查询改投其他任务');await finish();
  checks.push('查询必须属于当前会话及消息已归属的任务；其他用户不能读查询或结果');

  const multiCid=await h.create();await begin(multiCid,'准备三份独立目标的SQL');
  const leftTask=await createTask();const leftQuery=await draft(leftTask,'SELECT 31 AS value',{});
  const rightTask=await createTask();const rightQuery=await draft(rightTask,'SELECT 37 AS value',{});
  const excludedTask=await createTask();const excludedQuery=await draft(excludedTask,'SELECT 43 AS value',{});await finish();
  await begin(multiCid,'只执行前两份已经展示的SQL；第三份不执行，不要再重复要求确认。');
  const taskRelations=()=>h.sql(`SELECT JSON_OBJECT('task',task_id) FROM conversation_message_tasks WHERE message_id='${run.message_id}' ORDER BY task_id`).map(value=>value.task);
  const expectedRelations=[leftTask.task_id,rightTask.task_id].sort();
  const batchArgs=executeBatchArgs([leftQuery,rightQuery]);
  const beforeBatch=messageRouting();assert.equal(beforeBatch.routing,'pending');
  const invalidVersion=structuredClone(batchArgs);invalidVersion.queries[1].draft_version='999';
  const failedBatch=await tool('execute_query',invalidVersion,'version_conflict');
  const batchRejection=await h.internal('/internal/data/tool-rejections',failedBatch.input);
  assert.equal(batchRejection.value.data.new_execution_authorized,false);
  assert.match(batchRejection.value.data.hint,/批量确认整体未生效/);
  assert.deepEqual(batchRejection.value.data.recovery.queries.map(query=>query.query_id),[leftQuery.id,rightQuery.id]);
  assert.ok(batchRejection.value.data.recovery.queries.every(query=>query.execution_state==='not_submitted'));
  assert.deepEqual(messageRouting(),beforeBatch,'第二项版本失效必须回滚第一项确认及消息归属');
  for(const query of [leftQuery,rightQuery]){
    assert.equal((await read(query)).execution_state,'not_submitted');
    assert.equal(savedAuthorization(query).message,null);
  }
  const duplicate=executeBatchArgs([leftQuery,leftQuery]);duplicate.queries[1].draft_version='999';
  await tool('execute_query',duplicate,'invalid_input');
  assert.deepEqual(messageRouting(),beforeBatch,'同query不同版本不得重复列入同一授权集合');
  await tool('execute_query',executeBatchArgs([leftQuery,unconfirmed]),'not_available');
  await tool('execute_query',{...batchArgs,instruction_quote:'执行前两份'},'invalid_evidence');
  assert.deepEqual(messageRouting(),beforeBatch,'跨会话查询和不完整原话均不得留下半批确认');
  const batch=await tool('execute_query',batchArgs);
  assert.deepEqual(batch.data.queries.map(query=>query.id),[leftQuery.id,rightQuery.id]);
  assert.ok(batch.data.queries.every(query=>query.execution_state==='queued'));
  assert.deepEqual(taskRelations(),expectedRelations);
  const batchAuthorizations=[leftQuery,rightQuery].map(savedAuthorization);
  for(const authorization of batchAuthorizations){assert.equal(authorization.message,run.message_id);assert.equal(authorization.budget,run.budget_scope_id);assert.equal(authorization.key,batchAuthorizations[0].key);}
  assert.equal((await read(excludedQuery)).execution_state,'not_submitted');
  assert.deepEqual((await h.internal('/internal/data/tools',batch.input)).value.data,batch.data);
  await h.restartApi();
  assert.deepEqual((await h.internal('/internal/data/tools',batch.input)).value.data,batch.data,'API重启后接回整批原回执');
  assert.deepEqual([leftQuery,rightQuery].map(savedAuthorization),batchAuthorizations);
  await finish();
  const consumedResults=new Set(),consumedQueryIds=new Set();
  const notificationEvidence={conversation_id:multiCid,execution_message_id:run.message_id,budget_scope_id:run.budget_scope_id,
    query_ids:[leftQuery.id,rightQuery.id],excluded_query_id:excludedQuery.id,wait_ms:20000,extra_observation_ms:40000,samples:[]};
  const evidencePath=h.directory+'/multi-query-notifications.json';
  console.log('multi_query_notification_evidence '+evidencePath);
  const sampleNotifications=async(stage,iteration,details={})=>{
    const sample={stage,iteration,at:new Date().toISOString(),consumed_run_ids:[...consumedResults],consumed_query_ids:[...consumedQueryIds],...details,
      captured:h.captured.filter(value=>value.conversation_id===multiCid).map(value=>({run_id:value.run_id,message_id:value.message_id,
        recovery_chain_id:value.recovery_chain_id,budget_scope_id:value.budget_scope_id,lease_epoch:value.lease_epoch,
        result_notification:value.workspace_context.result_notification??null,aborted:h.captureAborted.includes(value.run_id)}))};
    try{
      sample.rows=h.sql(`START TRANSACTION READ ONLY;
        SELECT JSON_OBJECT('kind','clock','utc',UTC_TIMESTAMP(3),'unix_ms',UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000);
        SELECT JSON_OBJECT('kind','query','id',id,'task_id',task_id,'condition_version',condition_version,'draft_version',draft_version,
          'confirmation_state',confirmation_state,'execution_state',execution_state,'cancel_state',cancel_state,'confirmation_message_id',confirmation_message_id,
          'budget_scope_id',budget_scope_id,'result_ref',result_ref,'result_notified',result_notified,'submission_attempts',submission_attempts,
          'lease_owner',lease_owner,'lease_epoch',lease_epoch,'lease_until',lease_until,'error_code',error_code)
          FROM query_requests WHERE conversation_id='${multiCid}' ORDER BY id;
        SELECT JSON_OBJECT('kind','message','id',id,'client_key',client_key,'disposition',disposition,'routing_state',routing_state,
          'recovery_chain_id',recovery_chain_id,'budget_scope_id',budget_scope_id)
          FROM conversation_messages WHERE conversation_id='${multiCid}' ORDER BY created_at,id;
        SELECT JSON_OBJECT('kind','job','id',id,'message_id',message_id,'dispatch_seq',dispatch_seq,'state',state,'attempts',attempts,
          'lease_owner',lease_owner,'lease_epoch',lease_epoch,'lease_until',lease_until)
          FROM background_jobs WHERE conversation_id='${multiCid}' ORDER BY dispatch_seq;
        SELECT JSON_OBJECT('kind','run','id',id,'message_id',message_id,'recovery_chain_id',recovery_chain_id,'budget_scope_id',budget_scope_id,
          'state',state,'lease_epoch',lease_epoch,'job_id',job_id,'job_lease_epoch',job_lease_epoch,'output_id',output_id,'attempt_id',attempt_id)
          FROM agent_runs WHERE conversation_id='${multiCid}' ORDER BY created_at,id;
        SELECT JSON_OBJECT('kind','conversation','lease_owner',lease_owner,'lease_epoch',lease_epoch,'lease_until',lease_until)
          FROM conversations WHERE id='${multiCid}';
        SELECT JSON_OBJECT('kind','budget','id',id,'message_id',message_id,'issued_calls',issued_calls,'call_limit',call_limit)
          FROM budget_scopes WHERE id='${notificationEvidence.budget_scope_id}';
        COMMIT;`);
    }catch(error){sample.sampling_error={name:error.name,code:error.code??null};}
    sample.worker_events=h.logs.filter(value=>value.name.startsWith('worker')).slice(-3).map(value=>({name:value.name,
      events:value.output.split('\n').filter(line=>/^(run_started |query_worker_failure |query_prepare_renew_transient |delivery_|worker_|\[worker)/.test(line)).slice(-12)}));
    sample.completed_at=new Date().toISOString();notificationEvidence.samples.push(sample);
    await writeFile(evidencePath,JSON.stringify(notificationEvidence,null,2));
  };
  let notificationIteration=0;
  try{
  for(let i=0;i<2;i++){
    notificationIteration=i;
    await h.resumeWorker();const waitStarted=Date.now();await sampleNotifications('after_resume',i);
    const nextResult=()=>h.captured.find(r=>r.conversation_id===multiCid&&r.text.startsWith('[已确认查询结果事件]')&&!consumedResults.has(r.run_id));
    try{
      run=await until(nextResult,'多目标查询结果唤醒',Math.max(0,20000-(Date.now()-waitStarted)));
    }catch(error){
      const observationEnd=Date.now()+40000;
      await sampleNotifications('wait_failed',i,{wait_started_at:new Date(waitStarted).toISOString(),elapsed_ms:Date.now()-waitStarted,error:error.message});
      // 原20秒失败不变；额外观察只采证，不能把晚到通知改判为通过。
      let late;
      while(Date.now()<observationEnd&&!(late=nextResult()))await new Promise(resolve=>setTimeout(resolve,75));
      const lateQuery=late?.workspace_context.result_notification?.query_id;
      await sampleNotifications('extra_observation_end',i,{late_run_id:late?.run_id??null,elapsed_ms:Date.now()-waitStarted,
        late_identity_matches:!!late&&notificationEvidence.query_ids.includes(lateQuery)&&!consumedQueryIds.has(lateQuery)
          &&late.budget_scope_id===notificationEvidence.budget_scope_id});
      throw error;
    }
    await sampleNotifications('before_pause',i,{wait_started_at:new Date(waitStarted).toISOString(),elapsed_ms:Date.now()-waitStarted,selected_run_id:run.run_id});
    await h.pauseWorker();consumedResults.add(run.run_id);
    const resultTask=run.text.includes('query_id='+leftQuery.id)?leftTask:rightTask;
    assert.ok(run.text.includes('query_id='+leftQuery.id)||run.text.includes('query_id='+rightQuery.id));
    const resultQueryId=resultTask.task_id===leftTask.task_id?leftQuery.id:rightQuery.id;
    assert.ok(!consumedQueryIds.has(resultQueryId),'每个查询的结果只消费一次，恢复run不代替另一查询结果');
    consumedQueryIds.add(resultQueryId);
    await route(resultTask);await finish();await sampleNotifications('after_finish',i);
  }
  }catch(error){
    await sampleNotifications('notification_failed',notificationIteration,{error:error.message});
    throw error;
  }
  assert.deepEqual([...consumedQueryIds].sort(),[leftQuery.id,rightQuery.id].sort());
  assert.equal((await read(excludedQuery)).execution_state,'not_submitted');
  await begin(multiCid,'查看前两项已授权查询的状态，不重新运行。');
  const replayBatch=await tool('execute_query',executeBatchArgs([leftQuery,rightQuery]));
  assert.ok(replayBatch.data.queries.every(query=>query.execution_state==='succeeded'));
  assert.deepEqual([leftQuery,rightQuery].map(savedAuthorization),batchAuthorizations,'后续消息重放不能成为旧查询的新授权来源或预算');
  assert.equal(messageRouting().applied,0);await finish();
  checks.push('单条完整原话批量确认两个独立任务，无需预先route；第三项始终未执行，全部绑定原消息/预算；后项失效、重复query、跨会话和缺失原话均不留下半批确认；API重启和后续消息重放接回原授权');

  const noticeCid=await h.create();await begin(noticeCid,'仅准备系统输入权限检查');
  const noticeTask=await createTask();const noticeQuery=await draft(noticeTask);await finish();
  await begin(noticeCid,'合成系统通知不能执行查询');
  h.sql(`UPDATE conversation_messages SET client_key='server:synthetic-notice:${run.message_id}' WHERE id='${run.message_id}'`);
  const noticeRouting=messageRouting();await tool('execute_query',executeArgs(noticeQuery),'invalid_evidence');
  assert.deepEqual(messageRouting(),noticeRouting);assert.equal((await read(noticeQuery)).execution_state,'not_submitted');
  assert.equal((await h.request(`/conversations/${noticeCid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);h.releaseRun(run.run_id);
  checks.push('非查询结果类型的系统消息也不能凭完整原文获得执行权或自动任务归属');

  const deliveryCid=await h.create();await begin(deliveryCid,'执行 SELECT 42 AS sample_value');
  const deliveryTask=await createTask();const fastQuery=await draft(deliveryTask,'SELECT 42 AS sample_value',{});
  await tool('execute_query',executeArgs(fastQuery));await h.resumeWorker();
  await until(async()=>(await read(fastQuery)).execution_state==='succeeded','执行轮尚未结束的快查询');await h.pauseWorker();
  const deferred=(await tool('get_query',{query_id:fastQuery.id})).data;
  assert.equal(deferred.query.execution_state,'succeeded');assert.equal(deferred.results,null);assert.match(deferred.hint,/系统会自动交付/);
  const executingRun=run;h.releaseRun(executingRun.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${executingRun.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${deliveryCid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${executingRun.message_id}';`);
  await h.restartApi();await h.resumeWorker();
  run=await until(()=>h.captured.find(r=>r.message_id===executingRun.message_id&&r.run_id!==executingRun.run_id),'执行消息新运行恢复');await h.pauseWorker();
  assert.equal((await tool('get_query',{query_id:fastQuery.id})).data.results,null);await finish();await h.resumeWorker();
  run=await until(()=>h.captured.find(r=>r.conversation_id===deliveryCid&&r.text.startsWith('[已确认查询结果事件]')),'快查询结果交付');await h.pauseWorker();
  await route(deliveryTask);assert.deepEqual((await tool('get_query',{query_id:fastQuery.id})).data.results.rows,[['42']]);await finish();
  await begin(deliveryCid,'再解释这条查询的结果');await route(deliveryTask);
  assert.deepEqual((await tool('get_query',{query_id:fastQuery.id})).data.results.rows,[['42']]);await finish();
  checks.push('快查询及同一执行消息跨运行恢复只交付真实状态；结果交付轮和后续追问正常读取，避免执行轮重复解释');

  const rejectedCid=await h.create();await begin(rejectedCid,'执行合成检查');const rejectedTask=await createTask();
  const writeSql=await draft(rejectedTask,'DELETE FROM demo_order_detail',{});assert.equal(writeSql.check_state,'rejected');
  await tool('execute_query',executeArgs(writeSql),'version_conflict');
  const cancelled=await draft(rejectedTask);assert.equal((await h.request('/queries/'+cancelled.id+'/cancel',{operation_id:randomUUID()})).status,200);
  await tool('execute_query',executeArgs(cancelled),'version_conflict');await finish();
  await begin(rejectedCid,'执行上面这条');await route(rejectedTask);
  const withdrawn=run;assert.equal((await h.request(`/conversations/${rejectedCid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);
  const late={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'execute_query',arguments:executeArgs(cancelled),checkpoint:checkpoint()};
  assert.equal((await h.internal('/internal/data/tool-calls',late)).value.code,'lease_lost');h.releaseRun(withdrawn.run_id);
  checks.push('写入SQL、已取消查询和撤回后的晚到执行均拒绝');

  const deniedCid=await h.create();await begin(deniedCid,'执行权限检查');const deniedTask=await createTask();const denied=await draft(deniedTask);
  await tool('execute_query',executeArgs(denied));await finish();
  await writeFile(h.directory+'/platform/permissions.json',JSON.stringify({denied_query_users:['alice']}));await h.resumeWorker();
  await until(async()=>(await read(denied)).execution_state==='failed','平台撤权拒绝');await h.pauseWorker();
  assert.equal((await read(denied)).error,'forbidden');
  checks.push('执行授权不授予平台数据权限，提交时平台撤权会失败');
  }
  passed=true;
} finally {
  await mkdir('.local/checks',{recursive:true});
  await writeFile(`.local/checks/conversational-query${sourceAdmission?'-source-admission':''}.json`,JSON.stringify({passed,checks,traces,
    toolContractVersion:sourceAdmission?2:1,officialRequests:0,platform:'executable synthetic SQLite',model:'controlled tool inputs'},null,2));
  await h.close();console.log(JSON.stringify({passed,checks,officialRequests:0}));
}
