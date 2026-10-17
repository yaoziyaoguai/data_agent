import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";

// 本地协议给出独立流程，不替代真实模型的理解判断；Pi与Rust仍实际执行工具及状态转换。
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: "clarification_" + randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 65536,
  output_limit: 2048,
  trial_call_limit: 200,
  trial_cost_micros: "1000000",
  request_call_limit: 24,
  toolset: "data",
  payload_bytes_limit: 131072,
};
const h = await harness({
  capture: true,
  profile,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "0.1" },
});
let run,
  manager,
  plan,
  protocolFailure,
  passed = false,
  calls = 0;
const checks = [],
  payloadBytes = [],
  rounds = [];
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const binding = () => ({ run_id: run.run_id, lease_epoch: run.lease_epoch });
const checkpoint = () =>
  exportCheckpoint(
    manager,
    run.workspace_context.authority_revision,
    run.workspace_context.authority_snapshot,
  );
const begin = async (cid, text) => {
  await h.resumeWorker();
  run = await h.capture(cid, text);
  await h.pauseWorker();
  manager = SessionManager.inMemory("/synthetic/data-agent");
  return run;
};
const invokeRaw = async (name, args) => {
  const input = {
    ...binding(),
    sdk_tool_call_id: randomUUID(),
    tool_name: name,
    arguments: args,
    checkpoint: checkpoint(),
  };
  const registered = await h.internal("/internal/data/tool-calls", input);
  if (registered.status !== 200) return registered;
  return h.internal("/internal/data/tools", input);
};
const invoke = async (name, args) => ok(await invokeRaw(name, args)).data;
const finishManual = async (text = "请补充要采用的分母，原SQL保持未执行。") => {
  ok(
    await h.internal("/internal/outputs", {
      ...binding(),
      chunk_seq: "1",
      text,
    }),
  );
  ok(
    await h.internal("/internal/finish", {
      ...binding(),
      commit_id: run.output_id,
      final_text: text,
      checkpoint: checkpoint(),
    }),
  );
  h.releaseRun(run.run_id);
};
const question =
  "退款率要看发生退款的订单比例，还是退款金额占付款金额的比例？两者分母不同，结果不能混用。";
const options = [
  "订单比例：退款订单数 / 付款订单数",
  "金额比例：退款金额 / 付款金额",
];
const conditions = {
  time_start: "2026-01-01T00:00:00Z",
  time_end: "2026-02-01T00:00:00Z",
  timezone: "UTC",
  metric: "net_revenue",
  channel: "web",
  group_by: ["channel"],
  filters: ["is_test=0", "paid_amount_cents>0"],
  knowledge_refs: [],
  notes: "付款日期范围，排除测试，先沿用原过滤条件。",
};
const revisions = (task) =>
  h.sql(
    `SELECT JSON_OBJECT('n',COUNT(*)) FROM condition_revisions WHERE task_id='${task.task_id}'`,
  )[0].n;
const openQuestions = (task) =>
  h.sql(
    `SELECT JSON_OBJECT('id',id,'question',question,'options',options,'version',CAST(condition_version AS CHAR)) FROM clarifications WHERE task_id='${task.task_id}' AND state='open' ORDER BY id`,
  );
const taskIn = async (cid, task) =>
  (await h.snapshot(cid)).tasks.find((value) => value.id === task.task_id);
const readQuery = async (query) => ok(await h.request("/queries/" + query.id));
const routeArgs = (task) => ({
  action: "route",
  task_id: task.task_id,
  expected_version: task.condition_version,
  goal: "",
  options: [],
});
const draftArgs = (task, sql, parameters = {}, refs = [], replaces = null) => ({
  task_id: task.task_id,
  condition_version: task.condition_version,
  sql,
  parameters,
  target_id: "synthetic-sqlite",
  summary: "合成条件的当前草稿，等待用户明确要求执行。",
  knowledge_refs: refs,
  replaces_query_id: replaces,
});
const executeArgs = (query) => ({
  query_id: query.id,
  draft_version: query.draft_version,
  condition_version: query.condition_version,
  instruction_quote: run.text,
});
const noAuthorization = (query) => {
  const row = h.sql(
    `SELECT JSON_OBJECT('message',confirmation_message_id,'key',confirmation_key) FROM query_requests WHERE id='${query.id}'`,
  )[0];
  assert.equal(row.message, null);
  assert.equal(row.key, null);
};

