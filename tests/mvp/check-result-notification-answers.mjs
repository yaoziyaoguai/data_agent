import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { exportCheckpoint, restoreCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { RustTransport } from "../../apps/agent/transport/client.ts";
import { harness, until } from "./harness.mjs";

// 固定本地协议验证真实Pi的通知交付，不用模型替身伪造宿主终态或结果权限。
const profile = { provider_id: "deepseek", model_id: "deepseek-flash", trial_id: randomUUID(),
  price_version: "2026-10-04-peak-usd", input_limit: 65536, output_limit: 2048,
  trial_call_limit: 60, trial_cost_micros: "1000000", request_call_limit: 24,
  toolset: "data", payload_bytes_limit: 131072 };
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const onlyCase = process.argv.find(value => value.startsWith("--case="))?.slice(7);
const enabled = label => onlyCase === undefined || onlyCase.split(",").includes(label);
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
const lastReply = body => {
  const message = body.messages.findLast(value => value.role === "tool");
  assert.ok(message, "必须接到真实工具回执；实际消息角色 "
    + JSON.stringify(body.messages.map(value => value.role + ":" + String(value.content).slice(0, 80))));
  return JSON.parse(message.content);
};
let h, run, manager, plan, protocolFailure, passed = false;
let calls = 0, interrupted = false, renderFreeze = false, legacyPresent = false;
let controller, frozenBaseline, frozenPrepareSdk;
const checks = [];
const requests = [];
const posts = [];
const coverageReceipts = [];
const answerInvocations = new Map();
let narrowedRequests = 0;
const originalPost = RustTransport.prototype.post;
RustTransport.prototype.post = async function(path, name, input, ...rest) {
  posts.push({path, sdk: input.sdk_tool_call_id, run_id: input.run_id, tool: input.tool_name});
  // 渲染冻结中断：定稿route登记落账后立即中断，恢复只能沿原登记接回。
  const freezeRendered = renderFreeze && !interrupted && path === "/internal/data/tool-calls"
    && input.arguments?.finalize_current_answer === true;
  // 旧present中断：v1登记落账后中断，恢复在升级后的v2目录下回放。
  const interruptPresent = legacyPresent && !interrupted && path === "/internal/data/tool-calls"
    && input.tool_name === "present_analysis_answer";
  const receipt = await originalPost.call(this, path, name, input, ...rest);
  if (receipt.frozen_notification_covered !== undefined) coverageReceipts.push({
    run_id: input.run_id, finalized: input.arguments?.finalize_current_answer === true,
    covered: receipt.frozen_notification_covered,
  });
  if (path === "/internal/data/tools" && input.tool_name === "prepare_analysis_answer" && !receipt.data.error)
    answerInvocations.set(input.sdk_tool_call_id, structuredClone(input));
  if (freezeRendered) {
    frozenPrepareSdk = input.answer_handoff?.rendered_answer_binding?.prepared_sdk_tool_call_id;
    assert.ok(frozenPrepareSdk, "渲染冻结必须交接原prepare回执身份");
    frozenBaseline = h.sql(`SELECT JSON_OBJECT('bytes',HEX(CAST(receipt AS CHAR CHARACTER SET utf8mb4)),'origin',origin_run_id,'operation',operation_id) FROM tool_calls WHERE conversation_id=${quote(run.conversation_id)} AND sdk_tool_call_id=${quote(frozenPrepareSdk)}`)[0];
    interrupted = true; controller.abort();
    throw new Error("synthetic_rendered_freeze_interrupted");
  }
  if (interruptPresent) {
    interrupted = true; controller.abort();
    throw new Error("synthetic_present_interrupted");
  }
  return receipt;
};
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-protocol-key");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
    // v2目录以prepare取代present；本断言按当前run合同核对目录交付了答案数值工具。
    assert.ok(body.tools.some(tool => tool.function.name === (run?.tool_contract_version === 2 ? "prepare_analysis_answer" : "present_analysis_answer")));
    // §6.1：来源未裁决（收窄上下文，投影注入宿主事实标记）期间暂停正文读取与执行工具，
    // 以及Rust来源门必拒的纯受限工具；归属/来源身份/任务目录/取消及资产停用保留；非收窄请求保持全集。
    const narrowedRequest = body.messages.some(message =>
      typeof message.content === "string" ? message.content.includes("来源尚未确定")
        : Array.isArray(message.content) && message.content.some(part => part.type === "text" && part.text.includes("来源尚未确定")));
    if (narrowedRequest) {
      const visible = body.tools.map(tool => tool.function.name);
      for (const name of ["read", "read_knowledge", "read_source", "request_query", "execute_query",
        "get_query", "prepare_analysis_answer", "present_analysis_answer", "save_analysis_evidence",
        "save_analysis_report", "read_analysis_report", "read_analysis_task", "validate_sql",
        "prepare_skill_draft", "propose_semantic_change"])
        assert.ok(!visible.includes(name), "来源未裁决时不得可见正文读取或执行工具：" + name);
      for (const name of ["update_analysis_task", "read_conversation", "search_knowledge",
        "cancel_query", "manage_personal_asset"])
        assert.ok(visible.includes(name), "来源未裁决时任务目录/取消等合法工具必须可见：" + name);
      narrowedRequests++;
    }
    if (!plan || plan.index >= plan.steps.length) {
      // 诊断：追加回合的输入尾部消息，定位是answer_sources补轮还是其他触发。
      throw new Error(`状态通知不得追加无法满足的结果呈现回合 plan=${plan ? `${plan.label}#${plan.index}/${plan.steps.length}` : "null"} calls=${calls} `
        + JSON.stringify(body.messages.slice(-4).map(message => ({ role: message.role,
          content: String(message.content).slice(0, 240) }))));
    }
    const step = plan.steps[plan.index++];
    if (step.observe) step.observe(body);
    calls++;
    requests.push({ label: plan.label, step: plan.index, tool: step.name ?? null, bytes: Buffer.byteLength(raw) });
    const delta = step.name ? { role: "assistant", content: step.text ?? "正在核对查询状态。", tool_calls: [{
      index: 0, id: randomUUID(), type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) },
    }] } : { role: "assistant", content: step.text };
    const chunk = (value, reason = null) => ({ id: "synthetic-notification", object: "chat.completion.chunk",
      created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: value, finish_reason: reason }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify(chunk(delta)) + "\n\n");
    response.write("data: " + JSON.stringify(chunk({}, step.name ? "tool_calls" : "stop")) + "\n\n");
    response.write("data: " + JSON.stringify({ id: "synthetic-notification", choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } }) + "\n\n");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    protocolFailure = error;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "synthetic_notification_assertion_failed" } }));
  }
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const baseUrl = "http://127.0.0.1:" + provider.address().port;
const previous = Object.fromEntries(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DATA_AGENT_PROVIDER_TEST"]
  .map(key => [key, process.env[key]]));
