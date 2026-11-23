import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager, ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {selectedSkillResources} from '../../apps/agent/session/skills.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {taskProjection} from '../../apps/agent/session/task-projection.ts';
import {assetInput, ok, select} from './skill-fixtures.mjs';
import {until} from './harness.mjs';

export async function checkSkillRuntimeBoundaries(h, checks) {
  const originalRegister = ModelRuntime.prototype.registerProvider;
  const privateSkill = ok(await h.request('/assets', assetInput({body:'只有受控读取才能看到的正文。'})));
  let shared = ok(await h.request(`/assets/${privateSkill.id}/publish`, {operation_id:randomUUID(), expected_version:privateSkill.version, share_confirmed:true}));
  const cid = await h.create(); ok(await select(h, cid, shared));
  // 命令名字确实匹配原生目录，但此网页输入仍须保持字面消息。
  const name = selectedSkillResources([{...shared, native_path:`/skills/${shared.id}/1/SKILL.md`}])[0].name;
  const literal = `/skill:${name} 只是讨论这个名称`;
  await h.resumeWorker(); const run = await h.capture(cid, literal); await h.pauseWorker();
  let calls = 0;
  ModelRuntime.prototype.registerProvider = function(provider, configuration) {
    return originalRegister.call(this, provider, {...configuration, streamSimple(model, context) {
      const user = context.messages.findLast(message => message.role === 'user');
      const text = typeof user.content === 'string' ? user.content : user.content.map(v => v.text ?? '').join('');
      assert.equal(text, literal); assert.ok(!JSON.stringify(context).includes('只有受控读取才能看到的正文'));
      const content = calls++ === 0 ? [{type:'toolCall', id:'literal-route', name:'update_analysis_task', arguments:{action:'route', task_id:null, expected_version:null, goal:'', question:null, options:[]}}] : [{type:'text', text:'已按字面收到名称。'}];
      const message = {role:'assistant', api:model.api, provider:model.provider, model:model.id, content, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp:Date.now(), usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      const stream = createAssistantMessageEventStream(); stream.push({type:'start', partial:message});
      if (content[0].type === 'text') stream.push({type:'text_delta', contentIndex:0, delta:content[0].text, partial:message});
      stream.push({type:'done', reason:message.stopReason, message}); return stream;
    }});
  };
  try { await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''); }
  finally { ModelRuntime.prototype.registerProvider = originalRegister; }
  h.releaseRun(run.run_id); assert.equal(calls,2);
  checks.push('/skill:匹配真实目录名称仍保持字面输入，不直接展开文件或绕过受控read');

  const interruptedCid = await h.create();ok(await select(h,interruptedCid,shared));
  await h.resumeWorker();const pending = await h.capture(interruptedCid,'读取公共方法后继续');await h.pauseWorker();
  const manager=SessionManager.inMemory('/synthetic/data-agent');manager.appendMessage({role:'user',content:pending.text,timestamp:Date.now()});
  const data = dataTools(new RustTransport(pending,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN),manager,'');
  const binding = {run_id:pending.run_id,lease_epoch:pending.lease_epoch};
  await data.invokeRecorded('update_analysis_task','public-skill-route',
    {action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]});
  const path=`/skills/${shared.id}/1/SKILL.md`;
  const originalRead=await data.tools.find(v=>v.name==='read').execute('public-read',{path});
  assert.match(originalRead.content[0].text,/只有受控读取才能看到的正文/);
  const finalText='合成方法使用结论。';
  ok(await h.internal('/internal/outputs',{...binding,chunk_seq:'1',text:finalText}));
  ok(await h.request(`/assets/${shared.id}/disable`,{operation_id:randomUUID(),expected_version:shared.version}));
  const issuance=await h.internal('/internal/model/issue',{...binding,call_attempt_id:randomUUID()});
  const sending=await h.internal('/internal/model/send',{...binding,call_attempt_id:randomUUID(),
    parameters_fingerprint:'7'.repeat(64)});
  const completion=await h.internal('/internal/finish',{...binding,commit_id:pending.output_id,
    final_text:finalText,checkpoint:exportCheckpoint(manager)});
  for(const result of [issuance,sending,completion]){
    assert.equal(result.status,409,JSON.stringify(result.value));
    assert.equal(result.value.code,'stale_context');
  }
  const deniedRead=await data.tools.find(v=>v.name==='read').execute('public-read-after-disable',{path});
  assert.equal(deniedRead.isError,true);
  const deniedText=deniedRead.content.map(block=>block.text).join('');
  assert.match(deniedText,/"error"\s*:\s*"(not_available|forbidden|stale_knowledge|stale_context)"/);
  assert.ok(!deniedText.includes('只有受控读取才能看到的正文'));
  const job=h.sql(`SELECT JSON_OBJECT('id',id) FROM background_jobs WHERE message_id='${pending.message_id}'`)[0];
  const captured=h.captured.length;h.releaseRun(pending.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${pending.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${interruptedCid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${pending.message_id}';`);
  await h.resumeWorker();
  await until(()=>h.logs.some(log=>log.output.includes(`delivery_rejected job=${job.id} code=stale_context`)),'same-input recovery refuses disabled public Skill');
  assert.ok(!h.captured.slice(captured).some(v=>v.conversation_id===interruptedCid));
  const next=await h.capture(interruptedCid,'停用后分析新问题');await h.pauseWorker();
  assert.equal(next.checkpoint,null);
  assert.ok(!next.workspace_context.selected_skills.some(v=>v.id===shared.id));
  ok(await h.request(`/conversations/${interruptedCid}/messages/${next.message_id}/withdraw`,{operation_id:randomUUID()}));h.releaseRun(next.run_id);
  checks.push('公共Skill停用后下一次模型发送、普通定稿、再次精读及原输入恢复拒绝；新输入无旧正文并能继续');
  shared=ok(await h.request(`/assets/${shared.id}/enable`,{operation_id:randomUUID(),expected_version:'2'}));
  // 公共方法已经选用，也不能替代平台的执行授权。
  const queryCid = await h.create(); ok(await select(h,queryCid,shared));
  const permissionsPath=h.directory+'/platform/permissions.json';
  const deniedPermissions=JSON.stringify({denied_query_users:['alice']});
  await writeFile(permissionsPath,deniedPermissions);
  await h.resumeWorker(); const queryRun = await h.capture(queryCid,'查2026年1月净收入'); await h.pauseWorker();
  await deliver(queryRun,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''); h.releaseRun(queryRun.run_id);
  const query = ok(await h.request(`/conversations/${queryCid}/queries`)).queries[0]; assert.ok(query); assert.equal(query.execution_state,'not_submitted');
  const confirmPath=`/queries/${query.id}/confirm`;
  const confirmation={operation_id:randomUUID(),draft_version:query.draft_version,condition_version:query.condition_version};
  const refusedConfirmation=await h.request(confirmPath,confirmation);
  assert.equal(refusedConfirmation.status,403);
  assert.equal(refusedConfirmation.value.code,'forbidden');
  assert.equal(ok(await h.request(`/queries/${query.id}`)).execution_state,'not_submitted');
  await writeFile(permissionsPath,'{}');
  ok(await h.request(confirmPath,confirmation));
  await writeFile(permissionsPath,deniedPermissions);
  await h.resumeWorker();
  const denied = await until(async()=>{const q=ok(await h.request('/queries/'+query.id));return ['failed','succeeded'].includes(q.execution_state)&&q;},'public Skill does not grant query permission');
  await h.pauseWorker();assert.equal(denied.execution_state,'failed');assert.equal(denied.error,'forbidden');
  // 捕获器不会解释查询结果；结束本测试目标，避免待处理的结果唤醒占住下一场景。
  ok(await h.request(`/conversations/${queryCid}/tasks/${query.task_id}/cancel`,{operation_id:randomUUID(),expected_version:query.condition_version}));
  for(const capturedRun of h.captured.filter(value=>value.conversation_id===queryCid))h.releaseRun(capturedRun.run_id);
  await writeFile(permissionsPath,'{}');
  checks.push('已选公共Skill不能代替确认和执行权限；撤权时确认与提交分别返回forbidden');
  const table = ok(await h.request('/knowledge/table-demo_order_detail'));
  const dependent = ok(await h.request('/assets',assetInput({body:'依赖核验后才可读取的合成正文',dependencies:[{object_id:table.id,version:table.version,path:table.entries[0].entry_id}]})));
  const dependentCid = await h.create(); ok(await select(h,dependentCid,dependent));
  await h.resumeWorker(); const dependentRun = await h.capture(dependentCid,'读取含依赖的方法'); await h.pauseWorker();
  const controlled = dataTools(new RustTransport(dependentRun,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN),SessionManager.inMemory('/synthetic/data-agent'),'');
  const readArgs = {path:`/skills/${dependent.id}/${dependent.version}/SKILL.md`};
  const routeArgs = {action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]};
  const readReceipt = await controlled.invokeRecorded('read','dependent-read',readArgs);
  const routeReceipt = await controlled.invokeRecorded('update_analysis_task','dependent-route',routeArgs);
  assert.match(readReceipt.data.text,/依赖核验后才可读取/);
  await writeFile(permissionsPath,JSON.stringify({table_readers:{demo:{alice:[]}}}));
  const revokedDependency = await h.internal('/internal/model/issue',{
    run_id:dependentRun.run_id,lease_epoch:dependentRun.lease_epoch,call_attempt_id:randomUUID(),
  });
  assert.equal(revokedDependency.status,409);
  assert.equal(revokedDependency.value.code,'stale_context');
  await writeFile(permissionsPath,'{}');
  h.sql('RENAME TABLE source_heads TO temporarily_unavailable_source_heads');
  try {
    await assert.rejects(controlled.invokeRecorded('read','dependent-read',readArgs),/unavailable/);
    const {frozen_notification_covered: _currentCoverage, ...savedOperation}=routeReceipt;
    const replayed=await controlled.invokeRecorded('update_analysis_task','dependent-route',routeArgs);
    assert.equal('frozen_notification_covered' in replayed,false,'历史操作回执不改写当前通知覆盖事实');
    assert.deepEqual(replayed,savedOperation);
  } finally { h.sql('RENAME TABLE temporarily_unavailable_source_heads TO source_heads'); }
  assert.deepEqual(await controlled.invokeRecorded('read','dependent-read',readArgs),readReceipt);
  const operationCount=h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${dependentCid}' AND sdk_tool_call_id='dependent-read'`)[0];
  assert.equal(operationCount.n,1);
  await h.pausePlatform();
  const priorAttempts = h.sql(`SELECT JSON_OBJECT('n',attempts) FROM background_jobs WHERE message_id='${dependentRun.message_id}'`)[0].n;
  const preceding = h.captured.length;
  h.releaseRun(dependentRun.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${dependentRun.run_id}';
    UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${dependentCid}';
    UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${dependentRun.message_id}';`);
  await h.resumeWorker();
  await until(()=>h.logs.some(log=>log.output.includes('delivery_rejected')&&log.output.includes('code=source_unavailable')),
    '暂时无法核验平台权限时，等待原输入恢复');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',attempts) FROM background_jobs WHERE message_id='${dependentRun.message_id}'`)[0].n,priorAttempts);
  assert.equal(h.captured.length,preceding);
  await h.resumePlatform();
  const resumed=await until(()=>h.captured.slice(preceding).find(run=>run.message_id===dependentRun.message_id),
    '平台恢复后接回原输入');
  await h.pauseWorker();
  assert.equal(resumed.resume_same_input,true);
  assert.equal(resumed.recovery_chain_id,dependentRun.recovery_chain_id);
  assert.equal(resumed.budget_scope_id,dependentRun.budget_scope_id);
  ok(await h.request(`/conversations/${dependentCid}/messages/${dependentRun.message_id}/withdraw`,{operation_id:randomUUID()}));h.releaseRun(resumed.run_id);
  checks.push('Skill 依赖撤权阻断发送，回执可沿原身份重读；平台暂不可达等待原输入，恢复后保留原恢复链和预算');

  const scopedCid = await h.create(); ok(await select(h,scopedCid,dependent));
  await h.resumeWorker();
  const scopedRun = await h.capture(scopedCid,'先核对选用的方法，然后只用表 table-demo_order_detail 继续分析。');
  await h.pauseWorker();
  const scopedManager = SessionManager.inMemory('/synthetic/data-agent');
  scopedManager.appendMessage({role:'user',content:scopedRun.text,timestamp:Date.now()});
  const scopedTransport = new RustTransport(scopedRun,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN);
  const projection = taskProjection(scopedTransport,scopedManager,()=>{});
  const scopedTools = dataTools(scopedTransport,scopedManager,'',(receipt,sdk)=>projection.acceptReceipt(receipt,sdk));
  const scopedCall = async(name,args) => {
    const sdk = randomUUID();
    scopedManager.appendMessage({role:'assistant',api:'openai-completions',provider:'local_mock',model:'task_demo',
      content:[{type:'toolCall',id:sdk,name,arguments:args}],stopReason:'toolUse',timestamp:Date.now(),
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const receipt = await scopedTools.invokeRecorded(name,sdk,args);
    assert.equal(receipt.data.error,undefined,JSON.stringify(receipt.data));
    scopedManager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:name,...await scopedTools.formatResult(name,args,receipt),timestamp:Date.now()});
    return receipt;
  };
  const first = await scopedCall('update_analysis_task',{action:'create',goal:'核对合成订单表',options:[],conditions:{
    time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],
    knowledge_refs:[],notes:'仅核对口径',source_limits:null,
  }});
  await projection.apply();
  await scopedCall('read',readArgs);
  const containsRead = () => JSON.stringify(scopedManager.buildSessionContext().messages).includes('依赖核验后才可读取');
  assert.equal(containsRead(),true);
  const narrowed = await scopedCall('update_analysis_task',{action:'revise',task_id:first.data.task_id,
    expected_version:first.data.condition_version,options:[],condition_patch:{set:{source_limits:{
      allowed_sources:[{kind:'platform',id:table.id}],origin_message_ids:[]}},unset:[]}});
  assert.ok(narrowed.context_reset);
  await projection.apply();
  assert.equal(containsRead(),false);
  assert.ok(scopedRun.workspace_context.selected_skills.some(asset=>asset.id===dependent.id));
  ok(await h.request(`/assets/${dependent.id}/disable`,{operation_id:randomUUID(),expected_version:dependent.version}));
  const allowed = {...scopedTransport.binding(),call_attempt_id:randomUUID()};
  ok(await h.internal('/internal/model/issue',allowed));
  ok(await h.internal('/internal/model/settle',allowed));
  const scopedText = '当前任务已按合成订单表限定资料范围。';
  ok(await h.internal('/internal/outputs',{...scopedTransport.binding(),chunk_seq:'1',text:scopedText}));
  ok(await h.internal('/internal/finish',{...scopedTransport.binding(),commit_id:scopedRun.output_id,
    final_text:scopedText,checkpoint:exportCheckpoint(scopedManager)}));
  h.releaseRun(scopedRun.run_id);
  checks.push('真实范围切换移除旧精读、保留可选描述，停用旧正文所属 Skill 不阻断新分支');

  const answers = [];
  for (const notification of [true, false]) {
    const answerSkill = ok(await h.request('/assets', assetInput({body:'合成行数解释方法。'})));
    const answerCid = await h.create();
    ok(await select(h, answerCid, answerSkill));
    await h.resumeWorker();
    let turn = await h.capture(answerCid, '准备合成金额查询，先不执行。');
    await h.pauseWorker();
    const journal = SessionManager.inMemory('/synthetic/data-agent');
    const envelope = () => ({run_id:turn.run_id, lease_epoch:turn.lease_epoch});
    const invoke = async (tool_name, args, sdk = randomUUID()) => {
      const input = {...envelope(), sdk_tool_call_id:sdk, tool_name, arguments:args,
        checkpoint:exportCheckpoint(journal)};
      ok(await h.internal('/internal/data/tool-calls',input));
      const receipt = ok(await h.internal('/internal/data/tools',input));
      assert.ok(receipt.data.error == null, JSON.stringify(receipt.data));
      return receipt.data;
    };
    const finishPlain = async text => {
      ok(await h.internal('/internal/outputs',{...envelope(),chunk_seq:'1',text}));
      ok(await h.internal('/internal/finish',{...envelope(),commit_id:turn.output_id,
        final_text:text,checkpoint:exportCheckpoint(journal)}));
      h.releaseRun(turn.run_id);
    };
    const task = await invoke('update_analysis_task',{action:'create',goal:'合成金额查询',options:[],conditions:{
      time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],
      knowledge_refs:[],notes:'',source_limits:null,
    }});
    const preparedQuery = await invoke('request_query',{task_id:task.task_id,condition_version:task.condition_version,
      sql:'SELECT 42 AS amount',parameters:{},target_id:'synthetic-sqlite',summary:'合成金额',knowledge_refs:[]});
    await finishPlain('合成查询已准备。');
    ok(await h.request('/queries/'+preparedQuery.id+'/confirm',{operation_id:randomUUID(),
      draft_version:preparedQuery.draft_version,condition_version:preparedQuery.condition_version}));
    await h.resumeWorker();
    turn = await until(()=>h.captured.find(value=>value.workspace_context?.result_notification?.query_id===preparedQuery.id),
      '合成结果通知');
    await h.pauseWorker();
    if (!notification) {
      await finishPlain('结果已保存，可以继续解释。');
      await h.resumeWorker();
      turn = await h.capture(answerCid, '显示已保存的合成金额。');
      await h.pauseWorker();
    }
    assert.equal(Boolean(turn.workspace_context.result_notification),notification);
    assert.ok(turn.workspace_context.selected_skills.some(asset=>asset.id===answerSkill.id));
    await invoke('update_analysis_task',{action:'route',task_id:task.task_id,expected_version:task.condition_version,options:[]});
    if (notification) {
      const used = await invoke('read',{path:`/skills/${answerSkill.id}/${answerSkill.version}/SKILL.md`});
      assert.match(used.text,/合成行数解释方法/);
    }
    const result = (await invoke('get_query',{query_id:preparedQuery.id})).results;
    const sdk = randomUUID();
    const preparation = await invoke('prepare_analysis_answer',{
      sources:[{query_id:preparedQuery.id,result_ref:result.result_ref,columns:['amount']}],
      values:[{name:'amount',kind:'cell',query_id:preparedQuery.id,column:'amount',row_index:0}],
    },sdk);
    assert.equal(preparation.bindings.amount,'42');
    const source = '合成金额{{amount}}分。';
    const text = '合成金额42分。'+preparation.required_suffix;
    journal.appendMessage({role:'assistant',api:'openai-completions',provider:'local_mock',model:'task_demo',
      content:[{type:'text',text:source}],stopReason:'stop',timestamp:Date.now(),
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    ok(await h.internal('/internal/outputs',{...envelope(),chunk_seq:'1',text}));
    ok(await h.request(`/assets/${answerSkill.id}/disable`,{
      operation_id:randomUUID(),expected_version:answerSkill.version}));
    const completion = await h.internal('/internal/finish',{...envelope(),commit_id:turn.output_id,
      final_text:text,checkpoint:exportCheckpoint(journal), rendered_answer_binding:{
        assistant:{entry_id:journal.getLeafId(),attempt_id:turn.attempt_id,stop_reason:'stop',tool_call_ids:[],
          text_sha256:createHash('sha256').update(source).digest('hex'),first_chunk_seq:'1',last_chunk_seq:'1'},
        source_text:source,prepared_sdk_tool_call_id:sdk,first_chunk_seq:'1',last_chunk_seq:'1',
      }});
    const stored = h.sql(`SELECT JSON_OBJECT('state',state) FROM assistant_outputs WHERE attempt_id='${turn.attempt_id}'`)[0].state;
    answers.push([completion.status,completion.value.code ?? null,stored === 'committed']);
    h.releaseRun(turn.run_id);
  }
  assert.deepEqual(answers, [[409,'stale_context',false],[200,null,true]],
    '结果通知已精读的 Skill 停用后拒绝定稿，普通回答只见目录的 Skill 停用后继续定稿');
  checks.push('查询结果通知与普通回答按实际精读 Skill 定稿，停用目录项不影响独立结果');
}
