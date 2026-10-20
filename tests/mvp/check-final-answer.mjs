import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { mergeSnapshot } from "../../apps/web/src/features/workbench/conversation-timeline.ts";
import { harness } from "./harness.mjs";

// 固定协议模型只检验消息/工具/提交链；不模拟模型理解提示，也不证明真实遵循率。
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: "final_" + randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 65536,
  output_limit: 2048,
  trial_call_limit: 24,
  trial_cost_micros: "300000",
  request_call_limit: 24,
  toolset: "data",
  payload_bytes_limit: 131072,
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [],
  checks = [],
  limitations = [];
page.on("pageerror", (error) => errors.push(error.message));
let steps = [],
  index = 0,
  calls = 0,
  run,
  task,
  document,
  failure,
  passed = false;
const conclusion =
  "合成案例净额为123.45元（12345分），来自维护者给定的示例金额；这不是实际查询结果。";
const finalAnswer = conclusion + "分析依据已保存。";
const provisional = "未核对的暂定净额为99999元。";
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const lastTool = (body) => {
  const message = body.messages.findLast((value) => value.role === "tool");
  assert.ok(message);
  return JSON.parse(message.content);
};
const tool = (name, args, text = "", inspect) => ({
  name,
  args,
  text,
  inspect,
});
const reply = (text, inspect) => ({ text, inspect });
const provider = createServer(async (request, response) => {
  try {
    assert.equal(
      request.headers.authorization,
      "Bearer synthetic-protocol-key",
    );
    let raw = "";
    for await (const part of request) raw += part;
    assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
    const body = JSON.parse(raw);
    const system = body.messages.find(
      (message) => message.role === "system",
    ).content;
    assert.ok(system.length > 0);
    assert.ok(index < steps.length, "不能通过计划外请求伪造成功");
    const step = steps[index++];
    if (step.inspect) step.inspect(body);
    const args = typeof step.args === "function" ? step.args(body) : step.args;
    const delta = { role: "assistant", content: step.text };
    if (step.name)
      delta.tool_calls = [
        {
          index: 0,
          id: randomUUID(),
          type: "function",
          function: { name: step.name, arguments: JSON.stringify(args) },
        },
      ];
    calls++;
    const chunk = (delta, finish_reason = null) => ({
      id: "synthetic-final-answer",
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
          id: "synthetic-final-answer",
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
    failure = error;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "synthetic_protocol_assertion_failed" },
      }),
    );
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const savedEnvironment = Object.fromEntries(
  ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DATA_AGENT_PROVIDER_TEST"].map(
    (key) => [key, process.env[key]],
  ),
);
const h = await harness({
  capture: true,
  web: true,
  profile,
  protocolProviderUrl: "http://127.0.0.1:" + provider.address().port,
  env: { DATA_AGENT_LEASE_MS: "120000" },
});
process.env.DEEPSEEK_API_KEY = "synthetic-protocol-key";
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:" + provider.address().port;
process.env.DATA_AGENT_PROVIDER_TEST = "1";

const round = async (cid, text, planned) => {
  await h.resumeWorker();
  run = await h.capture(cid, text);
  await h.pauseWorker();
  steps = planned;
  index = 0;
  failure = null;
  try {
    await deliver(
      run,
      h.env.DATA_AGENT_API_URL,
      h.env.DATA_AGENT_INTERNAL_TOKEN,
      "",
    );
  } catch (error) {
    throw failure ?? error;
  }
  assert.equal(index, steps.length);
  h.releaseRun(run.run_id);
  const snapshot = await h.snapshot(cid);
  assert.equal(
    snapshot.runs.find((item) => item.run_id === run.run_id).state,
    "finished",
  );
  const persisted = h.sql(
    `SELECT JSON_OBJECT('text',final_text) FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`,
  )[0].text;
  assert.equal(persisted, planned.at(-1).text);
  assert.equal(
    snapshot.messages.findLast(
      (message) => message.role === "assistant" && message.committed,
    ).text,
    persisted,
  );
  assert.equal(mergeSnapshot(null, snapshot).messages.at(-1).text, persisted);
  return snapshot;
};
const route = () =>
  tool("update_analysis_task", () => ({
    action: "route",
    task_id: task.task_id,
    expected_version: task.condition_version,
    goal: "",
    options: [],
  }));
