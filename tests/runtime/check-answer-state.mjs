import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dataTools } from "../../apps/agent/tools/data-tools.ts";

// 调用正式工具封装，仅替换Rust传输边界；失败后旧答案不能继续充当本轮交付。
const checks = [];
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("network forbidden in answer state check");
};
const input = {
  template: "净收入{{amount}}分。",
  sources: [{ query_id: "query", result_ref: "result", columns: ["amount"] }],
  values: [{ name: "amount", kind: "cell", query_id: "query", column: "amount", row_index: 0 }],
};
function fixture() {
  let mode = "success";
  let text = "净收入41分。";
  const transport = {
    run: { run_id: "run", lease_epoch: "1" },
    binding: () => ({ run_id: "run", lease_epoch: "1" }),
    async post(path, _schema, invocation) {
      const operation = "operation-" + invocation.sdk_tool_call_id;
      if (path === "/internal/data/tool-calls") return { operation_id: operation };
      if (mode === "transport_failure") throw new Error("unavailable");
      assert.equal(path, "/internal/data/tools");
      let data;
      if (mode === "result_expired") {
        data = { error: "result_expired", outcome: "rejected" };
      } else if (mode === "result_available") {
        data = {
          query: { id: invocation.arguments.query_id, execution_state: "succeeded" },
          results: { query_id: invocation.arguments.query_id, result_ref: "result", columns: [{ name: "amount", type: "integer", encoding: "decimal_string" }], rows: [["41"]] },
        };
      } else if (mode === "rejection") {
        data = { error: "invalid_evidence", outcome: "rejected" };
      } else if (invocation.tool_name === "present_analysis_answer") {
        data = { answer_text: text, sources: [], result_dependencies: [] };
      } else {
        data = { query: { id: "query", execution_state: "succeeded" }, results: null };
      }
      return { operation_id: operation, tool_name: invocation.tool_name, data };
    },
  };
  const state = dataTools(transport, SessionManager.inMemory("/synthetic/answer-state"), "");
  const execute = (name, sdk, args) => state.tools.find(tool => tool.name === name).execute(sdk, args);
  const prepare = async (sdk = "answer") => {
    mode = "success";
    await execute("present_analysis_answer", sdk, input);
    assert.deepEqual(state.answer(), { text, sdkId: sdk });
  };
  return { state, execute, prepare, setMode: value => { mode = value; }, setText: value => { text = value; } };
}
async function check(name, test) {
  const entry = { name, passed: false };
  try { await test(); entry.passed = true; }
  catch (error) { entry.error = error.message; }
  checks.push(entry);
}

try {
  await check("成功答案后其他工具明确失败，不能继续提交旧答案", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("rejection");
    await assert.rejects(() => f.execute("get_query", "rejected-read", { query_id: "query" }), /invalid_evidence/);
    assert.equal(f.state.answer(), undefined);
  });
  await check("第二次答案生成失败清除旧答案，重新成功后只保留新回执", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("rejection");
    await assert.rejects(() => f.execute("present_analysis_answer", "rejected-answer", input), /invalid_evidence/);
    assert.equal(f.state.answer(), undefined);
    f.setText("净收入43分。");
    await f.prepare("repaired-answer");
    assert.deepEqual(f.state.answer(), { text: "净收入43分。", sdkId: "repaired-answer" });
  });
  await check("传输未知或调用参数在发送前失败，也不能沿用前一次成功答案", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("transport_failure");
    await assert.rejects(() => f.execute("get_query", "unavailable-read", { query_id: "query" }), /unavailable/);
    assert.equal(f.state.answer(), undefined);
    await f.prepare("fresh-answer");
    await assert.rejects(() => f.execute("get_query", "invalid-read", {}));
    assert.equal(f.state.answer(), undefined);
  });
  await check("检查点接回调用的拒绝回执与正常execute保持相同答案失效语义", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("rejection");
    const receipt = await f.state.invokeRecorded("present_analysis_answer", "recovered-rejection", input);
    assert.equal(receipt.data.error, "invalid_evidence");
    assert.equal(f.state.answer(), undefined);
  });
  await check("旧查询过期只影响自身，未定位来源的答案失败不能豁免当前查询来源", async () => {
    const f = fixture();
    f.setMode("result_expired");
    await assert.rejects(() => f.execute("get_query", "old-expired", { query_id: "old-query" }), /result_expired/);
    assert.equal(f.state.resultUnavailable("old-query"), true);
    assert.equal(f.state.resultUnavailable("current-query"), false);
    const multipleSources = {
      template: "核对两项已有结果。",
      sources: ["old-query", "current-query"].map(query_id => ({ query_id, result_ref: "result", columns: ["amount"] })),
      values: [],
    };
    await assert.rejects(() => f.execute("present_analysis_answer", "unlocated-expiry", multipleSources), /result_expired/);
    assert.equal(f.state.resultUnavailable("old-query"), true);
    assert.equal(f.state.resultUnavailable("current-query"), false, "答案工具未指出哪份来源过期，不能把每个来源标为不可读");
  });
  await check("同一查询重新取得结果后清除不可读状态，仅取得状态时不假称恢复", async () => {
    const f = fixture();
    f.setMode("result_expired");
    await assert.rejects(() => f.execute("get_query", "expired-result", { query_id: "query" }), /result_expired/);
    assert.equal(f.state.resultUnavailable("query"), true);
    f.setMode("success");
    await f.execute("get_query", "status-only", { query_id: "query" });
    assert.equal(f.state.resultUnavailable("query"), true);
    f.setMode("result_available");
    await f.execute("get_query", "result-restored", { query_id: "query" });
    assert.equal(f.state.resultUnavailable("query"), false, "已有有效结果必须重新要求来源答案，不能沿用旧不可读状态绕过交付");
  });
} finally {
  globalThis.fetch = originalFetch;
}
const passed = checks.every(check => check.passed) && networkAttempts === 0;
const report = { passed, checks, networkAttempts, officialRequests: 0, boundary: "real dataTools execute/invokeRecorded; controlled Rust transport" };
await mkdir(".local/checks/agent-reliability-repairs", { recursive: true });
await writeFile(".local/checks/agent-reliability-repairs/answer-state.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.ok(passed, "答案失效状态检查未全部通过");
