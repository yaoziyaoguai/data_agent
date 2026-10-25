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
const resolution = (basis, user_quote = null, unresolved_differences = [], adoption_message_id = null) => ({
  interpretation: "按合成样例中用户明确的金额口径生成草稿。",
  basis, user_quote, unresolved_differences, adoption_message_id,
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
    resolution("explicit_user", "按金额口径", ["以哪种币种比较"], run.message_id),
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
    semantic_resolution: resolution("explicit_user", "我已选择按交易数计算", [], run.message_id) };
  validateContract("RequestQueryInput", fabricated);
  await invoke("request_query", fabricated, "invalid_evidence");
  assert.deepEqual(await readQueries(), before);
  checks.push("模型写入任务不能代替当前用户原话；伪造采用引用拒绝且不失效旧稿");

  await invoke("request_query", { ...input, replaces_query_id: original.id,
    semantic_resolution: resolution("explicit_user", "按金额口径", [], run.message_id) }, "invalid_evidence");
  assert.deepEqual(await readQueries(), before, "真实子串仍不能裁掉本条输入的限定");
  checks.push("采用引用须完整保留本轮用户原话，不能凭真实子串删除否定或其他限定");

  // 采纳身份由宿主绑定本轮真实消息：原话正确但引用别的消息ID也不构成采纳。
  await invoke("request_query", { ...input, replaces_query_id: original.id,
    semantic_resolution: resolution("explicit_user", userText, [],
      "00000000-0000-0000-0000-000000000000") }, "invalid_evidence");
  assert.deepEqual(await readQueries(), before, "旧消息ID冒充采纳不创建草稿");
  checks.push("explicit_user采纳身份必须由宿主绑定本轮真实消息，模型自由填写消息ID拒绝");

  const explicit = { ...input, replaces_query_id: original.id,
    semantic_resolution: resolution("explicit_user", userText, [], run.message_id) };
  validateContract("RequestQueryInput", explicit);
  const adopted = (await invoke("request_query", explicit)).receipt.data;
  assert.notEqual(adopted.id, original.id);
  assert.equal(adopted.execution_state, "not_submitted");
  assert.equal((await readQuery(original.id)).confirmation_state, "superseded");
  assert.equal((await readQuery(original.id)).semantic_resolution, null,
    "旧草稿无口径决策保持null，不从模型历史猜回填");
  assert.equal((await readQuery(adopted.id)).semantic_resolution.adoption_message_id, run.message_id,
    "草稿持久化宿主核实的采纳身份");
  checks.push("真实本轮引用连同采纳消息身份一起保存并替代旧稿，不增加执行权");

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

  // 切片4残余：条件层口径决策记录与草稿一致性。
  const alignCid = await h.create();
  const adoptText = "按金额口径统计，先不要执行。";
  await begin(alignCid, adoptText);
  // create携带伪造采纳：完整条件与补丁同一绑定纪律，任务不得创建。
  await invoke("update_analysis_task", { action: "create", goal: "伪造采纳的条件创建", options: [],
    conditions: { time_start: null, time_end: null, timezone: "UTC", metric: "synthetic_completed_amount",
      channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "",
      semantic_resolution: resolution("explicit_user", "我已选择按交易数计算", [],
        "00000000-0000-0000-0000-000000000000") } }, "invalid_evidence");
  const alignTask = (await invoke("update_analysis_task", {
    action: "create", goal: "条件口径一致性检查", options: [],
    conditions: { time_start: null, time_end: null, timezone: "UTC", metric: "synthetic_completed_amount",
      channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "" } })).receipt.data;
  // 每次取当前条件版本：修订后旧版本会先撞version_conflict，测不到目标错误码。
  const alignQuery = async extra => ({ task_id: alignTask.task_id,
    condition_version: (await taskVersion()).condition_version,
    sql: "SELECT 18 AS completed_amount", parameters: {}, target_id: "synthetic-sqlite",
    summary: "条件一致性检查", knowledge_refs: [], replaces_query_id: null, ...extra });
  const taskVersion = async () =>
    (await invoke("read_analysis_task", { task_id: alignTask.task_id })).receipt.data;
  const alignQueries = async () => ok(await h.request(`/conversations/${alignCid}/queries`)).queries;

  // 未决状态如实记录进条件（此前路径直接拒绝）；同版草稿被阻断。
  await invoke("update_analysis_task", { action: "revise", task_id: alignTask.task_id,
    expected_version: alignTask.condition_version, goal: "",
    condition_patch: { set: { semantic_resolution: resolution("needs_clarification", null,
      ["按创建时间还是完成时间归属"]) }, unset: [] }, options: [] });
  let view = await taskVersion();
  assert.equal(view.conditions.semantic_resolution.basis, "needs_clarification", "未决决策记录进当前条件");
  await invoke("request_query", await alignQuery(), "clarification_required");
  await invoke("request_query", await alignQuery(
    { semantic_resolution: resolution("unambiguous") }), "clarification_required");
  assert.equal((await alignQueries()).length, 0, "条件声明未决时任何草稿都不创建");
  checks.push("needs_clarification如实记录进条件并按版本阻断草稿，包括另称明确的草稿");

  // 省略不能变unambiguous：后续修订不带semantic_resolution时未决状态随版本继承。
  await invoke("update_analysis_task", { action: "revise", task_id: alignTask.task_id,
    expected_version: view.condition_version, goal: "",
    condition_patch: { set: { time_start: "2026-09-01T00:00:00Z" }, unset: [] }, options: [] });
  view = await taskVersion();
  assert.equal(view.conditions.semantic_resolution.basis, "needs_clarification", "省略修订继承未决状态");
  await invoke("request_query", await alignQuery(), "clarification_required");
  checks.push("needs_clarification不能用省略变unambiguous：改区间等无关修订后仍未决");

  // 显式解除：改定新决策后省略的草稿继承该决策；不一致的草稿被拒。
  await invoke("update_analysis_task", { action: "revise", task_id: alignTask.task_id,
    expected_version: view.condition_version, goal: "",
    condition_patch: { set: { semantic_resolution: resolution("unambiguous") }, unset: [] },
    options: [] });
  view = await taskVersion();
  assert.equal(view.conditions.semantic_resolution.basis, "unambiguous");
  const inherited = (await invoke("request_query", await alignQuery())).receipt.data;
  assert.equal(inherited.semantic_resolution.basis, "unambiguous", "省略草稿继承条件声明决策");
  await invoke("request_query", await alignQuery(
    { semantic_resolution: resolution("explicit_user", adoptText, [], run.message_id) }),
    "invalid_input");
  assert.equal((await alignQueries()).length, 1, "与目标条件版本不一致的草稿不创建，先修订条件");
  checks.push("草稿决策与目标条件版本一致：省略继承声明决策、不一致硬拒不创建");

  // 本轮真实采纳写入条件；下一轮逐字复制原身份成立，改写或凭空旧ID不成立。
  await invoke("update_analysis_task", { action: "revise",
    task_id: alignTask.task_id, expected_version: view.condition_version, goal: "",
    condition_patch: { set: { semantic_resolution: resolution("explicit_user", adoptText, [],
      run.message_id) }, unset: [] }, options: [] });
  const adoptedMessage = run.message_id;
  const adoptedBody = (await taskVersion()).conditions.semantic_resolution;
  assert.equal(adoptedBody.adoption_message_id, adoptedMessage, "本轮真实采纳写入条件");
  await finish();

  await begin(alignCid, "继续按原口径，先不要执行。");
  await invoke("update_analysis_task", { action: "revise", task_id: alignTask.task_id,
    expected_version: (await taskVersion()).condition_version, goal: "",
    condition_patch: { set: { time_end: "2026-10-01T00:00:00Z",
      semantic_resolution: adoptedBody }, unset: [] }, options: [] });
  assert.equal((await taskVersion()).conditions.semantic_resolution.adoption_message_id,
    adoptedMessage, "逐字复制原采纳身份成立");
  await invoke("update_analysis_task", { action: "revise", task_id: alignTask.task_id,
    expected_version: (await taskVersion()).condition_version, goal: "",
    condition_patch: { set: { semantic_resolution:
      { ...adoptedBody, interpretation: "模型自拟的另一种解释" } }, unset: [] }, options: [] },
    "invalid_evidence");
  // 草稿在已决版本上省略继承：携带原采纳身份持久化。
  const carried = (await invoke("request_query", await alignQuery(
    { sql: "SELECT 19 AS completed_amount", summary: "继承原采纳身份" }))).receipt.data;
  assert.equal(carried.semantic_resolution.adoption_message_id, adoptedMessage,
    "草稿省略决策时继承条件里已验证的原采纳身份");
  checks.push("采纳身份复制继承：逐字复制成立、改写或旧ID另裁拒绝，草稿继承原身份");
  // 采纳身份宿主绑定（缺陷修复回执）：模型省略adoption_message_id时由宿主在
  // 持久化前回填本轮真实身份——模型不需要也不应该知道消息ID。
  const currentVersion = (await taskVersion()).condition_version;
  await invoke("update_analysis_task", { action: "revise", task_id: alignTask.task_id,
    expected_version: currentVersion, goal: "",
    condition_patch: { set: { semantic_resolution:
      resolution("explicit_user", "继续按原口径，先不要执行。", [], null) }, unset: [] },
    options: [] });
  assert.equal((await taskVersion()).conditions.semantic_resolution.adoption_message_id,
    run.message_id, "条件层省略采纳身份由宿主回填本轮消息");
  const boundDraft = (await invoke("request_query", await alignQuery(
    { sql: "SELECT 20 AS completed_amount", summary: "省略采纳身份的草稿",
      semantic_resolution: resolution("explicit_user", "继续按原口径，先不要执行。", [],
        null) }))).receipt.data;
  assert.equal(boundDraft.semantic_resolution.adoption_message_id, run.message_id,
    "草稿层省略采纳身份由宿主回填本轮消息");
  checks.push("adoption_message_id宿主绑定：模型省略时条件与草稿均回填本轮真实消息身份");
  // 对抗审查修复回执：等同create（task_id缺省）携带condition_patch时按完整条件核对，
  // 不能经补丁分支漏掉conditions里的采纳声明。
  await invoke("update_analysis_task", { action: "revise", task_id: null, expected_version: null,
    goal: "洗白采纳的目标", options: [],
    conditions: { time_start: null, time_end: null, timezone: "UTC",
      metric: "synthetic_completed_amount", channel: null, group_by: [], filters: [],
      knowledge_refs: [], notes: "", semantic_resolution: adoptedBody },
    condition_patch: { set: { notes: "x" }, unset: [] } }, "invalid_evidence");
  // split复制原任务已采纳决策：携带值与原任务当前声明逐字一致即成立。
  const current = await taskVersion();
  const splitTask = (await invoke("update_analysis_task", { action: "split",
    task_id: alignTask.task_id, expected_version: current.condition_version,
    goal: "拆分出的独立目标", conditions: current.conditions,
    moved_clarification_ids: [], options: [] })).receipt.data;
  const splitView = (await invoke("read_analysis_task", { task_id: splitTask.task_id })).receipt.data;
  assert.equal(splitView.conditions.semantic_resolution.adoption_message_id,
    (await taskVersion()).conditions.semantic_resolution.adoption_message_id,
    "split复制原任务当前已验证采纳身份成立");
  checks.push("等同create按完整条件核对采纳；split复制原任务已采纳决策成立");
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
