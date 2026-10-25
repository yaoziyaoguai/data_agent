import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {assetInput, editInput, ok} from './skill-fixtures.mjs';

// 真实 API/MySQL 与合成平台查询；平台来源校验的 HTTP 屏障暴露物理会话锁。
const h = await harness({capture:true, startWorker:false, env:{DATA_AGENT_LEASE_MS:'120000', DATA_AGENT_QUERY_DELAY_SECONDS:'0.1'}});
const checks = [];
let passed = false, run, platform, release, requests = 0, expired = false;
let pending = [];
const manager = SessionManager.inMemory('/synthetic/data-agent');
const checkpoint = () => exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const binding = () => ({run_id:run.run_id, lease_epoch:run.lease_epoch});
const tool = async (tool_name, args) => {
  const input = {...binding(), sdk_tool_call_id:randomUUID(), tool_name, arguments:args, checkpoint:checkpoint()};
  ok(await h.internal('/internal/data/tool-calls', input));
  return ok(await h.internal('/internal/data/tools', input)).data;
};
try {
  const sourceCid = await h.create();
  await h.resumeWorker(); run = await h.capture(sourceCid, '执行合成查询。'); await h.pauseWorker();
  const task = await tool('update_analysis_task', {action:'create', goal:'合成结果', conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''}, options:[]});
  const query = await tool('request_query', {task_id:task.task_id,condition_version:task.condition_version,sql:'SELECT 1 AS amount',parameters:{},target_id:'synthetic-sqlite',summary:'合成查询',knowledge_refs:[],replaces_query_id:null});
  await tool('execute_query', {query_id:query.id,draft_version:query.draft_version,condition_version:query.condition_version,instruction_quote:run.text});
  const text = '已提交合成查询。';
  ok(await h.internal('/internal/outputs', {...binding(),chunk_seq:'1',text}));
  ok(await h.internal('/internal/finish', {...binding(),commit_id:run.output_id,final_text:text,checkpoint:checkpoint()}));
  h.releaseRun(run.run_id); await h.resumeWorker();
  const result = await until(() => {
    const row = h.sql(`SELECT JSON_OBJECT('state',execution_state,'ref',result_ref) FROM query_requests WHERE id='${query.id}'`)[0];
    return row.state === 'succeeded' && row;
  }, '合成平台查询完成');
  await h.pauseWorker();
  for (const message of h.sql(`SELECT JSON_OBJECT('id',id) FROM conversation_messages WHERE conversation_id='${sourceCid}' AND disposition='pending'`)) {
    ok(await h.request(`/conversations/${sourceCid}/messages/${message.id}/withdraw`, {operation_id:randomUUID()}));
    for (const captured of h.captured.filter(r => r.message_id === message.id)) h.releaseRun(captured.run_id);
  }
  const asset = ok(await h.request('/assets', assetInput()));
  // 预置已持久的模型字段来源，结果身份来自上面的真实执行；不让选择输入自行声明来源。
  const authority = {dependency_schema:5,sources:[],knowledge:[],memories:[],skills:[],query_results:[],source_skills:[],source_query_results:[[query.id,result.ref]]};
  const fields = h.sql(`SELECT field_authorities FROM personal_assets WHERE id='${asset.id}'`)[0];
  fields.body = {origin:'generated', authority};
  const encoded = Buffer.from(JSON.stringify(fields)).toString('hex');
  h.sql(`UPDATE personal_assets SET field_authorities=CONVERT(0x${encoded} USING utf8mb4) WHERE id='${asset.id}'; UPDATE personal_asset_versions SET field_authorities=CONVERT(0x${encoded} USING utf8mb4) WHERE asset_id='${asset.id}';`);
  await h.pausePlatform();
  let gate;
  platform = createServer(async (req, res) => {
    for await (const _ of req) {}
    assert.equal(req.url, '/result-authority'); requests++;
    await gate;
    if (expired) {res.writeHead(409, {'content-type':'application/json'}); res.end(JSON.stringify({code:'result_expired'})); return;}
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({query_id:query.id,owner_id:'alice',result_ref:result.ref,state:'available',source:'mock',saved_row_count:1,saved_result_complete:true}));
  });
  await new Promise(r => platform.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port), '127.0.0.1', r));
  const heldSelection = async (cid, input) => {
    gate = new Promise(r => {release = r;}); const before = requests;
    const response = h.request(`/conversations/${cid}/skill-selections`, input);
    pending.push(response);
    await until(() => requests > before, '选择已等待平台授权');
    const rows = h.sql(`SET SESSION innodb_lock_wait_timeout=1; START TRANSACTION; SELECT JSON_OBJECT('id',id) FROM conversations WHERE id='${cid}' FOR UPDATE; COMMIT;`);
    assert.deepEqual(rows, [{id:cid}], '平台慢读取不得持有会话锁');
    return {response};
  };
  const cid = await h.create();
  const input = {operation_id:randomUUID(),asset_id:asset.id,version:asset.version};
  const first = await heldSelection(cid, input);
  const replay = h.request(`/conversations/${cid}/skill-selections`, input); pending.push(replay);
  release(); const original = ok(await first.response); assert.deepEqual(ok(await replay), original);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM skill_selections WHERE conversation_id='${cid}'`)[0].n, 1);
  checks.push('平台来源等待不持会话锁；并发同参选择只保存一次且返回同一回执');

  // 启动时还没有run心跳，已领取的job仍须在平台来源检查期间续租。
  gate = new Promise(r => {release = r;}); const beforeStartup = requests;
  h.env.DATA_AGENT_LEASE_MS = '2400';
  const startupMessage = await h.send(cid, '使用已选择的合成方法。');
  await h.resumeWorker();
  await until(() => requests > beforeStartup, '启动上下文等待平台授权');
  const jobState = () => h.sql(`SELECT JSON_OBJECT('epoch',lease_epoch,'valid',lease_until>UTC_TIMESTAMP(3),'attempts',attempts) FROM background_jobs WHERE message_id='${startupMessage.message_id}'`)[0];
  const preparing = jobState(); await delay(3200);
  assert.deepEqual(jobState(), {...preparing,valid:true}, '启动慢校验跨多个租约周期仍沿原job续租');
  release();
  const started = await until(() => h.captured.find(r => r.message_id === startupMessage.message_id), '原job建立一次运行');
  await h.pauseWorker();
  ok(await h.request(`/conversations/${cid}/messages/${startupMessage.message_id}/withdraw`, {operation_id:randomUUID()}));
  h.releaseRun(started.run_id);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM agent_runs WHERE message_id='${startupMessage.message_id}'`)[0].n, 1);
  checks.push('启动来源检查跨3.2秒仍续2400ms job租约，原代次只建立一个运行');

  const busyCid = await h.create();
  const busy = await heldSelection(busyCid, {...input,operation_id:randomUUID()});
  await h.send(busyCid, '新的待处理用户消息'); release();
  assert.equal((await busy.response).value.code, 'message_pending');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM skill_selections WHERE conversation_id='${busyCid}'`)[0].n, 0);
  checks.push('等待期间收到用户消息，最终事务拒绝选择而不修改会话');

  const changedCid = await h.create();
  const changed = await heldSelection(changedCid, {...input,operation_id:randomUUID()});
  ok(await h.request('/assets', editInput(asset, {body:'完全人工重写的新正文'})));
  release(); assert.equal((await changed.response).value.code, 'version_conflict');
  assert.deepEqual(ok(await h.request(`/conversations/${cid}/skill-selections`, input)), original);
  checks.push('锁外等待后重核资产版本；原成功操作仍接回旧回执且不重新激活');
  expired = true;
  const hidden = ok(await h.request(`/conversations/${cid}/skill-selections`, input));
  assert.equal(hidden.text_unavailable, true, '成功重放也不得再次交付失效来源正文');
  assert.equal(hidden.body, ''); assert.deepEqual(hidden.files, []);
  assert.equal(hidden.id, original.id);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM skill_selections WHERE conversation_id='${cid}'`)[0].n, 1);
  checks.push('来源结果过期后原选择仍成功接回控制身份，正文隐藏且选择不重做');
  passed = true;
} finally {
  release?.(); await Promise.allSettled(pending);
  if (platform) await new Promise(r => platform.close(r));
  if (run) h.releaseRun(run.run_id);
  await h.close();
  await writeFile('.local/checks/skill-selection-locks.json', JSON.stringify({passed, checks, officialRequests:0}, null, 2));
}
console.log(JSON.stringify({passed, checks, officialRequests:0}));
