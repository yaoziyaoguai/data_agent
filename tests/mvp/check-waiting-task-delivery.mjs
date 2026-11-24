import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { exportCheckpoint, restoreCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { RustTransport } from "../../apps/agent/transport/client.ts";
import { workspaceContext } from "../../apps/agent/session/workspace-context.ts";
import { harness, until } from "./harness.mjs";

// 完整自然说明与查询等待状态分开；文本不产生执行权，来源和原输出绑定仍由宿主核验。
const sameTaskOnly = process.argv.includes("--same-task-explanation");
const profile = { provider_id: "deepseek", model_id: "deepseek-flash", trial_id: randomUUID(),
  price_version: "2026-10-04-peak-usd", input_limit: 65536, output_limit: 2048,
  trial_call_limit: 48, trial_cost_micros: "1000000", request_call_limit: 24,
  toolset: "data", payload_bytes_limit: 131072 };
const conditions = { time_start: null, time_end: null, timezone: "UTC", metric: null,
  channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "合成等待/澄清交付", source_limits: null };
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
let h, run, manager, plan, protocolFailure, passed = false;
let calls = 0, interruptFinish = false, interrupted = false, advanceBeforeFinish = null, d2;
let summaries = 0;
const checks = [];
const originalPost = RustTransport.prototype.post;
RustTransport.prototype.post = async function(path, name, input, ...rest) {
  // 本地控制投影尚未送达finish时中断；未发布尾部不能冒充宿主恢复leaf。
  if (interruptFinish && !interrupted && path === "/internal/finish" && input.control_delivery_ref) {
    interrupted = true;
    controller.abort();
    throw new Error("synthetic_control_interrupted");
  }
  // 投影之后、finish之前推进查询终态：控制确认提交时查询已完成。
  if (advanceBeforeFinish && path === "/internal/finish" && input.control_delivery_ref) {
    h.sql(`UPDATE query_requests SET execution_state='succeeded' WHERE id=${quote(advanceBeforeFinish)};`);
    advanceBeforeFinish = null;
  }
  return originalPost.call(this, path, name, input, ...rest);
};
let controller;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-protocol-key");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
    const summary = !body.tools?.length;
    if (!summary && (!plan || plan.index >= plan.steps.length))
      throw new Error("控制交付不得追加无法满足的模型回合 " + JSON.stringify(body.messages.slice(-3)));
    const step = summary ? {text: "合成历史摘要：已保存的查询仍待确认，正式交付以宿主事实为准。"} : plan.steps[plan.index++];
    if (summary) summaries++;
    if (step.observe) step.observe(body);
    calls++;
    const delta = step.name
      ? { role: "assistant", content: step.text ?? "正在核对宿主状态。", tool_calls: [{
          index: 0, id: randomUUID(), type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) },
        }] }
      : { role: "assistant", content: step.text ?? "" };
    const chunk = (value, reason = null) => ({ id: "synthetic-waiting", object: "chat.completion.chunk",
      created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: value, finish_reason: reason }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify(chunk(delta)) + "\n\n");
    response.write("data: " + JSON.stringify(chunk({}, step.name ? "tool_calls" : "stop")) + "\n\n");
    response.write("data: " + JSON.stringify({ id: "synthetic-waiting", choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } }) + "\n\n");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    protocolFailure = error;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "synthetic_waiting_assertion_failed" } }));
  }
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const baseUrl = "http://127.0.0.1:" + provider.address().port;
const previous = Object.fromEntries(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DATA_AGENT_PROVIDER_TEST", "DATA_AGENT_TEST_COMPACT"]
  .map(key => [key, process.env[key]]));
const attach = value => { run = value; manager = SessionManager.inMemory("/synthetic/data-agent"); };
const binding = () => ({ run_id: run.run_id, lease_epoch: run.lease_epoch });
const checkpoint = () => exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const tool = async (name, args) => {
  const input = { ...binding(), sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args, checkpoint: checkpoint() };
  ok(await h.internal("/internal/data/tool-calls", input));
  return ok(await h.internal("/internal/data/tools", input)).data;
};
const finishNatural = async text => {
  ok(await h.internal("/internal/outputs", { ...binding(), chunk_seq: "1", text }));
  ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id, final_text: text, checkpoint: checkpoint() }));
  h.releaseRun(run.run_id);
};
const begin = async (cid, text) => {
  await h.resumeWorker();
  attach(await h.capture(cid, text));
  await h.pauseWorker();
  return run;
};
const committedText = async cid => {
  const snapshot = await h.snapshot(cid);
  const message = snapshot.messages.findLast(item => item.role === "assistant" && item.committed);
  assert.ok(message, "必须有正式提交的助手正文");
  return { snapshot, text: message.text };
};
const controlText = runId => h.sql(`SELECT JSON_OBJECT('t',JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.control_delivery.text'))) AS v
  FROM tool_calls WHERE origin_run_id=${quote(runId)} AND tool_name='update_analysis_task'
  AND JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.control_delivery.text')) IS NOT NULL`)[0]?.t;

