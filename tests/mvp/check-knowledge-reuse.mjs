import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { assetInput, ok, select } from "./skill-fixtures.mjs";
import { harness, until } from "./harness.mjs";

const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const command = () => ({ operation_id: randomUUID() });
export const reference = (object, path = "body") => ({
  object_id: object.id, version: object.version, path,
});

export function queryExampleInput(dependencies, changes = {}) {
  return {
    ...command(), kind: "query_example", name: "合成行数查询案例",
    body: "在选定的合成订单资料中按给定标签统计商品行数。标签只是输出参数，不是筛选口径。",
    related_ids: [],
    structured_value: {
      kind: "query_example",
      applicable_question: "需要统计商品行数，并给结果附上调用者指定的标签时使用。",
      parameters: [{ name: "cohort", type: "string", description: "结果标签，不改变数据范围", required: true }],
      sql: "SELECT :cohort AS cohort, COUNT(*) AS row_count FROM demo_order_detail",
      grain: "单条汇总行；row_count为商品行数，不是订单数",
      dependencies,
      verification: { note: "人工核对字段与粒度；未声称实际业务准确率", evidence_refs: dependencies },
    },
    ...changes,
  };
}

// 真实宿主及原生SessionManager；工具选择由测试控制，不冒称真实模型判断。
export async function createReuseFixture(options = {}) {
  const h = await harness({ capture: true, web: options.web ?? false,
    env: { DATA_AGENT_LEASE_MS: "120000" } });
  try {
    let run, manager;
    const attach = value => {
      run = value;
      manager = SessionManager.inMemory("/synthetic/data-agent");
    };
    const binding = () => ({ run_id: run.run_id, lease_epoch: run.lease_epoch });
    const checkpoint = () => exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
    const begin = async (cid, text) => {
      await h.resumeWorker();
      attach(await h.capture(cid, text));
      await h.pauseWorker();
      return run;
    };
    const invokeRaw = async (name, args, sdk = randomUUID()) => {
      const input = { ...binding(), sdk_tool_call_id: sdk, tool_name: name,
        arguments: args, checkpoint: checkpoint() };
      const registered = await h.internal("/internal/data/tool-calls", input);
      return registered.status === 200
        ? await h.internal("/internal/data/tools", input) : registered;
    };
    const invoke = async (name, args, sdk) => ok(await invokeRaw(name, args, sdk)).data;
    const finish = async (text = "已处理本轮合成材料。") => {
      ok(await h.internal("/internal/outputs", { ...binding(), chunk_seq: "1", text }));
      ok(await h.internal("/internal/finish", { ...binding(), commit_id: run.output_id,
        final_text: text, checkpoint: checkpoint() }));
      h.releaseRun(run.run_id);
    };
    const source = ok(await h.request("/knowledge", { ...command(), kind: "document",
      name: "合成商品行口径", body: "一行一个商品行，行数不能当订单数。",
      related_ids: [] }));
    const metric = ok(await h.request("/knowledge", { ...command(), kind: "metric",
      name: "合成商品行数", body: "COUNT(*)；粒度为商品行，不去重订单。", related_ids: [] }));
    const table = ok(await h.request("/knowledge/table-demo_order_detail"));
    const dependencies = [reference(table, "ddl"), reference(source), reference(metric)];
    const cid = await h.create();
    const instruction = "请把这次核对资料的分析方法准备成我的个人 Skill 草稿，保存前让我核对。";
    await begin(cid, instruction);
    const task = await invoke("update_analysis_task", { action: "create", goal: "核对商品行口径",
      conditions: { time_start: null, time_end: null, timezone: "UTC", metric: null,
        channel: null, group_by: [], filters: [], knowledge_refs: [reference(source)],
        notes: "只解释合成资料，不执行查询。" }, options: [] });
    const evidence = await invoke("save_analysis_evidence", { task_id: task.task_id,
      condition_version: task.condition_version, data_range: "只解释资料，无查询数字。",
      findings: [{ text: "商品行数不能替代订单数。", calculation: "读取人工资料定义。",
        limitations: ["没有运行查询，也不证明业务因果。"], query_refs: [],
        knowledge_refs: [reference(source)], figures: [] }] });
    const draftInput = { task_id: task.task_id, condition_version: task.condition_version,
      instruction_quote: instruction, evidence_ids: [evidence.evidence_id],
      name: "我的商品行核对方法", body: "先核对商品行与订单粒度，再展示SQL并等待用户在聊天中授权执行。",
      scope: "仅用于合成商品行资料；不推断业务原因", files: [] };
    const draftSdk = randomUUID();
    const draft = await invoke("prepare_skill_draft", draftInput, draftSdk);
    await finish();
    return { h, cid, source, metric, table, dependencies, task, evidence, draft,
      draftInput, draftSdk, begin, attach, invoke, invokeRaw, finish,
      get run() { return run; }, close: () => h.close() };
  } catch (error) { await h.close(); throw error; }
}

