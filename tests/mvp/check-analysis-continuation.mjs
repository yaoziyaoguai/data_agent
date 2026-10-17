import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { harness, until } from "./harness.mjs";

// 本地协议规定验证路径，Pi实际续接和调工具；不据此声称真实模型能自主完成分析。
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: "analysis_" + randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 65536,
  output_limit: 2048,
  trial_call_limit: 200,
  trial_cost_micros: "1000000",
  request_call_limit: 24,
  toolset: "data",
  payload_bytes_limit: 131072,
};
const sourceDirectory = resolve("docs/sources/analysis");
const h = await harness({
  capture: true,
  profile,
  sourceDirectory,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "6" },
});
let run,
  plan,
  protocolFailure,
  sessionId,
  passed = false,
  calls = 0;
const checks = [],
  rounds = [],
  payloadBytes = [],
  queries = [],
  evidence = [];
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const lastReply = (body) => {
  const message = body.messages.findLast((value) => value.role === "tool");
  assert.ok(message, "下一步须核对Pi真实工具回执");
  assert.ok(
    message.content.trim().startsWith("{"),
    "Pi真实工具拒绝本次调用：" + message.content,
  );
  return JSON.parse(message.content);
};
const toolStep = (name, args, observe) => ({ name, args, observe });
const finalStep = (text, observe) => ({ text, observe });
const provider = createServer(async (request, response) => {
  try {
    assert.equal(
      request.headers.authorization,
      "Bearer synthetic-protocol-key",
    );
    let raw = "";
    request.setEncoding("utf8");
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    payloadBytes.push(Buffer.byteLength(raw));
    assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
    assert.equal(body.max_tokens, profile.output_limit);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.ok(
      body.tools.some(
        (value) => value.function.name === "save_analysis_evidence",
      ),
    );
    assert.ok(plan && plan.index < plan.steps.length, "计划外请求不能制造成功");
    const step = plan.steps[plan.index++];
    if (step.observe) await step.observe(body);
    const args = typeof step.args === "function" ? step.args(body) : step.args;
    calls++;
    const delta = step.name
      ? {
          role: "assistant",
          content: "正在核对分析依据。",
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name: step.name, arguments: JSON.stringify(args) },
            },
          ],
        }
      : { role: "assistant", content: step.text };
    const chunk = (delta, finish_reason = null) => ({
      id: "synthetic-analysis",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify(chunk(delta)) + "\n\n");
    response.write(
      "data: " +
        JSON.stringify(chunk({}, step.name ? "tool_calls" : "stop")) +
        "\n\n",
    );
    response.write(
      "data: " +
        JSON.stringify({
          id: "synthetic-analysis",
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 25,
            total_tokens: 125,
          },
        }) +
        "\n\n",
    );
    response.end("data: [DONE]\n\n");
  } catch (error) {
    protocolFailure = error;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "synthetic_protocol_assertion_failed" },
      }),
    );
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const previous = Object.fromEntries(
  ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DATA_AGENT_PROVIDER_TEST"].map(
    (key) => [key, process.env[key]],
  ),
);
process.env.DEEPSEEK_API_KEY = "synthetic-protocol-key";
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:" + provider.address().port;
process.env.DATA_AGENT_PROVIDER_TEST = "1";
const begin = async (cid, text) => {
  await h.resumeWorker();
  run = await h.capture(cid, text);
  await h.pauseWorker();
};
const completeRound = async (label, steps) => {
  plan = { steps, index: 0 };
  protocolFailure = null;
  try {
    await deliver(
      run,
      h.env.DATA_AGENT_API_URL,
      h.env.DATA_AGENT_INTERNAL_TOKEN,
      "",
    );
  } catch (error) {
    throw protocolFailure ?? error;
  }
  assert.equal(plan.index, steps.length);
  const snapshotResponse = await h.request(
    `/conversations/${run.conversation_id}/snapshot`,
  );
  if (snapshotResponse.status !== 200)
    await writeFile(
      h.directory + "/snapshot-failure.json",
      JSON.stringify(
        {
          label,
          run_id: run.run_id,
          conversation_id: run.conversation_id,
          response: snapshotResponse,
          tasks: h.sql(
            `SELECT JSON_OBJECT('id',id,'goal',goal,'condition_version',CAST(condition_version AS CHAR),'lifecycle',lifecycle,'phase',phase) FROM analysis_tasks WHERE conversation_id='${run.conversation_id}'`,
          ),
          evidence: h.sql(
            `SELECT reference FROM analysis_evidence WHERE conversation_id='${run.conversation_id}'`,
          ),
        },
        null,
        2,
      ),
    );
  const snapshot = ok(snapshotResponse);
  assert.equal(
    snapshot.runs.find((value) => value.run_id === run.run_id).state,
    "finished",
  );
  assert.equal(
    snapshot.messages.findLast(
      (value) => value.role === "assistant" && value.committed,
    ).text,
    steps.at(-1).text,
  );
  const saved = h.sql(
    `SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`,
  )[0];
  const currentIdentity = saved.storage?.session_id ?? saved.entries[0].id;
  if (sessionId)
    assert.equal(currentIdentity, sessionId, "同对话必须续接原生Pi会话");
  else sessionId = currentIdentity;
  h.releaseRun(run.run_id);
  rounds.push({ label, steps: steps.length, run_id: run.run_id });
  return snapshot;
};
const routeArgs = (task) => ({
  action: "route",
  task_id: task.task_id,
  expected_version: task.condition_version,
  goal: "",
  options: [],
});
const draftArgs = (task, sql, refs) => ({
  task_id: task.task_id,
  condition_version: task.condition_version,
  sql,
  parameters: {},
  target_id: "synthetic-sqlite",
  summary: "已核对本次分析范围，等待聊天明确执行。",
  knowledge_refs: refs,
  replaces_query_id: null,
});
const readQuery = async (query) => ok(await h.request("/queries/" + query.id));
const authorization = (query) =>
  h.sql(
    `SELECT JSON_OBJECT('message',confirmation_message_id,'key',confirmation_key) FROM query_requests WHERE id='${query.id}'`,
  )[0];
