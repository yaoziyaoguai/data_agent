import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { RustTransport } from "../../apps/agent/transport/client.ts";
import {
  exportCheckpoint,
  restoreCheckpoint,
} from "../../apps/agent/session/checkpoint.ts";
const originalPost = RustTransport.prototype.post;
const authority = { knowledge: [], memories: [], skills: [] };
const conditions = {
  time_start: "2026-01-01T00:00:00Z",
  time_end: "2026-02-01T00:00:00Z",
  timezone: "UTC",
  metric: "net_revenue",
  channel: null,
  group_by: [],
  filters: ["is_test=0"],
  knowledge_refs: [],
  notes: "",
};
const envelope = (text, checkpoint, tasks = [], resume = false) => ({
  text,
  checkpoint,
  attempt_id: randomUUID(),
  budget_scope_id: randomUUID(),
  conversation_id: "session-test",
  lease_epoch: "2",
  message_id: randomUUID(),
  model_profile: null,
  output_id: randomUUID(),
  recovery_chain_id: randomUUID(),
  request_id: randomUUID(),
  run_id: randomUUID(),
  resume_same_input: resume,
  workspace_context: {
    tasks,
    memories: [],
    selected_skills: [],
    recent_messages: [],
    query_observations: [],
    authority_revision: "a",
    authority_snapshot: authority,
  },
});
const objects = ["net_revenue", "paying_customers"].map((m) => ({
  id: "metric-" + m,
  version: "1",
  entries: [
    {
      path: "sql",
      effective_value:
        "SELECT " +
        (m === "net_revenue"
          ? "SUM(paid_amount_cents-refunded_amount_cents)"
          : "COUNT(DISTINCT customer_id)") +
        " AS " +
        m +
        "\nFROM demo_order_detail",
    },
  ],
}));
let passed = false;
const checks = [];
try {
  const manager = SessionManager.inMemory("/synthetic/data-agent");
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (content) => ({
    role: "assistant",
    api: "openai-completions",
    provider: "local_mock",
    model: "task_demo",
    content,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "user",
    content: "查2026年1月净收入",
    timestamp: Date.now(),
  });
  manager.appendMessage(
    assistant([
      {
        type: "toolCall",
        id: "search-call",
        name: "search_knowledge",
        arguments: { query: "净收入" },
      },
    ]),
  );
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "search-call",
    toolName: "search_knowledge",
    content: [
      {
        type: "text",
        text: JSON.stringify({ objects, personal_memories: [] }),
      },
    ],
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendMessage(
    assistant([
      {
        type: "toolCall",
        id: "original-update-call",
        name: "update_analysis_task",
        arguments: {
          action: "create",
          task_id: null,
          expected_version: null,
          goal: "查2026年1月净收入",
          conditions,
          question: null,
          options: [],
        },
      },
    ]),
  );
  const tools = [];
  let final;
  RustTransport.prototype.post = async function (path, _name, input) {
    if (path === "/internal/data/tools") {
      tools.push(input);
      const data =
        input.tool_name === "update_analysis_task"
          ? {
              task_id: "original-task",
              condition_version: "1",
              question: null,
              options: [],
            }
          : { id: "query", draft_version: "1", check_state: "passed" };
      return {
        operation_id: "original-operation",
        tool_name: input.tool_name,
        data,
      };
    }
    if (path === "/internal/finish") final = input;
    return {};
  };
  await deliver(
    envelope(
      "查2026年1月净收入",
      exportCheckpoint(manager, "a", authority),
      [],
      true,
    ),
    "http://127.0.0.1",
    "synthetic",
    "",
  );
  assert.deepEqual(
    tools.map((t) => t.tool_name),
    ["update_analysis_task", "request_query"],
  );
  assert.equal(tools[0].sdk_tool_call_id, "original-update-call");
  assert.equal(tools[1].arguments.task_id, "original-task");
  assert.equal(tools[1].arguments.condition_version, "1");
  assert.match(final.final_text, /SQL/);
  checks.push({
    name: "半轮恢复接回同SDK调用、工具data格式一致并继续原任务SQL",
    passed: true,
  });
  let checkpoint = null;
  const tasks = [];
  const calls = [];
  const drafts = [];
  RustTransport.prototype.post = async function (path, _name, input) {
    if (path.startsWith("/internal/model/"))
      calls.push({ path, id: input.call_attempt_id });
    if (path === "/internal/finish") {
      checkpoint = input.checkpoint;
      return { state: "finished", output_id: this.run.output_id };
    }
    if (path !== "/internal/data/tools") return {};
    const args = input.arguments;
    let data = {};
    if (input.tool_name === "search_knowledge")
      data = {
        objects,
        personal_memories: [],
        synthetic_document: "合成说明。".repeat(6000),
      };
    if (input.tool_name === "update_analysis_task") {
      const task = {
        id: randomUUID(),
        goal: args.goal,
        lifecycle: "active",
        phase: "waiting_confirmation",
        condition_version: "1",
        conditions: args.conditions,
      };
      tasks.push(task);
      data = {
        task_id: task.id,
        condition_version: "1",
        question: null,
        options: [],
      };
    }
    if (input.tool_name === "request_query") {
      drafts.push(args);
      data = {
        id: randomUUID(),
        task_id: args.task_id,
        condition_version: "1",
        draft_version: "1",
        check_state: "passed",
      };
    }
    return { operation_id: randomUUID(), tool_name: input.tool_name, data };
  };
  let sessionId;
  for (let i = 0; i < 3; i++) {
    if (i === 1) process.env.DATA_AGENT_TEST_COMPACT = "1";
    else delete process.env.DATA_AGENT_TEST_COMPACT;
    await deliver(
      envelope(
        ["查2026年1月净收入", "查2026年1月支付客户数", "查2026年2月净收入"][i],
        checkpoint,
        structuredClone(tasks),
      ),
      "http://127.0.0.1",
      "synthetic",
      "",
    );
    const restored=restoreCheckpoint("/synthetic/data-agent",checkpoint);
    sessionId ??= restored.getHeader().id;
    assert.equal(restored.getHeader().id, sessionId);
    if (i > 0)
      assert.ok(restored.getBranch().some((e) => e.type === "compaction"));
    assert.ok(
      restoreCheckpoint(
        "/synthetic/data-agent",
        checkpoint,
      ).buildSessionContext().messages.length > 0,
    );
  }
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 3);
  assert.equal(drafts[2].parameters.start, "2026-02-01T00:00:00Z");
  assert.equal(drafts[2].parameters.end, "2026-03-01T00:00:00Z");
  const issued = calls.filter((c) => c.path.endsWith("/issue"));
  const settled = calls.filter((c) => c.path.endsWith("/settle"));
  assert.ok(issued.length > 12);
  assert.deepEqual(
    issued.map((c) => c.id).sort(),
    settled.map((c) => c.id).sort(),
  );
  checks.push({
    name: "同Pi会话三轮续接、SDK原生压缩持久保留、摘要调用也领取并结算许可",
    passed: true,
  });
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      checks,
      mode: "Pi SDK with local fake host",
      officialRequests: 0,
    }),
  );
} finally {
  RustTransport.prototype.post = originalPost;
  delete process.env.DATA_AGENT_TEST_COMPACT;
  await mkdir(".local/checks", { recursive: true });
  await writeFile(
    ".local/checks/mvp-session.json",
    JSON.stringify({ passed, checks }, null, 2),
  );
}