const investigate = (finalText) => [
  tool("update_analysis_task", {
    action: "create",
    goal: "解释合成案例金额并保存依据",
    options: [],
    conditions: {
      time_start: null,
      time_end: null,
      timezone: "UTC",
      metric: "synthetic_amount",
      channel: null,
      group_by: [],
      filters: [],
      knowledge_refs: [],
      notes: "只解释合成示例，不执行SQL。",
    },
  }),
  tool(
    "read_knowledge",
    (body) => {
      task = lastTool(body);
      assert.ok(task.task_id);
      return {
        object_id: document.id,
        version: document.version,
        entry_id: "body",
        offset: 0,
        limit: 4000,
      };
    },
    provisional,
  ),
  tool(
    "save_analysis_evidence",
    (body) => {
      const source = lastTool(body);
      assert.equal(source.id, document.id);
      assert.match(source.entries[0].effective_value, /12345/);
      return {
        task_id: task.task_id,
        condition_version: task.condition_version,
        data_range: "仅维护者给定的合成案例。",
        findings: [
          {
            text: conclusion,
            calculation: "示例已给出分与元的对应数值，未执行查询。",
            limitations: ["不是实际查询结果"],
            query_refs: [],
            figures: [],
            knowledge_refs: [
              {
                object_id: document.id,
                version: document.version,
                path: "body",
              },
            ],
          },
        ],
      };
    },
    conclusion,
  ),
  reply(finalText, (body) => {
    assert.ok(lastTool(body).evidence_id);
    assert.equal(lastTool(body).task_id, task.task_id);
  }),
];

try {
  document = ok(
    await h.request("/knowledge", {
      operation_id: randomUUID(),
      kind: "document",
      name: "完全虚构的金额说明",
      body: "此合成案例给定的净额是12345分，对应123.45元。没有实际查询，不能当成真实业务统计。",
      related_ids: [],
      source_url: null,
    }),
  );

  // 明确保留反例：若模型无视提示，仅以短确认结束，宿主不能自行推断和拼接旧结论。
  const incomplete = await round(
    await h.create(),
    "解释合成案例金额并保存",
    investigate("已保存。"),
  );
  assert.ok(
    incomplete.events.some(
      (event) =>
        event.type === "assistant_delta" &&
        event.payload.text.includes(conclusion),
    ),
  );
  assert.equal(
    incomplete.messages.findLast((message) => message.role === "assistant")
      .text,
    "已保存。",
  );
  limitations.push(
    "已复现短末条覆盖前文；提示不具备强制语义完整性，当前仍不能保证不遵循规则的模型输出。",
  );

  const cid = await h.create();
  const complete = await round(
    cid,
    "解释合成案例金额并保存依据",
    investigate(finalAnswer),
  );
  assert.ok(
    complete.events.some(
      (event) =>
        event.type === "assistant_delta" &&
        event.payload.text.includes(provisional),
    ),
  );
  const formal = complete.messages.findLast(
    (message) => message.role === "assistant",
  ).text;
  assert.equal(formal, finalAnswer);
  assert.ok(!formal.includes(provisional));
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence WHERE conversation_id='${cid}'`,
    )[0].n,
    1,
  );
  checks.push(
    "真实Pi工具读取并保存依据，正式文本含结论/数字/范围/保存状态，已被资料推翻的过程文字不拼入",
  );

  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await page.evaluate(
    (id) =>
      localStorage.setItem('data-agent.conversation.["demo","alice"]', id),
    cid,
  );
  await page.reload();
  const assistant = page.locator(".message.assistant");
  await assistant.filter({ hasText: finalAnswer }).waitFor();
  assert.equal(await assistant.filter({ hasText: provisional }).count(), 0);
  await page.reload();
  await assistant.filter({ hasText: finalAnswer }).waitFor();
  assert.equal(await assistant.filter({ hasText: finalAnswer }).count(), 1);
  checks.push(
    "正式工作台连续刷新后完整回答和123.45元仍在，过程文字不冒充正式结论",
  );

  const firstSession = h.sql(
    `SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`,
  )[0].storage.session_id;
  await round(cid, "再确认一下示例金额", [
    route(),
    reply(conclusion, (body) => {
      assert.ok(
        body.messages.some(
          (message) =>
            message.role === "assistant" && message.content === finalAnswer,
        ),
        "原生会话须恢复完整末条回答",
      );
    }),
  ]);
  assert.equal(run.checkpoint.storage.session_id, firstSession);
  checks.push("下一轮沿原Pi会话恢复完整最终答案，不另建会话或重做保存");

  await round(cid, "只确认刚才是否保存成功", [route(), reply("已保存。")]);
  checks.push("纯保存状态确认仍允许短答，不强制复述分析正文");
  assert.deepEqual(errors, []);
  assert.equal(calls, 12);
  passed = true;
  console.log(
    JSON.stringify({ passed, checks, limitations, calls, officialRequests: 0 }),
  );
} finally {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (run) h.releaseRun(run.run_id);
  await browser.close();
  await new Promise((resolve) => provider.close(resolve));
  await writeFile(
    ".local/checks/final-answer.json",
    JSON.stringify(
      { passed, checks, limitations, errors, calls, officialRequests: 0 },
      null,
      2,
    ),
  );
  await h.close();
}