try {
  h = await harness({ capture: true, web: true, profile, protocolProviderUrl: baseUrl,
    env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "3", DATA_AGENT_TOOL_CONTRACT_VERSION: "2" } });
  process.env.DEEPSEEK_API_KEY = "synthetic-protocol-key";
  process.env.DEEPSEEK_BASE_URL = baseUrl;
  process.env.DATA_AGENT_PROVIDER_TEST = "1";

  {
    const doc = ok(await h.request('/knowledge', {operation_id:randomUUID(),kind:'document',
      name:'合成缺测说明',body:'没有测量值时保持NULL，不能用零耗时代替。SQL草稿仍须确认后才执行。',related_ids:[]}));
    const cid = await h.create();
    await begin(cid, '准备只读SQL，不执行。');
    const task = await tool('update_analysis_task', {action:'create',goal:'解释缺测并准备核对SQL',conditions,options:[]});
    const query = await tool('request_query', {task_id:task.task_id,condition_version:task.condition_version,
      sql:'SELECT 1 AS samples',parameters:{},target_id:'synthetic-sqlite',summary:'合成核对草稿',knowledge_refs:[],replaces_query_id:null});
    const fabricated = '已执行SQL并得到123条结果。';
    plan = {label:'ordinary-control-kept',index:0,steps:[
      {name:'update_analysis_task',args:{action:'route',task_id:task.task_id,expected_version:task.condition_version,options:[]}},
      {text:fabricated},
    ]};
    await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');
    const ordinary = await committedText(cid);
    assert.equal(ordinary.text,fabricated,'普通完整final必须持久交付，不能被SQL等待投影替换');
    assert.equal(ordinary.snapshot.tasks.find(t=>t.id===task.task_id).phase,'waiting_confirmation');
    const unexecuted = ok(await h.request('/queries/'+query.id));
    assert.equal(unexecuted.execution_state,'not_submitted','自然文本不能提交SQL');
    assert.equal(unexecuted.confirmation_state,'awaiting_confirmation');
    h.releaseRun(run.run_id);
    const prior = await begin(cid, '解释缺测与零的区别，并保留原SQL待确认，不执行。');
    const explanation = '没有测量值时保持NULL，不能用零耗时代替。SQL草稿仍须确认后才执行。';
    plan = {label:'same-task-explanation',index:0,steps:[
      {name:'update_analysis_task',args:{action:'route',task_id:task.task_id,expected_version:task.condition_version,options:[]}},
      {name:'read_knowledge',args:{items:[{kind:'knowledge',ref:{object_id:doc.id,version:doc.version,path:'body'}}]}},
      {text:explanation},
    ]};
    // 通过真正finish发布候选leaf后中断；测试不构造或注入checkpoint。
    h.env.DATA_AGENT_FAULT = 'after_output_checkpoint';
    await h.restartApi();
    protocolFailure = null;
    await assert.rejects(deliver(prior,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''), /unavailable/);
    if (protocolFailure) throw protocolFailure;
    delete h.env.DATA_AGENT_FAULT;
    await h.restartApi();
    const stored = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id=${quote(prior.recovery_chain_id)}`)[0];
    const held = restoreCheckpoint('/synthetic/data-agent',stored);
    const location = held.getBranch().findLast(entry=>entry.type==='custom'&&entry.customType==='data_agent_output_binding');
    assert.equal(location.data.message_id,prior.message_id);
    assert.equal(location.data.output_binding.attempt_id,prior.attempt_id);
    assert.equal(held.getEntry(location.data.output_binding.entry_id)?.type,'message','原助手entry必须存在于实际可恢复leaf');
    assert.equal(held.buildSessionContext().messages.findLast(message=>message.role==='assistant').content
      .filter(part=>part.type==='text').map(part=>part.text).join(''),explanation);
    assert.equal(h.sql(`SELECT JSON_OBJECT('commit_id',commit_id) FROM agent_runs WHERE id=${quote(prior.run_id)}`)[0].commit_id,null);
    const captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
    await h.resumeWorker();
    run = await until(()=>h.captured.slice(captured).find(value=>value.message_id===prior.message_id),'接回完整自然final',40000);
    await h.pauseWorker();
    assert.equal(run.resume_same_input,true);
    assert.equal(run.output_id,prior.output_id);
    assert.equal(run.budget_scope_id,prior.budget_scope_id);
    assert.equal(run.recovery_chain_id,prior.recovery_chain_id);
    assert.notEqual(run.attempt_id,prior.attempt_id);
    const callsBefore = calls;
    plan = {label:'same-task-natural-recovery',index:0,steps:[]};
    try {await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}
    catch(error){throw protocolFailure??error;}
    assert.equal(calls,callsBefore,'完整final及原绑定已发布后恢复不应调用模型');
    const readBinding = h.sql(`SELECT read_binding FROM assistant_outputs WHERE attempt_id=${quote(run.attempt_id)}`)[0];
    assert.deepEqual(readBinding.units[0].chunk_range,{attempt_id:prior.attempt_id,
      first:Number(location.data.output_binding.first_chunk_seq),last:Number(location.data.output_binding.last_chunk_seq)},
      '读取单元必须保留原输出attempt与片段范围');
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM output_chunks WHERE attempt_id=${quote(run.attempt_id)}`)[0].n,0,
      '恢复不能把旧delta重新广播到新attempt');
    const committed = await committedText(cid);
    assert.ok(committed.text.includes(explanation),'同任务已定稿说明不能被待确认SQL控制摘要覆盖');
    assert.equal(committed.snapshot.tasks.find(t=>t.id===task.task_id).phase,'waiting_confirmation');
    const savedQuery = ok(await h.request('/queries/'+query.id));
    assert.equal(savedQuery.execution_state,'not_submitted');
    assert.equal(savedQuery.confirmation_state,'awaiting_confirmation');
    h.releaseRun(run.run_id);
    await h.restartApi();
    assert.ok((await h.snapshot(cid)).messages.some(m=>m.role==='assistant'&&m.text.includes(explanation)),
      '重启和重读仍保留同任务原说明');
    await begin(cid,'保存本任务的中途完整说明，SQL继续待确认。');
    const saveResult = '说明已保存，SQL仍待确认执行。';
    let savedEvidence;
    plan = {label:'explicit-handoff-compatible',index:0,steps:[
      {name:'update_analysis_task',args:{action:'route',task_id:task.task_id,expected_version:task.condition_version,options:[]}},
      {name:'read_knowledge',args:{items:[{kind:'knowledge',ref:{object_id:doc.id,version:doc.version,path:'body'}}]},
        observe:body=>assert.ok(JSON.stringify(body.messages).includes(explanation),'下一轮真实provider输入保留已交付的自然正文')},

      {name:'update_analysis_task',text:explanation,args:{action:'route',task_id:task.task_id,
        expected_version:task.condition_version,options:[],finalize_current_answer:true}},
      {name:'save_analysis_evidence',args:{task_id:task.task_id,condition_version:task.condition_version,
        data_range:'缺测与零的合成资料说明',findings:[{text:explanation,calculation:'查阅合成缺测说明，不含查询结果。',
          limitations:[],query_refs:[],knowledge_refs:[{object_id:doc.id,version:doc.version,path:'body'}],figures:[]}]}},
      // §5.4：实际保存后生成自然尾项；非法尾项退回一次仍不得删除冻结正文。
      {text:'说明已定稿{{，SQL仍待确认。',observe:body=>{
        savedEvidence=JSON.parse(body.messages.findLast(message=>message.role==='tool').content);
        assert.ok(savedEvidence.evidence_id,'必须先取得真实保存成功的依据引用');
        assert.equal(savedEvidence.task_id,task.task_id);
        assert.equal(savedEvidence.condition_version,task.condition_version);
      }},
      {text:saveResult},
    ]};
    await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');
    const handoff = await committedText(cid);
    assert.equal(handoff.text,
      `## 解释缺测并准备核对SQL\n\n${explanation}\n\n---\n\n## 解释缺测并准备核对SQL\n\n${saveResult}`,
      '冻结说明+自然保存结果说明=两内容单元仍一任务；尾项失败不删已冻结正文');
    assert.equal(h.sql(`SELECT body FROM analysis_evidence WHERE id=${quote(savedEvidence.evidence_id)}`)[0].findings[0].text,explanation,
      '保存工具必须实际持久化原任务说明，不能只返回保存文案');
    assert.equal(ok(await h.request('/queries/'+query.id)).execution_state,'not_submitted','保存与尾项不得执行待确认SQL');
    h.releaseRun(run.run_id);
    ok(await h.request('/knowledge/'+doc.id+'/disable',{operation_id:randomUUID(),expected_version:doc.version}));
    assert.ok(!(await h.snapshot(cid)).messages.some(m=>m.role==='assistant'&&m.text.includes(explanation)),
      '说明来源撤回仍隐藏，不能因自然final或同任务定稿放宽来源');
    checks.push({case:'same-task-explanation',explanation_persisted:true,waiting_confirmation_preserved:true,
      source_revocation_protected:true,natural_final_preserved:true,query_not_submitted:true,
      real_published_checkpoint_recovery:true,original_attempt_binding:true,recovery_model_calls:0,explicit_handoff_compatible:true,
      frozen_natural_tail_two_units_one_task:true,evidence_saved_after_freeze:true});
  }
  if (!sameTaskOnly) {
  // 控制正文只采用本人任务的可读字段；来源停用不隐藏本人任务文字，成功重放保持仍有效的
  // 控制候选，原持久回执不改写。失效投影的撤下另由下方任务改版场景覆盖。
  {
    const marker = "SYNTHETIC_REVOKED_CONTROL_TEXT";
    const doc = ok(await h.request("/knowledge", { operation_id: randomUUID(), kind: "document",
      name: "合成控制文字来源", body: marker, related_ids: [] }));
    const unrelated = ok(await h.request("/knowledge", { operation_id: randomUUID(), kind: "document",
      name: "合成无关资料", body: "不参与控制正文", related_ids: [] }));
    const cid = await h.create();
    await begin(cid, "根据合成资料登记需要补充的问题。");
    const task = await tool("update_analysis_task", { action: "create", goal: "合成独立目标",
      conditions: { ...conditions, source_limits: null }, options: [] });
    const input = { ...binding(), sdk_tool_call_id: randomUUID(), tool_name: "update_analysis_task",
      arguments: { action: "clarify", task_id: task.task_id, expected_version: task.condition_version,
        goal: marker + "目标", question: marker + "采用哪个口径？", options: [marker + "甲", marker + "乙"],
        condition_patch: { set: { knowledge_refs: [{ object_id: doc.id, version: doc.version, path: "body" }] }, unset: [] } },
      checkpoint: checkpoint() };
    ok(await h.internal("/internal/data/tool-calls", input));
    const original = ok(await h.internal("/internal/data/tools", input));
    assert.ok(JSON.stringify(original.control_delivery).includes(marker));
    assert.ok(original.control_delivery.text.includes(marker + "采用哪个口径？"), "正式可见控制正文必须包含已保存的问题");
    assert.ok(original.control_delivery.text.includes(marker + "甲") && original.control_delivery.text.includes(marker + "乙"), "已保存选项不能只藏在不可见状态里");
    ok(await h.request(`/knowledge/${unrelated.id}/disable`, { operation_id: randomUUID(), expected_version: unrelated.version }));
    assert.deepEqual(ok(await h.internal("/internal/data/tools", input)).control_delivery, original.control_delivery,
      "无关来源变化不能使合法控制回执失效");
    ok(await h.request(`/knowledge/${doc.id}/disable`, { operation_id: randomUUID(), expected_version: doc.version }));
    const replay = ok(await h.internal("/internal/data/tools", input));
    const projected = workspaceContext({...run.workspace_context, control_delivery: original.control_delivery});
    projected.acceptReceipt({operation_id: "synthetic-no-control-change", tool_name: "read_analysis_task", data: {}});
    assert.equal(projected.control().fingerprint, original.control_delivery.fingerprint, "省略控制字段仍是不更新");
    projected.acceptReceipt({operation_id: "synthetic-rejected-control", tool_name: "request_query", data: {error: "version_conflict"}, control_delivery: null});
    assert.equal(projected.control().fingerprint, original.control_delivery.fingerprint, "失败回执不能改变控制候选");
    projected.acceptReceipt(replay);
    assert.equal(projected.control().fingerprint, original.control_delivery.fingerprint,
      "任务版本未变时成功重放保持原控制候选");
    assert.deepEqual(replay.control_delivery, original.control_delivery, "本人任务已保存的问题与选项不随来源停用隐藏");
    ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id,
      final_text: original.control_delivery.text, control_delivery_ref: { fingerprint: original.control_delivery.fingerprint },
      checkpoint: checkpoint() }));
    const snapshot = await h.snapshot(cid);
    assert.equal(snapshot.messages.find(message => message.role === "assistant" && message.committed)?.text,
      original.control_delivery.text, "已保存的问题与选项经控制正文正式交付");
    assert.equal(snapshot.tasks.find(item => item.id === task.task_id).phase, "waiting_clarification");
    assert.deepEqual(h.sql(`SELECT receipt FROM tool_calls WHERE operation_id=${quote(original.operation_id)}`)[0], original,
      "重放与正式提交不能改写原成功存储");
    // 下一轮仍读到本人任务的持久等待状态。
    h.releaseRun(run.run_id);
    await begin(cid, "继续核对可读的任务状态。");
    const safeInput = { ...binding(), sdk_tool_call_id: randomUUID(), tool_name: "update_analysis_task",
      arguments: { action: "route", task_id: task.task_id, expected_version: original.data.condition_version, options: [] }, checkpoint: checkpoint() };
    ok(await h.internal("/internal/data/tool-calls", safeInput));
    const safe = ok(await h.internal("/internal/data/tools", safeInput));
    assert.ok(safe.control_delivery.text.includes(marker + "采用哪个口径？"), "下一轮仍确认已保存的等待问题");
    ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id,
      final_text: safe.control_delivery.text, control_delivery_ref: { fingerprint: safe.control_delivery.fingerprint }, checkpoint: checkpoint() }));
    h.releaseRun(run.run_id);
    checks.push({ case: "control-text-authority", task_text_kept_after_source_disable: true,
      replay_keeps_control: true, control_committed: true, unrelated_source_ignored: true });
  }

  // 旧控制回执没有文字authority；任务改名后不能用新goal来源为旧正文作保。
  {
    const marker = "SYNTHETIC_LEGACY_CONTROL_GOAL";
    const doc = ok(await h.request("/knowledge", {operation_id: randomUUID(), kind: "document",
      name: "合成旧控制目标来源", body: marker, related_ids: []}));
    const cid = await h.create();
    await begin(cid, "用户明确的新目标原话。");
    const task = await tool("update_analysis_task", {action: "create", goal: marker + "旧目标",
      conditions: {...conditions, source_limits: null, knowledge_refs: [{object_id: doc.id, version: doc.version, path: "body"}]}, options: []});
    await tool("request_query", {task_id: task.task_id, condition_version: task.condition_version,
      sql: "SELECT 40 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成旧目标SQL",
      knowledge_refs: [], replaces_query_id: null});
    const input = {...binding(), sdk_tool_call_id: randomUUID(), tool_name: "update_analysis_task",
      arguments: {action: "route", task_id: task.task_id, expected_version: task.condition_version, options: []}, checkpoint: checkpoint()};
    ok(await h.internal("/internal/data/tool-calls", input));
    const saved = ok(await h.internal("/internal/data/tools", input));
    const legacy = structuredClone(saved);
    delete legacy.control_delivery.text_authority;
    const encoded = Buffer.from(JSON.stringify(legacy)).toString("hex");
    h.sql(`UPDATE tool_calls SET receipt=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE operation_id=${quote(saved.operation_id)}`);
    assert.deepEqual(ok(await h.internal("/internal/data/tools", input)).control_delivery, legacy.control_delivery,
      "文字来源未变时仍接旧回执");
    const revised = await tool("update_analysis_task", {action: "revise", task_id: task.task_id,
      expected_version: task.condition_version, goal: run.text,
      condition_patch: {set: {knowledge_refs: []}, unset: []}, options: []});
    assert.notEqual(revised.condition_version, task.condition_version);
    ok(await h.request(`/knowledge/${doc.id}/disable`, {operation_id: randomUUID(), expected_version: doc.version}));
    const replay = ok(await h.internal("/internal/data/tools", input));
    assert.equal(replay.control_delivery, null, "新goal来源不能替旧控制文字授权");
    assert.equal(JSON.stringify(replay).includes(marker), false);
    assert.deepEqual(h.sql(`SELECT receipt FROM tool_calls WHERE operation_id=${quote(saved.operation_id)}`)[0], legacy);
    const finish = await h.internal("/internal/finish", {...binding(), commit_id: run.output_id,
      final_text: legacy.control_delivery.text, control_delivery_ref: {fingerprint: legacy.control_delivery.fingerprint}, checkpoint: checkpoint()});
    assert.equal(finish.status, 409);
    assert.equal((await h.snapshot(cid)).messages.some(message => message.role === "assistant" && message.committed), false);
    h.releaseRun(run.run_id);
    checks.push({case: "legacy-control-renamed-goal", replay_clears_control: true, original_receipt_preserved: true});
  }

  // 同任务的新保存是新事实，原调用重放仍接回各自回执。
  {
    const cid = await h.create();
    await begin(cid, "保存两条合成SQL草稿，等待我确认。");
    const task = await tool("update_analysis_task", { action: "create", goal: "合成两条草稿",
      conditions: { ...conditions, source_limits: null }, options: [] });
    const saved = [];
    for (const value of [41, 42]) {
      const input = { ...binding(), sdk_tool_call_id: randomUUID(), tool_name: "request_query",
        arguments: { task_id: task.task_id, condition_version: task.condition_version,
          sql: `SELECT ${value} AS value`, parameters: {}, target_id: "synthetic-sqlite",
          summary: "合成SQL草稿", knowledge_refs: [], replaces_query_id: null }, checkpoint: checkpoint() };
      ok(await h.internal("/internal/data/tool-calls", input));
      saved.push({ input, receipt: ok(await h.internal("/internal/data/tools", input)) });
    }
    const [first, second] = saved.map(item => item.receipt);
    assert.notEqual(first.data.id, second.data.id);
    assert.notEqual(first.control_delivery.fingerprint, second.control_delivery.fingerprint);
    assert.match(second.control_delivery.text, /2 条 SQL 已保存/);
    assert.deepEqual(second.control_delivery.facts.map(fact => fact.query_id).sort(), [first.data.id, second.data.id].sort());
    // 重放接回原回执；frozen_notification_covered是启动/刷新的当前事实，重放按合同剥离（data_tools.rs replay_receipt）。
    for (const { input, receipt } of saved) {
      const { frozen_notification_covered: currentFact, ...restored } = receipt;
      assert.equal(currentFact, false, "首次执行回执含通知覆盖当前事实");
      const replayed = ok(await h.internal("/internal/data/tools", input));
      assert.equal("frozen_notification_covered" in replayed, false, "重放不得用历史值覆盖通知覆盖事实");
      assert.deepEqual(replayed, restored, "原调用重放仍接回各自回执");
    }
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE task_id=${quote(task.task_id)}`)[0].n, 2);
    ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id,
      final_text: second.control_delivery.text, control_delivery_ref: { fingerprint: second.control_delivery.fingerprint }, checkpoint: checkpoint() }));
    h.releaseRun(run.run_id);
    checks.push({ case: "control-new-operation-facts", saved: 2, original_replays: true });
  }

  // 已保存第一条SQL后中断在第二条登记处；恢复必须先接原调用再提交控制正文。
  {
    const cid = await h.create();
    await begin(cid, "准备两条合成SQL草稿，随后等待确认。");
    const task = await tool("update_analysis_task", { action: "create", goal: "合成两条草稿恢复",
      conditions: { ...conditions, source_limits: null }, options: [] });
    const draft = { task_id: task.task_id, condition_version: task.condition_version,
      sql: "SELECT 51 AS value", parameters: {}, target_id: "synthetic-sqlite",
      summary: "合成恢复SQL草稿", knowledge_refs: [], replaces_query_id: null };
    const first = await tool("request_query", draft);
    const sdkId = randomUUID();
    const second = { ...draft, sql: "SELECT 52 AS value" };
    manager.appendMessage({ role: "user", content: run.text, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: sdkId, name: "request_query", arguments: second }],
      api: "openai-completions", provider: "deepseek", model: "deepseek-flash", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const registration = ok(await h.internal("/internal/data/tool-calls", { ...binding(), sdk_tool_call_id: sdkId,
      tool_name: "request_query", arguments: second, checkpoint: checkpoint() }));
    const prior = run, captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
    await h.resumeWorker();
    run = await until(() => h.captured.slice(captured).find(value => value.message_id === prior.message_id), "接回第二条SQL登记", 40000);
    await h.pauseWorker();
    assert.equal(run.resume_same_input, true);
    assert.equal(run.budget_scope_id, prior.budget_scope_id);
    assert.equal(run.output_id, prior.output_id);
    plan = { label: "pending-query-recovery", index: 0, steps: [{ text: "两条草稿均已保存，等待确认。" }] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    const { snapshot, text } = await committedText(cid);
    assert.equal(text, "两条草稿均已保存，等待确认。", "接回原调用后的完整自然确认仍应保留");
    assert.equal(snapshot.tasks.find(item => item.id === task.task_id).phase, "waiting_confirmation");
    const ledger = h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'state',state,'started',execution_started,
      'query_id',JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.data.id'))) FROM tool_calls WHERE sdk_tool_call_id=${quote(sdkId)}`)[0];
    assert.equal(ledger.operation, registration.operation_id);
    assert.equal(ledger.origin, prior.run_id);
    assert.equal(ledger.state, "succeeded");
    assert.equal(ledger.started, 1);
    assert.notEqual(ledger.query_id, first.id);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE task_id=${quote(task.task_id)}`)[0].n, 2);
    checks.push({ case: "control-pending-query-recovery", original_operation: true, original_budget: true, saved: 2 });
    h.releaseRun(run.run_id);
  }

  // 查询仍待确认时保存完整自然正文；压缩、后续请求和重启保持该正文，文字不产生执行权。
  {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "准备合成等待查询，随后确认执行。"));
    await h.pauseWorker();
    const task = await tool("update_analysis_task", { action: "create", goal: "核对等待中的查询", conditions, options: [] });
    const query = await tool("request_query", { task_id: task.task_id, condition_version: task.condition_version,
      sql: "SELECT 41 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成等待查询",
      knowledge_refs: [], replaces_query_id: null });
    assert.equal(query.check_state, "passed");
    await finishNatural("合成查询草稿已准备，尚未执行。");

    run = await begin(cid, "请确认刚才保存的SQL。");
    assert.equal(run.tool_contract_version, 2);
    const fabricated = "我已核对两条SQL，结果合计 123 行，可以直接采用。";
    const history = SessionManager.inMemory("/synthetic/data-agent");
    const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
    for (let index = 0; index < 24; index++) {
      history.appendMessage({role: "user", content: "合成旧轮资料".repeat(180), timestamp: index * 2});
      history.appendMessage({role: "assistant", content: [{type: "text", text: "旧轮已记录。"}], usage,
        api: "openai-completions", provider: "deepseek", model: "deepseek-flash", stopReason: "stop", timestamp: index * 2 + 1});
    }
    run.checkpoint = exportCheckpoint(history, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
    plan = { label: "d1-control", index: 0, steps: [
      { name: "update_analysis_task", args: { action: "route", task_id: task.task_id,
        expected_version: task.condition_version, options: [] } },
      { text: fabricated },
    ] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    const { snapshot, text } = await committedText(cid);
    const expected = fabricated;
    assert.ok(controlText(run.run_id), "宿主仍保留可核的查询控制事实");
    assert.equal(text, expected, "完整自然final独立交付，文字不改变执行状态");
    assert.equal(snapshot.tasks.find(item => item.id === task.task_id).phase, "waiting_confirmation");
    const queryState = ok(await h.request(`/queries/${query.id}`));
    assert.equal(queryState.execution_state, "not_submitted");
    assert.equal(queryState.confirmation_state, "awaiting_confirmation");
    const saved = h.sql(`SELECT checkpoint FROM pi_checkpoints
      WHERE recovery_chain_id=${quote(run.recovery_chain_id)}`)[0];
    const restored = restoreCheckpoint("/synthetic/data-agent", saved);
    const projected = restored.buildSessionContext().messages;
    const lastAssistant = projected.findLast(message => message.role === "assistant");
    const projectedText = lastAssistant.content.filter(part => part.type === "text").map(part => part.text).join("");
    assert.equal(projectedText, expected, "Pi投影必须与正式自然正文一致");
    assert.ok(JSON.stringify(projected).includes(fabricated), "已交付完整正文应保留在后续上下文，执行事实另核");
    assert.ok(summaries > 0, "正式deliver必须经过Pi原生压缩");
    assert.equal(restored.getSessionId(), history.getSessionId(), "压缩及交付仍在原Pi会话");
    checks.push({ case: "d1-control", committed: text, phase: "waiting_confirmation",
      query_state: queryState.execution_state, natural_final: true, native_compaction: true });
    h.releaseRun(run.run_id);
    for (const restart of [false, true]) {
      if (restart) await h.restartApi();
      await begin(cid, restart ? "重启后继续确认原状态。" : "下一轮继续确认原状态。");
      const step = {text: "仍等待确认。", observe: body => {
        const input = JSON.stringify(body.messages);
        assert.equal(input.includes(fabricated), true, "归属后provider实际输入保留正式自然正文");
      }};
      plan = {label: restart ? "control-restart-input" : "control-next-input", index: 0, steps: [
        {name: "update_analysis_task", args: {action: "route", task_id: task.task_id, expected_version: task.condition_version, options: []}, observe: body => {
          const input = JSON.stringify(body.messages);
          // 本人已提交的自然正文不随新输入的归属状态擦除，执行事实另由控制快照核对。
          assert.equal(input.includes(fabricated), true, "新输入归属前同样保留已提交的自然正文");
          assert.ok(input.includes(task.task_id), "来源未裁决时仍保留route所需任务控制身份");
        }},
        step,
      ]};
      protocolFailure = null;
      try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
      catch (error) { throw protocolFailure ?? error; }
      const stored = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id=${quote(run.recovery_chain_id)}`)[0];
      assert.equal(restoreCheckpoint("/synthetic/data-agent", stored).getSessionId(), history.getSessionId());
      h.releaseRun(run.run_id);
    }
    checks.push({case: "natural-provider-next-and-restart", original_body_present: true, same_session: true});
  }

  // 控制尾部尚未发布时恢复：沿原操作接回，再由Pi继续原输入，不能只凭waiting快照结束。
  {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "准备合成等待查询，随后确认执行。"));
    await h.pauseWorker();
    const task = await tool("update_analysis_task", { action: "create", goal: "核对恢复中的等待查询", conditions, options: [] });
    const query = await tool("request_query", { task_id: task.task_id, condition_version: task.condition_version,
      sql: "SELECT 42 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成恢复等待查询",
      knowledge_refs: [], replaces_query_id: null });
    await finishNatural("合成查询草稿已准备，尚未执行。");

    const prior = await begin(cid, "请确认刚才保存的SQL。");
    plan = { label: "d1-recovery-first", index: 0, steps: [
      { name: "update_analysis_task", args: { action: "route", task_id: task.task_id,
        expected_version: task.condition_version, options: [] } },
      { text: "" },
    ] };
    interruptFinish = true; interrupted = false; controller = new AbortController();
    protocolFailure = null;
    await assert.rejects(deliver(prior, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, "", controller.signal),
      /synthetic_control_interrupted|run_cancelled|model_run_failed/);
    interruptFinish = false;
    if (protocolFailure) throw protocolFailure;
    assert.equal(interrupted, true, "必须在控制提交前中断");
    assert.equal(plan.index, plan.steps.length);
    const expected = controlText(prior.run_id);
    assert.ok(expected);
    // 未到达finish的本地尾部不属于宿主leaf；恢复应先接回工具，再由Pi继续原输入。
    const captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
    await h.resumeWorker();
    run = await until(() => h.captured.slice(captured).find(value => value.message_id === prior.message_id),
      "接回控制交付原消息", 40000);
    await h.pauseWorker();
    assert.equal(run.resume_same_input, true);
    assert.equal(run.recovery_chain_id, prior.recovery_chain_id);
    assert.equal(run.tool_contract_version, 2);
    const callsBefore = calls;
    plan = { label: "d1-recovery", index: 0, steps: [{text:""}] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, 1, "只有waiting快照时须继续Pi，不能当作完整答案");
    assert.equal(calls, callsBefore + 1);
    const { text } = await committedText(cid);
    assert.equal(text, expected);
    assert.ok(!text.includes("未核验的恢复前分析"));
    const resumedCheckpoint = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id=${quote(run.recovery_chain_id)}`)[0];
    const resumedInput = JSON.stringify(restoreCheckpoint("/synthetic/data-agent", resumedCheckpoint).buildSessionContext().messages);
    assert.equal(resumedInput.includes("未核验的恢复前分析"), false, "extension创建前快提交也必须编辑当前正文");
    assert.equal(ok(await h.request(`/queries/${query.id}`)).execution_state, "not_submitted");
    checks.push({ case: "d1-recovery", committed: text, extra_model_calls: 1, resume_same_input: true,
      unpublished_local_tail_not_used: true });
    h.releaseRun(run.run_id);
  }

  // D1身份：控制回执观察为队列后查询推进queued→running，恢复必须接回原持久投影与原提交身份，
  // 不得因等待态推进重造出原回执中不存在的指纹。
  {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "准备合成等待查询，随后确认执行。"));
    await h.pauseWorker();
    const task = await tool("update_analysis_task", { action: "create", goal: "核对推进中的等待查询", conditions, options: [] });
    const query = await tool("request_query", { task_id: task.task_id, condition_version: task.condition_version,
      sql: "SELECT 43 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成推进等待查询",
      knowledge_refs: [], replaces_query_id: null });
    await finishNatural("合成查询草稿已准备，尚未执行。");
    const prior = await begin(cid, "请确认刚才保存的SQL。");
    // 本轮开始后才推进到队列：控制回执必须携带 queued 观察，恢复前再推进到 running。
    h.sql(`UPDATE query_requests SET execution_state='queued', confirmation_state='confirmed' WHERE id=${quote(query.id)};`);
    plan = { label: "d1-identity-first", index: 0, steps: [
      { name: "update_analysis_task", args: { action: "route", task_id: task.task_id,
        expected_version: task.condition_version, options: [] } },
      { text: "" },
    ] };
    interruptFinish = true; interrupted = false; controller = new AbortController();
    protocolFailure = null;
    await assert.rejects(deliver(prior, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, "", controller.signal),
      /synthetic_control_interrupted|run_cancelled|model_run_failed/);
    interruptFinish = false;
    if (protocolFailure) throw protocolFailure;
    assert.equal(interrupted, true, "必须在控制提交前中断");
    const expected = controlText(prior.run_id);
    assert.ok(expected, "队列观察的控制投影必须存在");
    assert.match(expected, /已加入队列/, "控制投影携带回执时点的队列观察");
    // 恢复前查询由队列推进到运行：等待态变化不得重造提交身份。
    // 未来租约模拟平台仍在执行，对账扫描在恢复窗口不重派该行。
    h.sql(`UPDATE query_requests SET execution_state='running',
      lease_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR) WHERE id=${quote(query.id)};`);
    const chainCalls = h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) AS v FROM tool_calls
      WHERE conversation_id=${quote(cid)} AND recovery_chain_id=${quote(prior.recovery_chain_id)}
      AND state='succeeded'`)[0].n;
    const captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
    await h.resumeWorker();
    run = await until(() => h.captured.slice(captured).find(value => value.message_id === prior.message_id),
      "接回推进后的控制原消息", 40000);
    await h.pauseWorker();
    assert.equal(run.resume_same_input, true);
    assert.equal(run.recovery_chain_id, prior.recovery_chain_id);
    const callsBefore = calls;
    plan = { label: "d1-identity-recovery", index: 0, steps: [{text:""}] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, 1, "本地控制尾部尚未发布时由原Pi继续一次");
    assert.equal(calls, callsBefore + 1);
    const { text } = await committedText(cid);
    assert.equal(text, expected, "恢复必须接回原持久控制投影，而非重算运行态正文");
    assert.equal(ok(await h.request(`/queries/${query.id}`)).execution_state, "running");
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) AS v FROM tool_calls
      WHERE conversation_id=${quote(cid)} AND recovery_chain_id=${quote(prior.recovery_chain_id)}
      AND state='succeeded'`)[0].n, chainCalls, "恢复不得重复编辑或派发原操作");
    checks.push({ case: "d1-identity-recovery", committed: text, extra_model_calls: 1, query_state: "running",
      original_operation_preserved:true });
    h.releaseRun(run.run_id);
  }

  // D1结清边界：投影之后、finish之前查询queued→succeeded，合法控制事实仍可提交，
  // 但未解释任务不得因此answered；混合冻结分析与等待任务分别推进，结果通知通道仍可交付分析。
  {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "甲等待查询结果，乙先交付分析。"));
    await h.pauseWorker();
    const taskA = await tool("update_analysis_task", { action: "create", goal: "等待查询解释的甲任务", conditions, options: [] });
    const queryA = await tool("request_query", { task_id: taskA.task_id, condition_version: taskA.condition_version,
      sql: "SELECT 44 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成甲等待查询",
      knowledge_refs: [], replaces_query_id: null });
    await finishNatural("甲的查询草稿已准备，乙稍后交付。");
    await begin(cid, "请交付乙的分析并确认甲的查询状态。");
    await tool("update_analysis_task", {action:"route", task_id:taskA.task_id,
      expected_version:taskA.condition_version, options:[]});
    h.sql(`UPDATE query_requests SET execution_state='queued', confirmation_state='confirmed' WHERE id=${quote(queryA.id)};`);
    const answerB = "乙的完整分析：口径一致，可直接采用。";
    const finalizeB = { text: answerB, name: "update_analysis_task", args: { action: "route", task_id: "",
      expected_version: "", options: [], finalize_current_answer: true }, observe: body => {
      const last = body.messages.findLast(message => message.role === "tool");
      const created = JSON.parse(last.content);
      assert.equal(typeof created.task_id, "string");
      assert.equal(created.condition_version, "1");
      finalizeB.args.task_id = created.task_id;
      finalizeB.args.expected_version = created.condition_version;
    } };
    plan = { label: "d1-settle-boundary", index: 0, steps: [
      { name: "update_analysis_task", args: { action: "create", goal: "乙的独立分析", conditions, options: [] } },
      finalizeB,
      { text: "乙已交付，甲仍在等待查询结果。" },
    ] };
    advanceBeforeFinish = queryA.id;
    const phaseBefore = h.sql(`SELECT JSON_OBJECT('p',phase) AS v FROM analysis_tasks WHERE id=${quote(taskA.task_id)}`)[0].p;
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    assert.equal(advanceBeforeFinish, null, "必须在提交前推进查询终态");
    const { snapshot, text } = await committedText(cid);
    const expectedControl = h.sql(`SELECT JSON_OBJECT('text',JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.control_delivery.text')))
      FROM tool_calls WHERE origin_run_id=${quote(run.run_id)} AND answer_part_sequence IS NOT NULL`)[0]?.text;
    assert.ok(expectedControl, "本次乙定稿回执必须包含甲的合法控制投影");
    assert.equal(text, "## 乙的独立分析\n\n" + answerB + "\n\n---\n\n" + expectedControl);
    const phaseA = snapshot.tasks.find(item => item.id === taskA.task_id).phase;
    const phaseB = snapshot.tasks.find(item => item.id !== taskA.task_id && item.goal === "乙的独立分析").phase;
    assert.equal(phaseB, "answered", "冻结正文解释的乙任务正常结清");
    assert.notEqual(phaseA, "answered", "仅控制确认不得结清未解释的甲任务");
    assert.equal(phaseA, phaseBefore, "甲任务保持原等待相位，由结果通知继续解释");
    checks.push({ case: "d1-settle-boundary", committed: text, phase_a: phaseA, phase_b: phaseB,
      query_state: "succeeded" });
    h.releaseRun(run.run_id);
    // 保单查询原正控，另用同任务尚有等待SQL证明grounded优先且等待义务保留。
    for (const waitingSibling of [false, true]) {
    const third = await begin(cid, "发起丙任务查询，完成后解释结果。");
    const taskC = await tool("update_analysis_task", { action: "create", goal: "丙任务真实结果解释", conditions, options: [] });
    const queryC = await tool("request_query", { task_id: taskC.task_id, condition_version: taskC.condition_version,
      sql: "SELECT 45 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成丙查询",
      knowledge_refs: [], replaces_query_id: null });
    if (waitingSibling) await tool("request_query", { task_id: taskC.task_id, condition_version: taskC.condition_version,
      sql: "SELECT 46 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成未执行的同任务草稿",
      knowledge_refs: [], replaces_query_id: null });
    await finishNatural("丙的查询草稿已准备。");
    ok(await h.request(`/queries/${queryC.id}/confirm`, { operation_id: randomUUID(),
      draft_version: queryC.draft_version, condition_version: queryC.condition_version }));
    const before = h.captured.length;
    await h.resumeWorker();
    attach(await until(() => h.captured.slice(before).find(value =>
      value.conversation_id === cid && value.workspace_context?.result_notification?.query_id === queryC.id),
      "丙查询结果通知", 40000));
    await h.pauseWorker();
    let answerC = "";
    let resultRefC = "";
    let bindingsC = null;
    const templateC = "丙的查询结果：{{value}}，口径与甲乙一致。";
    plan = { label: "d1-notification-after-control", index: 0, steps: [
      { name: "update_analysis_task", args: { action: "route", task_id: taskC.task_id,
        expected_version: taskC.condition_version, options: [] } },
      { name: "get_query", args: { query_id: queryC.id } },
      // v2两步答案：prepare登记数值绑定，正文以{{value}}引用由宿主渲染成定稿候选。
      // observe在请求构建时触发：get_query自身回执此刻不存在，读结果的断言挂在prepare步。
      { name: "prepare_analysis_answer",
        observe: body => {
          const result = JSON.parse(body.messages.findLast(message => message.role === "tool").content);
          assert.equal(result.query.execution_state, "succeeded");
          assert.ok(result.results?.result_ref, "真实执行结果可读: " + JSON.stringify(result.results).slice(0, 200));
          resultRefC = result.results.result_ref;
        },
        get args() {
          return { sources: [{ query_id: queryC.id, result_ref: resultRefC, columns: ["value"] }],
            values: [{ name: "value", kind: "cell", query_id: queryC.id, column: "value", row_index: 0 }] };
        } },
      { text: templateC, observe: body => {
        bindingsC = JSON.parse(body.messages.findLast(message => message.role === "tool").content).bindings;
      } },
    ] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    assert.deepEqual(bindingsC, { value: "45" }, "prepare回执必须绑定真实结果");
    answerC = templateC.replace("{{value}}", bindingsC.value);
    const notifiedText = (await h.snapshot(cid)).messages.findLast(item => item.role === "assistant" && item.committed).text;
    assert.equal(notifiedText, answerC, "结果通知仍能交付丙的分析");
    const notified = (await h.snapshot(cid)).tasks.find(item => item.id === taskC.task_id).phase;
    assert.equal(notified, waitingSibling ? "waiting_confirmation" : "answered", "其他等待草稿仍保确认义务");
    const saved = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id=${quote(run.recovery_chain_id)}`)[0];
    const projected = restoreCheckpoint("/synthetic/data-agent", saved);
    const finalMessage = projected.buildSessionContext().messages.findLast(message => message.role === "assistant");
    assert.equal(finalMessage.content.filter(part => part.type === "text").map(part => part.text).join(""), answerC,
      "Pi实际投影必须保留已核验答案，不能被旧控制覆盖");
    checks.push({ case: waitingSibling ? "grounded-after-waiting-control" : "d1-notification-after-control", answered: notified, committed: answerC });
    h.releaseRun(run.run_id);
    if (waitingSibling) for (const restart of [false, true]) {
      if (restart) await h.restartApi();
      await begin(cid, restart ? "重启后复核丙的交付。" : "继续复核丙的交付。");
      plan = {label: "grounded-provider-input", index: 0, steps: [
        {name: "update_analysis_task", args: {action: "route", task_id: taskC.task_id, expected_version: taskC.condition_version, options: []}, observe: body => {
          assert.ok(JSON.stringify(body.messages).includes(taskC.task_id), "归属前保留原任务控制身份");
        }},
        {text: "其他草稿仍等待确认。", observe: body => {
          const assistants = body.messages.filter(message => message.role === "assistant");
          assert.ok(assistants.some(message => JSON.stringify(message.content).includes(answerC)), "route后下一轮/重启实际provider仍收到已核验结果");
        }},
      ]};
      protocolFailure = null;
      try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
      catch (error) { throw protocolFailure ?? error; }
      h.releaseRun(run.run_id);
    }
    }
  }

  // D2正控：有冻结正文且无新分析末项，正式正文仍须交付持久问题及选项。
  {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "乙先交付，甲的问题稍后回答。"));
    await h.pauseWorker();
    const taskA = await tool("update_analysis_task", { action: "create", goal: "合成甲待澄清", conditions, options: [] });
    const clarified = await tool("update_analysis_task", { action: "clarify", task_id: taskA.task_id,
      expected_version: taskA.condition_version, condition_patch: { set: {}, unset: [] },
      clarifications: [{ question: "合成甲采用哪个口径？", options: ["按合成轮次", "按合成尝试"] }], options: [] });
    assert.equal(clarified.phase, "waiting_clarification");
    const taskB = await tool("update_analysis_task", { action: "create", goal: "合成乙目标", conditions, options: [] });
    const answer = "乙的完整答案：按原条件核对完成。";
    plan = { label: "d2-control", index: 0, steps: [
      // 定稿冻结当前活动任务乙的答案，route到仍需澄清的甲；本轮消息同时归属两任务。
      { text: answer, name: "update_analysis_task", args: { action: "route", task_id: taskA.task_id,
        expected_version: clarified.condition_version, options: [], finalize_current_answer: true } },
      { text: "", observe: body => {
        const reply = body.messages.findLast(message => message.role === "tool");
        const parsed = reply ? JSON.parse(reply.content) : null;
        assert.ok(parsed && !parsed.error, "定稿route必须成功: " + (reply?.content ?? "缺少回执"));
      } },
    ] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    const { snapshot, text } = await committedText(cid);
    const expectedControl = controlText(run.run_id);
    assert.ok(expectedControl, "冻结+澄清必须产生控制投影");
    assert.equal(text, "## 合成乙目标\n\n" + answer + "\n\n---\n\n" + expectedControl);
    assert.match(expectedControl, /合成甲待澄清/);
    assert.ok(expectedControl.includes("合成甲采用哪个口径？") && expectedControl.includes("按合成轮次") && expectedControl.includes("按合成尝试"),
      "冻结答案旁的正式正文必须有可回答的问题和全部保存选项");
    assert.equal(snapshot.tasks.find(item => item.id === taskA.task_id).phase, "waiting_clarification");
    assert.equal(snapshot.tasks.find(item => item.id === taskB.task_id).phase, "answered");
    const open = h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) AS v FROM clarifications
      WHERE task_id=${quote(taskA.task_id)} AND state='open'`)[0].n;
    assert.equal(open, 1, "澄清问题仍保持开放");
    const saved = h.sql(`SELECT checkpoint FROM pi_checkpoints
      WHERE recovery_chain_id=${quote(run.recovery_chain_id)}`)[0];
    const restored = restoreCheckpoint("/synthetic/data-agent", saved);
    const lastAssistant = restored.buildSessionContext().messages.findLast(message => message.role === "assistant");
    assert.equal(lastAssistant.content.filter(part => part.type === "text").map(part => part.text).join(""),
      expectedControl, "最后一条纯文本助手消息由context edit承担可见提示");
    d2 = { cid, taskA, question: "合成甲采用哪个口径？", text };
    checks.push({ case: "d2-frozen-clarification", committed: text,
      phase_a: "waiting_clarification", phase_b: "answered", open_clarifications: open });
    h.releaseRun(run.run_id);
  }

  // 冻结正文与澄清仍分责；未发布的控制尾部恢复后由Pi继续，不重做已冻结操作。
  {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "乙恢复交付，甲的问题稍后回答。"));
    await h.pauseWorker();
    const taskA = await tool("update_analysis_task", { action: "create", goal: "恢复中的待澄清任务", conditions, options: [] });
    const clarified = await tool("update_analysis_task", { action: "clarify", task_id: taskA.task_id,
      expected_version: taskA.condition_version, condition_patch: { set: {}, unset: [] },
      clarifications: [{ question: "恢复任务采用哪个口径？", options: [] }], options: [] });
    const taskB = await tool("update_analysis_task", { action: "create", goal: "恢复中的已交付任务", conditions, options: [] });
    const answer = "恢复前已冻结的乙正文。";
    plan = { label: "d2-recovery-first", index: 0, steps: [
      { text: answer, name: "update_analysis_task", args: { action: "route", task_id: taskA.task_id,
        expected_version: clarified.condition_version, options: [], finalize_current_answer: true } },
      { text: "" },
    ] };
    interruptFinish = true; interrupted = false; controller = new AbortController();
    protocolFailure = null;
    await assert.rejects(deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, "", controller.signal),
      /synthetic_control_interrupted|run_cancelled|model_run_failed/);
    interruptFinish = false;
    if (protocolFailure) throw protocolFailure;
    assert.equal(interrupted, true);
    const prior = run;
    const expectedControl = controlText(prior.run_id);
    assert.ok(expectedControl);
    const captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
    await h.resumeWorker();
    run = await until(() => h.captured.slice(captured).find(value => value.message_id === prior.message_id),
      "接回冻结+澄清原消息", 40000);
    await h.pauseWorker();
    assert.equal(run.resume_same_input, true);
    assert.ok(run.answer_parts?.some(part => part.task_ref.task_id === taskB.task_id), "恢复必须接回冻结引用");
    const callsBefore = calls;
    plan = { label: "d2-recovery", index: 0, steps: [{text:""}] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, 1, "未发布控制尾部仍须继续原Pi输入");
    assert.equal(calls, callsBefore + 1);
    const { text } = await committedText(cid);
    assert.equal(text, "## 恢复中的已交付任务\n\n" + answer + "\n\n---\n\n" + expectedControl);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) AS v FROM clarifications
      WHERE task_id=${quote(taskA.task_id)} AND state='open'`)[0].n, 1);
    checks.push({ case: "d2-recovery", committed: text, extra_model_calls: 1, frozen_parts: 1,
      original_frozen_operation_preserved:true });
    h.releaseRun(run.run_id);
  }

  // 长选项不强塞短控制协议；既有Pi正文绑定仍可解释，保存的原选项不能丢。
  {
    const cid = await h.create();
    await begin(cid, "乙先交付，甲的合法长选项稍后选择。");
    const taskA = await tool("update_analysis_task", { action: "create", goal: "合成甲长选项", conditions, options: [] });
    const longOption = "A".repeat(8000);
    const clarified = await tool("update_analysis_task", { action: "clarify", task_id: taskA.task_id,
      expected_version: taskA.condition_version, condition_patch: { set: {}, unset: [] },
      clarifications: [{ question: "采用哪个口径？", options: [longOption, "B"] }], options: [] });
    assert.equal(clarified.clarification.options[0], longOption);
    const taskB = await tool("update_analysis_task", { action: "create", goal: "合成乙长选项正控", conditions, options: [] });
    const answer = "乙的完整答案：合成核对已完成。";
    const explanation = "甲需要您补充：采用哪个口径？候选A为已保存的长说明口径，候选B为另一口径；请直接选择或自由回答。此处为简述，未逐字复述长选项。";
    plan = { label: "d2-long-option", index: 0, steps: [
      { text: answer, name: "update_analysis_task", args: { action: "route", task_id: taskA.task_id,
        expected_version: clarified.condition_version, options: [], finalize_current_answer: true } },
      { text: explanation },
    ] };
    protocolFailure = null;
    const beforeCalls = calls;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    assert.equal(calls - beforeCalls, 2, "长选项沿原Pi当前任务正文路径，不追加补救模型循环");
    assert.equal(controlText(run.run_id), undefined, "超过8000字符时不生成伪完整短控制提示");
    const { snapshot, text } = await committedText(cid);
    assert.equal(text, "## 合成乙长选项正控\n\n" + answer + "\n\n---\n\n## 合成甲长选项\n\n" + explanation);
    assert.equal(snapshot.tasks.find(task => task.id === taskA.task_id).phase, "waiting_clarification");
    assert.equal(snapshot.tasks.find(task => task.id === taskB.task_id).phase, "answered");
    const saved = h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) AS v FROM clarifications
      WHERE task_id=${quote(taskA.task_id)} AND state='open'
      AND JSON_UNQUOTE(JSON_EXTRACT(options,'$[0]'))=${quote(longOption)}`)[0].n;
    assert.equal(saved, 1, "原始长选项完整保留，简述不能改写持久正文或结清问题");
    checks.push({ case: "d2-long-option-native-final", model_calls: 2, stored_option_chars: longOption.length,
      phase: "waiting_clarification", frozen_answer_retained: true });
    h.releaseRun(run.run_id);
  }

  // D2可见性：真实工作台刷新后仍读冻结正文及明确的待答问题、选项。
  {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(h.url);
      await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
      await page.getByRole("button", { name: "进入工作台 →" }).click();
      await page.getByRole("navigation", { name: "会话历史" })
        .getByRole("button", { name: /乙先交付，甲的问题稍后回答/ }).click();
      const reminder = page.locator(".conversation").getByText(d2.question, { exact: false }).first();
      await reminder.waitFor();
      const before = await page.locator(".conversation").innerText();
      assert.ok(before.includes("乙的完整答案"), "冻结正文必须显示在正式正文中");
      await page.reload();
      await reminder.waitFor();
      const after = await page.locator(".conversation").innerText();
      assert.ok(after.includes("乙的完整答案") && after.includes(d2.question)
        && after.includes("按合成轮次") && after.includes("按合成尝试"),
        "刷新后仍读同一冻结正文及可回答的问题、全部选项");
      const snapshot = await h.snapshot(d2.cid);
      assert.equal(snapshot.tasks.find(task => task.id === d2.taskA.task_id).phase, "waiting_clarification");
      assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) AS v FROM clarifications
        WHERE task_id=${quote(d2.taskA.task_id)} AND state='open' AND question=${quote(d2.question)}`)[0].n, 1);
      assert.deepEqual(errors, []);
      checks.push({ case: "d2-browser-refresh", visible: true, refreshed: true, phase: "waiting_clarification" });
    } finally {
      await browser.close();
    }
  }

  }
  passed = true;
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (h) await h.close();
  await new Promise(resolve => provider.close(resolve));
  await mkdir(".local/checks/semantic-closure", { recursive: true });
  const report = { passed, checks, calls, officialRequests: 0,
    scope: "真实Pi/本地OpenAI协议、Rust/MySQL的控制投影提交、context edit、恢复快路径、可见澄清状态与工作台刷新；不证明真实模型判断" };
  await writeFile(".local/checks/semantic-closure/waiting-task-delivery.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
