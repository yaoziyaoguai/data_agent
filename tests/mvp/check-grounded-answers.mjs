import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";

// 真实业务入口核对数值来源和正式交付；不以工具脚本冒称模型理解能力。
const h = await harness({
  capture: true,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "0.1" },
});
const checks = [];
let run, manager, passed = false;
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const attach = (value) => {
  run = value;
  manager = SessionManager.inMemory("/synthetic/data-agent");
};
const binding = () => ({ run_id: run.run_id, lease_epoch: run.lease_epoch });
const checkpoint = () => exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const rawTool = async (name, args, sdk = randomUUID()) => {
  const input = { ...binding(), sdk_tool_call_id: sdk, tool_name: name, arguments: args, checkpoint: checkpoint() };
  const registered = await h.internal("/internal/data/tool-calls", input);
  return { input, response: registered.status === 200 ? await h.internal("/internal/data/tools", input) : registered };
};
const tool = async (name, args) => ok((await rawTool(name, args)).response).data;
const begin = async (cid, text) => {
  await h.resumeWorker();
  attach(await h.capture(cid, text));
  await h.pauseWorker();
};
const route = (task) => tool("update_analysis_task", { action: "route", task_id: task.task_id, expected_version: task.condition_version, options: [] });
const conditions = {
  time_start: "2026-01-01T00:00:00Z", time_end: "2026-02-01T00:00:00Z", timezone: "UTC",
  metric: "net_revenue", channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "合成结果来源验收",
};
const createTask = () => tool("update_analysis_task", { action: "create", goal: "合成结果解释", conditions, options: [] });
const draft = (task, sql, parameters = {}) => tool("request_query", {
  task_id: task.task_id, condition_version: task.condition_version, sql, parameters,
  target_id: "synthetic-sqlite", summary: "合成结果来源验收SQL", knowledge_refs: [], replaces_query_id: null,
});
const append = (text, sequence) => h.internal("/internal/outputs", { ...binding(), chunk_seq: String(sequence), text });
const finishInput = (text, sdk, sequence = 1) => ({
  ...binding(), commit_id: run.output_id, final_text: text, final_start_chunk_seq: String(sequence), checkpoint: checkpoint(),
  ...(sdk ? { answer_sdk_tool_call_id: sdk } : {}),
});
const finishSetup = async () => {
  const text = "合成查询草稿已经准备。";
  ok(await append(text, 1));
  ok(await h.internal("/internal/finish", finishInput(text)));
  h.releaseRun(run.run_id);
};
const confirm = (query) => h.request(`/queries/${query.id}/confirm`, { operation_id: randomUUID(), draft_version: query.draft_version, condition_version: query.condition_version });
const source = (query, result) => ({ query_id: query.id, result_ref: result.result_ref, columns: result.columns.map(column => column.name) });
const amountInput = (query, result) => ({
  template: "按{{start}}起的原查询条件，净收入{{amount}}分；退款率{{rate}}，共{{rows}}行。",
  sources: [source(query, result)],
  values: [
    { name: "start", kind: "parameter", query_id: query.id, parameter: "start" },
    { name: "amount", kind: "cell", query_id: query.id, column: "amount", row_index: 0 },
    { name: "rate", kind: "cell", query_id: query.id, column: "refund_rate", row_index: 0 },
    { name: "rows", kind: "statistic", query_id: query.id, statistic: "row_count" },
  ],
});
const rejectAnswer = async (input, code = "invalid_evidence") => {
  const response = (await rawTool("present_analysis_answer", input)).response;
  assert.notEqual(response.status, 200);
  assert.equal(response.value.code, code, JSON.stringify(response.value));
};

