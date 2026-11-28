import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";

// 明确区分两类离线验证（零外部付费调用）：
// A) unmodifiedHistoricalReplay：原封不动重放发生错误时的历史 prepare 请求（不含 comparisons）与原模板正文，
//    诚实证明在 comparisons 可选且不做逐句关键词扫描的设计下，旧静态请求原样重放仍会照旧送出反向自由散文；
// B) componentVerification：人工构造 comparisons 请求通过真实 Rust API + MySQL + 合成座舱 SQLite + Pi deliver()，
//    仅作受控比较引擎组件验证（不冒充真实模型自主调用证明）。
const STAGE_SQL = `SELECT
    stage,
    endpoint_kind,
    SUM(succeeded_attempt_count) AS succeeded_attempt_count,
    SUM(attempt_count) AS attempt_count,
    CAST(SUM(succeeded_attempt_count) AS REAL) / NULLIF(SUM(attempt_count), 0) AS stage_attempt_success_rate,
    SUM(latency_sum_ms) AS latency_sum_ms,
    SUM(latency_samples) AS latency_samples,
    CAST(SUM(latency_sum_ms) AS REAL) / NULLIF(SUM(latency_samples), 0) AS stage_mean_ms
FROM syn_daily_stage_latency
WHERE snapshot_exclusive = :snapshot
  AND turn_date >= substr(:start, 1, 10)
  AND turn_date < substr(:end, 1, 10)
GROUP BY stage, endpoint_kind
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end
ORDER BY stage, endpoint_kind;`;

const STAGE_PARAMS = {
  start: "2026-08-01T00:00:00Z",
  end: "2026-09-01T00:00:00Z",
  snapshot: "2026-10-04T00:00:00Z",
};