const lastReply = (body) => {
  const message = body.messages.findLast((value) => value.role === "tool");
  assert.ok(message, "协议下一步必须收到真正的Pi工具回执");
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
      body.tools.some((tool) => tool.function.name === "read_analysis_task"),
    );
    assert.ok(
      plan && plan.index < plan.steps.length,
      "协议计划外的模型请求不能制造成功",
    );
    const step = plan.steps[plan.index++];
    if (step.observe) await step.observe(body);
    const args = typeof step.args === "function" ? step.args(body) : step.args;
    calls++;
    const delta = step.name
      ? {
          role: "assistant",
          content: "正在核对当前任务与资料。",
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
    const chunk = (value, reason = null) => ({
      id: "synthetic-clarification",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: value, finish_reason: reason }],
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
          id: "synthetic-clarification",
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
const previous = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  DATA_AGENT_PROVIDER_TEST: process.env.DATA_AGENT_PROVIDER_TEST,
};
process.env.DEEPSEEK_API_KEY = "synthetic-protocol-key";
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:" + provider.address().port;
process.env.DATA_AGENT_PROVIDER_TEST = "1";
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
  const snapshot = await h.snapshot(run.conversation_id);
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
  h.releaseRun(run.run_id);
  rounds.push({ label, steps: steps.length, run_id: run.run_id });
  return snapshot;
};
const savedCheckpoint = () =>
  h.sql(
    `SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`,
  )[0];
const sessionIdentity = (saved) =>
  saved.storage?.session_id ?? saved.entries[0].id;

