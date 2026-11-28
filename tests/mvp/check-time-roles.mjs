import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";

// 04切片3：time_roles消费语义。观察截点/数据批次是用户声明：保存草稿时投影快照，
// 答案只绑定快照声明值；未声明不绑定，不以request_clock或data_freshness冒充。
const h = await harness({
  capture: true,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "0.1" },
});
const checks = [];
let run, manager;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const attach = value => {run = value; manager = SessionManager.inMemory("/synthetic/data-agent");};
const binding = () => ({run_id: run.run_id, lease_epoch: run.lease_epoch});
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const rawTool = async (name, args, sdk = randomUUID()) => {
  const input = {...binding(), sdk_tool_call_id: sdk, tool_name: name, arguments: args, checkpoint: checkpoint()};
  const registered = await h.internal("/internal/data/tool-calls", input);
  return {input, response: registered.status === 200 ? await h.internal("/internal/data/tools", input) : registered};
};
const tool = async (name, args) => ok((await rawTool(name, args)).response).data;
const begin = async (cid, text) => {
  await h.resumeWorker(); attach(await h.capture(cid, text)); await h.pauseWorker();
};
const route = task => tool("update_analysis_task",
  {action: "route", task_id: task.task_id, expected_version: task.condition_version, options: []});
const baseConditions = {
  time_start: "2026-01-01T00:00:00Z", time_end: "2026-02-01T00:00:00Z", timezone: "UTC",
  metric: "net_revenue", channel: null, group_by: [], filters: [], knowledge_refs: [],
  notes: "合成时间口径验收", source_limits: null,
};
const declaredConditions = {...baseConditions, time_roles: [
  {role: "event_time", description: "订单发生时间", field_ref: "ordered_at", value: null, evidence_refs: []},
  {role: "observation_cutoff", description: "用户声明的观察截点", field_ref: null,
    value: "2026-10-01T00:00:00+08:00", evidence_refs: []},
  {role: "data_batch", description: "上游批次", field_ref: "batch_id", value: "2026-09", evidence_refs: []},
  {role: "data_batch", description: "对账批次", field_ref: "recon_id", value: "2026-09-R", evidence_refs: []},
]};
const createTask = conditions => tool("update_analysis_task",
  {action: "create", goal: "合成时间口径验收", conditions, options: []});
const revise = (task, set, unset = []) => tool("update_analysis_task",
  {action: "revise", task_id: task.task_id, expected_version: task.condition_version,
    goal: "", condition_patch: {set, unset}, options: []});
const draft = (task, sql, summary) => tool("request_query", {
  task_id: task.task_id, condition_version: task.condition_version, sql, parameters: {},
  target_id: "synthetic-sqlite", summary, knowledge_refs: [], replaces_query_id: null,
});
const append = (text, sequence) => h.internal("/internal/outputs", {...binding(), chunk_seq: String(sequence), text});
const finishRun = async text => {
  ok(await append(text, 1));
  ok(await h.internal("/internal/finish", {...binding(), commit_id: run.output_id,
    final_text: text, checkpoint: checkpoint()}));
  h.releaseRun(run.run_id);
};
const confirm = query => h.request(`/queries/${query.id}/confirm`,
  {operation_id: randomUUID(), draft_version: query.draft_version, condition_version: query.condition_version});
const source = (query, result) => ({
  query_id: query.id, result_ref: result.result_ref,
  columns: result.columns.map(column => column.name),
});
const rejectAnswer = async (input, code = "invalid_evidence") => {
  const response = (await rawTool("present_analysis_answer", input)).response;
  assert.notEqual(response.status, 200);
  assert.equal(response.value.code, code, JSON.stringify(response.value));
};

