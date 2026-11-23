import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, replayEvents, until } from "./harness.mjs";

// 真实业务入口核对数值来源和正式交付；不以工具脚本冒称模型理解能力。
const historyBrowser = process.argv.includes("--history-browser");
const h = await harness({
  capture: true,
  web: historyBrowser,
  // 新隔离库准备已超出默认窗口；这里只调整准备等待，业务与租约断言不变。
  startupTimeout: 180000,
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
  if (name === "present_analysis_answer") {
    // 旧答案工具只接回已有登记；用实际运行和活动任务构造升级前留下的登记。
    const body = JSON.stringify({ name, arguments: args }, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
        : value);
    const fingerprint = createHash("sha256").update(body).digest("hex");
    h.sql(`INSERT INTO tool_calls(operation_id,conversation_id,recovery_chain_id,sdk_tool_call_id,
      origin_run_id,tool_contract_version,tool_name,arguments_fingerprint,state,created_at,task_id,task_condition_version,execution_started)
      SELECT '${randomUUID()}',r.conversation_id,r.recovery_chain_id,'${sdk}',r.id,2,
        'present_analysis_answer','${fingerprint}','registered',UTC_TIMESTAMP(3),t.id,t.condition_version,FALSE
      FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id
      JOIN analysis_tasks t ON t.id=c.active_task_id WHERE r.id='${run.run_id}'`);
  }
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
  source_limits: null,
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
  // 数字禁令已随格式化合同移除：正常语义数字直写不再被机械拒绝，程序只保证绑定值与来源一致。
  const directNumbers = await tool("present_analysis_answer", { ...validInput, template: "净收入增长10.8%；分母为0时比例为空。" });
  assert.equal(directNumbers.answer_text, "净收入增长10.8%；分母为0时比例为空。");
  const wrongResult = structuredClone(validInput); wrongResult.sources[0].result_ref = "other-result";
  await rejectAnswer(wrongResult);
  await rejectAnswer({
    template: "金额{{amount}}分。", sources: [source(foreignQuery, foreign)],
    values: [{ name: "amount", kind: "cell", query_id: foreignQuery.id, column: "amount", row_index: 0 }],
  }, "not_available");
  checks.push("未返回列、越界行、无来源插槽、错结果版本及跨会话结果都不能形成正式答案；语义数字直写不再整轮拒绝");

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
  const originalAnswer = snapshot.messages.find(message => message.role === "assistant" && message.text === expected);
  assert.ok(originalAnswer, "刷新读取持久正式答案与核对回执一致");
  assert.equal(snapshot.events.filter(event => event.type === "assistant_committed" && event.payload.attempt_id === run.attempt_id).length, 1);
  checks.push("定量答案直接finish，核验与正文事件同事务；改写正文或借用读取回执被拒绝且不提前广播，合法提交幂等并与刷新内容一致");

  // 同一合法单答案核旧NULL格式；非NULL损坏格式不能回退为公开自然文本。
  const originalBinding = h.sql(`SELECT JSON_OBJECT('binding',read_binding) FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0].binding;
  try {
    h.sql(`UPDATE assistant_outputs SET read_binding=NULL WHERE attempt_id='${run.attempt_id}'`);
    assert.equal((await h.snapshot(cid)).messages.find(message => message.attempt_id === run.attempt_id)?.text, expected, "旧NULL格式仍接回原成功单答案");
    h.sql(`UPDATE assistant_outputs SET read_binding=JSON_OBJECT('schema',1,'units',JSON_ARRAY()) WHERE attempt_id='${run.attempt_id}'`);
    assert.equal((await h.snapshot(cid)).messages.find(message => message.attempt_id === run.attempt_id)?.text, "部分内容因来源不可读而隐藏。", "非NULL格式缺少来源单元必须限制正文");
  } finally {
    h.sql(`UPDATE assistant_outputs SET read_binding=CONVERT(0x${Buffer.from(JSON.stringify(originalBinding), 'utf8').toString('hex')} USING utf8mb4) WHERE attempt_id='${run.attempt_id}'`);
  }
  assert.equal((await h.snapshot(cid)).messages.find(message => message.attempt_id === run.attempt_id)?.text, expected, "恢复原绑定后读取同一提交原文");
  checks.push("单答案旧NULL读取兼容，非NULL损坏绑定不降为无来源，恢复原绑定后正文保持");

  // 捕获式模型替身必须完成队列中先到的结果回合，才会继续派发下一会话。
  const completedResults = new Set([run.run_id]);
  const resultByQuery = new Map([[exactQuery.id, exact], [pagedQuery.id, paged], [partialQuery.id, partial]]);
  const settleResult = async () => {
    assert.equal(run.conversation_id, cid);
    await route(task);
    const query = queries.find(item => run.text.includes("query_id=" + item.id));
    assert.ok(query && resultByQuery.has(query.id));
    const remaining = await rawTool("present_analysis_answer", countInput(query, resultByQuery.get(query.id)));
    const remainingText = ok(remaining.response).data.answer_text;
    ok(await h.internal("/internal/finish", finishInput(remainingText, remaining.input.sdk_tool_call_id)));
    h.releaseRun(run.run_id);
    completedResults.add(run.run_id);
  };
  for (let count = 0; count < queries.length; count++) {
    await h.resumeWorker();
    attach(await until(() => h.captured.find(value => value.text.includes("query_id=") && !completedResults.has(value.run_id)), "next result run", 40000));
    await h.pauseWorker();
    if (run.conversation_id === foreignCid) break;
    await settleResult();
  }
  assert.equal(run.conversation_id, foreignCid);
  await route(foreignTask);
  // HTTP读取不登记本轮已交付结果；先由当前run读取，再绑定同一结果形成答案。
  const revocableResult = (await tool("get_query", { query_id: foreignQuery.id })).results;
  assert.equal(revocableResult.result_ref, foreign.result_ref, "当前run仍须读取原来同一份结果");
  const revocableInput = {
    template: "实际金额{{amount}}分。", sources: [source(foreignQuery, revocableResult)],
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
  const revokedCommitted = await h.snapshot(cid);
  assert.ok(!revokedCommitted.messages.some(message => message.role === "assistant" && message.text.includes("9007199254740993.01")), "撤权后已提交历史答案不能由snapshot缓存返回");
  assert.ok(!revokedCommitted.events.some(event => ["assistant_delta", "assistant_committed"].includes(event.type) && event.payload.text?.includes("9007199254740993.01")), "历史事件页同样不能返回撤权数值");
  const restrictedAnswer = revokedCommitted.messages.find(message => message.attempt_id === originalAnswer.attempt_id && message.committed);
  assert.ok(restrictedAnswer, "限制正文仍保留原答案消息身份");
  assert.equal(restrictedAnswer.output_id, originalAnswer.output_id);
  assert.ok(revokedCommitted.messages.some(message => message.role === "assistant" && message.text === "合成查询草稿已经准备。"), "无结果依赖的原说明继续可读");
  assert.ok(revokedCommitted.messages.some(message => message.role === "user" && message.text === "准备精确金额、空值和分页样例，先不执行。"), "用户原消息继续可读");
  const eventReplay = await replayEvents(h.env.DATA_AGENT_API_URL + `/conversations/${cid}/events?after_seq=0`, {authorization: "Bearer " + h.tokens.alice});
  assert.ok(!eventReplay.some(event => ["assistant_delta", "assistant_committed"].includes(event.type) && event.payload.text?.includes("9007199254740993.01")), "SSE重放不能绕过snapshot正文权限投影");
  // 正式数值可直接提交而不广播delta；用紧邻提交的游标核对重放来源。
  const originalCommit = snapshot.events.find(event => event.type === "assistant_committed" && event.payload.attempt_id === originalAnswer.attempt_id);
  assert.ok(originalCommit);
  const cursorReplay = await replayEvents(h.env.DATA_AGENT_API_URL + `/conversations/${cid}/events?after_seq=${BigInt(originalCommit.event_seq) - 1n}`, {authorization: "Bearer " + h.tokens.alice});
  assert.ok(cursorReplay.some(event => event.type === "assistant_committed" && event.payload.attempt_id === originalAnswer.attempt_id), "游标从答案内部续读仍保留提交身份");
  assert.ok(!cursorReplay.some(event => ["assistant_delta", "assistant_committed"].includes(event.type) && event.payload.text?.includes("9007199254740993.01")), "游标续读仍须核原答案来源");
  await writeFile(h.directory + "/platform/permissions.json", "{}");
  const restoredCommitted = await h.snapshot(cid);
  assert.ok(restoredCommitted.messages.some(message => message.role === "assistant" && message.text === expected), "恢复读取权后原正式正文仍可读，不能删除或改写历史记录");
  checks.push("已提交历史答案及事件按当前结果权限投影，恢复后读回同一原文且不重新执行查询");
  await h.pausePlatform();
  try {
    const unavailable = await h.snapshot(cid);
    assert.equal(unavailable.messages.find(message => message.output_id === originalAnswer.output_id)?.text,
      "部分内容因来源不可读而隐藏。", "结果来源暂不可达只隐藏受影响正文");
    assert.ok(unavailable.messages.some(message => message.text === "合成查询草稿已经准备。"), "仍能读取同页普通答复");
  } finally {
    await h.resumePlatform();
  }
  assert.ok((await h.snapshot(cid)).messages.some(message => message.text === expected));
  checks.push("平台暂不可达时同页仍可读，恢复后原答案可读");
  if (historyBrowser) {
    const { chromium } = await import("playwright");
    const foreignAttempt = run.attempt_id;
    ok(await h.internal("/internal/finish", finishInput(revokedText, revocable.input.sdk_tool_call_id)));
    h.releaseRun(run.run_id);
    while (completedResults.size < resultByQuery.size) {
      await h.resumeWorker();
      attach(await until(() => h.captured.find(value => value.conversation_id === cid
        && value.text.includes("query_id=") && !completedResults.has(value.run_id)), "remaining result notification", 40000));
      await h.pauseWorker();
      await settleResult();
    }
    await begin(cid, "先生成一段可停止的合成说明，不执行查询。");
    const cancelledAttempt = run.attempt_id;
    ok(await append("尚未定稿的合成说明。", 1));
    const streamingPage = await h.snapshot(cid);
    const streamEvent = streamingPage.events.find(event => event.type === "assistant_delta" && event.payload.attempt_id === cancelledAttempt);
    assert.ok(streamEvent, "取消前确已读入流式片段");
    const loadedRanges = [
      { attempt_id: cancelledAttempt, first_event_seq: streamEvent.event_seq, last_event_seq: streamEvent.event_seq },
      { attempt_id: originalAnswer.attempt_id, first_event_seq: originalCommit.event_seq, last_event_seq: originalCommit.event_seq },
    ];
    const beforeCancel = ok(await h.request(`/conversations/${cid}/snapshot`, { loaded_outputs: loadedRanges }));
    assert.equal(beforeCancel.output_projections[0].output_state, "streaming");
    const cancelled = ok(await h.request(`/conversations/${cid}/cancel-run`, binding()));
    assert.equal(cancelled.state, "cancelled");
    h.releaseRun(run.run_id);
    const afterCancel = ok(await h.request(`/conversations/${cid}/snapshot`, {
      after_seq: streamingPage.last_event_seq, loaded_outputs: loadedRanges,
    }));
    assert.equal(afterCancel.output_projections[0].output_state, "cancelled", "正常取消终态必须能进入历史刷新响应");
    assert.ok(afterCancel.output_projections[1].events.some(event => event.payload.text === expected), "取消片段不能阻断同次响应中的已提交答案");
    checks.push("已读流式片段经正式停止生成后仍能按原范围刷新，并保同次已提交答案投影");
    // 只在本隔离夹具的合法提交之间补分页消息，保答案、来源、ID及相对顺序。
    const cut = Number(originalCommit.event_seq), padding = 1100;
    const before = h.sql(`SELECT JSON_OBJECT('seq',event_seq) FROM conversations WHERE id='${cid}'`)[0].seq;
    h.sql(`UPDATE conversation_events SET event_seq=event_seq+${padding} WHERE conversation_id='${cid}' AND event_seq>${cut} ORDER BY event_seq DESC`);
    const rows = Array.from({ length: padding }, (_, index) => {
      const payload = Buffer.from(JSON.stringify({ message_id: "history-permission-" + index, text: "历史权限分页消息 " + index }), "utf8").toString("hex");
      return `('${randomUUID()}','${cid}',${cut + index + 1},'message',CONVERT(0x${payload} USING utf8mb4))`;
    });
    h.sql("INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) VALUES" + rows.join(",") + `;UPDATE conversations SET event_seq=${Number(before) + padding} WHERE id='${cid}'`);
    const eventCursor = String(Number(before) + padding);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [], reads = [];
    let activeReads = 0, maxActiveReads = 0, holdNext = false, held = false, releaseHeld = () => {};
    let waitingForLatestRetry = false, prematureOlder = false;
    const authorityChanged = async () => {
      const response = await fetch(h.env.DATA_AGENT_API_URL + "/internal/live-changes", {
        method: "POST",
        headers: { authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type": "application/json" },
        body: JSON.stringify([{ kind: "authority", space_id: "demo" }]),
      });
      assert.equal(response.status, 204);
    };
    page.on("pageerror", error => browserErrors.push(error.message));
    const permissions = h.directory + "/platform/permissions.json", originalPermissions = await readFile(permissions, "utf8");
    await page.route(`**/api/conversations/${cid}/snapshot`, async request => {
      activeReads++; maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        assert.equal(request.request().method(), "POST");
        const input = request.request().postDataJSON();
        const unavailable = {status:503, json:{code:"upstream_failed", message:"合成短暂故障", request_id:randomUUID(), retryable:true}};
        if (waitingForLatestRetry && input.before_seq) {
          prematureOlder = true;
          await request.fulfill(unavailable);
          return;
        }
        const response = await request.fetch();
        const output = await response.json();
        reads.push({ input, output });
        if (holdNext && input.after_seq) {
          holdNext = false; held = true;
          await new Promise(resolve => { releaseHeld = resolve; });
          waitingForLatestRetry = true;
          await request.fulfill(unavailable);
          return;
        }
        if (!input.before_seq && response.ok()) waitingForLatestRetry = false;
        await request.fulfill({ response });
      } finally { activeReads--; }
    });
    try {
      await page.addInitScript(id => {
        localStorage.setItem('data-agent.conversation.["demo","alice"]', id);
        const nativeFetch = window.fetch.bind(window), active = new Set();
        const observed = window.__historySnapshotReads = { max: 0, trace: [] };
        let sequence = 0;
        window.fetch = async (url, options) => {
          if (!String(url).endsWith(`/conversations/${id}/snapshot`)) return nativeFetch(url, options);
          const key = ++sequence, signal = options?.signal;
          active.add(key); observed.max = Math.max(observed.max, active.size);
          observed.trace.push({ event: "start", key, input: JSON.parse(options.body) });
          const settle = event => { active.delete(key); observed.trace.push({ event, key }); signal?.removeEventListener("abort", aborted); };
          const aborted = () => settle("abort");
          signal?.addEventListener("abort", aborted, { once: true });
          try {
            const response = await nativeFetch(url, options), json = response.json.bind(response);
            response.json = async () => { try { return await json(); } finally { settle("body_read"); } };
            return response;
          } catch (error) { settle("failed"); throw error; }
        };
      }, cid);
      await page.goto(h.url);
      await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
      await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
      await page.getByText("实际取得205行。", { exact: true }).waitFor();
      holdNext = true;
      await authorityChanged();
      await until(() => held, "普通快照在途");
      const heldCount = reads.length;
      await page.getByRole("button", { name: "加载更早的消息", exact: true }).click();
      await page.waitForTimeout(800);
      assert.equal(reads.length, heldCount, "loadOlder在普通刷新合并前不能另发snapshot");
      releaseHeld();
      await page.getByText(expected, { exact: true }).waitFor();
      await page.getByText("合成查询草稿已经准备。", { exact: true }).waitFor();
      const loaded = reads.findLast(read => read.input.before_seq);
      assert.ok(loaded, "确实加载旧页");
      assert.equal(prematureOlder, false, "权限补读短暂失败后先恢复快照，再继续原翻页请求");
      assert.equal((await page.evaluate(() => window.__historySnapshotReads)).max, 1, "首次页、普通刷新与翻页共用一个读取门");
      // 查询列表已随工作台事件发送；该状态失败不能丢掉已经成功的快照权限刷新。
      const stream = `**/api/conversations/${cid}/events?*`;
      let overviewFailed = false;
      const streamReady = response => response.url().includes(`/conversations/${cid}/events?`)
        && response.status() === 200 && !response.headers()["x-synthetic-invalid-frame"];
      const deniedStream = page.waitForResponse(streamReady);
      await page.route(stream, request => {
        if (overviewFailed) return request.continue();
        overviewFailed = true;
        return request.fulfill({status:200, contentType:"text/event-stream",
          headers:{"x-synthetic-invalid-frame":"true"},
          body:'event: workbench_state\ndata: {"query_list":null}\n\n'});
      });
      await writeFile(permissions, JSON.stringify({ denied_query_users: ["alice"] }));
      await authorityChanged();
      await until(async () => overviewFailed && await page.getByText(expected, { exact: true }).count() === 0 && await page.getByText("实际取得205行。", { exact: true }).count() === 0, "权限补读隐藏旧新页答案", 40000);
      assert.equal(await page.getByText("合成查询草稿已经准备。", { exact: true }).count(), 1);
      assert.equal(await page.getByText("准备精确金额、空值和分页样例，先不执行。", { exact: true }).count(), 1);
      await page.getByText("部分内容因来源不可读而隐藏。", { exact: true }).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: h.directory + "/history-loaded-denied.png" });
      await page.unroute(stream);
      await deniedStream;
      await writeFile(permissions, originalPermissions);
      const restoredStream = page.waitForResponse(streamReady);
      await authorityChanged();
      await until(async () => await page.getByText(expected, { exact: true }).count() === 1 && await page.getByText("实际取得205行。", { exact: true }).count() === 1, "权限补读恢复全部已加载页原文", 40000);
      await page.getByText(expected, { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: h.directory + "/history-loaded-restored.png" });
      await restoredStream;
      await authorityChanged();
      await until(() => reads.some(read => read.input.loaded_outputs?.length && read.output.output_projections?.every(projection => projection.projection_result === "unchanged" && projection.events === undefined)), "相同投影不重传正文", 40000);
      assert.ok(reads.some(read => read.output.output_projections?.some(projection => projection.attempt_id === cancelledAttempt && projection.output_state === "cancelled")), "权限补读已携带取消片段，其他答案仍完成撤权和恢复");
      assert.equal(String(h.sql(`SELECT JSON_OBJECT('seq',event_seq) FROM conversations WHERE id='${cid}'`)[0].seq), eventCursor, "撤权和恢复没有追加会话事件");
      assert.equal((await page.evaluate(() => window.__historySnapshotReads)).max, 1);
      assert.deepEqual(browserErrors, []);
      const boundary = ok(await h.request(`/conversations/${cid}/snapshot`, { after_seq: eventCursor, loaded_outputs: [
        { attempt_id: foreignAttempt, first_event_seq: "1", last_event_seq: eventCursor },
        { attempt_id: "missing-output", first_event_seq: "1", last_event_seq: eventCursor },
        { attempt_id: originalAnswer.attempt_id, first_event_seq: String(Number(eventCursor) + 1), last_event_seq: String(Number(eventCursor) + 1) },
      ] }));
      assert.deepEqual(boundary.output_projections.slice(0, 2).map(projection => [projection.projection_result, projection.output_state, projection.events]), [["not_available", null, undefined], ["not_available", null, undefined]], "外会话和缺失输出返回相同结果");
      assert.equal(boundary.output_projections[2].projection_result, "replace");
      assert.deepEqual(boundary.output_projections[2].events, [], "合法空范围也有明确完整替换");
      checks.push("真实浏览器两页收到权限变更后撤权和恢复，无新事件、无需手动刷新；单读取门、查询状态失败隔离、指纹与范围结果保持");
    } finally {
      releaseHeld();
      await writeFile(permissions, originalPermissions);
      const clientReads = await page.evaluate(() => window.__historySnapshotReads ?? null);
      await writeFile(h.directory + "/history-loaded-reads.json", JSON.stringify({ reads, hostRouteMaxActive: maxActiveReads, clientReads, eventCursor, browserErrors }, null, 2) + "\n");
      await browser.close();
    }
  }
  passed = true;
} finally {
  await mkdir(".local/checks/agent-reliability-repairs", { recursive: true });
  const report = { passed, checks, officialRequests: 0, platform: "executable synthetic SQLite", model: "controlled tool inputs", runtimeDirectory: h.directory.replace(process.cwd() + "/", "") };
  await writeFile(".local/checks/agent-reliability-repairs/grounded-answers.json", JSON.stringify(report, null, 2));
  await h.close();
  console.log(JSON.stringify(report));
}
