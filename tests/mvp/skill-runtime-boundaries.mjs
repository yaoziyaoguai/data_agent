import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager, ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {selectedSkillResources} from '../../apps/agent/session/skills.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
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
  const path=`/skills/${shared.id}/1/SKILL.md`;
  await data.tools.find(v=>v.name==='read').execute('public-read',{path});
  ok(await h.request(`/assets/${shared.id}/disable`,{operation_id:randomUUID(),expected_version:shared.version}));
  const issuance=await h.internal('/internal/model/issue',{run_id:pending.run_id,lease_epoch:pending.lease_epoch,call_attempt_id:randomUUID()});
  assert.equal(issuance.value.code,'stale_context');
  await assert.rejects(data.tools.find(v=>v.name==='read').execute('public-read-after-disable',{path}));
  const job=h.sql(`SELECT JSON_OBJECT('id',id) FROM background_jobs WHERE message_id='${pending.message_id}'`)[0];
  const captured=h.captured.length;h.releaseRun(pending.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${pending.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${interruptedCid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${pending.message_id}';`);
  await h.resumeWorker();
  await until(()=>h.logs.some(log=>log.output.includes(`delivery_rejected job=${job.id} code=stale_context`)),'same-input recovery refuses disabled public Skill');
  await h.pauseWorker();assert.ok(!h.captured.slice(captured).some(v=>v.conversation_id===interruptedCid));
  checks.push('公共Skill读取后停用，下一次模型准入/读取与同输入恢复均拒绝，旧正文不再送模型');
  shared=ok(await h.request(`/assets/${shared.id}/enable`,{operation_id:randomUUID(),expected_version:'2'}));
  // 公共方法已经选用，也不能替代平台的执行授权。
  const queryCid = await h.create(); ok(await select(h,queryCid,shared));
  await writeFile(h.directory+'/platform/permissions.json',JSON.stringify({denied_query_users:['alice']}));
  await h.resumeWorker(); const queryRun = await h.capture(queryCid,'查2026年1月净收入'); await h.pauseWorker();
  await deliver(queryRun,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''); h.releaseRun(queryRun.run_id);
  const query = ok(await h.request(`/conversations/${queryCid}/queries`)).queries[0]; assert.ok(query); assert.equal(query.execution_state,'not_submitted');
  ok(await h.request(`/queries/${query.id}/confirm`,{operation_id:randomUUID(),draft_version:query.draft_version,condition_version:query.condition_version}));
  await h.resumeWorker();
  const denied = await until(async()=>{const q=ok(await h.request('/queries/'+query.id));return ['failed','succeeded'].includes(q.execution_state)&&q;},'public Skill does not grant query permission');
  await h.pauseWorker();assert.equal(denied.execution_state,'failed');assert.equal(denied.error,'forbidden');
  // 捕获器不会解释查询结果；结束本测试目标，避免待处理的结果唤醒占住下一场景。
  ok(await h.request(`/conversations/${queryCid}/tasks/${query.task_id}/cancel`,{operation_id:randomUUID(),expected_version:query.condition_version}));
  for(const capturedRun of h.captured.filter(value=>value.conversation_id===queryCid))h.releaseRun(capturedRun.run_id);
  await writeFile(h.directory+'/platform/permissions.json','{}');
  checks.push('已选公共Skill的查询仍等待确认；确认后平台拒绝执行权，宿主明确返回forbidden');
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
  h.sql('RENAME TABLE source_heads TO temporarily_unavailable_source_heads');
  try {
    await assert.rejects(controlled.invokeRecorded('read','dependent-read',readArgs),/unavailable/);
    assert.deepEqual(await controlled.invokeRecorded('update_analysis_task','dependent-route',routeArgs),routeReceipt);
  } finally { h.sql('RENAME TABLE temporarily_unavailable_source_heads TO source_heads'); }
  assert.deepEqual(await controlled.invokeRecorded('read','dependent-read',readArgs),readReceipt);
  const operationCount=h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${dependentCid}' AND sdk_tool_call_id='dependent-read'`)[0];
  assert.equal(operationCount.n,1);
  ok(await h.request(`/conversations/${dependentCid}/messages/${dependentRun.message_id}/withdraw`,{operation_id:randomUUID()}));h.releaseRun(dependentRun.run_id);
  checks.push('依赖核验故障时重复read明确失败，恢复后原身份可重试；已提交写操作仍接回原回执');
}
