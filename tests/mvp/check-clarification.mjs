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

let run,
  manager,
  plan,
  protocolFailure,
  passed = false,
  calls = 0,
  compactions = 0;
const checks = [],
  payloadBytes = [],
  summaryRequests = [],
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
const invokeRaw = async (name, args, sdk = randomUUID()) => {
  const input = {
    ...binding(),
    sdk_tool_call_id: sdk,
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
    let step;
    if (!body.tools?.length) {
      // 长会话允许Pi原生摘要；单独计费且不消费业务脚本，不取消压缩来迎合夹具。
      assert.match(body.messages.find(message => message.role === "system")?.content ?? "", /context summarization assistant/);
      assert.match(JSON.stringify(body.messages), /<conversation>|# Conversation/);
      compactions++;
      summaryRequests.push(body);
      step = {text: "合成会话包含退款率与渠道两个独立任务。退款率的分母问题等待回答，渠道查询按自身授权执行。通过read_analysis_task核对完整条件及开放问题，read_conversation补读原话；用户回答不增加执行授权。"};
    } else {
      assert.ok(body.tools.some((tool) => tool.function.name === "read_analysis_task"));
      assert.ok(plan && plan.index < plan.steps.length, "协议计划外的模型请求不能制造成功");
      step = plan.steps[plan.index++];
    }
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
const h = await harness({
  capture: true,
  profile,
  protocolProviderUrl: "http://127.0.0.1:" + provider.address().port,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "0.1" },
});
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
  const savedQuestion = {
    ...guardedTask.opened_clarification,
    version: guardedTask.condition_version,
  };
  assert.deepEqual(openQuestions(guardedTask), [savedQuestion]);
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
    "waiting_clarification",
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
  await begin(guardCid, "时间改成二月，分母暂不决定。");
  guardedTask = await invoke("update_analysis_task", {
    action: "revise",
    task_id: guardedTask.task_id,
    expected_version: guardedTask.condition_version,
    goal: "",
    condition_patch: {
      set: {
        time_start: "2026-02-01T00:00:00Z",
        time_end: "2026-03-01T00:00:00Z",
      },
      unset: [],
    },
    options: [],
  });
  assert.deepEqual(
    openQuestions(guardedTask),
    [savedQuestion],
    "仅修改日期不能解决尚未回答的分母问题",
  );
  assert.equal((await taskIn(guardCid, guardedTask)).phase, "waiting_clarification");
  assert.equal(
    (await invokeRaw("request_query", draftArgs(guardedTask, "SELECT 3 AS verification_value"))).value.code,
    "waiting_clarification",
  );
  assert.equal(guardedTask.clarification.id, savedQuestion.id);
  await finishManual();
  checks.push(
    "clarify缺失/null/空白/伪null问题在新建及已有任务中均拒绝，没有新增任务、条件版本或开放问题；等待与旧稿不能执行",
  );
  checks.push(
    "用户仅修改日期时新增条件版本，保留原未答问题与等待阶段；按新版本提交SQL仍被拒绝",
  );

  await begin(guardCid, "地区口径也需要确认；分母尚未选择。");
  const beforeSecondQuestion = guardedTask;
  guardedTask = await invoke("update_analysis_task", {
    action: "clarify",
    task_id: guardedTask.task_id,
    expected_version: guardedTask.condition_version,
    goal: "",
    condition_patch: { set: {}, unset: [] },
    question: "地区采用下单时的历史地区，还是当前地区？",
    options: ["下单时地区", "当前地区"],
  });
  const bothQuestions = openQuestions(guardedTask);
  assert.equal(bothQuestions.length, 2);
  assert.ok(bothQuestions.some((value) => value.id === savedQuestion.id));
  const secondQuestion = {
    ...guardedTask.opened_clarification,
    version: guardedTask.condition_version,
  };
  assert.equal(guardedTask.clarification.id, savedQuestion.id);
  const visibleQuestions = await invoke("read_analysis_task", { task_id: guardedTask.task_id });
  assert.deepEqual(
    visibleQuestions.open_clarifications.map((value) => value.id).sort(),
    [savedQuestion.id, secondQuestion.id].sort(),
  );
  assert.equal(visibleQuestions.next_clarification_after, null);
  await finishManual("分母与地区口径仍待回答，可以先决定任意一个问题。");
  await begin(guardCid, "地区按当前地区；分母暂不决定。");
  const otherTask = await invoke("update_analysis_task", {
    action: "clarify",
    goal: "另一任务的独立问题",
    conditions,
    question: "另一任务需要哪个渠道？",
    options: ["web", "app"],
  });
  const otherQuestion = {
    ...otherTask.opened_clarification,
    version: otherTask.condition_version,
  };
  const answerArgs = (ids) => ({
    action: "revise",
    task_id: guardedTask.task_id,
    expected_version: guardedTask.condition_version,
    goal: "",
    condition_patch: { set: { metric: "refund_amount_rate" }, unset: [] },
    resolved_clarification_ids: ids,
    options: [],
  });
  const beforeAnswers = revisions(guardedTask);
  for (const ids of [[randomUUID()], [otherQuestion.id], [savedQuestion.id, otherQuestion.id]]) {
    const rejected = await invokeRaw("update_analysis_task", answerArgs(ids));
    assert.equal(rejected.value.code, "not_available");
    assert.equal(revisions(guardedTask), beforeAnswers);
    assert.deepEqual(openQuestions(guardedTask), bothQuestions);
    assert.deepEqual(openQuestions(otherTask), [otherQuestion]);
  }
  const duplicate = await invokeRaw("update_analysis_task", answerArgs([savedQuestion.id, savedQuestion.id]));
  assert.equal(duplicate.status, 400);
  const stale = await invokeRaw("update_analysis_task", {
    ...answerArgs([savedQuestion.id]),
    expected_version: beforeSecondQuestion.condition_version,
  });
  assert.equal(stale.value.code, "version_conflict");
  assert.equal(revisions(guardedTask), beforeAnswers);
  assert.deepEqual(openQuestions(guardedTask), bothQuestions);

  const answerableSecond = visibleQuestions.open_clarifications.find((value) => value.id === secondQuestion.id);
  const firstAnswer = {
    ...answerArgs([answerableSecond.id]),
    condition_patch: { set: { notes: "用户明确接受当前地区口径。" }, unset: [] },
  };
  const answerSdk = randomUUID();
  const answerReceipt = ok(await invokeRaw("update_analysis_task", firstAnswer, answerSdk));
  guardedTask = answerReceipt.data;
  assert.equal(guardedTask.phase, "waiting_clarification");
  assert.equal(guardedTask.clarification.id, savedQuestion.id);
  assert.deepEqual(openQuestions(guardedTask), [savedQuestion]);
  const replay = ok(await invokeRaw("update_analysis_task", firstAnswer, answerSdk));
  assert.deepEqual(replay, answerReceipt);
  assert.equal(revisions(guardedTask), beforeAnswers + 1);
  const resolvedAgain = await invokeRaw("update_analysis_task", answerArgs([secondQuestion.id]));
  assert.equal(resolvedAgain.value.code, "clarification_not_open");
  assert.equal(revisions(guardedTask), beforeAnswers + 1);
  assert.deepEqual(openQuestions(guardedTask), [savedQuestion]);
  assert.equal(
    (await invokeRaw("request_query", draftArgs(guardedTask, "SELECT 4 AS verification_value"))).value.code,
    "waiting_clarification",
  );
  await finishManual("地区口径已保存，分母问题仍待决定，尚未生成或执行SQL。");

  await begin(guardCid, "采用金额分母；省级和市级的区别请说明一下，暂不决定。");
  guardedTask = await invoke("update_analysis_task", {
    ...answerArgs([savedQuestion.id]),
    action: "clarify",
    question: "地区汇总采用省级还是市级？",
    options: ["省级", "市级"],
  });
  const remainingQuestion = guardedTask.opened_clarification;
  assert.equal(openQuestions(guardedTask).length, 1);
  assert.notEqual(remainingQuestion.id, secondQuestion.id);
  assert.equal(guardedTask.clarification.id, remainingQuestion.id);
  assert.equal(guardedTask.phase, "waiting_clarification");
  await finishManual("当前地区口径已保存；请补充采用省级还是市级。");

  await begin(guardCid, "采用省级，先给SQL，不要执行。");
  guardedTask = await invoke("update_analysis_task", {
    ...answerArgs([remainingQuestion.id]),
    condition_patch: { set: { group_by: ["province"] }, unset: [] },
  });
  assert.equal(guardedTask.phase, "investigating");
  assert.equal(guardedTask.clarification, null);
  assert.deepEqual(openQuestions(guardedTask), []);
  assert.deepEqual(openQuestions(otherTask), [otherQuestion]);
  const answerDraft = await invoke("request_query", draftArgs(guardedTask, "SELECT 5 AS verification_value"));
  assert.equal(answerDraft.execution_state, "not_submitted");
  noAuthorization(answerDraft);
  await finishManual("已按当前地区、省级与金额口径生成草稿；尚未执行。");
  checks.push(
    "多个问题通过工具回执/read均可读，先答后问仍保留首问；旧版、未知、跨任务、重复ID拒绝且整笔回滚；已提交回答重传取原回执；回答同时追问只保留新问题，最后回答后可生成SQL且不自动执行",
  );

  const goalCid = await h.create();
  await begin(goalCid, "建立合成分析任务并调查资料；此次不取数。\n只修改明确提供的条件。");
  for (const action of ["create", "revise", "clarify"]) {
    for (const task_id of [undefined, null]) {
      const rejected = await invokeRaw("update_analysis_task", {
        action, conditions, options: [],
        ...(task_id === undefined ? {} : { task_id }),
        ...(action === "clarify" ? { clarifications: [{ question: "采用哪个合成口径？", options: [] }] } : {}),
      });
      assert.equal(rejected.status, 400, "所有创建分支仍必须给出目标");
      assert.equal((await h.snapshot(goalCid)).tasks.length, 0);
    }
  }
  let goalTask = await invoke("update_analysis_task", {
    action: "create", goal: "保持原有分析目标", conditions, options: [],
  });
  const storedGoal = () => h.sql(`SELECT JSON_OBJECT('goal',goal,'condition_version',goal_condition_version,'authority',goal_authority) FROM analysis_tasks WHERE id='${goalTask.task_id}'`)[0];
  const originalGoal = storedGoal();
  const goalSource = ok(await h.request("/knowledge", {
    operation_id: randomUUID(), kind: "document", name: "目标来源的合成说明", body: "此合成资料用于核对新目标来源，不应覆盖未修改的旧目标来源。", related_ids: [],
  }));
  await invoke("read_knowledge", { object_id: goalSource.id, version: goalSource.version, entry_id: "body", offset: 0, limit: 4096 });
  for (const invalid of [
    { action: "revise", task_id: goalTask.task_id, expected_version: goalTask.condition_version, options: [] },
    { action: "revise", task_id: goalTask.task_id, condition_patch: { set: {}, unset: [] }, options: [] },
    { action: "clarify", task_id: goalTask.task_id, expected_version: goalTask.condition_version, condition_patch: { set: {}, unset: [] }, options: [] },
    { ...routeArgs(goalTask), condition_patch: { set: {}, unset: [] } },
  ]) {
    assert.equal((await invokeRaw("update_analysis_task", invalid)).status, 400);
    assert.equal(revisions(goalTask), 1);
    assert.deepEqual(storedGoal(), originalGoal, "省略goal不放宽补丁、版本或澄清约束");
  }
  goalTask = await invoke("update_analysis_task", {
    action: "revise", task_id: goalTask.task_id, expected_version: goalTask.condition_version,
    condition_patch: { set: { notes: "只补充条件，不改目标" }, unset: [] }, options: [],
  });
  assert.deepEqual(storedGoal(), originalGoal, "已有revise省略goal保持原正文、创建版本和来源");
  goalTask = await invoke("update_analysis_task", {
    action: "clarify", task_id: goalTask.task_id, expected_version: goalTask.condition_version,
    condition_patch: { set: {}, unset: [] }, options: [], clarifications: [{ question: "另一个合成条件采用哪个范围？", options: ["全部", "指定范围"] }],
  });
  assert.deepEqual(storedGoal(), originalGoal, "已有clarify省略goal不把新问题来源写进旧目标");
  await invoke("update_analysis_task", routeArgs(goalTask));
  assert.deepEqual(storedGoal(), originalGoal, "route省略goal只登记归属");
  assert.equal(revisions(goalTask), 3);
  goalTask = await invoke("update_analysis_task", {
    action: "revise", task_id: goalTask.task_id, expected_version: goalTask.condition_version,
    goal: originalGoal.goal, condition_patch: { set: {}, unset: [] }, options: [],
  });
  assert.deepEqual(storedGoal(), originalGoal, "显式重传同文仍保留原来源");
  goalTask = await invoke("update_analysis_task", {
    action: "revise", task_id: goalTask.task_id, expected_version: goalTask.condition_version,
    goal: "根据已读合成资料修订后的新目标", condition_patch: { set: {}, unset: [] }, options: [],
  });
  const rewrittenGoal = storedGoal();
  assert.equal(rewrittenGoal.goal, "根据已读合成资料修订后的新目标");
  assert.equal(rewrittenGoal.condition_version, Number(goalTask.condition_version));
  assert.notDeepEqual(rewrittenGoal.authority, originalGoal.authority, "真实改写仍按已有规则绑定当前资料来源");
  assert.equal(openQuestions(goalTask).length, 1, "省略或改写目标均不自动解决未答问题");
  await finishManual("已补充条件并保留未答问题，没有执行查询。");
  checks.push("创建含兼容分支必须有目标；已有revise/clarify/route省略goal保留目标正文、版本与来源，补丁/版本/澄清约束不放宽，显式改写仍重绑来源");

  const batchCid = await h.create();
  await begin(batchCid, "同一个联合分析需要确认分母和地区；两个问题分别回答。");
  const questions = [
    { question: "采用订单数还是金额作分母？", options: ["订单数", "金额"] },
    { question: "地区取发生时还是当前归属？", options: ["发生时", "当前"] },
  ];
  let batchTask = await invoke("update_analysis_task", {
    action: "clarify", goal: "联合分析的独立条件", conditions, options: [], clarifications: questions,
  });
  const opened = batchTask.opened_clarifications;
  assert.equal(opened.length, 2);
  assert.notEqual(opened[0].id, opened[1].id);
  assert.equal(batchTask.clarification.id, opened[0].id, "恢复摘要保留同批问题的输入顺序");
  assert.deepEqual(opened.map(({ question, options }) => ({ question, options })), questions);
  assert.equal(revisions(batchTask), 1, "一批问题随同一条件版本原子登记");
  const blockedSdk = randomUUID();
  const blockedArgs = draftArgs(batchTask, "SELECT 7 AS verification_value");
  assert.equal((await invokeRaw("request_query", blockedArgs, blockedSdk)).value.code, "waiting_clarification");
  const blockedReceipt = ok(await h.internal("/internal/data/tool-rejections", {
    ...binding(), sdk_tool_call_id: blockedSdk, tool_name: "request_query", arguments: blockedArgs, checkpoint: checkpoint(),
  }));
  assert.equal(blockedReceipt.data.recovery.task.condition_version, batchTask.condition_version);
  assert.deepEqual(blockedReceipt.data.recovery.task.open_clarification_ids.sort(), opened.map(item => item.id).sort());
  assert.deepEqual(blockedReceipt.data.recovery.task.read_tool, { name: "read_analysis_task", arguments: { task_id: batchTask.task_id } });
  assert.equal(blockedReceipt.data.recovery.task.conditions, undefined, "拒绝回执不复制条件和知识正文");
  await finishManual("两个问题分别保留，先回答任意一个。");
  await begin(batchCid, "先用当前地区，分母之后回答。");
  const batchPreview = run.workspace_context.tasks.find((value) => value.id === batchTask.task_id);
  assert.equal(batchPreview.clarification.id, opened[0].id);
  assert.equal(batchPreview.has_more_clarifications, true, "首题预览须说明还有其他未答问题");
  assert.equal(batchPreview.context_complete, false, "省略问题的启动快照不能冒称完整");
  assert.equal(batchPreview.open_clarifications, undefined, "启动快照不扩充为问题全集");
  assert.equal(batchTask.has_more_clarifications, true, "更新回执也标明首题不是未答问题全集");
  batchTask = await invoke("update_analysis_task", {
    action: "revise", task_id: batchTask.task_id, expected_version: batchTask.condition_version,
    goal: "", condition_patch: { set: { notes: "地区采用当前归属" }, unset: [] },
    options: [], resolved_clarification_ids: [opened[1].id],
  });
  assert.equal(batchTask.phase, "waiting_clarification");
  assert.equal(batchTask.has_more_clarifications, false);
  assert.deepEqual(openQuestions(batchTask).map(item => item.id), [opened[0].id]);
  const historical = await invoke("read_analysis_task", { task_id: batchTask.task_id, condition_version: "1" });
  assert.equal(historical.condition_version, "1");
  assert.equal(historical.current_condition_version, "2");
  assert.equal(historical.is_historical, true);
  assert.deepEqual(historical.conditions, conditions);
  assert.equal(historical.phase, "waiting_clarification");
  assert.deepEqual(historical.current_open_clarification_ids, [opened[0].id]);
  assert.equal(historical.open_clarifications, undefined);
  assert.equal(historical.clarification, undefined);
  assert.equal(historical.goal, undefined, "没有持久化目标历史，不能返回当前目标冒称原目标");
  assert.equal((await invokeRaw("read_analysis_task", { task_id: batchTask.task_id, condition_version: "99" })).value.code, "not_available");
  assert.equal((await invokeRaw("read_analysis_task", { task_id: guardedTask.task_id, condition_version: "1" })).value.code, "not_available");
  assert.equal((await invokeRaw("request_query", { ...draftArgs(batchTask, "SELECT 7 AS verification_value"), condition_version: "1" })).value.code, "version_conflict");
  assert.equal((await invokeRaw("request_query", draftArgs(batchTask, "SELECT 7 AS verification_value"))).value.code, "waiting_clarification");
  for (const invalid of [
    { clarifications: questions, question: "不能并存单问题" },
    { clarifications: [{ question: "有效", options: [] }, { question: " ", options: [] }] },
    { clarifications: Array(9).fill(questions[0]) },
  ]) {
    assert.equal((await invokeRaw("update_analysis_task", {
      action: "clarify", task_id: batchTask.task_id, expected_version: batchTask.condition_version,
      goal: "", condition_patch: { set: {}, unset: [] }, options: [], ...invalid,
    })).status, 400);
    assert.equal(revisions(batchTask), 2);
    assert.deepEqual(openQuestions(batchTask).map(item => item.id), [opened[0].id]);
  }
  await finishManual("地区已保存，分母未回答，保持等待。");
  ok(await h.request(`/conversations/${batchCid}/tasks/${batchTask.task_id}/cancel`, {
    operation_id: randomUUID(), expected_version: batchTask.condition_version,
  }));
  await begin(batchCid, "查看已取消任务的状态。");
  const cancelledPreview = run.workspace_context.tasks.find((value) => value.id === batchTask.task_id);
  assert.equal(cancelledPreview.has_more_clarifications, false);
  assert.notEqual(cancelledPreview.context_complete, false);
  const cancelledHistorical = await invoke("read_analysis_task", { task_id: batchTask.task_id, condition_version: "1" });
  assert.equal(cancelledHistorical.lifecycle, "cancelled");
  assert.equal(cancelledHistorical.is_historical, true);
  assert.deepEqual(cancelledHistorical.conditions, conditions);
  assert.equal((await invokeRaw("update_analysis_task", routeArgs(batchTask))).value.code, "task_inactive");
  assert.equal((await invokeRaw("request_query", draftArgs(batchTask, "SELECT 7 AS verification_value"))).value.code, "task_inactive");
  assert.equal((await invokeRaw("request_query", { ...draftArgs(batchTask, "SELECT 7 AS verification_value"), condition_version: "1" })).value.code, "version_conflict");
  await invoke("update_analysis_task", { action: "route", goal: "", options: [] });
  await finishManual("任务已经取消，没有恢复执行。");
  checks.push("独立问题同版本原子登记、逆序回答保留残留问题；错误码区分旧版/等待/取消；拒绝回执给当前控制状态和读取入口，非法批次无部分写入");

  const pageCid = await h.create();
  await begin(pageCid, "请保存九个独立待确认项，暂不回答。");
  let pageTask;
  const pageQuestions = [];
  for (let index = 0; index < 9; index++) {
    pageTask = await invoke("update_analysis_task", {
      action: "clarify",
      ...(pageTask ? {
        task_id: pageTask.task_id,
        expected_version: pageTask.condition_version,
        condition_patch: { set: {}, unset: [] },
      } : { conditions }),
      goal: "分页读取待确认项",
      question: `合成独立待确认项${index + 1}采用哪个范围？`,
      options: ["范围一", "范围二"],
    });
    pageQuestions.push(pageTask.opened_clarification);
  }
  const pageOne = await invoke("read_analysis_task", { task_id: pageTask.task_id });
  assert.equal(pageOne.open_clarifications.length, 8);
  assert.equal(pageOne.context_complete, undefined, "正式读取以问题分页游标表达范围，不继承启动预览标记");
  assert.equal(pageOne.next_clarification_after, pageOne.open_clarifications.at(-1).id);
  const pageTwo = await invoke("read_analysis_task", {
    task_id: pageTask.task_id,
    clarification_after: pageOne.next_clarification_after,
  });
  assert.equal(pageTwo.open_clarifications.length, 1);
  assert.equal(pageTwo.next_clarification_after, null);
  assert.deepEqual(
    [...pageOne.open_clarifications, ...pageTwo.open_clarifications].map((value) => value.id),
    pageQuestions.map((value) => value.id).sort(),
  );
  const invalidPage = await invokeRaw("read_analysis_task", {
    task_id: pageTask.task_id,
    clarification_after: otherQuestion.id,
  });
  assert.equal(invalidPage.value.code, "not_available");
  await finishManual("九个问题均已保存，暂不生成SQL。");
  await begin(pageCid, "先继续阅读这些问题。");
  const workspaceTask = run.workspace_context.tasks.find((value) => value.id === pageTask.task_id);
  assert.equal(workspaceTask.clarification.id, pageQuestions[0].id);
  assert.equal(workspaceTask.open_clarifications, undefined);
  assert.equal(workspaceTask.has_more_clarifications, true);
  assert.equal(workspaceTask.context_complete, false);
  await completeRound("问题预览省略信号到达模型并能分页补齐", [
    toolStep("read_analysis_task", { task_id: pageTask.task_id }, body => {
      const content = body.messages.map(message => typeof message.content === "string"
        ? message.content : (message.content ?? []).map(part => part.text ?? "").join("\n"));
      const facts = JSON.parse(content.find(value => value.startsWith("当前宿主事实：")).split("\n").slice(1).join("\n"));
      const task = facts.tasks.find(value => value.id === pageTask.task_id);
      assert.equal(task.has_more_clarifications, true);
      assert.equal(task.context_complete, false);
      assert.equal(task.clarification.id, pageQuestions[0].id);
      assert.equal(task.open_clarifications, undefined);
    }),
    toolStep("read_analysis_task", body => {
      const current = lastReply(body);
      assert.deepEqual(current.open_clarifications, pageOne.open_clarifications);
      assert.equal(current.context_complete, undefined);
      assert.equal(current.next_clarification_after, pageOne.next_clarification_after);
      return { task_id: pageTask.task_id, clarification_after: current.next_clarification_after };
    }),
    toolStep("update_analysis_task", routeArgs(pageTask), body => {
      assert.deepEqual(lastReply(body).open_clarifications, pageTwo.open_clarifications);
      assert.equal(lastReply(body).next_clarification_after, null);
    }),
    finalStep("待答问题已按页读完，仍未自动接受任何选项。"),
  ]);
  assert.deepEqual(openQuestions(pageTask).map(value => value.id), pageQuestions.map(value => value.id).sort());
  checks.push("未决问题正式读取每页最多8项，游标覆盖全部真实ID且拒绝跨任务；初始工作区只带首题并标明省略，真实Pi请求收到信号后能分页补齐且不自动关题");

  const recoveryCid = await h.create();
  await begin(recoveryCid, "先保存SQL，不执行。");
  const recoveryTask = await invoke("update_analysis_task", { action: "create", goal: "验证受控拒绝的可恢复执行", conditions, options: [] });
  const recoveryQuery = await invoke("request_query", draftArgs(recoveryTask, "SELECT 23 AS verification_value"));
  await finishManual("草稿已保存，尚未执行。");
  await begin(recoveryCid, "执行已经保存的这条SQL。");
  await completeRound("模型收到受控拒绝及恢复快照后继续原授权执行", [
    toolStep("execute_query", { ...executeArgs(recoveryQuery), draft_version: String(Number(recoveryQuery.draft_version) + 1) }),
    toolStep("get_query", { query_id: recoveryQuery.id }, body => {
      const rejected = lastReply(body);
      assert.equal(rejected.error, "version_conflict");
      assert.equal(rejected.outcome, "rejected");
      assert.equal(rejected.new_execution_authorized, false);
      assert.equal(rejected.recovery.query.query_id, recoveryQuery.id);
      assert.equal(rejected.recovery.query.execution_state, "not_submitted");
      assert.deepEqual(rejected.recovery.query.read_tool, { name: "get_query", arguments: { query_id: recoveryQuery.id } });
      assert.equal(rejected.recovery.task.task_id, recoveryTask.task_id);
      assert.deepEqual(rejected.recovery.task.read_tool, { name: "read_analysis_task", arguments: { task_id: recoveryTask.task_id } });
      assert.equal(rejected.recovery.task.conditions, undefined);
    }),
    toolStep("execute_query", body => {
      const current = lastReply(body).query;
      assert.equal(current.id, recoveryQuery.id);
      assert.equal(current.draft_version, recoveryQuery.draft_version);
      assert.equal(current.execution_state, "not_submitted");
      return executeArgs(current);
    }),
    finalStep("执行请求已获授权并排队，尚无完成结果。", body => {
      const submitted = lastReply(body);
      assert.equal(submitted.id, recoveryQuery.id);
      assert.equal(submitted.execution_state, "queued");
    }),
  ]);
  assert.equal((await readQuery(recoveryQuery)).execution_state, "queued");
  await h.resumeWorker();
  run = await until(() => h.captured.find(value => value.conversation_id === recoveryCid && value.text.startsWith("[已确认查询结果事件]")), "恢复检查的真实结果交付");
  await h.pauseWorker();
  manager = SessionManager.inMemory("/synthetic/data-agent");
  await invoke("update_analysis_task", routeArgs(recoveryTask));
  await finishManual("平台已返回结果，本次恢复验证结束。");
  checks.push("真实Pi下一次provider请求含版本拒绝recovery和未授权标记；模型读当前草稿后沿同完整原话直接execute，原子归属并排队，未另建查询或虚报完成");

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
  const waitingQuestion = {
    ...waitingTask.opened_clarification,
    version: waitingTask.condition_version,
  };
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
        resolved_clarification_ids: [waitingQuestion.id],
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
      compactions,
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
        compactions,
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
  await writeFile(".local/checks/clarification-summary-requests.json", JSON.stringify(summaryRequests, null, 2) + "\n");
  if (run) h.releaseRun(run.run_id);
  await new Promise((resolve) => provider.close(resolve));
  await h.close();
}