const buildHistoricalPrepareValues = qid => [
  { name: "action_cloud_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 0, format: { style: "percent", precision: 2 } },
  { name: "action_cloud_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 0, format: { style: "decimal", precision: 1 } },
  { name: "action_cloud_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 0 },
  { name: "action_edge_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 1, format: { style: "percent", precision: 2 } },
  { name: "action_edge_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 1, format: { style: "decimal", precision: 1 } },
  { name: "action_edge_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 1 },
  { name: "asr_cloud_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 2, format: { style: "percent", precision: 2 } },
  { name: "asr_cloud_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 2, format: { style: "decimal", precision: 1 } },
  { name: "asr_cloud_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 2 },
  { name: "asr_edge_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 3, format: { style: "percent", precision: 2 } },
  { name: "asr_edge_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 3, format: { style: "decimal", precision: 1 } },
  { name: "asr_edge_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 3 },
  { name: "nlu_cloud_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 4, format: { style: "percent", precision: 2 } },
  { name: "nlu_cloud_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 4, format: { style: "decimal", precision: 1 } },
  { name: "nlu_cloud_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 4 },
  { name: "nlu_edge_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 5, format: { style: "percent", precision: 2 } },
  { name: "nlu_edge_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 5, format: { style: "decimal", precision: 1 } },
  { name: "nlu_edge_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 5 },
  { name: "route_cloud_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 6, format: { style: "percent", precision: 2 } },
  { name: "route_cloud_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 6, format: { style: "decimal", precision: 1 } },
  { name: "route_cloud_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 6 },
  { name: "route_edge_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 7, format: { style: "percent", precision: 2 } },
  { name: "route_edge_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 7, format: { style: "decimal", precision: 1 } },
  { name: "route_edge_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 7 },
  { name: "tts_edge_rate", query_id: qid, kind: "cell", column: "stage_attempt_success_rate", row_index: 8, format: { style: "percent", precision: 2 } },
  { name: "tts_edge_ms", query_id: qid, kind: "cell", column: "stage_mean_ms", row_index: 8, format: { style: "decimal", precision: 1 } },
  { name: "tts_edge_attempts", query_id: qid, kind: "cell", column: "attempt_count", row_index: 8 },
  { name: "returned_rows", query_id: qid, kind: "statistic", statistic: "row_count" },
  { name: "distinct_stage", query_id: qid, kind: "statistic", statistic: "distinct_count", column: "stage" },
  { name: "data_freshness", query_id: qid, kind: "metadata", metadata: "data_freshness" },
];

let historicalTemplate = "查询成功，共返回 {{returned_rows}} 行、覆盖 {{distinct_stage}} 个 stage。端云之间差异方向不一致：asr、nlu、route 是 cloud 成功率高于 edge 或接近（asr cloud {{asr_cloud_rate}} vs edge {{asr_edge_rate}}；nlu cloud {{nlu_cloud_rate}} vs edge {{nlu_edge_rate}}；route cloud {{route_cloud_rate}} vs edge {{route_edge_rate}}），数据批次 `{{data_freshness}}`。";
const localSessionPath = resolve(".local/pi-sessions/2026-11-26T03-55-13-014Z_01a215fe-3cee-738f-a49a-fd7513f132af.jsonl");
let loadedLiteralPiSession = false;
try {
  await access(localSessionPath);
  const entries = (await readFile(localSessionPath, "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  const rawPrepareEntry = entries.find(e => e.id === "7dd84d50");
  const rawTemplateEntry = entries.find(e => e.id === "5a867f2a");
  assert.ok(rawPrepareEntry && rawTemplateEntry, "必须定位到自留盲测 #1 原 prepare 与原模板条目");
  const rawPrepareCall = rawPrepareEntry.message.content.find(part => part.type === "toolCall");
  assert.equal(rawPrepareCall.name, "prepare_analysis_answer");
  assert.equal("comparisons" in rawPrepareCall.arguments, false, "历史原请求确实不含 comparisons");
  assert.equal(rawPrepareCall.arguments.values.length, 30);
  historicalTemplate = rawTemplateEntry.message.content.find(part => part.type === "text").text;
  loadedLiteralPiSession = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 65536,
  output_limit: 2048,
  trial_call_limit: 60,
  trial_cost_micros: "1000000",
  request_call_limit: 24,
  toolset: "data",
  payload_bytes_limit: 131072,
};

const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const lastToolReply = body => {
  const message = body.messages.findLast(value => value.role === "tool");
  assert.ok(message, "必须收到真实工具回执");
  return JSON.parse(message.content);
};

let plan = null;
let protocolFailure = null;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-protocol-key");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    if (!plan || plan.index >= plan.steps.length) {
      throw new Error(`unexpected model step ${plan ? `${plan.label}#${plan.index}` : "null"}`);
    }
    const step = plan.steps[plan.index++];
    if (step.observe) step.observe(body);
    const delta = step.name
      ? {
          role: "assistant",
          content: step.text ?? "",
          tool_calls: [{
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          }],
        }
      : { role: "assistant", content: step.text };
    const chunk = (value, reason = null) => ({
      id: "synthetic-cmp",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: value, finish_reason: reason }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify(chunk(delta)) + "\n\n");
    response.write("data: " + JSON.stringify(chunk({}, step.name ? "tool_calls" : "stop")) + "\n\n");
    response.write(
      "data: " +
        JSON.stringify({
          id: "synthetic-cmp",
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        }) +
        "\n\n",
    );
    response.end("data: [DONE]\n\n");
  } catch (error) {
    protocolFailure = error;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise(done => provider.listen(0, "127.0.0.1", done));
const baseUrl = "http://127.0.0.1:" + provider.address().port;
const previousEnv = Object.fromEntries(
  ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DATA_AGENT_PROVIDER_TEST"].map(k => [k, process.env[k]]),
);

let h;
try {
  h = await harness({
    capture: true,
    sourceDirectory: resolve("docs/sources/cockpit"),
    startupTimeout: 120000,
    profile,
    protocolProviderUrl: baseUrl,
    env: {
      DATA_AGENT_TOOL_CONTRACT_VERSION: "2",
      DATA_AGENT_LEASE_MS: "120000",
      DATA_AGENT_QUERY_DELAY_SECONDS: "1",
    },
  });
  process.env.DEEPSEEK_API_KEY = "synthetic-protocol-key";
  process.env.DEEPSEEK_BASE_URL = baseUrl;
  process.env.DATA_AGENT_PROVIDER_TEST = "1";

  const runConfirmedQuery = async (sql, parameters, summary) => {
    const cid = await h.create();
    await h.resumeWorker();
    const firstRun = await h.capture(cid, summary);
    await h.pauseWorker();
    const manager = SessionManager.inMemory("/synthetic/data-agent");
    const binding = { run_id: firstRun.run_id, lease_epoch: firstRun.lease_epoch };
    const checkpoint = () =>
      exportCheckpoint(
        manager,
        firstRun.workspace_context.authority_revision,
        firstRun.workspace_context.authority_snapshot,
      );
    const callTool = async (name, args) => {
      const input = {
        ...binding,
        sdk_tool_call_id: randomUUID(),
        tool_name: name,
        arguments: args,
        checkpoint: checkpoint(),
      };
      ok(await h.internal("/internal/data/tool-calls", input));
      return ok(await h.internal("/internal/data/tools", input)).data;
    };
    const task = await callTool("update_analysis_task", {
      action: "create",
      goal: summary,
      conditions: {
        time_start: null,
        time_end: null,
        timezone: "UTC",
        metric: null,
        channel: null,
        group_by: [],
        filters: [],
        knowledge_refs: [],
        notes: summary,
        source_limits: null,
      },
      options: [],
    });
    const query = await callTool("request_query", {
      task_id: task.task_id,
      condition_version: task.condition_version,
      sql,
      parameters,
      target_id: "synthetic-sqlite",
      summary,
      knowledge_refs: [],
      replaces_query_id: null,
    });
    assert.equal(query.check_state, "passed");
    const draftText = "查询草稿已保存，等待确认执行。";
    ok(await h.internal("/internal/outputs", { ...binding, chunk_seq: "1", text: draftText }));
    ok(
      await h.internal("/internal/finish", {
        ...binding,
        commit_id: firstRun.output_id,
        final_text: draftText,
        checkpoint: checkpoint(),
      }),
    );
    h.releaseRun(firstRun.run_id);
    const before = h.captured.length;
    ok(
      await h.request(`/queries/${query.id}/confirm`, {
        operation_id: randomUUID(),
        draft_version: query.draft_version,
        condition_version: query.condition_version,
      }),
    );
    await h.resumeWorker();
    await until(
      async () => ok(await h.request(`/queries/${query.id}`)).execution_state === "succeeded",
      summary + " succeeded",
      40000,
    );
    const resultRun = await until(
      () => h.captured.slice(before).find(item => item.conversation_id === cid),
      summary + " result notification",
      40000,
    );
    await h.pauseWorker();
    const queryView = ok(await h.request(`/queries/${query.id}`));
    return { cid, task, query: queryView, resultRun };
  };

  // A) 原封不动重放发生错误时的真实请求（无 comparisons）+ 原模板正文：
  // 验证向后兼容的同时，诚实确认：若不经新提示重新驱动模型生成 comparisons，原静态散文仍会照旧流出反向结论。
  const unmodifiedCase = await runConfirmedQuery(
    STAGE_SQL,
    STAGE_PARAMS,
    "原封不动重放历史无comparisons请求",
  );
  const uqid = unmodifiedCase.query.id;
  const uref = unmodifiedCase.query.result_ref;
  plan = {
    label: "unmodified-historical-replay",
    index: 0,
    steps: [
      { name: "get_query", args: { query_id: uqid } },
      {
        name: "prepare_analysis_answer",
        args: {
          sources: [{
            query_id: uqid,
            result_ref: uref,
            columns: [
              "stage",
              "endpoint_kind",
              "succeeded_attempt_count",
              "attempt_count",
              "stage_attempt_success_rate",
              "latency_sum_ms",
              "latency_samples",
              "stage_mean_ms",
            ],
          }],
          values: buildHistoricalPrepareValues(uqid),
        },
      },
      { text: historicalTemplate },
    ],
  };
  protocolFailure = null;
  try {
    await deliver(unmodifiedCase.resultRun, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, "");
  } catch (error) {
    throw protocolFailure ?? error;
  }
  const unmodifiedSnap = await h.snapshot(unmodifiedCase.cid);
  const unmodifiedCommitted = unmodifiedSnap.messages.filter(m => m.role === "assistant" && m.committed).at(-1).text;
  const stillEmitsReversedProseWhenComparisonsOmitted =
    /asr、nlu、route 是 cloud 成功率高于 edge 或接近/.test(unmodifiedCommitted);
  assert.equal(
    stillEmitsReversedProseWhenComparisonsOmitted,
    true,
    "诚实边界：原封不动的旧请求未携带 comparisons 且不做关键词黑名单扫描，原样重放仍会送出原反向散文",
  );

  // B) 组件验证（人工构造 comparisons 请求）：验证四态核定、错向拦截、防反标与漏引拦截
  const stageCase = await runConfirmedQuery(
    STAGE_SQL,
    STAGE_PARAMS,
    "组件验证：2026年8月语音阶段尝试成功率与平均耗时受控比较",
  );
  const qid = stageCase.query.id;
  const ref = stageCase.query.result_ref;
  const stageSources = [{
    query_id: qid,
    result_ref: ref,
    columns: ["stage", "endpoint_kind", "attempt_count", "stage_attempt_success_rate", "stage_mean_ms"],
  }];

  plan = {
    label: "component-comparisons-replay",
    index: 0,
    steps: [
      { name: "get_query", args: { query_id: qid } },
      // 1a) 错误方向预期（expected_relation=higher）：宿主当场拒绝并返回实际 lower
      {
        name: "prepare_analysis_answer",
        observe: body => assert.equal(lastToolReply(body).results.saved_row_count, 9),
        args: {
          sources: stageSources,
          values: [],
          comparisons: [{
            name: "asr_rate_cmp",
            query_id: qid,
            column: "stage_attempt_success_rate",
            expected_relation: "higher",
            left: { label: "cloud", row_index: 2 },
            right: { label: "edge", row_index: 3 },
          }],
        },
      },
      // 1b) 行与标签对调（row 2 实为 cloud 却标成 edge）：宿主防反标校验拒绝
      {
        name: "prepare_analysis_answer",
        observe: body => {
          const rejected = lastToolReply(body);
          assert.equal(rejected.error, "invalid_evidence");
          assert.equal(rejected.comparison_mismatch.actual_relation, "lower");
          assert.equal(rejected.comparison_mismatch.rendered, "cloud 低于 edge");
        },
        args: {
          sources: stageSources,
          values: [],
          comparisons: [{
            name: "asr_swapped",
            query_id: qid,
            column: "stage_attempt_success_rate",
            left: { label: "edge", row_index: 2 },
            right: { label: "cloud", row_index: 3 },
          }],
        },
      },
      // 1c) 合法准备四类事实结论（低、高、持平、缺样本）及反向比较（edge 相对 cloud）
      {
        name: "prepare_analysis_answer",
        observe: body => {
          const rejected = lastToolReply(body);
          assert.equal(rejected.error, "invalid_evidence");
          assert.match(rejected.hint, /标签.*相反/);
        },
        args: {
          sources: stageSources,
          values: [
            { name: "asr_cloud_rate", query_id: qid, kind: "cell", row_index: 2, column: "stage_attempt_success_rate", format: { style: "percent", precision: 2 } },
            { name: "asr_edge_rate", query_id: qid, kind: "cell", row_index: 3, column: "stage_attempt_success_rate", format: { style: "percent", precision: 2 } },
            { name: "nlu_cloud_rate", query_id: qid, kind: "cell", row_index: 4, column: "stage_attempt_success_rate", format: { style: "percent", precision: 2 } },
            { name: "nlu_edge_rate", query_id: qid, kind: "cell", row_index: 5, column: "stage_attempt_success_rate", format: { style: "percent", precision: 2 } },
            { name: "route_cloud_ms", query_id: qid, kind: "cell", row_index: 6, column: "stage_mean_ms", format: { style: "decimal", precision: 1 } },
            { name: "route_edge_ms", query_id: qid, kind: "cell", row_index: 7, column: "stage_mean_ms", format: { style: "decimal", precision: 1 } },
          ],
          comparisons: [
            {
              name: "asr_rate_cmp",
              query_id: qid,
              column: "stage_attempt_success_rate",
              left: { label: "cloud", row_index: 2 },
              right: { label: "edge", row_index: 3 },
            },
            {
              name: "nlu_rate_cmp",
              query_id: qid,
              column: "stage_attempt_success_rate",
              left: { label: "cloud", row_match: [{ column: "stage", value: "nlu" }, { column: "endpoint_kind", value: "cloud" }] },
              right: { label: "edge", row_match: [{ column: "stage", value: "nlu" }, { column: "endpoint_kind", value: "edge" }] },
            },
            {
              name: "route_ms_cmp",
              query_id: qid,
              column: "stage_mean_ms",
              left: { label: "cloud", row_index: 6 },
              right: { label: "edge", row_index: 7 },
            },
            {
              name: "tts_rate_cmp",
              query_id: qid,
              column: "stage_attempt_success_rate",
              left: { label: "cloud", row_match: [{ column: "stage", value: "tts" }, { column: "endpoint_kind", value: "cloud" }] },
              right: { label: "edge", row_match: [{ column: "stage", value: "tts" }, { column: "endpoint_kind", value: "edge" }] },
            },
            {
              name: "asr_reverse_cmp",
              query_id: qid,
              column: "stage_attempt_success_rate",
              left: { label: "edge", row_index: 3 },
              right: { label: "cloud", row_index: 2 },
            },
          ],
        },
      },
      // 1d) 已准备 comparisons 但正文漏引 {{asr_rate_cmp}}：deliver 必须拦截 answer_render_invalid
      {
        observe: body => {
          const prepared = lastToolReply(body);
          assert.equal(prepared.bindings.asr_rate_cmp, "cloud 低于 edge");
          assert.equal(prepared.bindings.nlu_rate_cmp, "cloud 高于 edge");
          assert.equal(prepared.bindings.route_ms_cmp, "cloud 与 edge 持平");
          assert.equal(prepared.bindings.tts_rate_cmp, "cloud 缺少有效样本，暂无法与 edge 比较");
          assert.equal(prepared.bindings.asr_reverse_cmp, "edge 高于 cloud");
        },
        text: "漏引尝试：asr 是 cloud 高于 edge（{{asr_cloud_rate}} vs {{asr_edge_rate}}），nlu {{nlu_rate_cmp}}，route耗时 {{route_ms_cmp}}，tts {{tts_rate_cmp}}，反向 {{asr_reverse_cmp}}。",
      },
      // 1e) 纠正后完整引用全部已核比较标记
      {
        observe: body => {
          const tail = JSON.stringify(body.messages.slice(-2));
          assert.match(tail, /answer_render_invalid/);
          assert.match(tail, /漏引了comparisons/);
        },
        text: "2026年8月核定结果：asr成功率 {{asr_rate_cmp}}（{{asr_cloud_rate}} vs {{asr_edge_rate}}，换向即 {{asr_reverse_cmp}}）；nlu成功率 {{nlu_rate_cmp}}（{{nlu_cloud_rate}} vs {{nlu_edge_rate}}）；route平均耗时 {{route_ms_cmp}}（{{route_cloud_ms}} ms vs {{route_edge_ms}} ms）；tts阶段 {{tts_rate_cmp}}。",
      },
    ],
  };

  protocolFailure = null;
  try {
    await deliver(stageCase.resultRun, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, "");
  } catch (error) {
    throw protocolFailure ?? error;
  }
  const stageSnap = await h.snapshot(stageCase.cid);
  const committedAnswer = stageSnap.messages.filter(m => m.role === "assistant" && m.committed).at(-1).text;
  assert.equal(
    committedAnswer,
    "2026年8月核定结果：asr成功率 cloud 低于 edge（78.17% vs 88.64%，换向即 edge 高于 cloud）；nlu成功率 cloud 高于 edge（95.67% vs 82.54%）；route平均耗时 cloud 与 edge 持平（70.0 ms vs 70.0 ms）；tts阶段 cloud 缺少有效样本，暂无法与 edge 比较。",
  );

  await mkdir(".local/checks/data-quality-review", { recursive: true });
  const summary = {
    passed: true,
    officialRequests: 0,
    unmodifiedHistoricalReplay: {
      loadedLiteralPiSession,
      hadComparisonsInOriginalRequest: false,
      stillEmitsReversedProseWhenComparisonsOmitted,
      note: "comparisons 为可选字段且不做自由文本关键词扫描；原封不动重放旧静态请求仍会输出原反向句子，实际闭环依赖真实 Pi 模型自主生成并引用 comparisons（另由真实运行独立核验）。",
    },
    componentVerification: {
      kind: "component_manual_comparisons",
      verifiedRelations: ["lower", "higher", "equal", "insufficient_data"],
      verifiedRejections: ["expected_relation_mismatch", "swapped_row_labels", "omitted_comparison_marker"],
      committedAnswer,
    },
  };
  await writeFile(
    ".local/checks/data-quality-review/offline-comparison-replay.json",
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} finally {
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  provider.close();
  if (h) await h.close();
}