const attach = value => { run = value; manager = SessionManager.inMemory("/synthetic/data-agent"); };
const binding = () => ({ run_id: run.run_id, lease_epoch: run.lease_epoch });
const checkpoint = () => exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const tool = async (name, args) => {
  const input = { ...binding(), sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args, checkpoint: checkpoint() };
  ok(await h.internal("/internal/data/tool-calls", input));
  return ok(await h.internal("/internal/data/tools", input)).data;
};
const conditions = { time_start: null, time_end: null, timezone: "UTC", metric: null,
  channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "合成查询终态通知", source_limits: null };
const createQuery = async sql => {
  const cid = await h.create();
  await h.resumeWorker();
  attach(await h.capture(cid, "准备合成查询，随后确认执行。"));
  await h.pauseWorker();
  const task = await tool("update_analysis_task", { action: "create", goal: "核对查询终态", conditions, options: [] });
  const query = await tool("request_query", { task_id: task.task_id, condition_version: task.condition_version,
    sql, parameters: {}, target_id: "synthetic-sqlite", summary: "合成终态验证", knowledge_refs: [], replaces_query_id: null });
  assert.equal(query.check_state, "passed");
  const text = "合成查询草稿已准备，尚未执行。";
  ok(await h.internal("/internal/outputs", { ...binding(), chunk_seq: "1", text }));
  ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id, final_text: text, checkpoint: checkpoint() }));
  h.releaseRun(run.run_id);
  ok(await h.request(`/queries/${query.id}/confirm`, { operation_id: randomUUID(),
    draft_version: query.draft_version, condition_version: query.condition_version }));
  return { cid, task, query };
};

