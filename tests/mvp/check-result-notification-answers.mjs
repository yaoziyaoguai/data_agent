import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";

// 固定本地协议验证真实Pi的通知交付，不用模型替身伪造宿主终态或结果权限。
const profile = { provider_id: "deepseek", model_id: "deepseek-flash", trial_id: randomUUID(),
  price_version: "2026-10-04-peak-usd", input_limit: 65536, output_limit: 2048,
  trial_call_limit: 40, trial_cost_micros: "1000000", request_call_limit: 24,
  toolset: "data", payload_bytes_limit: 131072 };
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
const lastReply = body => {
  const message = body.messages.findLast(value => value.role === "tool");
  assert.ok(message, "必须接到真实工具回执");
  return JSON.parse(message.content);
};
let h, run, manager, plan, protocolFailure, passed = false;
let calls = 0;
const checks = [];
const requests = [];
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-protocol-key");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
    assert.ok(body.tools.some(tool => tool.function.name === "present_analysis_answer"));
    assert.ok(plan && plan.index < plan.steps.length, "状态通知不得追加无法满足的结果呈现回合");
    const step = plan.steps[plan.index++];
    if (step.observe) step.observe(body);
    calls++;
    requests.push({ label: plan.label, step: plan.index, tool: step.name ?? null, bytes: Buffer.byteLength(raw) });
    const delta = step.name ? { role: "assistant", content: "正在核对查询状态。", tool_calls: [{
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
  channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "合成查询终态通知" };
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
  ]) {
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
    assert.deepEqual(run.workspace_context.result_notification, { query_id: query.id, execution_state: example.state });
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
    assert.equal(snapshot.runs.find(item => item.run_id === run.run_id).state, "finished");
    assert.equal(snapshot.messages.findLast(item => item.role === "assistant" && item.committed).text, example.answer);
    assert.deepEqual(ok(await h.request(`/queries/${query.id}`)), queryState, "通知解释不重新执行或改写查询状态");
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
  assert.equal(calls, 9);
  const unsettled = h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE state<>'settled'")[0].n;
  assert.equal(unsettled, 0);
  passed = true;
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (h) await h.close();
  await new Promise(resolve => provider.close(resolve));
  await mkdir(".local/checks/agent-reliability-repairs", { recursive: true });
  const report = { passed, checks, calls, requests, officialRequests: 0,
    scope: "真实Pi/本地OpenAI协议、Rust/MySQL和可执行SQLite产生的failed/cancelled及成功后撤权通知；不证明真实模型判断" };
  await writeFile(".local/checks/agent-reliability-repairs/result-notification-answers.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