try {
  const guardCid = await h.create();
  await begin(guardCid, "先核对分母，尚未回答不执行。");
  const invalidQuestions = [undefined, null, "", " ", "null"];
  for (const invalid of invalidQuestions) {
    const args = {
      action: "clarify",
      goal: "必须有实际问题的任务",
      conditions,
      options: [],
      ...(invalid === undefined ? {} : { question: invalid }),
    };
    const rejected = await invokeRaw("update_analysis_task", args);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.value));
    assert.equal((await h.snapshot(guardCid)).tasks.length, 0);
    assert.equal(
      h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM condition_revisions")[0].n,
      0,
    );
    assert.equal(
      h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM clarifications")[0].n,
      0,
    );
  }
  let guardedTask = await invoke("update_analysis_task", {
    action: "create",
    goal: "已有草稿的独立控制边界",
    conditions,
    options: [],
  });
  const guardedDraft = await invoke(
    "request_query",
    draftArgs(guardedTask, "SELECT 1 AS verification_value"),
  );
  for (const invalid of invalidQuestions) {
    const rejected = await invokeRaw("update_analysis_task", {
      action: "clarify",
      task_id: guardedTask.task_id,
      expected_version: guardedTask.condition_version,
      goal: "",
      condition_patch: { set: {}, unset: [] },
      options: [],
      ...(invalid === undefined ? {} : { question: invalid }),
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.value));
    assert.equal(revisions(guardedTask), 1);
    assert.equal(openQuestions(guardedTask).length, 0);
    assert.equal(
      (await taskIn(guardCid, guardedTask)).condition_version,
      guardedTask.condition_version,
    );
  }
  guardedTask = await invoke("update_analysis_task", {
    action: "clarify",
    task_id: guardedTask.task_id,
    expected_version: guardedTask.condition_version,
    goal: "",
    condition_patch: { set: {}, unset: [] },
    question,
    options,
  });
  assert.equal(openQuestions(guardedTask).length, 1);
  const savedQuestion = openQuestions(guardedTask)[0];
  const invalidExisting = await invokeRaw("update_analysis_task", {
    action: "clarify",
    task_id: guardedTask.task_id,
    expected_version: guardedTask.condition_version,
    goal: "",
    condition_patch: { set: { channel: "app" }, unset: [] },
    question: null,
    options: [],
  });
  assert.equal(invalidExisting.status, 400);
  assert.equal(revisions(guardedTask), 2);
  assert.deepEqual(openQuestions(guardedTask), [savedQuestion]);
  assert.equal(
    (
      await invokeRaw(
        "request_query",
        draftArgs(guardedTask, "SELECT 2 AS verification_value"),
      )
    ).value.code,
    "version_conflict",
  );
  assert.equal(
    (await invokeRaw("execute_query", executeArgs(guardedDraft))).value.code,
    "version_conflict",
  );
  assert.equal(
    (await readQuery(guardedDraft)).execution_state,
    "not_submitted",
  );
  noAuthorization(guardedDraft);
  await finishManual();
  checks.push(
    "clarify缺失/null/空白/伪null问题在新建及已有任务中均拒绝，没有新增任务、条件版本或开放问题；等待与旧稿不能执行",
  );

  const cid = await h.create();
  const table = ok(await h.request("/knowledge/table-demo_order_detail"));
  const metric = ok(await h.request("/knowledge/metric-net_revenue"));
  const tableRef = {
    object_id: table.id,
    version: table.version,
    path: "description",
  };
  const baselineConditions = { ...conditions, knowledge_refs: [tableRef] };
  let originalTask,
    originalDraft,
    waitingTask,
    unrelatedTask,
    unrelatedDraft,
    revisedTask,
    revisedDraft;
  await begin(
    cid,
    "先给2026年1月web渠道净收入SQL，按渠道分组，排除测试和没有付款的行。先不执行。",
  );
  const known = await completeRound("资料已明，只生成SQL", [
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
    toolStep(
      "read_knowledge",
      {
        object_id: table.id,
        version: table.version,
        entry_id: "description",
        offset: 0,
        limit: 4096,
      },
      (body) => assert.equal(lastReply(body).id, metric.id),
    ),
    toolStep(
      "update_analysis_task",
      {
        action: "create",
        goal: "2026年1月web渠道净收入",
        conditions: baselineConditions,
        options: [],
      },
      (body) => assert.equal(lastReply(body).id, table.id),
    ),
    toolStep("request_query", (body) => {
      originalTask = lastReply(body);
      return draftArgs(
        originalTask,
        "SELECT channel,SUM(paid_amount_cents-refunded_amount_cents) AS net_revenue_cents FROM demo_order_detail WHERE paid_at>=:start AND paid_at<:end AND channel=:channel AND is_test=0 AND paid_amount_cents>0 GROUP BY channel",
        {
          start: conditions.time_start,
          end: conditions.time_end,
          channel: "web",
        },
        [tableRef],
      );
    }),
    finalStep("已核对正式口径并生成SQL，可继续补充条件，尚未执行。", (body) => {
      originalDraft = lastReply(body);
    }),
  ]);
  assert.equal(known.tasks.length, 1);
  assert.equal(openQuestions(originalTask).length, 0);
  assert.equal(
    (await readQuery(originalDraft)).execution_state,
    "not_submitted",
  );
  noAuthorization(originalDraft);
  checks.push(
    "真实Pi协议先检索/读取已有口径再生成草稿，没有强制澄清或执行；该协议验证不代表真实模型自主判断准确率",
  );

  await begin(cid, "把刚才的分析改成退款率。金额和订单我还没有选。");
  await completeRound("关键歧义保存一题", [
    toolStep("read_analysis_task", { task_id: originalTask.task_id }),
    toolStep(
      "update_analysis_task",
      {
        action: "clarify",
        task_id: originalTask.task_id,
        expected_version: originalTask.condition_version,
        goal: "2026年1月退款率",
        condition_patch: { set: { metric: "refund_rate" }, unset: [] },
        question,
        options,
      },
      (body) => assert.equal(lastReply(body).id, originalTask.task_id),
    ),
    finalStep(
      question +
        "\n\n" +
        options.join("\n") +
        "\n也可以直接告诉我你实际想比较的范围。",
      (body) => {
        waitingTask = lastReply(body);
      },
    ),
  ]);
  assert.equal((await taskIn(cid, waitingTask)).phase, "waiting_clarification");
  const waitingQuestion = openQuestions(waitingTask)[0];
  assert.equal(waitingQuestion.question, question);
  assert.deepEqual(waitingQuestion.options, options);
  assert.equal(openQuestions(waitingTask).length, 1);
  assert.equal(
    (await readQuery(originalDraft)).confirmation_state,
    "superseded",
  );
  checks.push(
    "关键分母歧义通过Pi保存为任务的一条真实开放问题，问题和选项实际持久化，旧条件草稿失效",
  );

  await begin(cid, "先解释这两个选项各有什么区别，我还没决定。");
  await completeRound("解释选项保留问题", [
    toolStep("read_analysis_task", { task_id: waitingTask.task_id }),
    toolStep("update_analysis_task", routeArgs(waitingTask), (body) =>
      assert.equal(lastReply(body).clarification.question, question),
    ),
    finalStep(
      "订单比例看多少订单发生退款；金额比例看退款金额占付款金额多少。可以继续补充，当前尚未选择分母。",
    ),
  ]);
  assert.deepEqual(openQuestions(waitingTask), [waitingQuestion]);
  assert.equal(
    (await taskIn(cid, waitingTask)).condition_version,
    waitingTask.condition_version,
  );

  await begin(cid, "另外先给我各渠道的数量汇总SQL，之前那个问题暂时放着。");
  await completeRound("新话题独立任务", [
    toolStep("update_analysis_task", {
      action: "create",
      goal: "渠道种类数量",
      conditions: {
        ...baselineConditions,
        metric: "channel_count",
        channel: null,
        group_by: [],
      },
      options: [],
    }),
    toolStep("request_query", (body) => {
      unrelatedTask = lastReply(body);
      return draftArgs(
        unrelatedTask,
          "SELECT COUNT(DISTINCT channel) AS channel_count FROM demo_order_detail WHERE paid_at>=:start AND paid_at<:end AND is_test=0 AND paid_amount_cents>0",
          { start: conditions.time_start, end: conditions.time_end },
        [tableRef],
      );
    }),
    finalStep("渠道数量SQL已生成，退款率的问题保留，尚未执行。", (body) => {
      unrelatedDraft = lastReply(body);
    }),
  ]);
  assert.notEqual(unrelatedTask.task_id, waitingTask.task_id);
  assert.equal((await h.snapshot(cid)).tasks.length, 2);
  assert.deepEqual(openQuestions(waitingTask), [waitingQuestion]);
  assert.equal((await taskIn(cid, waitingTask)).phase, "waiting_clarification");
  noAuthorization(unrelatedDraft);
  checks.push(
    "解释选项route不改变条件或吞掉问题，独立新话题创建另一任务，原问题仍开放且不阻塞聊天",
  );

  await begin(cid, "执行刚才渠道数量的SQL，退款率仍未选择。");
  const executeMessage = run.message_id;
  await completeRound("独立查询继续运行", [
    toolStep("update_analysis_task", routeArgs(unrelatedTask)),
    toolStep("execute_query", executeArgs(unrelatedDraft)),
    finalStep("渠道查询已开始，仍可继续回答退款率的问题。", (body) =>
      assert.equal(lastReply(body).id, unrelatedDraft.id),
    ),
  ]);
  const capturedCount = h.captured.length;
  await h.resumeWorker();
  await until(
    async () =>
      (await readQuery(unrelatedDraft)).execution_state === "succeeded",
    "无关查询在澄清期间完成",
    40000,
  );
  run = await until(
    () =>
      h.captured
        .slice(capturedCount)
        .find(
          (value) =>
            value.conversation_id === cid &&
            value.text.includes("query_id=" + unrelatedDraft.id),
        ),
    "原查询结果交付",
    40000,
  );
  await h.pauseWorker();
  await completeRound("结果归属独立任务", [
    toolStep("update_analysis_task", routeArgs(unrelatedTask)),
    toolStep("get_query", { query_id: unrelatedDraft.id }),
    finalStep("渠道查询结果已返回，退款率的分母问题仍待回答。", (body) => {
      assert.equal(lastReply(body).query.execution_state, "succeeded");
      assert.equal(lastReply(body).results.rows.length, 1);
    }),
  ]);
  assert.deepEqual(openQuestions(waitingTask), [waitingQuestion]);
  assert.equal((await taskIn(cid, waitingTask)).phase, "waiting_clarification");
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('message',confirmation_message_id) FROM query_requests WHERE id='${unrelatedDraft.id}'`,
    )[0].message,
    executeMessage,
  );
  checks.push(
    "同会话另一任务的查询在澄清期间执行并交付真实平台结果，授权绑定明确执行消息，原问题及任务不被关闭",
  );

  const sessionBefore = sessionIdentity(savedCheckpoint());
  assert.equal(typeof sessionBefore, "string");
  await h.restartApi();
  const reopened = await h.snapshot(cid);
  assert.equal(
    reopened.tasks.find((value) => value.id === waitingTask.task_id).phase,
    "waiting_clarification",
  );
  await begin(
    cid,
    "我选按金额算，这次只看app渠道。原来的日期、时区、分组和排除条件保持。先不要执行。",
  );
  const recoveredTask = run.workspace_context.tasks.find(
    (value) => value.id === waitingTask.task_id,
  );
  assert.ok(recoveredTask);
  assert.equal(recoveredTask.clarification.question, question);
  await completeRound("自由回答恢复同任务", [
    toolStep("read_analysis_task", { task_id: waitingTask.task_id }),
    toolStep(
      "update_analysis_task",
      {
        action: "revise",
        task_id: waitingTask.task_id,
        expected_version: waitingTask.condition_version,
        goal: "2026年1月app渠道退款金额比例",
        condition_patch: {
          set: { metric: "refund_amount_rate", channel: "app" },
          unset: [],
        },
        options: [],
      },
      (body) => {
        assert.equal(lastReply(body).clarification.question, question);
        assert.deepEqual(
          lastReply(body).conditions.filters,
          conditions.filters,
        );
      },
    ),
    toolStep("request_query", (body) => {
      revisedTask = lastReply(body);
      return draftArgs(
        revisedTask,
        "SELECT channel,SUM(refunded_amount_cents)*1.0/NULLIF(SUM(paid_amount_cents),0) AS refund_amount_rate FROM demo_order_detail WHERE paid_at>=:start AND paid_at<:end AND channel=:channel AND is_test=0 AND paid_amount_cents>0 GROUP BY channel",
        {
          start: conditions.time_start,
          end: conditions.time_end,
          channel: "app",
        },
        [tableRef],
        originalDraft.id,
      );
    }),
    finalStep(
      "已沿原任务改为退款金额比例和app渠道。原日期、时区与过滤条件保留，新SQL只展示，尚未执行。",
      (body) => {
        revisedDraft = lastReply(body);
      },
    ),
  ]);
  assert.equal(revisedTask.task_id, originalTask.task_id);
  assert.equal(
    Number(revisedTask.condition_version),
    Number(waitingTask.condition_version) + 1,
  );
  assert.equal(revisedTask.conditions.metric, "refund_amount_rate");
  assert.equal(revisedTask.conditions.channel, "app");
  for (const key of [
    "time_start",
    "time_end",
    "timezone",
    "group_by",
    "filters",
    "knowledge_refs",
    "notes",
  ])
    assert.deepEqual(revisedTask.conditions[key], baselineConditions[key]);
  assert.equal(openQuestions(revisedTask).length, 0);
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('state',state) FROM clarifications WHERE id='${waitingQuestion.id}'`,
    )[0].state,
    "resolved",
  );
  assert.equal(
    (await readQuery(originalDraft)).execution_state,
    "not_submitted",
  );
  assert.equal(
    (await readQuery(revisedDraft)).execution_state,
    "not_submitted",
  );
  noAuthorization(originalDraft);
  noAuthorization(revisedDraft);
  assert.equal(sessionIdentity(savedCheckpoint()), sessionBefore);
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_tasks WHERE conversation_id='${cid}'`,
    )[0].n,
    2,
  );
  checks.push(
    "API/Worker重启后Pi沿同一长期会话与原任务续答；自由回答只合并指定指标/渠道，日期、时区、分组与其它过滤保留，原问题解决且回答不自动执行SQL",
  );

  await begin(cid, "请执行之前最早的SQL。");
  await invoke("update_analysis_task", routeArgs(revisedTask));
  const oldDenied = await invokeRaw(
    "execute_query",
    executeArgs(originalDraft),
  );
  assert.equal(oldDenied.value.code, "version_conflict");
  noAuthorization(originalDraft);
  noAuthorization(revisedDraft);
  await finishManual("最早的SQL条件已失效，当前新草稿也保持未执行。");
  checks.push(
    "自由答案产生新条件后，即使新消息明确执行，旧稿仍拒绝；当前新草稿也没有被顺便授权",
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
      mode: "real Pi/local OpenAI protocol, real Rust/MySQL/synthetic SQLite",
    }),
  );
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await writeFile(
    ".local/checks/clarification.json",
    JSON.stringify(
      {
        passed,
        checks,
        calls,
        payloadBytes,
        rounds,
        officialRequests: 0,
        scope:
          "实际Pi、Rust、MySQL与合成平台；本地协议流程，不证明真实模型的自主澄清效果",
      },
      null,
      2,
    ) + "\n",
  );
  if (run) h.releaseRun(run.run_id);
  await new Promise((resolve) => provider.close(resolve));
  await h.close();
}
