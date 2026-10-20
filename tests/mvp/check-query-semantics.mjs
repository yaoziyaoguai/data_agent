import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateContract } from "../../packages/contracts/validate.ts";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness } from "./harness.mjs";

// 直接构造口径决策核验宿主边界，不模拟模型能否发现或正确解释歧义。
const h = await harness({ capture: true, env: { DATA_AGENT_LEASE_MS: "120000" } });
const manager = SessionManager.inMemory("/synthetic/data-agent");
const checks = [];
let run, passed = false;
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const begin = async (cid, text) => {
  await h.resumeWorker();
  run = await h.capture(cid, text);
  await h.pauseWorker();
};
const invoke = async (name, args, error) => {
  const input = { run_id: run.run_id, lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args, checkpoint: checkpoint() };
  ok(await h.internal("/internal/data/tool-calls", input));
  const response = await h.internal("/internal/data/tools", input);
  if (!error) return { input, receipt: ok(response) };
  assert.notEqual(response.status, 200);
  assert.equal(response.value.code, error, JSON.stringify(response.value));
  const receipt = ok(await h.internal("/internal/data/tool-rejections", input));
  assert.equal(receipt.data.error, error);
  assert.equal(receipt.data.outcome, "rejected");
  assert.deepEqual(ok(await h.internal("/internal/data/tools", input)), receipt,
    "同一拒绝身份回放原回执，不能转为创建草稿");
  return { input, receipt };
};
const finish = async () => {
  const binding = { run_id: run.run_id, lease_epoch: run.lease_epoch };
  ok(await h.internal("/internal/outputs", { ...binding, chunk_seq: "1", text: "合成口径边界检查完成。" }));
  ok(await h.internal("/internal/finish", { ...binding, commit_id: run.output_id,
    final_text: "合成口径边界检查完成。", checkpoint: checkpoint() }));
  h.releaseRun(run.run_id);
};
const resolution = (basis, user_quote = null, unresolved_differences = []) => ({
  interpretation: "按合成样例中用户明确的金额口径生成草稿。",
  basis, user_quote, unresolved_differences,
});
try {
  const cid = await h.create();
  const userText = "按金额口径，给出合成完成金额。\n先不要执行。";
  await begin(cid, userText);
  const task = (await invoke("update_analysis_task", {
    action: "create", goal: "合成完成金额口径检查", options: [],
    conditions: { time_start: null, time_end: null, timezone: "UTC", metric: "synthetic_completed_amount",
      channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "任务写入不证明用户采纳任何新增解释。" },
  })).receipt.data;
  const input = { task_id: task.task_id, condition_version: task.condition_version,
    sql: "SELECT 18 AS completed_amount", parameters: {}, target_id: "synthetic-sqlite",
    summary: "合成金额检查，不执行", knowledge_refs: [], replaces_query_id: null };
  const readQueries = async () => ok(await h.request(`/conversations/${cid}/queries`)).queries;
  const readQuery = async id => ok(await h.request(`/queries/${id}`));

  validateContract("RequestQueryInput", input);
  const original = (await invoke("request_query", input)).receipt.data;
  assert.equal(original.confirmation_state, "awaiting_confirmation");
  assert.equal(original.execution_state, "not_submitted");
  checks.push("旧调用不带口径决策保持兼容，仅保存未执行草稿");

  const before = await readQueries();
  for (const decision of [
    resolution("needs_clarification"),
    resolution("unambiguous", null, ["按创建时间还是完成时间归属"]),
    resolution("explicit_user", "按金额口径", ["以哪种币种比较"]),
  ]) {
    const rejected = { ...input, sql: "SELECT 99 AS completed_amount", replaces_query_id: original.id,
      semantic_resolution: decision };
    validateContract("RequestQueryInput", rejected);
    const { receipt } = await invoke("request_query", rejected, "clarification_required");
    assert.match(receipt.data.hint, /澄清|问题|clarif/);
    assert.deepEqual(await readQueries(), before, "已声明未决时不能创建草稿或使原草稿失效");
  }
  assert.equal((await readQuery(original.id)).confirmation_state, "awaiting_confirmation");
  checks.push("未决状态及未决差异优先拒绝，即使另称明确采用；旧稿和查询数量不变，拒绝回放无副作用");

  const fabricated = { ...input, replaces_query_id: original.id,
    semantic_resolution: resolution("explicit_user", "我已选择按交易数计算") };
  validateContract("RequestQueryInput", fabricated);
  await invoke("request_query", fabricated, "invalid_evidence");
  assert.deepEqual(await readQueries(), before);
  checks.push("模型写入任务不能代替当前用户原话；伪造采用引用拒绝且不失效旧稿");

  await invoke("request_query", { ...input, replaces_query_id: original.id,
    semantic_resolution: resolution("explicit_user", "按金额口径") }, "invalid_evidence");
  assert.deepEqual(await readQueries(), before, "真实子串仍不能裁掉本条输入的限定");
  checks.push("采用引用须完整保留本轮用户原话，不能凭真实子串删除否定或其他限定");

  const explicit = { ...input, replaces_query_id: original.id,
    semantic_resolution: resolution("explicit_user", userText) };
  validateContract("RequestQueryInput", explicit);
  const adopted = (await invoke("request_query", explicit)).receipt.data;
  assert.notEqual(adopted.id, original.id);
  assert.equal(adopted.execution_state, "not_submitted");
  assert.equal((await readQuery(original.id)).confirmation_state, "superseded");
  checks.push("真实本轮引用允许保存并按既有规则替代旧稿，不增加执行权");

  const unambiguous = { ...input, sql: "SELECT 23 AS completed_amount",
    semantic_resolution: resolution("unambiguous") };
  validateContract("RequestQueryInput", unambiguous);
  const straightforward = (await invoke("request_query", unambiguous)).receipt.data;
  assert.equal(straightforward.execution_state, "not_submitted");
  assert.equal((await readQueries()).length, 3);
  const taskAfter = (await invoke("read_analysis_task", { task_id: task.task_id })).receipt.data;
  assert.equal(taskAfter.open_clarifications.length, 0);
  checks.push("声明无实质歧义的普通请求直接保存，不强制新增用户确认");
  await finish();

  await begin(cid, "继续解释金额计算，先不要执行。");
  await invoke("update_analysis_task", { action: "route", goal: "", task_id: task.task_id,
    expected_version: task.condition_version, options: [] });
  const currentBefore = await readQueries();
  await invoke("request_query", { ...explicit, replaces_query_id: adopted.id }, "invalid_evidence");
  assert.deepEqual(await readQueries(), currentBefore);
  checks.push("上一轮真实引用不能冒充本轮用户输入，复用原任务不绕过当前原话绑定");
  await finish();
  passed = true;
} finally {
  await mkdir(".local/checks", { recursive: true });
  await writeFile(".local/checks/query-semantics.json", JSON.stringify({ passed, checks,
    officialRequests: 0, platform: "isolated MySQL and synthetic SQLite", model: "controlled tool inputs",
    limitations: ["引用真实不证明语义充分；本检查不证明模型发现了全部歧义，也不证明无歧义声明正确。"] }, null, 2));
  await h.close();
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
}