async function checkHistoricalMethodSources(fixture, checks) {
  const { h } = fixture;
  const cid = await h.create();
  const conditions = { time_start: "2026-01-01T00:00:00Z", time_end: "2026-04-01T00:00:00Z",
    timezone: "UTC", metric: null, channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "合成固定结果" };
  const route = task => fixture.invoke("update_analysis_task", { action: "route", task_id: task.task_id,
    expected_version: task.condition_version, options: [] });
  const queryEvidence = async (task, sql, column, expected) => {
    const query = await fixture.invoke("request_query", { task_id: task.task_id,
      condition_version: task.condition_version, sql, parameters: {}, target_id: "synthetic-sqlite",
      summary: "用于验证方法来源的合成固定结果", knowledge_refs: [], replaces_query_id: null });
    await fixture.finish();
    ok(await h.request(`/queries/${query.id}/confirm`, { ...command(),
      draft_version: query.draft_version, condition_version: query.condition_version }));
    const before = h.captured.length;
    await h.resumeWorker();
    const done = await until(async () => {
      const current = ok(await h.request(`/queries/${query.id}`));
      assert.notEqual(current.execution_state, "failed");
      return current.execution_state === "succeeded" ? current : false;
    }, "historical method query succeeds");
    const wake = await until(() => h.captured.slice(before).find(run => run.conversation_id === cid),
      "historical method query wake");
    await h.pauseWorker();
    fixture.attach(wake);
    await route(task);
    const evidence = await fixture.invoke("save_analysis_evidence", {
      task_id: task.task_id, condition_version: task.condition_version, data_range: "固定合成结果",
      findings: [{ text: "记录本次固定结果，供方法来源核对。", calculation: "读取查询实际列。", limitations: [],
        query_refs: [{ query_id: query.id, result_ref: done.result_ref, columns: [column] }], knowledge_refs: [],
        figures: [{ label: column, query_id: query.id, column, row_index: 0, value: expected }] }],
    });
    await fixture.finish();
    return { evidence, query: done };
  };

  await fixture.begin(cid, "先准备季度趋势的固定合成查询，随后确认执行。");
  const first = await fixture.invoke("update_analysis_task", { action: "create", goal: "季度趋势与渠道贡献",
    conditions, options: [] });
  const trend = await queryEvidence(first, "SELECT 102000 AS trend_cents", "trend_cents", "102000");
  await fixture.begin(cid, "继续核对二月与三月渠道贡献的固定合成查询。");
  const current = await fixture.invoke("update_analysis_task", { action: "revise", task_id: first.task_id,
    expected_version: first.condition_version,
    condition_patch: { set: { time_start: "2026-02-01T00:00:00Z", group_by: ["channel"] }, unset: [] }, options: [] });
  const contribution = await queryEvidence(current, "SELECT 11000 AS delta_cents", "delta_cents", "11000");
  const doc = ok(await h.request("/knowledge", { ...command(), kind: "document", name: "跨阶段方法核对原则",
    body: "先看趋势，再核对渠道贡献，保持各步骤原始范围。", related_ids: [] }));
  const instruction = "请把季度趋势、渠道贡献及独立核对原则一起整理成我的方法草稿，保存前让我核对。";
  await fixture.begin(cid, instruction);
  await route(current);
  const independent = await fixture.invoke("update_analysis_task", { action: "create", goal: "独立资料核对",
    conditions: { ...conditions, knowledge_refs: [reference(doc)] }, options: [] });
  const principle = await fixture.invoke("save_analysis_evidence", { task_id: independent.task_id,
    condition_version: independent.condition_version, data_range: "独立核对资料",
    findings: [{ text: "核对各步骤原始范围。",
      calculation: "读取资料约定。", limitations: [], query_refs: [], knowledge_refs: [reference(doc)], figures: [] }] });
  const input = { task_id: current.task_id, condition_version: current.condition_version, instruction_quote: instruction,
    evidence_ids: [trend.evidence.evidence_id, contribution.evidence.evidence_id, principle.evidence_id],
    name: "季度趋势与渠道贡献方法", body: "先查看季度趋势，再按二月和三月核对渠道贡献，并查阅独立核对原则。",
    scope: "各步骤保留其原时间范围，不自动执行新查询。", files: [] };
  const refs = [];
  for (let i = 0; i < 3; i++) refs.push(await fixture.invoke("prepare_skill_draft", input));
  await fixture.finish();
  const drafts = [];
  for (const ref of refs) drafts.push(ok(await h.request(`/assets/skill-drafts/${ref.draft_id}`)));
  const expectedSources = [
    { evidence_id: trend.evidence.evidence_id, task_id: first.task_id, condition_version: first.condition_version },
    { evidence_id: contribution.evidence.evidence_id, task_id: current.task_id, condition_version: current.condition_version },
    { evidence_id: principle.evidence_id, task_id: independent.task_id, condition_version: independent.condition_version },
  ];
  for (const draft of drafts) {
    assert.equal(draft.status, "pending");
    assert.equal(draft.reference.task_id, current.task_id);
    assert.equal(draft.reference.condition_version, current.condition_version);
    assert.deepEqual(draft.evidence_refs.map(({ evidence_id, task_id, condition_version }) =>
      ({ evidence_id, task_id, condition_version })), expectedSources);
    assert.deepEqual(draft.evidence_refs[0].result_dependencies,
      [{ query_id: trend.query.id, result_ref: trend.query.result_ref }]);
    assert.deepEqual(draft.evidence_refs[1].result_dependencies,
      [{ query_id: contribution.query.id, result_ref: contribution.query.result_ref }]);
  }
  assert.deepEqual(ok(await h.request(`/assets/skill-drafts/${refs[0].draft_id}`)).evidence_refs, drafts[0].evidence_refs);
  const saved = ok(await h.request("/assets", assetInput({ draft_id: refs[0].draft_id, name: input.name,
    body: input.body, scope: input.scope, dependencies: drafts[0].dependencies, files: input.files })));
  assert.equal(saved.body, input.body);
  assert.equal(ok(await h.request(`/assets/skill-drafts/${refs[0].draft_id}`)).status, "confirmed");
  checks.push("方法草稿可组合同任务v1趋势、v2贡献与另一任务资料；刷新和确认保留全部原task/version/result引用");

  // 来源属于别的会话时，即使是本人可读资料，也不能混入本次方法。
  const foreignCid = await h.create();
  await fixture.begin(foreignCid, "整理另一会话的资料核对结论。");
  const foreignTask = await fixture.invoke("update_analysis_task", { action: "create", goal: "另一会话资料",
    conditions: { ...conditions, knowledge_refs: [reference(doc)] }, options: [] });
  const foreignEvidence = await fixture.invoke("save_analysis_evidence", { task_id: foreignTask.task_id,
    condition_version: foreignTask.condition_version, data_range: "另一会话",
    findings: [{ text: "仅另一会话的资料结论。", calculation: "读取资料。", limitations: [],
      query_refs: [], knowledge_refs: [reference(doc)], figures: [] }] });
  await fixture.finish();
  await fixture.begin(cid, instruction);
  await route(current);
  const rejected = await fixture.invokeRaw("prepare_skill_draft", { ...input,
    evidence_ids: [trend.evidence.evidence_id, foreignEvidence.evidence_id] });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.value.code, "invalid_evidence");
  await fixture.finish();

  await writeFile(h.directory + "/platform/permissions.json", JSON.stringify({ denied_query_users: ["alice"] }));
  const unavailable = ok(await h.request(`/assets/skill-drafts/${refs[1].draft_id}`));
  assert.equal(unavailable.status, "sources_unavailable");
  assert.equal(Object.hasOwn(unavailable, "body"), false);
  const hidden = ok(await h.request("/assets")).assets.find(asset => asset.id === saved.id);
  assert.equal(hidden.text_unavailable, true);
  assert.equal(JSON.stringify(hidden).includes(input.body), false);
  await writeFile(h.directory + "/platform/permissions.json", "{}");
  await fixture.begin(cid, "修改方法当前任务的范围说明。");
  await fixture.invoke("update_analysis_task", { action: "revise", task_id: current.task_id,
    expected_version: current.condition_version,
    condition_patch: { set: { notes: "调整后的范围" }, unset: [] }, options: [] });
  await fixture.finish();
  assert.equal(ok(await h.request(`/assets/skill-drafts/${refs[2].draft_id}`)).status, "condition_changed");
  checks.push("跨会话来源仍拒绝；任一历史查询撤权使待确认及已保存方法隐藏，草稿当前归属变化仍使其失效");
}