try {
  // 一、快照投影：声明time_roles的任务草稿带完整快照；未声明任务的草稿为null。
  const cid = await h.create();
  await begin(cid, "按声明的截点和批次统计，同时准备一个不声明口径的对照任务。");
  const declaredTask = await createTask(declaredConditions);
  const plainTask = await createTask(baseConditions);
  const declaredQuery = await draft(declaredTask, "SELECT 41 AS amount", "声明时间口径的草稿");
  assert.equal(declaredQuery.time_basis.time_roles.length, 4, "草稿快照携带全部声明角色");
  assert.equal(declaredQuery.time_basis.time_start, "2026-01-01T00:00:00Z");
  assert.equal(declaredQuery.time_basis.time_roles.find(role => role.role === "observation_cutoff").value,
    "2026-10-01T00:00:00+08:00", "观察截点为用户声明值");
  const plainQuery = await draft(plainTask, "SELECT 42 AS amount", "不声明口径的草稿");
  assert.equal(plainQuery.time_basis, null, "未声明time_roles的任务草稿不携带时间基准");
  await finishRun("时间口径草稿已准备。");

  // 二、答案只绑定声明快照：截点/批次渲染声明值并按field_ref消歧；
  // 未声明草稿拒绝绑定，不能以request_clock或平台data_freshness冒充用户口径。
  for (const query of [declaredQuery, plainQuery]) ok(await confirm(query));
  await h.resumeWorker();
  for (const query of [declaredQuery, plainQuery]) {
    await until(async () => ok(await h.request(`/queries/${query.id}`)).execution_state === "succeeded",
      "time role query completed", 40000);
  }
  attach(await until(() => h.captured.find(value => value.conversation_id === cid && value.text.includes("query_id=")),
    "time role result run", 40000));
  await h.pauseWorker();
  await route(declaredTask);
  const declaredResult = (await tool("get_query", {query_id: declaredQuery.id})).results;
  const plainResult = (await tool("get_query", {query_id: plainQuery.id})).results;
  const validInput = {
    template: "截至{{cutoff}}（上游批次{{batch}}，对账批次{{recon}}），共{{rows}}行。",
    sources: [source(declaredQuery, declaredResult)],
    values: [
      {name: "cutoff", kind: "observation_cutoff", query_id: declaredQuery.id},
      {name: "batch", kind: "data_batch", query_id: declaredQuery.id, field_ref: "batch_id"},
      {name: "recon", kind: "data_batch", query_id: declaredQuery.id, field_ref: "recon_id"},
      {name: "rows", kind: "statistic", query_id: declaredQuery.id, statistic: "row_count"},
    ],
  };
  const valid = await rawTool("present_analysis_answer", validInput);
  assert.equal(ok(valid.response).data.answer_text,
    "截至2026-10-01T00:00:00+08:00（上游批次2026-09，对账批次2026-09-R），共1行。",
    "截点/批次由宿主绑定声明快照值，field_ref消歧同名角色");
  const ambiguous = structuredClone(validInput);
  ambiguous.values = [structuredClone(validInput.values[1])];
  delete ambiguous.values[0].field_ref;
  ambiguous.template = "批次{{batch}}。";
  await rejectAnswer(ambiguous);
  const undeclaredInput = {
    template: "截至{{cutoff}}。",
    sources: [source(plainQuery, plainResult)],
    values: [{name: "cutoff", kind: "observation_cutoff", query_id: plainQuery.id}],
  };
  await rejectAnswer(undeclaredInput);
  checks.push("答案绑定声明快照：截点/批次渲染声明值并按field_ref消歧；未声明草稿拒绝绑定");
  const answerText = ok(valid.response).data.answer_text;
  ok(await append(answerText, 1));
  ok(await h.internal("/internal/finish", {...binding(), commit_id: run.output_id,
    final_text: answerText, final_start_chunk_seq: "1",
    answer_sdk_tool_call_id: valid.input.sdk_tool_call_id, checkpoint: checkpoint()}));
  const seen = new Set(h.captured.filter(v => v.conversation_id === cid).map(v => v.run_id));
  h.releaseRun(run.run_id);
  // 对照查询的结果各有一轮自动交付：先让plainQuery的交付轮完成，第三条消息才能开始。
  await h.resumeWorker();
  attach(await until(() => h.captured.find(v => v.conversation_id === cid && !seen.has(v.run_id)),
    "plain result run", 40000));
  await h.pauseWorker();
  const note = "对照查询结果已记录。";
  ok(await append(note, 1));
  ok(await h.internal("/internal/finish", {...binding(), commit_id: run.output_id,
    final_text: note, checkpoint: checkpoint()}));
  h.releaseRun(run.run_id);

  // 三、任务后来解除声明：新草稿为null，已执行草稿的快照保持原状不被改写。
  await begin(cid, "这轮不再限定截点和批次。");
  const lifted = await revise(declaredTask, {}, ["time_roles"]);
  const liftedQuery = await draft({...declaredTask, condition_version: lifted.condition_version},
    "SELECT 43 AS amount", "解除声明后的草稿");
  assert.equal(liftedQuery.time_basis, null, "解除声明后新草稿不携带时间基准");
  const reread = ok(await h.request(`/queries/${declaredQuery.id}`));
  assert.equal(reread.time_basis.time_roles.length, 4,
    "任务后来改版不改写已保存草稿的声明快照");
  await finishRun("解除时间口径后的草稿已准备。");
  checks.push("声明快照跟草稿走：保存时投影、解除后新草稿为null、旧草稿不被改写");

  const summary = {passed: true, checks, officialRequests: 0};
  await writeFile(".local/checks/mvp-time-roles.json", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {await h.close();}