try {
  h = await harness({ capture: true, profile, protocolProviderUrl: baseUrl,
    env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "3" } });
  process.env.DEEPSEEK_API_KEY = "synthetic-protocol-key";
  process.env.DEEPSEEK_BASE_URL = baseUrl;
  process.env.DATA_AGENT_PROVIDER_TEST = "1";
  for (const example of [
    { label: "failed", sql: "SELECT ABS(-9223372036854775808) AS value", state: "failed",
      answer: "查询失败，整数计算溢出，没有可解释的查询结果。" },
    { label: "cancelled", sql: "SELECT 7 AS value", state: "cancelled",
      answer: "查询已取消，没有可解释的查询结果。" },
    { label: "unavailable", sql: "SELECT 23 AS value", state: "succeeded",
      answer: "查询已完成，但当前无权读取结果，因此无法给出分析结论。" },
  ].filter(example => enabled(example.label))) {
    const { cid, task, query } = await createQuery(example.sql);
    const before = h.captured.length;
    await h.resumeWorker();
    if (example.label === "cancelled") {
      await until(async () => ok(await h.request(`/queries/${query.id}`)).execution_state === "running", "cancel running query");
      ok(await h.request(`/queries/${query.id}/cancel`, { operation_id: randomUUID() }));
    }
    await until(async () => ok(await h.request(`/queries/${query.id}`)).execution_state === example.state,
      example.label + " actual terminal state", 40000);
    attach(await until(() => h.captured.slice(before).find(value => value.conversation_id === cid),
      example.label + " host result notification", 40000));
    await h.pauseWorker();
    assert.deepEqual(run.workspace_context.result_notification, { query_id: query.id, execution_state: example.state,
      task_ref: {task_id: task.task_id, condition_version: task.condition_version} });
    // 结果输入在其交付事务内显式归属所属任务（04切片5/Fix B 正向锁定）：
    // 通知轮的活动任务引用必须已绑定该任务，而不是等到模型补route才归属。
    assert.deepEqual(run.workspace_context.active_task_ref,
      { task_id: task.task_id, condition_version: task.condition_version },
      "查询结果输入交付时绑定其所属任务为活动任务");
    assert.ok(run.text.startsWith("[已确认查询结果事件]"));
    if (example.label === "unavailable") {
      await writeFile(h.directory + "/platform/permissions.json", JSON.stringify({ denied_query_users: ["alice"] }));
    }
    const originalBudget = h.sql(`SELECT JSON_OBJECT('id',budget_scope_id) FROM query_requests WHERE id=${quote(query.id)}`)[0].id;
    const queryState = ok(await h.request(`/queries/${query.id}`));
    plan = { label: example.label, index: 0, steps: [
      { name: "update_analysis_task", args: { action: "route", task_id: task.task_id,
        expected_version: task.condition_version, options: [] } },
      { name: "get_query", args: { query_id: query.id }, observe: body => assert.equal(lastReply(body).task_id, task.task_id) },
      { text: example.answer, observe: body => {
        const result = lastReply(body);
        assert.equal(result.query.execution_state, example.state);
        if (example.label === "unavailable") assert.equal(result.results.error, "forbidden");
        else assert.equal(result.results, null);
        if (example.label === "failed") assert.match(result.query.error_details.message, /overflow/);
      } },
    ] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    const snapshot = await h.snapshot(cid);
    const notificationRun = snapshot.runs.find(item => item.run_id === run.run_id);
    assert.equal(notificationRun.state, "finished");
    // §6.3：RunSnapshot携带持久run身份；结果通知run为query_result并关联原查询。
    assert.equal(notificationRun.purpose, "query_result");
    assert.equal(notificationRun.result_query_id, query.id);
    assert.equal(typeof notificationRun.message_id, "string");
    assert.equal(typeof notificationRun.attempt_id, "string");
    const userRun = snapshot.runs.find(item => item.purpose === "user_request");
    assert.ok(userRun, "用户请求run保持user_request身份");
    assert.equal(userRun.result_query_id, null, "普通run不携带结果查询关联");
    assert.equal(snapshot.messages.findLast(item => item.role === "assistant" && item.committed).text, example.answer);
    assert.deepEqual(ok(await h.request(`/queries/${query.id}`)), queryState, "通知解释不重新执行或改写查询状态");
    const firstChanged = h.sql(`SELECT JSON_OBJECT('s',MIN(event_seq)) FROM conversation_events WHERE conversation_id=${quote(cid)} AND event_type='query_changed' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.query_id'))=${quote(query.id)}`)[0].s;
    assert.equal(queryState.timeline_event_seq, String(firstChanged), "查询读取携带首次query_changed持久序号");
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE origin_run_id=${quote(run.run_id)} AND tool_name='present_analysis_answer'`)[0].n, 0);
    const budget = h.sql(`SELECT JSON_OBJECT('id',r.budget_scope_id,'limit',b.call_limit,'calls',b.issued_calls) FROM agent_runs r JOIN budget_scopes b ON b.id=r.budget_scope_id WHERE r.id=${quote(run.run_id)}`)[0];
    assert.equal(budget.id, originalBudget);
    assert.equal(budget.limit, 24);
    assert.equal(budget.calls, 3);
    checks.push({ case: example.label, execution_state: example.state, model_calls: 3, budget_limit: budget.limit,
      present_calls: 0, notification: run.workspace_context.result_notification, answer: example.answer });
    h.releaseRun(run.run_id);
    if (example.label === "unavailable") await writeFile(h.directory + "/platform/permissions.json", "{}");
  }

  // 同一旧条件通知接缝分别证明单答案、B先冻结再A混源末项、B正文已覆盖A。
  for (const label of ["v2-frozen-late-condition", "mixed-no-parts", "mixed-frozen-tail", "mixed-frozen-cover", "mixed-frozen-scope"].filter(enabled)) {
    const scopeReachability = label === 'mixed-frozen-scope';
    const composeFrozen = label !== "mixed-no-parts", frozenCovers = label === "mixed-frozen-cover" || scopeReachability;
    const naturalFrozen = label === "v2-frozen-late-condition";
    const platformB = composeFrozen && !naturalFrozen ? "synthetic-sqlite" : "etl";
    const goalB = platformB === "etl" ? "etl口径独立目标" : "合成平台独立目标";
    const scopeDocument = scopeReachability ? ok(await h.request('/knowledge', {
      operation_id: randomUUID(), kind: 'document', name: '合成C独立金额说明',
      body: '合成C金额17的独立核对说明。', related_ids: [],
    })) : null;
    const extraRefs = scopeDocument ? [{ object_id: scopeDocument.id, version: scopeDocument.version, path: 'body' }] : [];
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, '准备合成金额查询，随后确认执行。' + (scopeReachability ? 'A仅用合成平台，C另可使用合成C独立金额说明。' : '')));
    await h.pauseWorker();
    const taskA = await tool("update_analysis_task", { action: "create", goal: "核对合成金额", conditions: scopeReachability
      ? { ...conditions, source_limits: { allowed_sources: [{ kind: 'platform', id: 'synthetic-sqlite' }], origin_message_ids: [run.message_id] } } : conditions, options: [] });
    const query = await tool("request_query", { task_id: taskA.task_id, condition_version: taskA.condition_version,
      sql: "SELECT 99 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成旧条件金额", knowledge_refs: [], replaces_query_id: null });
    const taskC = await tool("update_analysis_task", { action: "create", goal: "仅作来源的独立金额", conditions, options: [] });
    const otherQuery = await tool("request_query", { task_id: taskC.task_id, condition_version: taskC.condition_version,
      sql: "SELECT 17 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成独立来源金额", knowledge_refs: extraRefs, replaces_query_id: null });
    const draftText = "合成查询草稿已准备，尚未执行。";
    ok(await h.internal("/internal/outputs", { ...binding(), chunk_seq: "1", text: draftText }));
    ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id, final_text: draftText, checkpoint: checkpoint() }));
    h.releaseRun(run.run_id);
    // 用户消息另立不同明确来源的B；其后只有B自身冻结正文能结清B。
    await h.resumeWorker();
    attach(await h.capture(cid, `另立仅使用${platformB}平台${scopeReachability ? '及合成C独立金额说明' : ''}的独立目标，稍后处理。`));
    await h.pauseWorker();
    const taskB = await tool("update_analysis_task", { action: "create", goal: goalB,
      conditions: { ...conditions, source_limits: { allowed_sources: [{ kind: "platform", id: platformB },
        ...(scopeDocument ? [{ kind: 'document', id: scopeDocument.id }] : [])],
        origin_message_ids: [run.message_id] } }, options: [] });
    h.sql(`UPDATE agent_runs SET state='failed' WHERE id=${quote(run.run_id)} AND state='running';
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)} AND lease_owner=${quote(run.run_id)};
      UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE conversation_id=${quote(cid)} AND state<>'finished';
      UPDATE conversation_messages SET disposition='failed' WHERE id=${quote(run.message_id)} AND disposition='pending';`);
    h.releaseRun(run.run_id);
    ok(await h.request(`/queries/${otherQuery.id}/confirm`, { operation_id: randomUUID(),
      draft_version: otherQuery.draft_version, condition_version: otherQuery.condition_version }));
    let before = h.captured.length;
    await h.resumeWorker();
    await until(async () => ok(await h.request(`/queries/${otherQuery.id}`)).execution_state === "succeeded", "C实际来源查询完成", 40000);
    const sourceRun = await until(() => h.captured.slice(before).find(value => value.workspace_context?.result_notification?.query_id === otherQuery.id), "C来源通知", 40000);
    await h.pauseWorker();
    h.sql(`UPDATE agent_runs SET state='failed' WHERE id=${quote(sourceRun.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(sourceRun.message_id)};
      UPDATE conversation_messages SET disposition='failed' WHERE id=${quote(sourceRun.message_id)};`);
    h.releaseRun(sourceRun.run_id);
    const sourceState = ok(await h.request(`/queries/${otherQuery.id}`));
    const sourceTaskPhase = (await h.snapshot(cid)).tasks.find(task => task.id === taskC.task_id).phase;
    const originalBudget = h.sql(`SELECT JSON_OBJECT('id',budget_scope_id) FROM query_requests WHERE id=${quote(query.id)}`)[0].id;
    ok(await h.request(`/queries/${query.id}/confirm`, { operation_id: randomUUID(),
      draft_version: query.draft_version, condition_version: query.condition_version }));
    before = h.captured.length;
    await h.resumeWorker();
    await until(async () => ok(await h.request(`/queries/${query.id}`)).execution_state === "succeeded", "A原通知查询完成", 40000);
    attach(await until(() => h.captured.slice(before).find(value => value.workspace_context?.result_notification?.query_id === query.id), "A原结果通知", 40000));
    await h.pauseWorker();
    assert.equal(run.workspace_context.result_notification.query_id, query.id);
    const originalNotification = structuredClone(run.workspace_context.result_notification);
    h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id=${quote(run.run_id)}`);
    run.tool_contract_version = 2;
    const revised = frozenCovers ? taskA : await tool("update_analysis_task", { action: "revise", task_id: taskA.task_id,
      expected_version: taskA.condition_version, goal: "核对web渠道金额",
      condition_patch: { set: { channel: "web" }, unset: [] }, options: [] });
    if (!frozenCovers) assert.ok(Number(revised.condition_version) > Number(taskA.condition_version));
    const queryState = ok(await h.request(`/queries/${query.id}`));
    const sourceC = { query_id: otherQuery.id, result_ref: null, columns: ["value"] };
    const sourceA = { query_id: query.id, result_ref: null, columns: ["value"] };
    const answerTemplate = "合成旧条件金额{{a}}，另一个原结果{{c}}。";
    const answerText = scopeReachability ? "只按原范围解释金额99。" : "合成旧条件金额99，另一个原结果17。";
    // v2两步答案：prepare登记数值绑定，正文以{{name}}引用由宿主渲染成定稿候选。
    const prepareMixed = { sources: [sourceA, sourceC],
      values: [{ name: "a", kind: "cell", query_id: query.id, column: "value", row_index: 0 },
        { name: "c", kind: "cell", query_id: otherQuery.id, column: "value", row_index: 0 }] };
    const prepareFrozen = frozenCovers ? prepareMixed : { sources: [sourceC],
      values: [{ name: "c", kind: "cell", query_id: otherQuery.id, column: "value", row_index: 0 }] };
    const prepareScoped = { sources: [sourceA],
      values: [{ name: "a", kind: "cell", query_id: query.id, column: "value", row_index: 0 }] };
    const frozenTemplate = naturalFrozen ? "独立任务的合成概念结论。"
      : frozenCovers ? "独立任务解释原金额{{a}}，另一来源{{c}}。" : "独立任务的合成金额{{c}}。";
    const frozenText = naturalFrozen ? "独立任务的合成概念结论。"
      : frozenCovers ? "独立任务解释原金额99，另一来源17。" : "独立任务的合成金额17。";
    const readC = { name: "get_query", args: { query_id: otherQuery.id } };
    const readA = { name: "get_query", args: { query_id: query.id }, observe: body => {
      sourceC.result_ref = lastReply(body).results.result_ref;
    } };
    const bindA = body => {
      const result = lastReply(body);
      assert.equal(result.query.condition_version, taskA.condition_version);
      sourceA.result_ref = result.results.result_ref;
    };
    const route = (task, extra = {}) => ({ name: "update_analysis_task", args: { action: "route",
      task_id: task.task_id, expected_version: task.condition_version, options: [], ...extra } });
    // 冻结正文与finalize同消息：route在message_end后执行，{{}}已由条内prepare渲染为定稿候选。
    const freezeStep = { name: "update_analysis_task", text: frozenTemplate,
      args: { action: "route", task_id: taskB.task_id, expected_version: taskB.condition_version,
        options: [], finalize_current_answer: true } };
    const renderedText = (template, bindings) => ({ text: template, ...(bindings ? { observe: body => {
      assert.deepEqual(lastReply(body).bindings, bindings, "正文步骤必须看到prepare回执的数值绑定");
    } } : {}) });
    // 迟到条件末项：route回改后条件（route只认当前版本），尾项归属改后任务。
    // task切换触发Pi自保留compaction，observe只能读切换后回执；中断恢复开新run、
    // 授权按run累积，尾项两个来源都必须在当前run重读（同mixed-recovery恢复后补读）。
    const readAPlain = { name: "get_query", args: { query_id: query.id } };
    const tailSteps = [route(revised), readC, readA,
      { name: "prepare_analysis_answer", args: prepareMixed, observe: bindA },
      renderedText(answerTemplate, { a: "99", c: "17" })];
    plan = { label, index: 0, steps: composeFrozen ? [
      route(taskB),
      ...(naturalFrozen ? [] : [readC, ...(frozenCovers ? [readA] : []),
        { name: "prepare_analysis_answer", args: prepareFrozen, observe: frozenCovers ? bindA
          : body => { sourceC.result_ref = lastReply(body).results.result_ref; } }]),
      freezeStep,
      ...(frozenCovers && !scopeReachability ? [{ text: "冻结正文已完整解释本次通知。" }] : []),
      ...(scopeReachability ? [route(taskA), readAPlain,
        { name: "prepare_analysis_answer", args: prepareScoped },
        renderedText("只按原范围解释金额{{a}}。", { a: "99" })] : []),
      ...(!frozenCovers ? tailSteps : []),
    ] : [
      route(revised), readC, readA,
      { name: "prepare_analysis_answer", args: prepareMixed, observe: bindA },
      // 普通读取在prepare之后不清洗准备表（审查澄清③）；绑定证据在此步回执上断言。
      { name: "get_query", args: { query_id: otherQuery.id }, observe: body => {
        assert.deepEqual(lastReply(body).bindings, { a: "99", c: "17" }, "prepare后普通读取保留准备表");
      } },
      renderedText(answerTemplate, null),
    ] };
    protocolFailure = null;
    const freezeRunId = run.run_id;
    if (label === "mixed-frozen-tail") {
      renderFreeze = true; interrupted = false; controller = new AbortController();
      await assert.rejects(deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, "", controller.signal),
        /synthetic_rendered_freeze_interrupted|run_cancelled|model_run_failed/);
      renderFreeze = false;
      if (protocolFailure) throw protocolFailure;
      assert.equal(interrupted, true);
      const prior = run, captured = h.captured.length;
      h.releaseRun(prior.run_id);
      h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
        UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
        UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
      await h.resumeWorker();
      run = await until(() => h.captured.slice(captured).find(value => value.message_id === prior.message_id), "B渲染冻结恢复", 40000);
      await h.pauseWorker();
      for (const key of ["message_id", "recovery_chain_id", "budget_scope_id", "output_id"]) assert.equal(run[key], prior[key]);
      assert.equal(run.resume_same_input, true);
      // 中断只停在定稿登记后：原prepare存储字节、operation与origin不变，回执副本只补宿主owner。
      const savedPrepare = answerInvocations.get(frozenPrepareSdk);
      assert.ok(savedPrepare, "渲染冻结必须沿真实成功prepare建立");
      const replay = ok(await h.internal("/internal/data/tools", { ...savedPrepare, ...binding() }));
      assert.deepEqual(replay.answer_task_ref, { task_id: taskB.task_id, condition_version: taskB.condition_version },
        "旧prepare回执只按首次登记补owner，不能改成通知A");
      const stored = h.sql(`SELECT JSON_OBJECT('bytes',HEX(CAST(receipt AS CHAR CHARACTER SET utf8mb4)),'origin',origin_run_id,'operation',operation_id) FROM tool_calls WHERE conversation_id=${quote(cid)} AND sdk_tool_call_id=${quote(frozenPrepareSdk)}`)[0];
      assert.deepEqual(stored, frozenBaseline, "中断不重写prepare原存储字节及operation/origin");
      await writeFile(h.directory + "/rendered-freeze-recovery.json", JSON.stringify({ baseline: frozenBaseline, after: stored, replay }, null, 2) + "\n");
    }
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) {
      if (scopeReachability) await writeFile(h.directory + '/scope-reachability.json', JSON.stringify({
        stage: 'deliver', error: error.message, plan_index: plan.index, expected_steps: plan.steps.length,
        notification: originalNotification, scopeDocument, taskA, taskB, taskC,
        query, otherQuery, posts, snapshot: await h.snapshot(cid),
        successful_tools: h.sql(`SELECT JSON_OBJECT('tool',tool_name,'state',state,'task',task_id,'receipt',receipt) FROM tool_calls WHERE recovery_chain_id=${quote(run.recovery_chain_id)}`),
      }, null, 2) + '\n');
      throw protocolFailure ?? error;
    }
    assert.equal(plan.index, plan.steps.length);
    if (composeFrozen) assert.equal(coverageReceipts.findLast(receipt => (receipt.run_id === freezeRunId || receipt.run_id === run.run_id) && receipt.finalized)?.covered,
      frozenCovers && !scopeReachability, 'query命中不替代原通知scope，真实冻结回执必须携宿主覆盖值');
    const snapshot = await h.snapshot(cid), phases = Object.fromEntries(snapshot.tasks.map(task => [task.goal, task]));
    // 尾项归属：改后条件末项标题是当前goal；受限尾项按通知原任务记"核对合成金额"。
    // 冻结后收尾正文按执行包§5.5是允许的一个合法新尾项：两内容单元、仍一任务。
    const expectedText = composeFrozen ? `## ${goalB}\n\n${frozenText}`
      + (frozenCovers && !scopeReachability ? `\n\n---\n\n## ${goalB}\n\n冻结正文已完整解释本次通知。`
        : `\n\n---\n\n## ${scopeReachability ? '核对合成金额' : '核对web渠道金额'}\n\n${answerText}`) : answerText;
    assert.equal(snapshot.runs.find(item => item.run_id === run.run_id).state, "finished");
    assert.equal(snapshot.messages.findLast(item => item.role === "assistant" && item.committed).text, expectedText);
    assert.equal((await h.snapshot(cid)).messages.findLast(item => item.role === "assistant" && item.committed).text, expectedText, "正式历史保留每份原文一次");
    const deliveredA = phases[frozenCovers ? "核对合成金额" : "核对web渠道金额"];
    const tailAtRevised = composeFrozen && !frozenCovers;
    assert.equal(deliveredA.phase, frozenCovers || tailAtRevised ? "answered" : "investigating",
      "覆盖原通知可推进原条件；尾项归属改后条件同样结清；单份渲染按通知原条件记账不结清改后条件");
    assert.equal(deliveredA.condition_version, revised.condition_version);
    assert.equal(phases[goalB].phase, composeFrozen ? "answered" : "investigating");
    assert.equal(phases["仅作来源的独立金额"].phase, sourceTaskPhase, "引用来源C不自动结清");
    assert.deepEqual(ok(await h.request(`/queries/${query.id}`)), queryState);
    assert.deepEqual(ok(await h.request(`/queries/${otherQuery.id}`)), sourceState, "解释不重新提交任何查询");
    const prepareRows = h.sql(`SELECT JSON_OBJECT('receipt',receipt,'task',task_id,'version',CAST(task_condition_version AS CHAR)) FROM tool_calls WHERE recovery_chain_id=${quote(run.recovery_chain_id)} AND tool_name='prepare_analysis_answer' ORDER BY operation_id`);
    assert.equal(prepareRows.length, label === "mixed-frozen-tail" || scopeReachability ? 2 : 1);
    for (const row of prepareRows) {
      if (row.receipt.answer_task_ref) assert.deepEqual(row.receipt.answer_task_ref, { task_id: row.task, condition_version: row.version });
      const original = row.receipt.data.sources.find(source => source.query_id === query.id);
      if (original) assert.deepEqual(original, { query_id: query.id, result_ref: sourceA.result_ref, task_id: taskA.task_id, condition_version: taskA.condition_version });
    }
    const budget = h.sql(`SELECT JSON_OBJECT('id',r.budget_scope_id,'limit',b.call_limit,'calls',b.issued_calls) FROM agent_runs r JOIN budget_scopes b ON b.id=r.budget_scope_id WHERE r.id=${quote(run.run_id)}`)[0];
    const expectedCalls = { "v2-frozen-late-condition": 7, "mixed-no-parts": 6, "mixed-frozen-tail": 9,
      "mixed-frozen-cover": 6, "mixed-frozen-scope": 9 }[label];
    assert.equal(budget.id, originalBudget); assert.equal(budget.limit, 24); assert.equal(budget.calls, expectedCalls);
    checks.push({ case: label, execution_state: "succeeded", model_calls: expectedCalls, prepare_calls: prepareRows.length,
      notification: originalNotification, answer: expectedText, new_condition_phase: deliveredA.phase,
      source_task_phase: sourceTaskPhase, rendered_freeze_replayed: label === "mixed-frozen-tail",
      ...(scopeReachability ? { frozen_notification_covered: false, original_scope: taskA.conditions.source_limits,
        frozen_owner_scope: taskB.conditions.source_limits, source_document: scopeDocument.id } : {}) });
    h.releaseRun(run.run_id);
  }

  // R10恢复：真实finish发布已消费混源候选后中断，沿原输入零模型接回。
  if (enabled("mixed-recovery")) {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "准备合成恢复金额查询，随后确认执行。"));
    await h.pauseWorker();
    const taskA = await tool("update_analysis_task", { action: "create", goal: "核对恢复金额", conditions, options: [] });
    const query = await tool("request_query", { task_id: taskA.task_id, condition_version: taskA.condition_version,
      sql: "SELECT 123 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成恢复金额",
      knowledge_refs: [], replaces_query_id: null });
    const otherTask = await tool("update_analysis_task", { action: "create", goal: "恢复候选的独立来源", conditions, options: [] });
    const otherQuery = await tool("request_query", { task_id: otherTask.task_id, condition_version: otherTask.condition_version,
      sql: "SELECT 17 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成恢复来源", knowledge_refs: [], replaces_query_id: null });
    const draftText = "合成恢复查询草稿已准备，尚未执行。";
    ok(await h.internal("/internal/outputs", { ...binding(), chunk_seq: "1", text: draftText }));
    ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id, final_text: draftText, checkpoint: checkpoint() }));
    h.releaseRun(run.run_id);
    ok(await h.request(`/queries/${otherQuery.id}/confirm`, { operation_id: randomUUID(),
      draft_version: otherQuery.draft_version, condition_version: otherQuery.condition_version }));
    let sourceBefore = h.captured.length;
    await h.resumeWorker();
    await until(async () => ok(await h.request(`/queries/${otherQuery.id}`)).execution_state === "succeeded", "恢复来源查询完成", 40000);
    const sourceRun = await until(() => h.captured.slice(sourceBefore).find(value => value.workspace_context?.result_notification?.query_id === otherQuery.id), "恢复来源通知", 40000);
    await h.pauseWorker();
    h.sql(`UPDATE agent_runs SET state='failed' WHERE id=${quote(sourceRun.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(sourceRun.message_id)};
      UPDATE conversation_messages SET disposition='failed' WHERE id=${quote(sourceRun.message_id)};`);
    h.releaseRun(sourceRun.run_id);
    ok(await h.request(`/queries/${query.id}/confirm`, { operation_id: randomUUID(),
      draft_version: query.draft_version, condition_version: query.condition_version }));
    const before = h.captured.length;
    await h.resumeWorker();
    await until(async () => ok(await h.request(`/queries/${query.id}`)).execution_state === "succeeded",
      "恢复通知查询完成", 40000);
    attach(await until(() => h.captured.slice(before).find(value => value.conversation_id === cid),
      "恢复通知run", 40000));
    await h.pauseWorker();
    h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id=${quote(run.run_id)}`);
    run.tool_contract_version = 2;
    const revised = await tool("update_analysis_task", { action: "revise", task_id: taskA.task_id,
      expected_version: taskA.condition_version, goal: "核对恢复web渠道金额",
      condition_patch: { set: { channel: "web" }, unset: [] }, options: [] });
    const originalBudget = h.sql(`SELECT JSON_OBJECT('id',budget_scope_id) FROM query_requests WHERE id=${quote(query.id)}`)[0].id;
    const prepareArgs = { sources: [{ query_id: query.id, result_ref: null, columns: ["value"] },
        { query_id: otherQuery.id, result_ref: null, columns: ["value"] }],
      values: [{ name: "value", kind: "cell", query_id: query.id, column: "value", row_index: 0 },
        { name: "other", kind: "cell", query_id: otherQuery.id, column: "value", row_index: 0 }] };
    const committedText = "恢复查询结果123，另一原来源17。";
    plan = { label: "v2-route-recovery-first", index: 0, steps: [
      { name: "update_analysis_task", args: { action: "route", task_id: taskA.task_id,
        expected_version: revised.condition_version, options: [] } },
      { name: "get_query", args: { query_id: otherQuery.id } },
      { name: "get_query", args: { query_id: query.id }, observe: body => {
        prepareArgs.sources[1].result_ref = lastReply(body).results.result_ref;
      } },
      { name: "prepare_analysis_answer", args: prepareArgs, observe: body => {
        prepareArgs.sources[0].result_ref = lastReply(body).results.result_ref;
      } },
      { text: "恢复查询结果{{value}}，另一原来源{{other}}。", observe: body => {
        assert.deepEqual(lastReply(body).bindings, { value: "123", other: "17" }, "提交前已取得渲染绑定");
      } },
    ] };
    h.env.DATA_AGENT_FAULT = "after_output_checkpoint";
    await h.restartApi();
    protocolFailure = null;
    await assert.rejects(deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""), /unavailable/);
    delete h.env.DATA_AGENT_FAULT;
    await h.restartApi();
    if (protocolFailure) throw protocolFailure;
    const saved = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id=${quote(run.recovery_chain_id)}`)[0];
    const published = restoreCheckpoint("/synthetic/data-agent", saved);
    assert.ok(published.getBranch().some(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === "prepare_analysis_answer" && !entry.message.isError), "真实finish准备阶段已发布消费成功回执的leaf");
    assert.ok(JSON.stringify(published.getBranch()).includes("rendered_binding"), "候选leaf同时发布渲染绑定身份");
    assert.equal(h.sql(`SELECT JSON_OBJECT('state',state) FROM assistant_outputs WHERE attempt_id=${quote(run.attempt_id)}`)[0].state, "streaming", "候选leaf发布不代表正文已提交");
    const prior = run;
    const captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
    await h.resumeWorker();
    run = await until(() => h.captured.slice(captured).find(value => value.message_id === prior.message_id),
      "接回通知答案原消息", 40000);
    await h.pauseWorker();
    assert.equal(run.resume_same_input, true);
    assert.equal(run.recovery_chain_id, prior.recovery_chain_id);
    assert.equal(run.output_id, prior.output_id);
    const callsBefore = calls;
    plan = { label: "mixed-recovery", index: 0, steps: [] };
    const postStart = posts.length;
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, 0);
    assert.equal(calls, callsBefore, "已消费混源成功候选按原leaf零模型恢复");
    assert.ok(!posts.slice(postStart).some(post => post.path === "/internal/data/tool-calls"), "已消费候选恢复不重新登记操作");
    const snapshot = await h.snapshot(cid);
    assert.equal(snapshot.messages.findLast(message => message.role === "assistant" && message.committed).text, committedText);
    assert.equal(ok(await h.request(`/queries/${query.id}`)).execution_state, "succeeded");
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id=${quote(cid)} AND recovery_chain_id=${quote(run.recovery_chain_id)} AND tool_name='prepare_analysis_answer'`)[0].n, 1);
    const budget = h.sql(`SELECT JSON_OBJECT('id',r.budget_scope_id,'limit',b.call_limit,'calls',b.issued_calls) FROM agent_runs r JOIN budget_scopes b ON b.id=r.budget_scope_id WHERE r.id=${quote(run.run_id)}`)[0];
    assert.equal(budget.id, originalBudget);
    assert.equal(budget.limit, 24);
    assert.equal(budget.calls, 5);
    checks.push({ case: "mixed-recovery", committed: true, extra_calls: 0, model_calls: 5, prepare_calls: 1, resume_same_input: true });
    h.releaseRun(run.run_id);
  }

  // 旧present恢复：v1登记落账后被中断，恢复前升级v2目录，pending调用仍沿原登记回放并提交。
  if (enabled("legacy-present-recovery")) {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "准备旧回执恢复金额查询，随后确认执行。"));
    await h.pauseWorker();
    const taskA = await tool("update_analysis_task", { action: "create", goal: "核对旧回执恢复金额", conditions, options: [] });
    const query = await tool("request_query", { task_id: taskA.task_id, condition_version: taskA.condition_version,
      sql: "SELECT 99 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成旧回执金额",
      knowledge_refs: [], replaces_query_id: null });
    const draftText = "旧回执恢复查询草稿已准备。";
    ok(await h.internal("/internal/outputs", { ...binding(), chunk_seq: "1", text: draftText }));
    ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id, final_text: draftText, checkpoint: checkpoint() }));
    h.releaseRun(run.run_id);
    const originalBudget = h.sql(`SELECT JSON_OBJECT('id',budget_scope_id) FROM query_requests WHERE id=${quote(query.id)}`)[0].id;
    ok(await h.request(`/queries/${query.id}/confirm`, { operation_id: randomUUID(),
      draft_version: query.draft_version, condition_version: query.condition_version }));
    const before = h.captured.length;
    await h.resumeWorker();
    await until(async () => ok(await h.request(`/queries/${query.id}`)).execution_state === "succeeded", "旧回执恢复查询完成", 40000);
    attach(await until(() => h.captured.slice(before).find(value => value.conversation_id === cid), "旧回执恢复通知run", 40000));
    await h.pauseWorker();
    assert.equal(run.workspace_context.result_notification.query_id, query.id);
    const pArgs = { template: "旧回执恢复金额{{value}}。",
      sources: [{ query_id: query.id, result_ref: null, columns: ["value"] }],
      values: [{ name: "value", kind: "cell", query_id: query.id, column: "value", row_index: 0 }] };
    // v1的present回执本身是完整答案：中断登记、恢复回放后无需再补正文模型调用。
    plan = { label: "legacy-present-recovery", index: 0, steps: [
      { name: "update_analysis_task", args: { action: "route", task_id: taskA.task_id,
        expected_version: taskA.condition_version, options: [] } },
      { name: "get_query", args: { query_id: query.id } },
      { name: "present_analysis_answer", args: pArgs, observe: body => {
        pArgs.sources[0].result_ref = lastReply(body).results.result_ref;
      } },
    ] };
    protocolFailure = null;
    legacyPresent = true; interrupted = false; controller = new AbortController();
    await assert.rejects(deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, "", controller.signal),
      /synthetic_present_interrupted|run_cancelled|model_run_failed/);
    legacyPresent = false;
    if (protocolFailure) throw protocolFailure;
    assert.equal(interrupted, true);
    const prior = run, captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id=${quote(prior.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(prior.message_id)};`);
    await h.resumeWorker();
    run = await until(() => h.captured.slice(captured).find(value => value.message_id === prior.message_id), "旧present恢复run", 40000);
    await h.pauseWorker();
    assert.equal(run.resume_same_input, true);
    assert.equal(run.recovery_chain_id, prior.recovery_chain_id);
    // 恢复前升级合同：pending的旧present必须在v2目录下经原登记回放。
    h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id=${quote(run.run_id)}`);
    run.tool_contract_version = 2;
    const callsBefore = calls;
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    assert.equal(calls - callsBefore, 0, "旧present回执即完整答案，恢复零新增模型调用");
    const snapshot = await h.snapshot(cid);
    assert.equal(snapshot.messages.findLast(message => message.role === "assistant" && message.committed).text, "旧回执恢复金额99。");
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id=${quote(cid)} AND recovery_chain_id=${quote(run.recovery_chain_id)} AND tool_name='present_analysis_answer' AND state='succeeded'`)[0].n, 1, "旧present按原登记接回并成功");
    const budget = h.sql(`SELECT JSON_OBJECT('id',r.budget_scope_id,'limit',b.call_limit,'calls',b.issued_calls) FROM agent_runs r JOIN budget_scopes b ON b.id=r.budget_scope_id WHERE r.id=${quote(run.run_id)}`)[0];
    assert.equal(budget.id, originalBudget);
    assert.equal(budget.limit, 24);
    assert.equal(budget.calls, 3);
    checks.push({ case: "legacy-present-recovery", committed: true, model_calls: 3, present_calls: 1,
      resumed_under_v2: true, extra_calls: calls - callsBefore });
    h.releaseRun(run.run_id);
  }

  // R10负控：同task/version下只有P的成功答案不能满足Q的通知；补Q答案后才提交。
  if (enabled("p-negative")) {
    const cid = await h.create();
    await h.resumeWorker();
    attach(await h.capture(cid, "准备两条合成金额查询，随后分别确认。"));
    await h.pauseWorker();
    const taskA = await tool("update_analysis_task", { action: "create", goal: "核对同版两条金额", conditions, options: [] });
    const p = await tool("request_query", { task_id: taskA.task_id, condition_version: taskA.condition_version,
      sql: "SELECT 7 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成P查询",
      knowledge_refs: [], replaces_query_id: null });
    const q = await tool("request_query", { task_id: taskA.task_id, condition_version: taskA.condition_version,
      sql: "SELECT 99 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成Q查询",
      knowledge_refs: [], replaces_query_id: null });
    const draftText = "两条合成查询草稿已准备。";
    ok(await h.internal("/internal/outputs", { ...binding(), chunk_seq: "1", text: draftText }));
    ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id, final_text: draftText, checkpoint: checkpoint() }));
    h.releaseRun(run.run_id);
    // 先执行P并消费其通知run；任务仍等待Q结果。
    ok(await h.request(`/queries/${p.id}/confirm`, { operation_id: randomUUID(),
      draft_version: p.draft_version, condition_version: p.condition_version }));
    let before = h.captured.length;
    await h.resumeWorker();
    await until(async () => ok(await h.request(`/queries/${p.id}`)).execution_state === "succeeded", "P完成", 40000);
    const pRun = await until(() => h.captured.slice(before).find(value => value.conversation_id === cid), "P通知run", 40000);
    h.sql(`UPDATE agent_runs SET state='failed' WHERE id=${quote(pRun.run_id)};
      UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=${quote(cid)};
      UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE message_id=${quote(pRun.message_id)};
      UPDATE conversation_messages SET disposition='failed' WHERE id=${quote(pRun.message_id)};`);
    h.releaseRun(pRun.run_id);
    await h.pauseWorker();
    // 再执行Q并取得其通知run。
    ok(await h.request(`/queries/${q.id}/confirm`, { operation_id: randomUUID(),
      draft_version: q.draft_version, condition_version: q.condition_version }));
    before = h.captured.length;
    await h.resumeWorker();
    await until(async () => ok(await h.request(`/queries/${q.id}`)).execution_state === "succeeded", "Q完成", 40000);
    attach(await until(() => h.captured.slice(before).find(value => value.conversation_id === cid), "Q通知run", 40000));
    await h.pauseWorker();
    const originalBudget = h.sql(`SELECT JSON_OBJECT('id',budget_scope_id) FROM query_requests WHERE id=${quote(q.id)}`)[0].id;
    const pState = ok(await h.request(`/queries/${p.id}`));
    const qState = ok(await h.request(`/queries/${q.id}`));
    const pArgs = { template: "P查询结果{{value}}。",
      sources: [{ query_id: p.id, result_ref: null, columns: ["value"] }],
      values: [{ name: "value", kind: "cell", query_id: p.id, column: "value", row_index: 0 }] };
    const qArgs = { template: "Q查询结果{{value}}。",
      sources: [{ query_id: q.id, result_ref: null, columns: ["value"] }],
      values: [{ name: "value", kind: "cell", query_id: q.id, column: "value", row_index: 0 }] };
    let qAnswer;
    plan = { label: "p-negative", index: 0, steps: [
      { name: "get_query", args: { query_id: p.id } },
      { name: "present_analysis_answer", args: pArgs, observe: body => {
        pArgs.sources[0].result_ref = lastReply(body).results.result_ref;
      } },
      { text: "P已解释。", observe: body => {
        assert.equal(lastReply(body).answer_text, "P查询结果7。");
      } },
      { name: "get_query", args: { query_id: q.id }, observe: body => {
        const request = JSON.stringify(body.messages.slice(-2));
        assert.match(request, /本轮是查询结果解释/, "只有P答案时必须补Q结果答案");
        assert.match(request, /present_analysis_answer/);
      } },
      { name: "present_analysis_answer", args: qArgs, observe: body => {
        qArgs.sources[0].result_ref = lastReply(body).results.result_ref;
      } },
      { text: "", observe: body => { qAnswer = lastReply(body).answer_text; } },
    ] };
    protocolFailure = null;
    try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ""); }
    catch (error) { throw protocolFailure ?? error; }
    assert.equal(plan.index, plan.steps.length);
    assert.ok(qAnswer, "补答后必须取得Q答案");
    const snapshot = await h.snapshot(cid);
    assert.equal(snapshot.messages.findLast(message => message.role === "assistant" && message.committed).text, qAnswer);
    assert.ok(!qAnswer.includes("P查询结果"), "同版P答案不能冒充Q通知");
    assert.deepEqual(ok(await h.request(`/queries/${p.id}`)), pState, "P查询不因Q通知重执行或改写");
    assert.deepEqual(ok(await h.request(`/queries/${q.id}`)), qState, "Q查询不因补答重执行或改写");
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE origin_run_id=${quote(run.run_id)} AND tool_name='present_analysis_answer'`)[0].n, 2);
    const budget = h.sql(`SELECT JSON_OBJECT('id',r.budget_scope_id,'limit',b.call_limit,'calls',b.issued_calls) FROM agent_runs r JOIN budget_scopes b ON b.id=r.budget_scope_id WHERE r.id=${quote(run.run_id)}`)[0];
    assert.equal(budget.id, originalBudget);
    assert.equal(budget.limit, 24);
    assert.equal(budget.calls, 6);
    checks.push({ case: "p-negative", committed: true, present_calls: 2, answer: qAnswer, model_calls: 6 });
    h.releaseRun(run.run_id);
  }

  assert.ok(checks.length > 0, "筛选必须命中既有场景");
  assert.equal(calls, checks.reduce((total, check) => total + check.model_calls, 0));
  // 通知消息按既有准入事实出生即routed：本电池不进入来源未裁决窗口，
  // narrowedRequests恒为0；可见性断言仅作收窄意外发生时集合正确的守护。
  const unsettled = h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE state<>'settled'")[0].n;
  assert.equal(unsettled, 0);
  passed = true;
} finally {
  RustTransport.prototype.post = originalPost;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (h) await h.close();
  await new Promise(resolve => provider.close(resolve));
  await mkdir(".local/checks/agent-reliability-repairs", { recursive: true });
  const report = { passed, onlyCase, checks, calls, narrowedRequests, requests, posts, harnessDirectory: h?.directory, officialRequests: 0,
    scope: "真实Pi/本地OpenAI协议、Rust/MySQL和可执行SQLite产生的failed/cancelled及成功后撤权通知；不证明真实模型判断" };
  await writeFile(".local/checks/agent-reliability-repairs/result-notification-answers.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