const assertDraft = async (query) => {
  assert.equal((await readQuery(query)).execution_state, "not_submitted");
  assert.equal(authorization(query).message, null);
  queries.push(query);
};
const execute = async (cid, task, query, text) => {
  await begin(cid, text);
  const message = run.message_id;
  await completeRound("聊天明确执行", [
    toolStep("update_analysis_task", routeArgs(task)),
    toolStep("execute_query", {
      query_id: query.id,
      draft_version: query.draft_version,
      condition_version: query.condition_version,
      instruction_quote: text,
    }),
    finalStep("查询在后台运行，可以继续补充或停止这条查询。", (body) =>
      assert.equal(lastReply(body).id, query.id),
    ),
  ]);
  assert.equal(authorization(query).message, message);
  assert.ok(authorization(query).key);
};
const captureResult = async (cid, query, expectedState = "succeeded") => {
  await h.resumeWorker();
  await until(
    async () => (await readQuery(query)).execution_state === expectedState,
    "实际平台查询进入" + expectedState,
    40000,
  );
  run = await until(
    () =>
      h.captured.find(
        (value) =>
          value.conversation_id === cid &&
          value.text.includes("query_id=" + query.id),
      ),
    "实际查询结果通知",
    40000,
  );
  await h.pauseWorker();
  assert.notEqual(
    run.message_id,
    authorization(query).message,
    "执行消息不能假装是已经完成的结果唤醒",
  );
};
const saveResult = async (
  cid,
  task,
  query,
  expectedRows,
  figures,
  observation,
  limitations,
) => {
  await captureResult(cid, query);
  let result, reference;
  await completeRound("结果唤醒后核对并保存依据", [
    toolStep("update_analysis_task", routeArgs(task)),
    toolStep("get_query", { query_id: query.id }),
    toolStep("save_analysis_evidence", (body) => {
      const actual = lastReply(body);
      assert.equal(actual.query.id, query.id);
      result = actual.results;
      assert.ok(result.saved_result_complete);
      assert.equal(result.data_freshness, "synthetic_snapshot_2026-04-04");
      expectedRows(result.rows);
      return {
        task_id: task.task_id,
        condition_version: task.condition_version,
        data_range:
          "UTC；排除测试；付款时间半开区间；退款截至2026年4月4日按原付款归属。",
        findings: [
          {
            text: observation,
            calculation: "按已保存SQL结果核对；金额单位为分。",
            limitations,
            query_refs: [
              {
                query_id: query.id,
                result_ref: result.result_ref,
                columns: result.columns.map((value) => value.name),
              },
            ],
            knowledge_refs: [],
            figures: figures.map((value) => ({ ...value, query_id: query.id })),
          },
        ],
      };
    }),
    finalStep(observation, (body) => {
      reference = lastReply(body);
      assert.deepEqual(Object.keys(reference).sort(), [
        "condition_version",
        "conversation_id",
        "evidence_id",
        "result_dependencies",
        "task_id",
      ]);
      assert.equal(reference.task_id, task.task_id);
      assert.equal(reference.condition_version, task.condition_version);
      assert.deepEqual(reference.result_dependencies, [
        { query_id: query.id, result_ref: result.result_ref },
      ]);
    }),
  ]);
  evidence.push(reference);
  return reference;
};
const conditions = {
  time_start: "2026-01-01T00:00:00Z",
  time_end: "2026-04-01T00:00:00Z",
  timezone: "UTC",
  metric: "net_revenue",
  channel: null,
  group_by: ["month"],
  filters: ["is_test=0", "paid_amount_cents>0"],
  knowledge_refs: [],
  notes: "按付款月份归属截至快照成功退款；关联或贡献不证明因果。",
};
try {
  const cid = await h.create();
  const table = ok(await h.request("/knowledge/table-demo_order_detail"));
  const metric = ok(await h.request("/knowledge/metric-net_revenue"));
  const relation = ok(await h.request("/knowledge/relationship-tags"));
  const tableRef = {
    object_id: table.id,
    version: table.version,
    path: "description",
  };
  const relationRef = {
    object_id: relation.id,
    version: relation.version,
    path: "join",
  };
  const monthlySql = await readFile(
    sourceDirectory + "/evaluation/queries/monthly-net.sql",
    "utf8",
  );
  const contributionSql = await readFile(
    sourceDirectory + "/evaluation/queries/channel-contribution.sql",
    "utf8",
  );
  let task, query;
  await begin(
    cid,
    "先给2026年一月至三月按月净收入SQL，排除测试及未付款。暂不执行。",
  );
  await completeRound("查正式指标后生成趋势草稿", [
    toolStep("search_knowledge", {
      query: "净收入",
      kinds: ["metric"],
      limit: 5,
    }),
    toolStep(
      "read_knowledge",
      {
        object_id: metric.id,
        version: metric.version,
        entry_id: "sql",
        offset: 0,
        limit: 4096,
      },
      (body) =>
        assert.ok(
          lastReply(body).objects.some((value) => value.id === metric.id),
        ),
    ),
    toolStep("read_knowledge", {
      object_id: table.id,
      version: table.version,
      entry_id: "description",
      offset: 0,
      limit: 4096,
    }),
    toolStep("update_analysis_task", {
      action: "create",
      goal: "一季度月度净收入变化",
      conditions: { ...conditions, knowledge_refs: [tableRef] },
      options: [],
    }),
    toolStep("request_query", (body) => {
      task = lastReply(body);
      return draftArgs(task, monthlySql, [tableRef]);
    }),
    finalStep("已生成趋势SQL，可以继续补充条件。", (body) => {
      query = lastReply(body);
    }),
  ]);
  await assertDraft(query);
  const trendQuery = query,
    trendTask = task;
  await execute(cid, task, query, "执行刚才的月度净收入SQL。");
  const trendEvidence = await saveResult(
    cid,
    task,
    query,
    (rows) => {
      assert.deepEqual(
        rows.map((row) => [row[0], row[3]]),
        [
          ["2026-01", "102000"],
          ["2026-02", "113000"],
          ["2026-03", "134000"],
        ],
      );
    },
    [
      {
        label: "三月净收入（分）",
        column: "net_cents",
        row_index: 2,
        value: "134000",
      },
    ],
    "月度净收入依次为102000、113000、134000分；这描述变化，尚不能解释业务原因。",
    [
      "退款按原付款月份归属，截至2026年4月4日；不是完整四月数据。",
      "算术变化不能证明业务因果。",
    ],
  );
  checks.push(
    "同一原生Pi对话先展示SQL，再由独立聊天消息授权；真实平台结果通知后读取三个月趋势并保存精确依据",
  );

  await begin(cid, "继续拆解二月至三月，各渠道贡献多少？先给SQL。");
  await completeRound("沿原任务改范围与分组", [
    toolStep("update_analysis_task", {
      action: "revise",
      task_id: task.task_id,
      expected_version: task.condition_version,
      goal: "二月至三月渠道变化贡献",
      condition_patch: {
        set: { time_start: "2026-02-01T00:00:00Z", group_by: ["channel"] },
        unset: [],
      },
      options: [],
    }),
    toolStep("request_query", (body) => {
      task = lastReply(body);
      return draftArgs(task, contributionSql, [tableRef]);
    }),
    finalStep("已准备渠道贡献SQL，尚未执行。", (body) => {
      query = lastReply(body);
    }),
  ]);
  assert.equal(task.task_id, trendTask.task_id);
  assert.notEqual(task.condition_version, trendTask.condition_version);
  await assertDraft(query);
  const contributionQuery = query;
  await execute(cid, task, query, "执行渠道贡献SQL。");
  await saveResult(
    cid,
    task,
    query,
    (rows) =>
      assert.deepEqual(rows, [
        ["app", "51000", "62000", "11000", "21000"],
        ["store", "23000", "27000", "4000", "21000"],
        ["web", "39000", "45000", "6000", "21000"],
      ]),
    [
      {
        label: "app增量（分）",
        column: "delta_cents",
        row_index: 0,
        value: "11000",
      },
      {
        label: "总增量（分）",
        column: "total_delta_cents",
        row_index: 0,
        value: "21000",
      },
    ],
    "二月至三月总增量21000分，其中app贡献11000分，web贡献6000分，store贡献4000分。",
    ["贡献是分组金额差，不能据此认定渠道活动造成增长。"],
  );
  checks.push(
    "继续追问修改原任务范围，渠道贡献由SQL计算而非模型心算；新依据只绑定新条件，旧趋势依据保留历史归属",
  );

  await begin(cid, "现在只看app的付款明细，保持二月至三月，先给SQL。");
  await completeRound("改渠道并准备明细", [
    toolStep("update_analysis_task", {
      action: "revise",
      task_id: task.task_id,
      expected_version: task.condition_version,
      goal: "app付款明细",
      condition_patch: { set: { channel: "app", group_by: [] }, unset: [] },
      options: [],
    }),
    toolStep("request_query", (body) => {
      task = lastReply(body);
      return draftArgs(
        task,
        "SELECT order_id,line_id,paid_at,paid_amount_cents,refunded_amount_cents FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND channel='app' AND paid_at>='2026-02-01T00:00:00Z' AND paid_at<'2026-04-01T00:00:00Z' ORDER BY order_id,line_id",
        [tableRef],
      );
    }),
    finalStep("app明细SQL已准备好。", (body) => {
      query = lastReply(body);
    }),
  ]);
  await assertDraft(query);
  const detailQuery = query,
    detailTask = task;
  await execute(cid, task, query, "执行app明细SQL。");
  await h.resumeWorker();
  await until(
    async () => (await readQuery(query)).execution_state === "running",
    "独立明细正在执行",
  );
  await begin(cid, "停止刚才的app明细查询，前面的汇总保留。");
  await completeRound("新聊天停止一条运行查询", [
    toolStep("update_analysis_task", routeArgs(task)),
    toolStep("cancel_query", { query_id: query.id }),
    finalStep("已请求停止app明细，前面的汇总仍保留。", (body) =>
      assert.equal(lastReply(body).id, query.id),
    ),
  ]);
  await captureResult(cid, query, "cancelled");
  await completeRound("停止回执独立归属", [
    toolStep("update_analysis_task", routeArgs(task)),
    toolStep("get_query", { query_id: query.id }),
    finalStep("平台已确认停止该明细查询。", (body) => {
      assert.equal(lastReply(body).query.execution_state, "cancelled");
      assert.equal(lastReply(body).results, null);
    }),
  ]);
  assert.equal((await readQuery(trendQuery)).execution_state, "succeeded");
  assert.equal(
    (await readQuery(contributionQuery)).execution_state,
    "succeeded",
  );
  checks.push(
    "后台明细运行时可以继续聊天并停止单个查询；平台确认取消，历史汇总仍成功且没有被重跑",
  );

  await begin(
    cid,
    "换个问题：一季度vip或newsletter客户的付款、退款、净收入和去重客户数，先给SQL。",
  );
  let tagTask, tagQuery;
  const quarterSql =
    "SELECT SUM(d.paid_amount_cents) AS paid_cents,SUM(d.refunded_amount_cents) AS refund_cents,SUM(d.paid_amount_cents-d.refunded_amount_cents) AS net_cents,COUNT(DISTINCT d.customer_id) AS known_customers FROM demo_order_detail d WHERE d.is_test=0 AND d.paid_amount_cents>0 AND d.paid_at>='2026-01-01T00:00:00Z' AND d.paid_at<'2026-04-01T00:00:00Z' AND EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id=d.customer_id AND t.tag IN ('vip','newsletter'))";
  await completeRound("跨表问题建立独立任务并读关联", [
    toolStep("search_knowledge", {
      query: "客户标签",
      kinds: ["relationship"],
      related_object_id: table.id,
      limit: 5,
    }),
    toolStep("read_knowledge", {
      object_id: relation.id,
      version: relation.version,
      entry_id: "join",
      offset: 0,
      limit: 4096,
    }),
    toolStep("update_analysis_task", {
      action: "create",
      goal: "一季度标签客户退款影响与去重客户数",
      conditions: {
        ...conditions,
        group_by: [],
        filters: [
          ...conditions.filters,
          "vip或newsletter客户；使用EXISTS避免标签重复",
        ],
        knowledge_refs: [tableRef, relationRef],
      },
      options: [],
    }),
    toolStep("request_query", (body) => {
      tagTask = lastReply(body);
      return draftArgs(tagTask, quarterSql, [tableRef, relationRef]);
    }),
    finalStep("已准备跨表去重SQL，客户数按整个季度去重。", (body) => {
      tagQuery = lastReply(body);
    }),
  ]);
  assert.notEqual(tagTask.task_id, detailTask.task_id);
  await assertDraft(tagQuery);
  await execute(cid, tagTask, tagQuery, "执行这条vip或newsletter季度汇总SQL。");
  await saveResult(
    cid,
    tagTask,
    tagQuery,
    (rows) => assert.deepEqual(rows, [["267250", "23000", "244250", "5"]]),
    [
      {
        label: "净收入（分）",
        column: "net_cents",
        row_index: 0,
        value: "244250",
      },
      {
        label: "季度去重客户数",
        column: "known_customers",
        row_index: 0,
        value: "5",
      },
    ],
    "标签客户季度付款267250分、退款23000分、净收入244250分，去重客户5人；不能相加每月去重人数。",
    [
      "按当前客户标签选择；不代表交易当时标签。",
      "退款截至4月4日按原付款归属；不是按退款发生月。",
      "没有证明标签导致收入或退款变化。",
    ],
  );
  const snapshot = await h.snapshot(cid);
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(
    snapshot.tasks.find((value) => value.id === detailTask.task_id)
      .condition_version,
    detailTask.condition_version,
  );
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE conversation_id='${cid}'`,
    )[0].n,
    4,
  );
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence WHERE conversation_id='${cid}'`,
    )[0].n,
    3,
  );
  assert.ok(
    !snapshot.tasks
      .find((value) => value.id === detailTask.task_id)
      .evidence_refs.some(
        (value) => value.evidence_id === trendEvidence.evidence_id,
      ),
  );
  assert.equal((await readQuery(detailQuery)).execution_state, "cancelled");
  checks.push(
    "换话题保留原任务；多标签用EXISTS，季度COUNT DISTINCT不累加月度人数；退款截止和标签有效期限制与结果共同保存",
  );
  const ledger = h.sql(
    `SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`,
  )[0];
  assert.equal(ledger.calls, calls);
  assert.equal(ledger.reserved, 0);
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      checks,
      calls,
      maxPayloadBytes: Math.max(...payloadBytes),
      officialRequests: 0,
    }),
  );
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await writeFile(
    ".local/checks/analysis-continuation.json",
    JSON.stringify(
      {
        passed,
        checks,
        calls,
        payloadBytes,
        rounds,
        queries,
        evidence,
        officialRequests: 0,
        scope:
          "实际Pi长期会话、Rust/MySQL、合成SQLite；预定本地模型协议，不证明真实模型自主分析准确率",
      },
      null,
      2,
    ) + "\n",
  );
  if (run) h.releaseRun(run.run_id);
  await new Promise((resolve) => provider.close(resolve));
  await h.close();
}