async function checkReuse() {
  let fixture, passed = false;
  const checks = [];
  try {
    fixture = await createReuseFixture();
    const { h, source, metric, table, dependencies, cid, task, draftInput } = fixture;
    const exampleInput = queryExampleInput(dependencies);
    assert.equal((await h.request("/knowledge", exampleInput, "carol")).status, 403);
    const example = ok(await h.request("/knowledge", exampleInput));
    assert.equal(example.kind, "query_example");
    assert.equal(example.maintenance.maintainer_id, "alice");
    assert.deepEqual(example.entries.find(entry => entry.path === "body").effective_structure,
      exampleInput.structured_value);
    assert.deepEqual(ok(await h.request("/knowledge", exampleInput)), example);
    const foreignEdit = await h.request(`/knowledge/${example.id}`, { ...command(),
      expected_version: example.version, entry_id: "body", value: "替换案例" }, "bob", "PATCH");
    assert.equal(foreignEdit.status, 403);
    checks.push("有资格者明确录入公共案例并成为负责人；只读成员不能创建，非负责人不能覆盖独立案例；创建幂等");

    await fixture.begin(cid, "查看刚才的商品行案例，先不要执行。");
    await fixture.invoke("update_analysis_task", { action: "route", task_id: task.task_id,
      expected_version: task.condition_version, goal: "", options: [] });
    const search = await fixture.invoke("search_knowledge", { query: "商品行",
      limit: 10, kinds: ["query_example"] });
    assert.ok(search.objects.some(object => object.id === example.id));
    const read = await fixture.invoke("read_knowledge", { object_id: example.id,
      version: example.version });
    assert.ok(JSON.stringify(read).includes("结果标签"));
    assert.ok(JSON.stringify(read).includes(source.id));
    const sql = exampleInput.structured_value.sql;
    const query = await fixture.invoke("request_query", { task_id: task.task_id,
      condition_version: task.condition_version, sql, parameters: { cohort: "合成样本" },
      target_id: "synthetic-sqlite", summary: "按案例原逻辑生成待执行SQL。",
      knowledge_refs: [reference(example)], replaces_query_id: null });
    assert.equal(query.execution_state, "not_submitted");
    assert.equal((await h.request(`/queries/${query.id}`)).value.execution_state, "not_submitted");
    await fixture.finish();
    checks.push("案例可按种类检索并补读完整参数/SQL/文档依赖；参考原逻辑只生成草稿，没有新增执行权");

    await fixture.begin(cid, draftInput.instruction_quote);
    await fixture.invoke("update_analysis_task", { action: "route", task_id: task.task_id,
      expected_version: task.condition_version, goal: "", options: [] });
    const invalidQuote = await fixture.invokeRaw("prepare_skill_draft", { ...draftInput,
      instruction_quote: "核对资料的分析方法" });
    assert.ok(invalidQuote.status >= 400, "截取的用户消息不能代替完整真实来源");
    const pendingSdk = randomUUID();
    const anotherInput = { ...draftInput, name: "未确认的来源保护方法" };
    const pendingDraft = await fixture.invoke("prepare_skill_draft", anotherInput, pendingSdk);
    assert.deepEqual(await fixture.invoke("prepare_skill_draft", anotherInput, pendingSdk), pendingDraft);
    const origin = h.sql(`SELECT JSON_OBJECT('draft_operation',d.operation_id,'tool_operation',t.operation_id,'draft_origin',d.origin_run_id,'tool_origin',t.origin_run_id,'message',d.source_message_id) FROM skill_drafts d JOIN tool_calls t ON d.operation_id=t.operation_id WHERE d.id=${quote(pendingDraft.draft_id)} AND t.sdk_tool_call_id=${quote(pendingSdk)}`)[0];
    assert.ok(origin);
    assert.equal(origin.draft_operation, origin.tool_operation);
    assert.equal(origin.draft_origin, origin.tool_origin);
    assert.equal(origin.message, fixture.run.message_id);
    const raceDraft = await fixture.invoke("prepare_skill_draft", { ...draftInput, name: "并发确认来源方法" });
    await fixture.finish();
    checks.push("方法草稿绑定完整真实本轮用户来源，截句拒绝；同SDK重放保持宿主持久operation/origin身份");

    const raceDetail = ok(await h.request(`/assets/skill-drafts/${raceDraft.draft_id}`));
    const raceInputs = [1, 2].map(() => assetInput({ draft_id: raceDraft.draft_id,
      name: "并发确认只保存一份的方法", body: draftInput.body, scope: draftInput.scope,
      dependencies: raceDetail.dependencies }));
    const raceResults = await Promise.all(raceInputs.map(input => h.request("/assets", input)));
    assert.equal(raceResults.filter(result => result.status === 200).length, 1);
    assert.equal(raceResults.filter(result => result.status === 404 && result.value.code === "not_available").length, 1);
    const raceWinner = raceResults.findIndex(result => result.status === 200);
    assert.deepEqual(ok(await h.request("/assets", raceInputs[raceWinner])), raceResults[raceWinner].value);
    assert.equal(ok(await h.request("/assets")).assets.filter(asset => asset.name === raceInputs[0].name).length, 1);
    checks.push("同一待确认草稿两个真实并发确认只有一份资产；胜出原操作重放接回同一回执");

    const draftId = fixture.draft.draft_id;
    assert.ok(draftId);
    const detail = () => h.request(`/assets/skill-drafts/${draftId}`);
    const pending = ok(await detail());
    assert.equal(pending.status, "pending");
    assert.equal(pending.name, draftInput.name);
    assert.equal(ok(await h.request("/assets")).assets.some(a => a.name === draftInput.name), false);
    assert.equal((await h.request(`/assets/skill-drafts/${draftId}`, undefined, "bob")).status, 404);
    assert.equal(JSON.stringify(ok(await h.request("/assets/skill-drafts", undefined, "bob"))).includes(draftId), false);
    assert.equal((await h.request(`/conversations/${cid}/skill-selections`, { ...command(),
      asset_id: draftId, version: "1" })).status, 404);
    checks.push("私人待确认方法不进入正式资产或Skill选择；他人详情与目录不可读取");

    const confirmInput = assetInput({ draft_id: draftId, name: draftInput.name,
      body: draftInput.body + "\n确认前补充：字段含义以当前资料为准。", scope: draftInput.scope,
      dependencies: pending.dependencies, files: draftInput.files });
    const saved = ok(await h.request("/assets", confirmInput));
    assert.equal(saved.kind, "skill"); assert.equal(saved.visibility, "personal");
    assert.equal(saved.owner_id, "alice");
    assert.deepEqual(ok(await h.request("/assets", confirmInput)), saved);
    assert.equal(ok(await detail()).status, "confirmed");
    assert.equal(JSON.stringify(ok(await detail())).includes(draftInput.body), false);
    assert.equal(ok(await h.request(`/conversations/${cid}/skill-selections`)).selections.length, 0);
    ok(await select(h, cid, saved));
    await fixture.begin(cid, "采用我明确选用的商品行方法，先解释步骤。");
    await fixture.invoke("update_analysis_task", { action: "route", task_id: task.task_id,
      expected_version: task.condition_version, goal: "", options: [] });
    const native = await fixture.invoke("read", { path: `/skills/${saved.id}/${saved.version}/SKILL.md`, limit: 30 });
    assert.ok(JSON.stringify(native).includes("确认前补充"));
    await fixture.finish();
    checks.push("待确认草稿经用户修改并明确保存才成为独立原生Skill，重试不重复；未自动选用，选用后可原生读取");

    // 一次合成查询的实际结果唤醒不能冒充用户的保存请求。
    ok(await h.request(`/queries/${query.id}/confirm`, { ...command(),
      draft_version: query.draft_version, condition_version: query.condition_version }));
    await h.resumeWorker();
    const notice = await until(() => h.captured.find(value => value.conversation_id === cid &&
      value.text.includes(`query_id=${query.id}`)), "真实查询结果唤醒", 40000);
    assert.equal(h.sql(`SELECT JSON_OBJECT('key',client_key) FROM conversation_messages WHERE id=${quote(notice.message_id)}`)[0].key,
      `server:query-result:${query.id}`);
    fixture.attach(notice); await h.pauseWorker();
    await fixture.invoke("update_analysis_task", { action: "route", task_id: task.task_id,
      expected_version: task.condition_version, goal: "", options: [] });
    const noticeSave = await fixture.invokeRaw("prepare_skill_draft", { ...draftInput,
      instruction_quote: notice.text });
    assert.ok(noticeSave.status >= 400);
    await fixture.finish("已处理合成结果通知，没有创建新的个人方法草稿。");
    checks.push("平台实际结果唤醒不能代替真实用户消息授予个人方法保存来源");

    const impact = async (target, kind, after = "", user = "alice") => h.request(
      `/knowledge/${target.id}/maintenance-impact?` + new URLSearchParams({ kind,
        expected_version: target.version, ...(after ? { after_id: after } : {}) }), undefined, user);
    const knowledgeImpact = ok(await impact(source, "knowledge"));
    assert.equal(knowledgeImpact.scope, "direct_explicit_references");
    const dependent = knowledgeImpact.items.find(v => v.id === example.id);
    assert.ok(dependent); assert.equal(dependent.can_edit, true);
    assert.ok(dependent.references.some(v => v.referenced_path === "body"));
    const privateBob = ok(await h.request("/assets", assetInput({ name: "不能泄露的Bob私人方法",
      dependencies: [reference(source)] }), "bob"));
    const disabled = ok(await h.request(`/assets/${saved.id}/disable`, { ...command(), expected_version: saved.version }));
    const skills = ok(await impact(source, "skill"));
    assert.ok(skills.items.some(v => v.id === saved.id && v.state === "disabled"));
    assert.equal(JSON.stringify(skills).includes(privateBob.id), false);
    assert.equal(JSON.stringify(skills).includes(privateBob.name), false);
    assert.equal(skills.next_after_id, null);
    checks.push("维护提示按完整文档path发现案例和个人方法，保留停用项；超级维护者看不到他人私人名称、ID、数量或游标");

    const revisedSource = ok(await h.request(`/knowledge/${source.id}`, { ...command(),
      expected_version: source.version, entry_id: "body", value: source.entries[0].effective_value + " 核对后使用。" }, "alice", "PATCH"));
    assert.equal((await impact(source, "knowledge")).value.code, "version_conflict");
    const oldBinding = ok(await impact(revisedSource, "knowledge")).items.find(v => v.id === example.id);
    assert.ok(oldBinding.references.some(v => v.referenced_version === source.version && v.reference_state === "version_changed"));
    const invalidDraft = ok(await h.request(`/assets/skill-drafts/${pendingDraft.draft_id}`));
    assert.equal(invalidDraft.status, "sources_unavailable");
    assert.equal(JSON.stringify(invalidDraft).includes(anotherInput.name), false);
    assert.equal(JSON.stringify(invalidDraft).includes(draftInput.body), false);
    const invalidConfirmation = await h.request("/assets", assetInput({
      draft_id: pendingDraft.draft_id, name: anotherInput.name, body: draftInput.body,
      scope: draftInput.scope, dependencies: [reference(source)] }));
    assert.ok(invalidConfirmation.status >= 400);
    await fixture.begin(cid, "重新查看这个案例，不要执行。");
    await fixture.invoke("update_analysis_task", { action: "route", task_id: task.task_id,
      expected_version: task.condition_version, goal: "", options: [] });
    const stale = await fixture.invokeRaw("read_knowledge", { object_id: example.id, version: example.version });
    const staleData = ok(stale).data;
    const staleEntry = staleData.entries.find(entry => entry.path === "body");
    assert.equal(staleEntry.effective_structure, null);
    assert.ok(staleEntry.structure_gap);
    await fixture.finish();
    checks.push("来源改版拒绝旧维护页，按ID保留旧版本直接依赖；Agent读旧案例显式失效，不按名称猜规则");

    const freshSource = revisedSource;
    // 独立大量真实知识创建验证分页；正文无关系，只由显式related_ids提供引用。
    const pageObjects = [];
    for (let i = 0; i < 51; i++) pageObjects.push(ok(await h.request("/knowledge", { ...command(),
      kind: "document", name: `直接引用分页样本${i}`, body: "合成直接关联", related_ids: [freshSource.id] })));
    let cursor = "", seen = [];
    do {
      const page = ok(await impact(freshSource, "knowledge", cursor));
      assert.ok(page.items.length <= 50); seen.push(...page.items.map(item => item.id));
      cursor = page.next_after_id ?? "";
    } while (cursor);
    assert.equal(seen.length, new Set(seen).size);
    for (const object of pageObjects) assert.ok(seen.includes(object.id));
    h.sql(`UPDATE knowledge_objects SET space_id='other' WHERE id=${quote(metric.id)}`);
    assert.equal((await impact(metric, "knowledge")).status, 404);
    checks.push("超过50个直接依赖真实分页无重漏；跨空间目标统一不可用");

    const visibleSkills = [], hiddenSkills = [];
    for (let i = 0; i < 51; i++) {
      visibleSkills.push(ok(await h.request("/assets", assetInput({ name: `本人分页方法${i}`,
        dependencies: [reference(freshSource)] }))));
      hiddenSkills.push(ok(await h.request("/assets", assetInput({ name: `他人私人分页方法${i}`,
        dependencies: [reference(freshSource)] }), "bob")));
    }
    cursor = ""; seen = [];
    do {
      const page = ok(await impact(freshSource, "skill", cursor));
      assert.ok(page.items.length <= 50); seen.push(...page.items.map(item => item.id));
      assert.ok(hiddenSkills.every(hidden => !JSON.stringify(page).includes(hidden.id) &&
        !JSON.stringify(page).includes(hidden.name)));
      cursor = page.next_after_id ?? "";
      if (cursor) assert.ok(page.items.some(item => item.id === cursor));
    } while (cursor);
    assert.equal(seen.length, new Set(seen).size);
    for (const asset of visibleSkills) assert.ok(seen.includes(asset.id));
    assert.ok(hiddenSkills.every(asset => !seen.includes(asset.id)));
    checks.push("51本人方法和51他人私有方法混合真实分页，仅可见项进入列表、数量和游标");

    const methodInstruction = "请把这次新的资料核对方法准备成个人 Skill 草稿，等我核对保存。";
    const freshDocument = ok(await h.request("/knowledge", { ...command(), kind: "document",
      name: "独立条件和删除验证资料", body: "只核对单行参数说明，没有实际业务数字。", related_ids: [] }));
    await fixture.begin(cid, methodInstruction);
    const makePending = async name => {
      const currentTask = await fixture.invoke("update_analysis_task", { action: "create", goal: name,
        conditions: { time_start: null, time_end: null, timezone: "UTC", metric: null, channel: null,
          group_by: [], filters: [], knowledge_refs: [reference(freshDocument)], notes: "原范围" }, options: [] });
      const currentEvidence = await fixture.invoke("save_analysis_evidence", { task_id: currentTask.task_id,
        condition_version: currentTask.condition_version, data_range: "独立合成资料",
        findings: [{ text: "只采用资料定义。", calculation: "按资料读取。", limitations: [],
          query_refs: [], knowledge_refs: [reference(freshDocument)], figures: [] }] });
      const currentDraft = await fixture.invoke("prepare_skill_draft", { ...draftInput,
        name, task_id: currentTask.task_id, condition_version: currentTask.condition_version,
        instruction_quote: methodInstruction, evidence_ids: [currentEvidence.evidence_id] });
      return { task: currentTask, draft: currentDraft };
    };
    const changed = await makePending("条件变更前的方法");
    const deleting = await makePending("删除会话前仍有效的方法");
    await fixture.finish();
    await fixture.begin(cid, "第一份核对方法的条件说明改为新范围。");
    await fixture.invoke("update_analysis_task", { action: "revise", task_id: changed.task.task_id,
      expected_version: changed.task.condition_version, condition_patch: { set: { notes: "新范围" }, unset: [] },
      goal: "", options: [] });
    await fixture.finish();
    const conditionChanged = ok(await h.request(`/assets/skill-drafts/${changed.draft.draft_id}`));
    assert.equal(conditionChanged.status, "condition_changed");
    assert.equal(JSON.stringify(conditionChanged).includes("条件变更前的方法"), false);
    assert.equal(ok(await h.request(`/assets/skill-drafts/${deleting.draft.draft_id}`)).status, "pending");
    checks.push("任务条件变化使对应待确认方法只返回状态，不影响同会话其他仍有效草稿");

    // 原会话删除仅清待确认草稿，已主动保存的独立方法仍存在。
    ok(await h.request(`/conversations/${cid}`, command(), "alice", "DELETE"));
    assert.ok(ok(await h.request("/assets")).assets.some(a => a.id === disabled.id));
    const deletedDraft = ok(await h.request(`/assets/skill-drafts/${pendingDraft.draft_id}`));
    assert.equal(deletedDraft.status, "sources_unavailable");
    assert.equal(JSON.stringify(deletedDraft).includes(draftInput.body), false);
    const deletedValidDraft = ok(await h.request(`/assets/skill-drafts/${deleting.draft.draft_id}`));
    assert.equal(deletedValidDraft.status, "sources_unavailable");
    assert.equal(JSON.stringify(deletedValidDraft).includes("删除会话前仍有效的方法"), false);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM skill_drafts WHERE conversation_id=${quote(cid)} AND state<>'confirmed' AND body IS NOT NULL`)[0].n, 0);
    checks.push("来源变化后未确认草稿只返回失效状态且不能确认；删除会话清未确认内容，已确认独立方法保持");

    const staleMetric = ok(await h.request("/knowledge/metric-net_revenue"));
    assert.equal(staleMetric.entries.find(entry => entry.effective_structure)?.effective_structure.table.version,
      table.version);
    const changedTable = ok(await h.request(`/knowledge/${table.id}`, { ...command(),
      expected_version: table.version, entry_id: "description", value: "核对后的商品行说明。" }, "alice", "PATCH"));
    const investigation = await h.create();
    await fixture.begin(investigation, "核对表改版后的资料，先不要执行查询。");
    const candidates = await fixture.invoke("search_knowledge", { query: "净收入", limit: 10 });
    assert.ok(candidates.objects.some(object => object.id === staleMetric.id));
    const manifest = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id=${quote(fixture.run.run_id)}`)[0];
    assert.equal(manifest.knowledge.some(([id, version]) => id === table.id && version === table.version), false);
    const currentTable = await fixture.invoke("read_knowledge", { object_id: table.id, version: changedTable.version });
    assert.equal(currentTable.version, changedTable.version);
    const metricClue = await fixture.invoke("read_knowledge", { object_id: staleMetric.id, version: staleMetric.version });
    const oldRule = metricClue.entries.find(entry => entry.entry_id === "definition");
    assert.equal(oldRule.effective_structure, null); assert.ok(oldRule.structure_gap);
    const investigationTask = await fixture.invoke("update_analysis_task", { action: "create", goal: "核对改版资料",
      conditions: { time_start: null, time_end: null, timezone: "UTC", metric: null, channel: null,
        group_by: [], filters: [], knowledge_refs: [], notes: "先查资料" }, options: [] });
    const oldRuleAdoption = await fixture.invokeRaw("request_query", { task_id: investigationTask.task_id,
      condition_version: investigationTask.condition_version, sql: "SELECT 1 AS value", parameters: {},
      target_id: "synthetic-sqlite", summary: "尝试绑定已失效指标，应被拒绝。",
      knowledge_refs: [reference(staleMetric, "definition")], replaces_query_id: null });
    assert.equal(oldRuleAdoption.status, 409); assert.equal(oldRuleAdoption.value.code, "stale_knowledge");
    await fixture.finish();
    const indirectMetric = ok(await h.request("/knowledge", { ...command(), kind: "metric",
      name: "合成传递商品行数", body: "按当前表的商品行粒度计数。", related_ids: [],
      structured_value: { kind: "metric", table: { object_id: table.id, version: changedTable.version },
        expression: "COUNT(*)", input_grain: "商品行", time_column: null, unit: "行",
        required_filters: [], dimensions: [] } }));
    const indirectCase = ok(await h.request("/knowledge", queryExampleInput([reference(indirectMetric)],
      { name: "只直接引用指标的案例" })));
    const indirectConversation = await h.create();
    await fixture.begin(indirectConversation, "读取只引用指标的查询案例，不执行。");
    const indirectRead = await fixture.invoke("read_knowledge", { object_id: indirectCase.id,
      version: indirectCase.version });
    assert.ok(indirectRead.structure_dependencies.some(ref => ref.object_id === indirectMetric.id && ref.path === "body"));
    assert.ok(indirectRead.structure_dependencies.some(ref => ref.object_id === table.id && ref.version === changedTable.version && ref.path === "ddl"));
    const indirectAuthority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id=${quote(fixture.run.run_id)}`)[0];
    assert.ok(indirectAuthority.knowledge.some(([id, version]) => id === table.id && version === changedTable.version));
    const changedAgain = ok(await h.request(`/knowledge/${table.id}`, { ...command(),
      expected_version: changedTable.version, entry_id: "description", value: "再次核对后的商品行说明。" }, "alice", "PATCH"));
    const adoptedVersionChanged = await fixture.invokeRaw("read_knowledge", { object_id: indirectCase.id, version: indirectCase.version });
    assert.equal(adoptedVersionChanged.status, 409); assert.equal(adoptedVersionChanged.value.code, "stale_context");
    assert.equal(changedAgain.version, (BigInt(changedTable.version) + 1n).toString());
    checks.push("已撤下旧结构的线索允许补查，正式采用旧指标仍拒绝；案例→指标→表完整依赖进入实际清单，表改版仍使旧上下文失效");
    await checkHistoricalMethodSources(fixture, checks);
    passed = true;
  } finally {
    await writeFile(".local/checks/knowledge-reuse.json", JSON.stringify({ passed, checks,
      officialRequests: 0, scope: "真实本地Rust/MySQL、受控Pi工具及合成资料；不证明真实模型自主提取和SQL准确率" }, null, 2) + "\n");
    if (fixture) await fixture.close();
    console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await checkReuse();
