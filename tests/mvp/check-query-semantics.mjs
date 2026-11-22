import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateContract } from "../../packages/contracts/validate.ts";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness } from "./harness.mjs";

// 直接构造口径决策核验宿主边界，不模拟模型能否发现或正确解释歧义。
const decisionState = process.argv.includes("--decision-state");
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
  if (decisionState) { h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id='${run.run_id}'`); run.tool_contract_version=2; }
};
const invoke = async (name, args, error) => {
  const input = { run_id: run.run_id, lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args, checkpoint: checkpoint(),
    ...(['search_knowledge','read_knowledge','read_source'].includes(name) ? {response_budget:{max_bytes:16384,estimated_tokens:8192,projection_fingerprint:'0'.repeat(64)}} : {}) };
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
  if (!decisionState) {
  const cid = await h.create();
  const userText = "按金额口径，给出合成完成金额。\n先不要执行。";
  await begin(cid, userText);
  const task = (await invoke("update_analysis_task", {
    action: "create", goal: "合成完成金额口径检查", options: [],
    conditions: { time_start: null, time_end: null, timezone: "UTC", metric: "synthetic_completed_amount",
      channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "任务写入不证明用户采纳任何新增解释。" },
  })).receipt.data;
  // 默认分支保留旧草稿决定合同的合法样本；新任务合同由--decision-state验证。
  h.sql(`UPDATE condition_revisions SET decision_state_version=1 WHERE task_id='${task.task_id}' AND version=1`);
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

  // 语义决策的依据同样来自模型参数，不能先污染authority再让下一次请求失败。
  const referenceDoc = ok(await h.request('/knowledge', {operation_id:randomUUID(),kind:'document',name:'合成引用核对',body:'合成金额只用于边界核对。',related_ids:[]}));
  const realReference={object_id:referenceDoc.id,version:referenceDoc.version,path:'body'};
  const referenceRead = (await invoke('read_knowledge',{items:[{kind:'knowledge',ref:realReference}]})).receipt.data;
  assert.equal(referenceRead.items[0].state,'ok');
  const invalidReference={...realReference,object_id:referenceDoc.id+'-missing'};
  const queriesBeforeInvalid=await readQueries();
  const authorityBeforeInvalid=h.sql(`SELECT JSON_OBJECT('knowledge',JSON_EXTRACT(authority_snapshot,'$.knowledge')) FROM agent_runs WHERE id='${run.run_id}'`)[0];
  await invoke('request_query',{...input,sql:'SELECT 24 AS completed_amount',knowledge_refs:[realReference],semantic_resolution:{...resolution('unambiguous'),evidence_refs:[invalidReference]}},'not_available');
  assert.deepEqual(await readQueries(),queriesBeforeInvalid,'错误语义依据不得保存新稿或改变既有稿');
  assert.deepEqual(h.sql(`SELECT JSON_OBJECT('knowledge',JSON_EXTRACT(authority_snapshot,'$.knowledge')) FROM agent_runs WHERE id='${run.run_id}'`)[0],authorityBeforeInvalid,'被拒引用不得进入当前运行的持久知识authority');
  const validReferenceDraft=(await invoke('request_query',{...input,sql:'SELECT 24 AS completed_amount',knowledge_refs:[realReference],semantic_resolution:{...resolution('unambiguous'),evidence_refs:[realReference]}})).receipt.data;
  assert.equal(validReferenceDraft.execution_state,'not_submitted','纠正引用后同一原请求仍可继续保存，不执行');
  checks.push('语义决策依据不存在时在保存与authority合并前拒绝，旧稿/authority不变，纠正后同请求可继续');
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
  const oldPending = resolution("needs_clarification", null, ["按创建时间还是完成时间归属"]);
  h.sql(`UPDATE condition_revisions SET decision_state_version=1,body=JSON_SET(body,'$.semantic_resolution',CAST(CONVERT(0x${Buffer.from(JSON.stringify(oldPending)).toString("hex")} USING utf8mb4) AS JSON)) WHERE task_id='${alignTask.task_id}' AND version=1`);
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

  // 旧字符串不能被覆盖假清；明确链接问题并在同次修订转换，后续仍核草稿一致性。
  const identified = (await invoke("update_analysis_task", { action: "clarify", task_id: alignTask.task_id,
    expected_version: view.condition_version, condition_patch: { set: {}, unset: [] },
    clarifications: [{ question: "按创建时间还是完成时间归属", options: ["创建时间", "完成时间"] }], options: [] })).receipt.data;
  const pendingId = identified.opened_clarifications[0].id;
  await invoke("update_analysis_task", { action: "revise", task_id: alignTask.task_id,
    expected_version: identified.condition_version, goal: "",
    condition_patch: { set: { semantic_resolution: resolution("unambiguous") }, unset: [] },
    resolved_clarification_ids: [pendingId],
    legacy_resolution_migration: { from_condition_version: identified.condition_version, links: [{ pending_index: 0, clarification_id: pendingId }] },
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
  } else {
    const cid = await h.create();
    const conditions = { time_start: null, time_end: null, timezone: "UTC", metric: null,
      channel: null, group_by: ["channel"], filters: [], knowledge_refs: [], notes: "", source_limits: null };
    const readTask = async (task, version) => (await invoke("read_analysis_task", { task_id: task.task_id, ...(version ? { condition_version: version } : {}) })).receipt.data;
    await begin(cid, "分别核对合成指标与分组选择，先不要执行。");
    const plain = (await invoke("update_analysis_task", { action: "create", goal: "合成无歧义草稿", conditions, options: [] })).receipt.data;
    const plainDraft = (await invoke("request_query", { task_id: plain.task_id, condition_version: plain.condition_version,
      sql: "SELECT 18 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成普通草稿", knowledge_refs: [], replaces_query_id: null })).receipt.data;
    assert.equal(plainDraft.execution_state, "not_submitted", "无歧义新任务无需额外采纳槽或工具回合");
    assert.equal((await readTask(plain)).decision_state_version, 2, "新条件的格式由宿主保存");
    // 资料调查只依赖当前任务/版本和来源权限，不能要求用户先回答可查证的事实。
    const research = (await invoke("update_analysis_task", {action:"create",goal:"核对合成指标的适用事实",conditions,options:[],
      clarifications:[{question:"该指标有哪些适用条件需要核对？",options:["按当前资料核对","仍需用户选择"]}]})).receipt.data;
    const researchRef = {task_id:research.task_id,condition_version:research.condition_version};
    const beforeResearch = await readTask(research);
    assert.equal(beforeResearch.phase,"waiting_clarification");
    const found = await invoke("search_knowledge",{query:"净收入",limit:5,task_ref:researchRef});
    assert.ok(found.receipt.data.hits.length>0,"开放问题期间仍可调查当前获准资料");
    assert.equal(found.receipt.source_context_ready,true);
    const replayedRead = ok(await h.internal("/internal/data/tools",found.input));
    assert.equal(replayedRead.operation_id,found.receipt.operation_id,"读取恢复沿原身份");
    assert.deepEqual(replayedRead.data,found.receipt.data,"未改变来源和版本时重放原读取结果");
    const metric = ok(await h.request("/knowledge/metric-net_revenue"));
    const knowledge = await invoke("read_knowledge", {task_ref:researchRef, items:[{kind:"knowledge",
      ref:{object_id:metric.id,version:metric.version,path:"definition"},limit:4096}]});
    validateContract("KnowledgeReadReply", knowledge.receipt.data);
    assert.equal(knowledge.receipt.data.items[0].state,"ok");
    assert.ok(knowledge.receipt.data.items[0].content.includes("退款按原付款期间归属"),
      "开放问题期间可补读已获准指标的实际口径");
    const schema = await readFile(new URL("../../docs/sources/schema.sql",import.meta.url),"utf8");
    const source = await invoke("read_source", {task_ref:researchRef,citation:{
      source:{kind:"platform",id:"schema"},revision:"1",locator:{offset:0,length:64}}});
    validateContract("SourceReadReply", source.receipt.data);
    assert.equal(source.receipt.data.text,[...schema].slice(0,64).join(""),
      "开放问题期间可回源读取原合成资料片段");
    const afterResearch = await readTask(research);
    assert.equal(afterResearch.phase,"waiting_clarification","读取不自动替用户关闭问题");
    assert.equal(afterResearch.condition_version,research.condition_version);
    assert.deepEqual(afterResearch.open_clarifications,beforeResearch.open_clarifications);
    await invoke("request_query",{task_id:research.task_id,condition_version:research.condition_version,
      sql:"SELECT 1 AS value",parameters:{},target_id:"synthetic-sqlite",summary:"未解问题不得新建SQL",knowledge_refs:[],replaces_query_id:null},"waiting_clarification");
    await invoke("search_knowledge",{query:"净收入",limit:5,task_ref:{...researchRef,condition_version:String(Number(research.condition_version)+1)}},"version_conflict");
    await invoke("search_knowledge",{query:"净收入",limit:5,task_ref:{task_id:plain.task_id,condition_version:plain.condition_version}},"task_context_required");
    assert.equal(ok(await h.request(`/conversations/${cid}/queries`)).queries.length,1,"调查与拒绝均不新增或执行查询");
    checks.push("开放澄清可检索/补读语义/回源，检索沿原身份重放；保留问题/版本、旧版和错误活动任务拒绝，SQL门不放开");
    const legacy = (await invoke("update_analysis_task", { action: "create", goal: "合成两项旧决定", conditions, options: [],
      clarifications: [{ question: "指标采用哪种口径？", options: ["净收入", "交易数"] }, { question: "保留按渠道分组吗？", options: ["保留", "取消"] }] })).receipt.data;
    const questionA = legacy.opened_clarifications[0].id, questionB = legacy.opened_clarifications[1].id;
    // 仅布置升级前持久格式；后续回答、回执与修订全部经真实业务入口产生。
    const legacyResolution = { interpretation: "待核对合成指标与分组。", basis: "explicit_user", user_quote: "伪造的历史采纳原话",
      adoption_message_id: run.message_id, unresolved_differences: ["指标采用哪种口径？", "保留按渠道分组吗？"] };
    h.sql(`UPDATE condition_revisions SET decision_state_version=1,body=JSON_SET(body,'$.semantic_resolution',CAST(CONVERT(0x${Buffer.from(JSON.stringify(legacyResolution)).toString("hex")} USING utf8mb4) AS JSON)) WHERE task_id='${legacy.task_id}' AND version=1`);
    // 格式标记不能把损坏的旧JSON字符串解释成没有决定；仍走同一公共读取边界。
    try {
      h.sql(`UPDATE condition_revisions SET body=JSON_SET(body,'$.semantic_resolution',CAST(JSON_EXTRACT(body,'$.semantic_resolution') AS CHAR)) WHERE task_id='${legacy.task_id}' AND version=1`);
      const invalidRead = await h.internal("/internal/data/tool-calls", { run_id: run.run_id, lease_epoch: run.lease_epoch,
        sdk_tool_call_id: randomUUID(), tool_name: "read_analysis_task", arguments: { task_id: legacy.task_id }, checkpoint: checkpoint() });
      assert.equal(invalidRead.status, 409, "旧持久格式在登记所需的首次读取边界就应被拒绝");
      assert.equal(invalidRead.value.code, "invalid_evidence");
    } finally {
      h.sql(`UPDATE condition_revisions SET body=JSON_SET(body,'$.semantic_resolution',CAST(CONVERT(0x${Buffer.from(JSON.stringify(legacyResolution)).toString("hex")} USING utf8mb4) AS JSON)) WHERE task_id='${legacy.task_id}' AND version=1`);
    }
    let current = await readTask(legacy);
    await writeFile(h.directory + "/decision-state-initial.json", JSON.stringify({ current, stored: h.sql(`SELECT JSON_OBJECT('version',version,'decision_state_version',decision_state_version,'body',body) FROM condition_revisions WHERE task_id='${legacy.task_id}' AND version=1`) }, null, 2) + "\n");
    assert.deepEqual(current.conditions.semantic_resolution, legacyResolution, "旧格式夹具必须是原对象，不能把JSON字符串当旧决定");
    assert.ok(current.legacy_pending, "旧未决必须随当前任务以原版本/稳定索引交付");
    assert.deepEqual(current.legacy_pending.items.map(item => item.text), legacyResolution.unresolved_differences, "旧未决通过只读索引交付，不能伪装成新采纳");
    assert.equal(current.legacy_pending.condition_version, "1");
    await finish();

    await begin(cid, "第一项按净收入，另一项继续等待，先不要执行。");
    await invoke("update_analysis_task", { action: "route", task_id: legacy.task_id, expected_version: current.condition_version, options: [] });
    const partial = (await invoke("update_analysis_task", { action: "revise", task_id: legacy.task_id, expected_version: current.condition_version,
      condition_patch: { set: { metric: "net_revenue" }, unset: [] }, resolved_clarification_ids: [questionA], options: [] })).receipt.data;
    const answeredVersion = partial.condition_version;
    current = await readTask(legacy);
    assert.deepEqual(current.open_clarifications.map(question => question.id), [questionB]);
    await finish();

    await begin(cid, "只补充说明，另一项仍等待选择。");
    await invoke("update_analysis_task", { action: "route", task_id: legacy.task_id, expected_version: current.condition_version, options: [] });
    current = (await invoke("update_analysis_task", { action: "revise", task_id: legacy.task_id, expected_version: current.condition_version,
      condition_patch: { set: { notes: "与原指标选择无关的说明。" }, unset: [] }, options: [] })).receipt.data;
    const migration = { action: "revise", task_id: legacy.task_id, expected_version: current.condition_version,
      condition_patch: { set: {}, unset: [] }, options: [], legacy_resolution_migration: { from_condition_version: current.condition_version, links: [
        { pending_index: 0, clarification_id: questionA, resolution_condition_version: answeredVersion, condition_fields: ["metric"] },
        { pending_index: 1, clarification_id: questionB },
      ] } };
    const migrated = await invoke("update_analysis_task", migration);
    current = await readTask(legacy);
    assert.equal(current.decision_state_version, 2);
    assert.equal(current.legacy_pending, undefined);
    assert.deepEqual(current.open_clarifications.map(question => question.id), [questionB], "只比较所指指标字段，不让后来notes变化抹掉已答决定");
    assert.equal(current.conditions.metric, "net_revenue");
    assert.equal(current.conditions.semantic_resolution ?? null, null, "旧未决早退未核过的伪造explicit_user不能变成已验证采纳");
    const replayed = ok(await h.internal("/internal/data/tools", migrated.input));
    assert.equal(replayed.data.condition_version, current.condition_version, "原操作重放接回原版本");
    assert.equal((await readTask(legacy)).condition_version, current.condition_version);
    const historical = await readTask(legacy, answeredVersion);
    assert.deepEqual(historical.conditions.semantic_resolution, legacyResolution, "转换不改写历史条件和旧采纳原文");
    current = (await invoke("update_analysis_task", { action: "revise", task_id: legacy.task_id, expected_version: current.condition_version,
      condition_patch: { set: { semantic_resolution: null }, unset: [] }, options: [] })).receipt.data;
    assert.deepEqual((await readTask(legacy)).open_clarifications.map(question => question.id), [questionB], "清采纳说明不关闭剩余问题");
    checks.push("旧两未决部分回答、无关字段修订后按原条件/真实回执转换，保留另一题和历史，伪造旧采纳不继承，原操作不重复推版");
    await finish();

    const confirmation = "保留原渠道分组，净收入口径继续沿用，先不要执行。";
    await begin(cid, confirmation);
    await invoke("update_analysis_task", { action: "route", task_id: legacy.task_id, expected_version: current.condition_version, options: [] });
    const adoption = { interpretation: "保留按渠道分组。", basis: "explicit_user", user_quote: confirmation, adoption_message_id: null, evidence_refs: [] };
    current = (await invoke("update_analysis_task", { action: "revise", task_id: legacy.task_id, expected_version: current.condition_version,
      condition_patch: { set: { group_by: ["channel"], semantic_resolution: adoption }, unset: [] }, resolved_clarification_ids: [questionB], options: [] })).receipt.data;
    const adoptedMessage = run.message_id;
    assert.equal((await readTask(legacy)).open_clarifications.length, 0, "确认同值可以关闭实际已答问题，不强造条件变化");
    assert.equal(current.conditions.semantic_resolution.adoption_message_id, adoptedMessage);
    const split = (await invoke("update_analysis_task", { action: "split", task_id: legacy.task_id, expected_version: current.condition_version,
      goal: "合成独立渠道分析", conditions: current.conditions, moved_clarification_ids: [], options: [] })).receipt.data;
    for (const task of [legacy, split]) {
      const saved = await readTask(task);
      assert.equal(saved.conditions.metric, "net_revenue");
      assert.equal(saved.conditions.semantic_resolution.adoption_message_id, adoptedMessage, "split沿原采纳身份");
      const draft = (await invoke("request_query", { task_id: task.task_id, condition_version: saved.condition_version,
        sql: "SELECT 23 AS value", parameters: {}, target_id: "synthetic-sqlite", summary: "合成选择后的独立草稿", knowledge_refs: [], replaces_query_id: null })).receipt.data;
      assert.equal(draft.execution_state, "not_submitted");
      assert.equal(draft.semantic_resolution.adoption_message_id, adoptedMessage);
    }
    checks.push("新任务普通出稿、确认同值关闭、采纳身份宿主绑定和split后两稿继承，不增加执行权或强制采纳调用");
    await finish();

    await begin(cid, "检查合成旧格式中缺少历史依据的问题，先不要执行。");
    const basisOnly = (await invoke("update_analysis_task", { action: "create", goal: "合成basis旧项", conditions, options: [],
      clarifications: [{ question: "原口径仍需选择。", options: ["甲", "乙"] }] })).receipt.data;
    const missingQuestion = basisOnly.opened_clarifications[0].id;
    const basisResolution = { ...resolution("needs_clarification"), interpretation: "原口径仍需选择。" };
    h.sql(`UPDATE condition_revisions SET decision_state_version=1,body=JSON_SET(body,'$.semantic_resolution',CAST(CONVERT(0x${Buffer.from(JSON.stringify(basisResolution)).toString("hex")} USING utf8mb4) AS JSON)) WHERE task_id='${basisOnly.task_id}' AND version=1;UPDATE clarifications SET state='resolved' WHERE id='${missingQuestion}'`);
    const oldBasis = await readTask(basisOnly);
    assert.equal(oldBasis.legacy_pending.items.length, 1, "basis-only旧阻断不能遗漏");
    await invoke("update_analysis_task", { action: "revise", task_id: basisOnly.task_id, expected_version: basisOnly.condition_version,
      condition_patch: { set: {}, unset: [] }, options: [], legacy_resolution_migration: { from_condition_version: basisOnly.condition_version,
        links: [{ pending_index: 0, clarification_id: missingQuestion, resolution_condition_version: "1", condition_fields: ["metric"] }] } });
    const reopened = await readTask(basisOnly);
    assert.deepEqual(reopened.open_clarifications.map(question => question.id), [missingQuestion], "只有resolved且无匹配历史依据必须恢复open，不制造历史用户采纳");
    checks.push("basis-only旧项可定位，缺实际条件回执依据的resolved恢复原open身份");
    await finish();
  }
  passed = true;
} finally {
  await mkdir(".local/checks", { recursive: true });
  await writeFile(".local/checks/query-semantics" + (decisionState ? "-decision-state" : "") + ".json", JSON.stringify({ passed, decisionState, checks,
    officialRequests: 0, platform: "isolated MySQL and synthetic SQLite", model: "controlled tool inputs",
    limitations: ["引用真实不证明语义充分；本检查不证明模型发现了全部歧义，也不证明无歧义声明正确。"] }, null, 2));
  await h.close();
  console.log(JSON.stringify({ passed, decisionState, checks, officialRequests: 0, runtimeDirectory: h.directory.replace(process.cwd() + "/", "") }));
}
