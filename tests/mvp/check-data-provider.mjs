import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { restoreCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness } from "./harness.mjs";
import { assetInput, ok, select } from "./skill-fixtures.mjs";
import contractSchema from "../../packages/contracts/schema.json" with { type: "json" };
const expectedTools =
  contractSchema.$defs.DataToolInvocation.properties.tool_name.enum;
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 32768,
  output_limit: 2048,
  trial_call_limit: 24,
  trial_cost_micros: "300000",
  request_call_limit: 12,
  toolset: "data",
  payload_bytes_limit: 65536,
};
let h;
let passed = false;
let calls = 0;
let agentCalls = 0;
let summaryCalls = 0;
const summaryRequests = [];
let document;
const bytes = [];
const refs = [{ object_id: "metric-net_revenue", version: "1", path: "sql" }];
const conditions = {
  time_start: "2026-01-01T00:00:00Z",
  time_end: "2026-02-01T00:00:00Z",
  timezone: "UTC",
  metric: "net_revenue",
  channel: null,
  group_by: [],
  filters: ["is_test=0"],
  knowledge_refs: refs,
  notes: "",
};
// Pi 1.0.0的原生摘要协议；无工具请求必须同时符合系统提示和会话摘要模板。
const summarySystemPrompt =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
function summarize(body) {
  assert.equal(body.tools, undefined);
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(body.messages[0].content, summarySystemPrompt);
  const content = body.messages[1].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  const prompt = content[0].text;
  assert.equal(typeof prompt, "string");
  let kind;
  if (prompt.startsWith("# Conversation\n")) {
    assert.ok(
      prompt.includes(
        "\n\n# Instructions\nThe messages above are earlier context from an ongoing conversation.",
      ),
    );
    for (const heading of [
      "## Original Request",
      "## Progress So Far",
      "## Context Needed to Continue",
    ])
      assert.ok(prompt.includes(heading));
    assert.ok(
      prompt.endsWith(
        "Only summarize information explicitly present above. Do not infer or recreate later messages.",
      ),
    );
    kind = "turn_prefix";
  } else {
    assert.ok(prompt.startsWith("<conversation>\n"));
    assert.ok(prompt.includes("\n</conversation>\n\n"));
    assert.ok(
      prompt.includes(
        "The messages above are a conversation to summarize. Create a structured context checkpoint summary",
      ) ||
        prompt.includes(
          "The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.",
        ),
    );
    for (const heading of [
      "## Goal",
      "## Progress",
      "## Next Steps",
      "## Critical Context",
    ])
      assert.ok(prompt.includes(heading));
    assert.ok(
      prompt.endsWith(
        "Keep each section concise. Preserve exact file paths, function names, and error messages.",
      ),
    );
    kind = "history";
  }
  summaryRequests.push({
    call: calls,
    kind,
    roles: body.messages.map((message) => message.role),
    payloadBytes: bytes.at(-1),
    max_tokens: body.max_tokens,
    stream: body.stream,
  });
  const originalRequest =
    prompt.match(/\[User\]: ([^\n]+)/)?.[1] ?? "已展示的用户请求";
  const records = [
    ...new Set(
      prompt.match(
        /"(?:task_id|condition_version|query_id|id)"\s*:\s*"[^"\n]+"/g,
      ) ?? [],
    ),
  ].slice(-8);
  return kind === "turn_prefix"
    ? `## Original Request\n${originalRequest}\n\n## Progress So Far\n- 保留已完成的工具调用，不重新创建任务或执行查询。\n\n## Context Needed to Continue\n${records.join("\n")}`
    : `## Goal\n${originalRequest}\n\n## Progress\n- 已有工具调用记录。\n\n## Next Steps\n- 沿用现有任务与查询。\n\n## Critical Context\n${records.join("\n")}`;
}
const provider = createServer(async (req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  bytes.push(Buffer.byteLength(raw));
  calls++;
  assert.equal(body.model, profile.model_id);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
  assert.deepEqual(body.thinking, { type: "disabled" });
  let summary;
  if (body.tools === undefined) {
    summary = summarize(body);
    summaryCalls++;
  } else {
    agentCalls++;
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name).sort(),
      [...expectedTools].sort(),
    );
    assert.ok(body.tools.some((tool) => tool.function.name === "read"));
    assert.ok(
      body.tools.some((tool) => tool.function.name === "execute_query"),
    );
  }
  let name, args;
  if (!summary && agentCalls === 1) {
    name = "search_knowledge";
    args = { query: "净收入", limit: 3 };
  }
  if (!summary && (agentCalls === 2 || agentCalls === 3)) {
    name = "read_knowledge";
    args = {
      object_id: document.id,
      version: document.version,
      entry_id: "body",
      offset: agentCalls === 2 ? 0 : 32000,
      limit: 2048,
    };
  }
  if (!summary && agentCalls === 3) {
    const firstPage = JSON.parse(
      body.messages.findLast((m) => m.role === "tool").content,
    );
    assert.equal(firstPage.entries[0].content_page.complete, false);
    assert.equal(firstPage.entries[0].effective_value.length, 2048);
  }
  if (!summary && agentCalls === 4) {
    const lastPage = JSON.parse(
      body.messages.findLast((m) => m.role === "tool").content,
    );
    assert.ok(lastPage.entries[0].effective_value.includes("尾部合成口径"));
    assert.equal(lastPage.entries[0].content_page.complete, false);
    name = "update_analysis_task";
    args = {
      action: "create",
      goal: "2026年1月净收入",
      conditions,
      options: [],
    };
  }
  if (!summary && agentCalls === 5) {
    const task = JSON.parse(
      body.messages.findLast((m) => m.role === "tool").content,
    );
    name = "request_query";
    args = {
      task_id: task.task_id,
      condition_version: task.condition_version,
      sql: "SELECT SUM(paid_amount_cents-refunded_amount_cents) AS net_revenue FROM demo_order_detail WHERE paid_at >= :start AND paid_at < :end AND is_test=0",
      parameters: { start: conditions.time_start, end: conditions.time_end },
      target_id: "synthetic-sqlite",
      replaces_query_id: null,
      summary: "净收入，2026年1月，UTC，排除测试",
      knowledge_refs: refs,
    };
  }
  if (!summary && agentCalls === 7) {
    name = "update_analysis_task";
    args = {
      action: "create",
      task_id: null,
      expected_version: null,
      goal: "被拒绝的合成任务",
      question: null,
      options: [],
    };
  }
  if (!summary && (agentCalls === 9 || agentCalls === 11)) {
    assert.ok(
      body.messages.some((m) =>
        JSON.stringify(m.content).includes("宿主拒绝本次交付：message_pending"),
      ),
    );
  }
  if (!summary && agentCalls === 11) {
    name = "update_analysis_task";
    args = {
      action: "create",
      task_id: null,
      expected_version: null,
      goal: "原消息需要选择分母",
      conditions: { ...conditions, metric: null },
      question: "按订单还是金额？",
      options: ["订单", "金额"],
    };
  }
  if (!summary && agentCalls === 13) {
    name = "update_analysis_task";
    args = {
      action: "create",
      task_id: null,
      expected_version: null,
      goal: "输出截断后的原问题",
      conditions,
      question: null,
      options: [],
    };
  }
  if (!summary && agentCalls === 15) {
    assert.ok(
      body.messages.some((m) =>
        JSON.stringify(m.content).includes(
          "宿主拒绝本次交付：model_output_limit",
        ),
      ),
    );
  }
  const delta = name
    ? {
        role: "assistant",
        content: "正在读取资料的过程文字。",
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : {
        role: "assistant",
        content:
          summary ??
          (agentCalls === 12
            ? "请选择订单或金额，澄清已保存。"
            : agentCalls === 14
              ? "解释还没写完：一、"
              : agentCalls === 15
                ? "完整解释已经重写，保留原任务。"
                : "SQL已保存，请确认后执行。"),
      };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null, usage) => ({
    id: "synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  });
  res.write("data: " + JSON.stringify(chunk(delta)) + "\n\n");
  res.write(
    "data: " +
      JSON.stringify(
        chunk(
          {},
          name
            ? "tool_calls"
            : !summary && agentCalls === 14
              ? "length"
              : "stop",
        ),
      ) +
      "\n\n",
  );
  res.write(
    "data: " +
      JSON.stringify({
        id: "synthetic",
        choices: [],
        // 只有真正达到输出cap的length才交宿主补正；低于cap的length由Pi原生压缩续跑。
        usage: {
          prompt_tokens: 100,
          completion_tokens: !summary && agentCalls === 14 ? 2048 : 25,
          total_tokens: !summary && agentCalls === 14 ? 2148 : 125,
        },
      }) +
      "\n\n",
  );
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const previous = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  DATA_AGENT_PROVIDER_TEST: process.env.DATA_AGENT_PROVIDER_TEST,
};
process.env.DEEPSEEK_API_KEY = "synthetic-protocol-key";
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:" + provider.address().port;
process.env.DATA_AGENT_PROVIDER_TEST = "1";
try {
  // API在接收消息时冻结连接及凭据，必须和Pi使用同一个本地协议替身。
  h = await harness({
    capture: true,
    profile,
    protocolProviderUrl: process.env.DEEPSEEK_BASE_URL,
    env: { DATA_AGENT_LEASE_MS: "120000" },
  });
  document = (
    await h.request("/knowledge", {
      operation_id: randomUUID(),
      kind: "document",
      name: "净收入长文合成说明",
      body: "合成文档".repeat(8000) + "尾部合成口径：退款按支付行归属。",
      related_ids: ["table-demo_order_detail"],
      source_url: null,
    })
  ).value;
  const cid = await h.create();
  const skill = ok(
    await h.request(
      "/assets",
      assetInput({
        name: "合成试用报告方法",
        body: "需要查看结果时先核对语义与时间。SQL 必须经用户按钮确认。回答顺序遵守 references/report.md。",
        files: [
          { path: "references/report.md", content: "先给结论，再列依据。" },
        ],
      }),
    ),
  );
  ok(await select(h, cid, skill));
  const run = await h.capture(cid, "查2026年1月净收入");
  await h.pauseWorker();
  await deliver(
    run,
    h.env.DATA_AGENT_API_URL,
    h.env.DATA_AGENT_INTERNAL_TOKEN,
    "",
  );
  const snapshot = await h.snapshot(cid);
  assert.equal(snapshot.runs[0].state, "finished");
  assert.equal(
    snapshot.messages.findLast((m) => m.role === "assistant" && m.committed)
      .text,
    "SQL已保存，请确认后执行。",
  );
  assert.ok(
    snapshot.events.some(
      (e) =>
        e.type === "assistant_delta" &&
        e.payload.text.includes("正在读取资料的过程文字。"),
    ),
    "普通调查回合保留原流式体验，不扩大结果核验的暂缓范围",
  );
  assert.equal(snapshot.tasks.length, 1);
  const q = (await h.request("/conversations/" + cid + "/queries")).value
    .queries;
  assert.equal(q.length, 1);
  assert.equal(q[0].execution_state, "not_submitted");
  assert.equal(agentCalls, 6);
  assert.ok(summaryCalls > 0);
  assert.equal(calls, agentCalls + summaryCalls);
  const ledger = h.sql(
    `SELECT JSON_OBJECT('calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`,
  )[0];
  assert.equal(ledger.calls, calls);
  assert.equal(ledger.reserved, 0);
  const compactedCheckpoint = h.sql(
    `SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`,
  )[0];
  assert.ok(
    restoreCheckpoint("/synthetic/data-agent", compactedCheckpoint)
      .getBranch()
      .some((entry) => entry.type === "compaction"),
  );
  assert.ok(
    restoreCheckpoint("/synthetic/data-agent", compactedCheckpoint)
      .getBranch()
      .some((entry) => entry.message?.role === "assistant" &&
        entry.message.content.some((part) => part.type === "text" &&
          part.text.includes("正在读取资料的过程文字。"))),
    "普通调查与结果核验均保留Pi历史中的实际消息",
  );
  h.releaseRun(run.run_id);
  await h.resumeWorker();
  const rejectedRun = await h.capture(
    await h.create(),
    "验证任务参数拒绝后诊断",
  );
  await h.pauseWorker();
  let diagnostic;
  await assert.rejects(
    deliver(
      rejectedRun,
      h.env.DATA_AGENT_API_URL,
      h.env.DATA_AGENT_INTERNAL_TOKEN,
      "",
    ),
    (error) => {
      assert.equal(error.message, "message_pending");
      diagnostic = error.checkpoint;
      return true;
    },
  );
  await writeFile(
    ".local/checks/mvp-failure-diagnostic.json",
    JSON.stringify(diagnostic, null, 2),
  );
  const diagnosticBranch = restoreCheckpoint(
    "/synthetic/data-agent",
    diagnostic,
  ).getBranch();
  const entries = diagnosticBranch
    .filter((e) => e.type === "message")
    .map((e) => e.message);
  assert.ok(
    entries.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (c) =>
            c.type === "toolCall" &&
            c.name === "update_analysis_task" &&
            !("conditions" in c.arguments),
        ),
    ),
  );
  assert.ok(
    entries.some(
      (m) =>
        m.role === "toolResult" &&
        m.isError &&
        m.content.some((c) => c.text?.includes("Validation failed")),
    ),
  );
  assert.equal(entries.at(-1).role, "assistant");
  assert.equal(
    diagnosticBranch.filter(
      (e) =>
        e.type === "custom_message" &&
        e.customType === "data_agent_delivery_rejected",
    ).length,
    1,
  );
  assert.equal(agentCalls, 9);
  h.releaseRun(rejectedRun.run_id);
  await h.resumeWorker();
  const correctedCid = await h.create();
  const correctedRun = await h.capture(
    correctedCid,
    "请查退款率，原消息需要澄清",
  );
  await h.pauseWorker();
  await deliver(
    correctedRun,
    h.env.DATA_AGENT_API_URL,
    h.env.DATA_AGENT_INTERNAL_TOKEN,
    "",
  );
  const corrected = await h.snapshot(correctedCid);
  assert.equal(corrected.tasks.length, 1);
  assert.equal(corrected.tasks[0].phase, "waiting_clarification");
  assert.equal(corrected.messages.filter((m) => m.role === "user").length, 1);
  assert.equal(
    corrected.messages.findLast((m) => m.role === "assistant" && m.committed)
      .text,
    "请选择订单或金额，澄清已保存。",
  );
  assert.ok(
    corrected.runs.some(
      (r) => r.run_id === correctedRun.run_id && r.state === "finished",
    ),
  );
  const saved = h.sql(
    `SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${correctedRun.recovery_chain_id}'`,
  )[0];
  assert.equal(
    restoreCheckpoint("/synthetic/data-agent", saved)
      .getBranch()
      .filter(
        (e) =>
          e.type === "custom_message" &&
          e.customType === "data_agent_delivery_rejected",
      ).length,
    1,
  );
  const finalLedger = h.sql(
    `SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`,
  )[0];
  assert.equal(finalLedger.calls, calls);
  assert.equal(finalLedger.reserved, 0);
  h.releaseRun(correctedRun.run_id);
  assert.equal(agentCalls, 12);
  await h.resumeWorker();
  const lengthCid = await h.create();
  const lengthRun = await h.capture(lengthCid, "请完整解释原问题");
  await h.pauseWorker();
  await deliver(
    lengthRun,
    h.env.DATA_AGENT_API_URL,
    h.env.DATA_AGENT_INTERNAL_TOKEN,
    "",
  );
  const lengthSnapshot = await h.snapshot(lengthCid);
  assert.equal(lengthSnapshot.tasks.length, 1);
  assert.equal(
    lengthSnapshot.messages.findLast(
      (m) => m.role === "assistant" && m.committed,
    ).text,
    "完整解释已经重写，保留原任务。",
  );
  const lengthCheckpoint = h.sql(
    `SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${lengthRun.recovery_chain_id}'`,
  )[0];
  const lengthBranch = restoreCheckpoint(
    "/synthetic/data-agent",
    lengthCheckpoint,
  ).getBranch();
  assert.equal(
    lengthBranch.filter(
      (e) =>
        e.type === "custom_message" &&
        e.customType === "data_agent_delivery_rejected",
    ).length,
    1,
  );
  assert.ok(lengthBranch.some((e) => e.message?.stopReason === "length"));
  h.releaseRun(lengthRun.run_id);
  assert.equal(agentCalls, 15);
  assert.equal(calls, agentCalls + summaryCalls);
  const completeLedger = h.sql(
    `SELECT JSON_OBJECT('calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`,
  )[0];
  assert.equal(completeLedger.calls, calls);
  assert.equal(completeLedger.reserved, 0);
  assert.ok(
    BigInt(completeLedger.spent) > 0n &&
      BigInt(completeLedger.spent) <= BigInt(profile.trial_cost_micros),
  );
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      calls,
      agentCalls,
      summaryCalls,
      summaryRequests,
      ledger: completeLedger,
      payloadBytes: bytes,
      tools: expectedTools.length,
      mode: "Pi OpenAI protocol via local provider",
      officialRequests: 0,
    }),
  );
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise((r) => provider.close(r));
  await writeFile(
    ".local/checks/mvp-data-provider.json",
    JSON.stringify(
      {
        passed,
        calls,
        agentCalls,
        summaryCalls,
        summaryRequests,
        payloadBytes: bytes,
        officialRequests: 0,
      },
      null,
      2,
    ),
  );
  if (h) await h.close();
}
