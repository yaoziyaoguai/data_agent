import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createReuseFixture, reference } from "./check-knowledge-reuse.mjs";
import { ok } from "./skill-fixtures.mjs";

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const fixture = await createReuseFixture();
const { h } = fixture;
const checks = [];
let passed = false;
const empty = { time_start: null, time_end: null, timezone: "UTC", metric: null, channel: null,
  group_by: [], filters: [], knowledge_refs: [], notes: "三个指标的口径分别确认" };
const read = task => fixture.invoke("read_analysis_task", { task_id: task.task_id });
const update = input => fixture.invoke("update_analysis_task", input);
const split = (source, goal, conditions, ids) => ({ action: "split", task_id: source.task_id,
  expected_version: source.condition_version, goal, conditions, moved_clarification_ids: ids, options: [] });
const taskCount = cid => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_tasks WHERE conversation_id=${quote(cid)}`)[0].n;

try {
  const cid = await h.create();
  await fixture.begin(cid, "我要比较收入、退款率和客户数，口径分别确认，先不要写 SQL。");
  await fixture.invoke("read_knowledge", { object_id: fixture.source.id, version: fixture.source.version });
  const base = await update({ action: "create", goal: "比较收入、退款率和客户数",
    conditions: { ...empty, knowledge_refs: [reference(fixture.source)] }, options: [] });
  const common = await update({ action: "clarify", task_id: base.task_id, expected_version: base.condition_version,
    condition_patch: { set: {}, unset: [] }, options: [], clarifications: [
      { question: "收入采用付款月还是退款发生月？", options: ["付款月", "退款发生月"] },
      { question: "退款率使用订单数还是金额？", options: ["订单数", "金额"] },
      { question: "客户数按整季去重还是各月分别去重？", options: ["整季去重", "各月分别去重"] },
    ] });
  const original = await read(common);
  const [income, refund, customer] = common.opened_clarifications;
  const originalQuestion = h.sql(`SELECT JSON_OBJECT('question',question,'options',options,'authority',text_authority) FROM clarifications WHERE id=${quote(income.id)}`)[0];
  const originalFields = h.sql(`SELECT field_authorities FROM condition_revisions WHERE task_id=${quote(common.task_id)} AND version=${quote(common.condition_version)}`)[0];
  await fixture.finish();

  await fixture.begin(cid, "只把收入独立出来，月份改为 2026 年 2 月，其余口径继续等我回答。");
  const incomeConditions = { ...original.conditions, time_start: "2026-02-01T00:00:00Z", time_end: "2026-03-01T00:00:00Z" };
  const args = split(common, "2026 年 2 月收入", incomeConditions, [income.id]);
  const sdk = randomUUID();
  const detached = await fixture.invoke("update_analysis_task", args, sdk);
  assert.notEqual(detached.task_id, common.task_id);
  assert.equal(detached.condition_version, "1");
  assert.equal(detached.source_task_id, common.task_id);
  assert.equal(detached.source_phase, "waiting_clarification");
  assert.equal(detached.phase, "waiting_clarification");
  assert.deepEqual(await fixture.invoke("update_analysis_task", args, sdk), detached);
  assert.equal(taskCount(cid), 2);
  const remaining = await read(common);
  const target = await read(detached);
  assert.deepEqual(remaining.conditions, original.conditions);
  assert.equal(remaining.condition_version, common.condition_version);
  assert.deepEqual(remaining.open_clarifications.map(q => q.id).sort(), [refund.id, customer.id].sort());
  assert.deepEqual(target.open_clarifications, [income]);
  assert.equal(target.conditions.time_start, incomeConditions.time_start);
  const movedQuestion = h.sql(`SELECT JSON_OBJECT('question',question,'options',options,'authority',text_authority) FROM clarifications WHERE id=${quote(income.id)}`)[0];
  assert.deepEqual(movedQuestion, originalQuestion);
  const movedFields = h.sql(`SELECT field_authorities FROM condition_revisions WHERE task_id=${quote(detached.task_id)} AND version=1`)[0];
  assert.deepEqual(movedFields.knowledge_refs, originalFields.knowledge_refs);
  const history = await fixture.invoke("read_analysis_task", { task_id: common.task_id, condition_version: "1" });
  assert.equal(history.is_historical, true);
  assert.deepEqual(history.current_open_clarification_ids.sort(), [refund.id, customer.id].sort());
  assert.equal(Object.hasOwn(history, "open_clarifications"), false);
  checks.push("只分离收入目标时原任务条件不变，未答退款/客户问题保持；问题ID及来源、历史当前开放ID和工具重放一致");

  const failed = await fixture.invokeRaw("update_analysis_task",
    split(common, "混入已迁移问题的失败拆分", empty, [refund.id, income.id]));
  assert.equal(failed.value.code, "clarification_not_open");
  assert.equal(taskCount(cid), 2);
  assert.deepEqual((await read(common)).open_clarifications.map(q => q.id).sort(), [refund.id, customer.id].sort());
  const stale = await fixture.invokeRaw("update_analysis_task", { ...args, expected_version: "1" });
  assert.equal(stale.value.code, "version_conflict");
  assert.equal(taskCount(cid), 2);
  await fixture.finish();

  await fixture.begin(cid, "收入使用付款月，先展示收入 SQL，不执行；退款率和客户数继续等待。");
  const answered = await update({ action: "revise", task_id: detached.task_id, expected_version: detached.condition_version,
    condition_patch: { set: { metric: "支付归属净收入" }, unset: [] }, resolved_clarification_ids: [income.id], options: [] });
  const query = await fixture.invoke("request_query", { task_id: answered.task_id, condition_version: answered.condition_version,
    sql: "SELECT 11000 AS income_cents", parameters: {}, target_id: "synthetic-sqlite", summary: "独立收入目标的合成固定草稿",
    knowledge_refs: [], replaces_query_id: null });
  assert.equal(query.execution_state, "not_submitted");
  assert.equal((await read(common)).phase, "waiting_clarification");
  assert.equal((await read(answered)).phase, "waiting_confirmation");
  await fixture.finish();
  checks.push("失败拆分原子回滚且旧版本拒绝；独立收入回答后可生成SQL，其他指标未答不再阻塞它");

  await fixture.begin(cid, "从收入分析分出一个独立的说明目标，不移动问题，也不改变已有 SQL。");
  const before = ok(await h.request(`/queries/${query.id}`));
  const emptySplit = await update(split(answered, "独立说明目标", { ...empty, notes: "只解释资料" }, []));
  assert.equal(emptySplit.source_phase, "waiting_confirmation");
  assert.equal((await read(answered)).phase, "waiting_confirmation");
  assert.deepEqual(ok(await h.request(`/queries/${query.id}`)), before);
  await fixture.finish();
  checks.push("无开放问题也可分离独立目标，原待执行查询的归属/条件/状态不迁移，源任务仍等待确认");

  await fixture.begin(cid, "将剩余两个待答口径单独整理，保留问题原文。");
  const rest = await update(split(common, "退款率与客户口径", original.conditions, [refund.id, customer.id]));
  assert.equal(rest.source_phase, "investigating");
  assert.equal((await read(common)).open_clarifications.length, 0);
  assert.equal((await read(rest)).open_clarifications.length, 2);
  await fixture.finish();
  checks.push("迁走最后开放问题后源任务重算状态；新任务保留原未答问题，不把迁移当作回答或执行授权");
  await fixture.begin(cid, "先说明一个没有查询和澄清的独立目标。");
  const completed = await update({ action: "create", goal: "已完成的资料说明", conditions: empty, options: [] });
  await fixture.finish();
  await fixture.begin(cid, "从已完成的资料说明里分离一个新的调查目标。");
  assert.equal((await read(completed)).phase, "answered");
  const continuation = await update(split(completed, "后续独立调查", empty, []));
  assert.equal(continuation.source_phase, "answered");
  assert.equal((await read(completed)).phase, "answered");
  await fixture.finish();
  checks.push("从已完成目标分离后续调查不会把原目标倒退为调查中");
  passed = true;
} finally {
  await fixture.close();
  await writeFile(".local/checks/task-splitting.json", JSON.stringify({ passed, checks, officialRequests: 0,
    scope: "真实本地Rust/MySQL与受控工具；不宣称模型对所有自然语言都能正确拆分" }, null, 2) + "\n");
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
}