try {
  const cid = await h.create();
  await begin(cid, "准备精确金额、空值和分页样例，先不执行。");
  const task = await createTask();
  const exactQuery = await draft(task, "SELECT '9007199254740993.01' AS amount, NULL AS refund_rate, :start AS period_start", { start: conditions.time_start });
  const pagedQuery = await draft(task, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<205) SELECT x FROM n");
  const partialQuery = await draft(task, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1005) SELECT x FROM n");
  await finishSetup();

  const foreignCid = await h.create();
  await begin(foreignCid, "准备另一会话的合成金额结果。");
  const foreignTask = await createTask();
  const foreignQuery = await draft(foreignTask, "SELECT '41' AS amount, NULL AS refund_rate", { });
  await finishSetup();
  const queries = [exactQuery, pagedQuery, partialQuery, foreignQuery];
  for (const query of queries) ok(await confirm(query));
  await h.resumeWorker();
  for (const query of queries) {
    await until(async () => ok(await h.request(`/queries/${query.id}`)).execution_state === "succeeded", "grounded query completed", 40000);
  }
  attach(await until(() => h.captured.find(value => value.conversation_id === cid && value.text.includes("query_id=")), "grounded result run", 40000));
  await h.pauseWorker();
  await route(task);
  const exactRead = await rawTool("get_query", { query_id: exactQuery.id });
  const exact = ok(exactRead.response).data.results;
  const paged = (await tool("get_query", { query_id: pagedQuery.id })).results;
  const partial = (await tool("get_query", { query_id: partialQuery.id })).results;
  const foreign = ok(await h.request(`/queries/${foreignQuery.id}/results`));
  const expected = "按2026-01-01T00:00:00Z起的原查询条件，净收入9007199254740993.01分；退款率NULL（空值），共1行。";
  const validInput = amountInput(exactQuery, exact);
  const valid = await rawTool("present_analysis_answer", validInput);
  assert.equal(ok(valid.response).data.answer_text, expected);
  assert.deepEqual(valid.response.value.data.result_dependencies.map(({ query_id, result_ref }) => ({ query_id, result_ref })), [{ query_id: exactQuery.id, result_ref: exact.result_ref }]);
  checks.push("精确大整数金额保留十进制原文，NULL不改零或百分比，原SQL日期参数和结果行数均由宿主填入");

  const badColumn = structuredClone(validInput); badColumn.values[1].column = "not_returned";
  await rejectAnswer(badColumn);
  const badRow = structuredClone(validInput); badRow.values[1].row_index = 1;
  await rejectAnswer(badRow);
  const unbound = structuredClone(validInput); unbound.template = "净收入{{missing}}分。";
  await rejectAnswer(unbound);
  await rejectAnswer({ ...validInput, template: "净收入增长10.8%。" }, "invalid_input");
  const wrongResult = structuredClone(validInput); wrongResult.sources[0].result_ref = "other-result";
  await rejectAnswer(wrongResult);
  await rejectAnswer({
    template: "金额{{amount}}分。", sources: [source(foreignQuery, foreign)],
    values: [{ name: "amount", kind: "cell", query_id: foreignQuery.id, column: "amount", row_index: 0 }],
  }, "not_available");
  checks.push("未返回列、越界行、无来源插槽、模型直写比例、错结果版本及跨会话结果都不能形成正式答案");

  const countInput = (query, result) => ({
    template: "实际取得{{rows}}行。", sources: [source(query, result)],
    values: [{ name: "rows", kind: "statistic", query_id: query.id, statistic: "row_count" }],
  });
  const allPages = await tool("present_analysis_answer", countInput(pagedQuery, paged));
  assert.equal(allPages.answer_text, "实际取得205行。", "统计来自完整保存结果，不能只数首个预览页");
  const partialAnswer = await tool("present_analysis_answer", countInput(partialQuery, partial));
  assert.match(partialAnswer.answer_text, /实际取得1000行/);
  assert.match(partialAnswer.answer_text, /不能视作全量统计/);
  checks.push("多页完整结果按全保存范围统计，平台截断结果明确标示范围不足而非宣称全量");

  const answer = await rawTool("present_analysis_answer", validInput);
  const answerText = ok(answer.response).data.answer_text;
  const sdk = answer.input.sdk_tool_call_id;
  const changed = await h.internal("/internal/finish", finishInput(answerText + "额外增长10.8%。", sdk));
  assert.notEqual(changed.status, 200, "不能借成功来源回执提交另加数字的正文");
  assert.equal(h.sql(`SELECT JSON_OBJECT('state',state) FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0].state, "streaming");
  const wrongTool = await h.internal("/internal/finish", finishInput(answerText, exactRead.input.sdk_tool_call_id));
  assert.notEqual(wrongTool.status, 200, "一般查询读取回执不能冒充已核对答案");
  const beforeCommit = await h.snapshot(cid);
  assert.ok(!beforeCommit.events.some(event => ["assistant_delta", "assistant_committed"].includes(event.type) && event.payload.attempt_id === run.attempt_id), "未通过正式提交的定量正文不能先产生可见事件");
  const committed = finishInput(answerText, sdk);
  ok(await h.internal("/internal/finish", committed));
  ok(await h.internal("/internal/finish", committed));
  h.releaseRun(run.run_id);
  const stored = h.sql(`SELECT JSON_OBJECT('state',state,'text',final_text) FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0];
  assert.deepEqual(stored, { state: "committed", text: expected });
  const snapshot = await h.snapshot(cid);
  assert.ok(snapshot.messages.some(message => message.role === "assistant" && message.text === expected), "刷新读取持久正式答案与核对回执一致");
  assert.equal(snapshot.events.filter(event => event.type === "assistant_committed" && event.payload.attempt_id === run.attempt_id).length, 1);
  checks.push("定量答案直接finish，核验与正文事件同事务；改写正文或借用读取回执被拒绝且不提前广播，合法提交幂等并与刷新内容一致");

  // 捕获式模型替身必须完成队列中先到的结果回合，才会继续派发下一会话。
  const completedResults = new Set([run.run_id]);
  const resultByQuery = new Map([[exactQuery.id, exact], [pagedQuery.id, paged], [partialQuery.id, partial]]);
  for (let count = 0; count < queries.length; count++) {
    await h.resumeWorker();
    attach(await until(() => h.captured.find(value => value.text.includes("query_id=") && !completedResults.has(value.run_id)), "next result run", 40000));
    await h.pauseWorker();
    if (run.conversation_id === foreignCid) break;
    assert.equal(run.conversation_id, cid);
    await route(task);
    const query = queries.find(item => run.text.includes("query_id=" + item.id));
    assert.ok(query && resultByQuery.has(query.id));
    const remaining = await rawTool("present_analysis_answer", countInput(query, resultByQuery.get(query.id)));
    const remainingText = ok(remaining.response).data.answer_text;
    ok(await h.internal("/internal/finish", finishInput(remainingText, remaining.input.sdk_tool_call_id)));
    h.releaseRun(run.run_id);
    completedResults.add(run.run_id);
  }
  assert.equal(run.conversation_id, foreignCid);
  await route(foreignTask);
  const revocableInput = {
    template: "实际金额{{amount}}分。", sources: [source(foreignQuery, foreign)],
    values: [{ name: "amount", kind: "cell", query_id: foreignQuery.id, column: "amount", row_index: 0 }],
  };
  const revocable = await rawTool("present_analysis_answer", revocableInput);
  const revokedText = ok(revocable.response).data.answer_text;
  await writeFile(h.directory + "/platform/permissions.json", JSON.stringify({ denied_query_users: ["alice"] }));
  const staleReplay = await h.internal("/internal/data/tools", revocable.input);
  assert.notEqual(staleReplay.status, 200, "平台撤权后不能从旧成功回执取回答案正文");
  assert.equal(staleReplay.value.data?.answer_text, undefined);
  const staleFinish = await h.internal("/internal/finish", finishInput(revokedText, revocable.input.sdk_tool_call_id));
  assert.notEqual(staleFinish.status, 200, "平台撤权后未提交的答案不能再被提交");
  assert.notEqual(h.sql(`SELECT JSON_OBJECT('state',state) FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0].state, "committed");
  const revokedSnapshot = await h.snapshot(foreignCid);
  assert.ok(!revokedSnapshot.events.some(event => ["assistant_delta", "assistant_committed"].includes(event.type) && event.payload.attempt_id === run.attempt_id), "来源撤权后失败的finish不能产生该正文的可见事件");
  assert.ok(!revokedSnapshot.messages.some(message => message.role === "assistant" && message.text === revokedText));
  const committedReplay = ok(await h.internal("/internal/finish", committed));
  assert.equal(committedReplay.state, "finished", "已经提交的相同payload在撤权后只接回提交状态，不重做来源读取");
  assert.equal(committedReplay.final_text, undefined);
  assert.equal(committedReplay.answer_text, undefined);
  checks.push("成功present后撤权阻止旧回执和finish，snapshot/events没有泄漏正文；已提交finish的相同payload撤权后仍幂等返回状态且无正文");
  passed = true;
} finally {
  await mkdir(".local/checks/agent-reliability-repairs", { recursive: true });
  const report = { passed, checks, officialRequests: 0, platform: "executable synthetic SQLite", model: "controlled tool inputs", runtimeDirectory: h.directory.replace(process.cwd() + "/", "") };
  await writeFile(".local/checks/agent-reliability-repairs/grounded-answers.json", JSON.stringify(report, null, 2));
  await h.close();
  console.log(JSON.stringify(report));
}
