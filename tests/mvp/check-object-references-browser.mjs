import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createReuseFixture } from "./check-knowledge-reuse.mjs";
import { ok } from "./skill-fixtures.mjs";
import { until } from "./harness.mjs";
import { remarkObjectReferences } from "../../apps/web/src/shared/markdown-object-references.ts";
import { objectReferenceLabels } from "../../apps/web/src/features/workbench/object-reference-labels.ts";
import { validateContract } from "../../packages/contracts/validate.ts";

// AST边界直接核对：只替换已知引用，代码与链接的值不能被文字替换误伤。
const known = "12345678-aaaa-4000-8000-000000000001";
const second = "12345678-bbbb-4000-8000-000000000002";
const unknown = "99999999-aaaa-4000-8000-000000000001";
const ast = { type: "root", children: [
  { type: "paragraph", children: [
    { type: "text", value: `${known} ${unknown} prefix${known}suffix 12345678-…` },
    { type: "inlineCode", value: known },
    { type: "inlineCode", value: `SELECT '${known}' AS value` },
    { type: "link", url: `https://example.org/${known}`, children: [{ type: "text", value: "保留链接地址" }] },
  ] },
  { type: "code", lang: "sql", value: `SELECT '${known}' AS value` },
] };
remarkObjectReferences({ [known]: "任务「收入」〔1〕", [second]: "任务「收入」〔2〕" })()(ast);
assert.equal(ast.children[0].children[0].value, `任务「收入」〔1〕 ${unknown} prefix${known}suffix 12345678-…`);
assert.deepEqual(ast.children[0].children[1], { type: "text", value: "任务「收入」〔1〕" });
assert.equal(ast.children[0].children[2].value, `SELECT '${known}' AS value`);
assert.equal(ast.children[0].children[3].url, `https://example.org/${known}`);
assert.equal(ast.children[1].value, `SELECT '${known}' AS value`);
const memory = randomUUID();
assert.equal(objectReferenceLabels({ tasks: [], events: [{ type: "memory_saved", payload: { asset_id: memory } }] }, [])[memory], "个人记忆");

const f = await createReuseFixture({ web: true });
const { h, cid } = f;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const checks = ["Markdown AST仅转换已知引用；未知/有前后缀的业务编号、歧义缩略ID、SQL代码及链接地址保持"];
let passed = false, observedDraftEvent;
page.on("pageerror", error => errors.push(error.message));
const conditions = { time_start: null, time_end: null, timezone: "UTC", metric: null, channel: null,
  group_by: [], filters: [], knowledge_refs: [], notes: "仅核对展示，不执行查询" };
try {
  await f.begin(cid, "为展示验证创建两份独立的收入分析和查询；整理报告，不执行 SQL。");
  const tasks = [];
  for (let i = 0; i < 2; i++) tasks.push(await f.invoke("update_analysis_task", {
    action: "create", goal: "收入分析", conditions, options: [],
  }));
  const businessId = randomUUID();
  const sql = `SELECT '${tasks[0].task_id}' AS task_literal, '${businessId}' AS order_id`;
  const queries = [];
  for (let i = 0; i < 2; i++) queries.push(await f.invoke("request_query", {
    task_id: tasks[i].task_id, condition_version: tasks[i].condition_version,
    sql: i === 0 ? sql : "SELECT 2 AS value", parameters: {}, target_id: "synthetic-sqlite",
    summary: "收入查询", knowledge_refs: [], replaces_query_id: null,
  }));
  const report = await f.invoke("save_analysis_report", {
    task_id: tasks[0].task_id, condition_version: tasks[0].condition_version,
    title: "展示核对报告", evidence_ids: [f.evidence.evidence_id], charts: [], expected_version: null,
  });
  const text = [
    `任务甲：${tasks[0].task_id}；任务乙：${tasks[1].task_id}。`,
    `查询甲：\`${queries[0].id}\`；查询乙：${queries[1].id}。`,
    `报告：${report.report_id}。`,
    `依据：${f.evidence.evidence_id}。`,
    `方法：${f.draft.draft_id}。`,
    `缩略任务：\`${tasks[0].task_id.slice(0, 9)}…\`。`,
    `业务订单：${businessId}。`,
    `内联 SQL：\`${sql}\`。`,
    `\`\`\`sql\n${sql}\n\`\`\``,
  ].join("\n\n");
  await f.finish(text);
  const snapshot = await h.snapshot(cid);
  observedDraftEvent = snapshot.events.find(event => event.type === "skill_draft_prepared" && event.payload.draft_id === f.draft.draft_id);
  assert.ok(observedDraftEvent);
  validateContract("Event", observedDraftEvent);
  validateContract("SkillDraftRef", observedDraftEvent.payload);
  assert.deepEqual(observedDraftEvent.payload, f.draft);
  checks.push("实际prepare_skill_draft同事务产生完整SkillDraftRef事件，Event及payload同源契约通过");
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await page.evaluate(conversation => localStorage.setItem('data-agent.conversation.["demo","alice"]', conversation), cid);
  await page.reload();
  const message = page.locator(".assistant-markdown").last();
  const taskOrder = tasks.map(task => task.task_id).sort();
  const queryOrder = queries.map(query => query.id).sort();
  const taskLabel = task => `任务「收入分析」〔${taskOrder.indexOf(task.task_id) + 1}〕`;
  const queryLabel = query => `查询「收入查询」〔${queryOrder.indexOf(query.id) + 1}〕`;
  const normal = async () => {
    await until(async () => (await message.locator("p").first().innerText()) ===
      `任务甲：${taskLabel(tasks[0])}；任务乙：${taskLabel(tasks[1])}。`, "friendly task references");
    const paragraphs = await message.locator("p").allTextContents();
    assert.ok(paragraphs.includes(`查询甲：${queryLabel(queries[0])}；查询乙：${queryLabel(queries[1])}。`));
    assert.ok(paragraphs.includes("报告：分析报告「收入分析」。"));
    assert.ok(paragraphs.includes("依据：分析依据「核对商品行口径」。"));
    assert.ok(paragraphs.includes("方法：方法草稿「核对商品行口径」。"));
    assert.ok(paragraphs.includes(`缩略任务：${taskLabel(tasks[0])}。`));
    assert.ok(paragraphs.includes(`业务订单：${businessId}。`));
    assert.equal(await message.locator("p > code").textContent(), sql);
    assert.equal((await message.locator("pre code").textContent()).trim(), sql);
  };
  await normal();
  checks.push("正式工作台将任务/查询/报告/依据/方法草稿完整ID及唯一缩略引用显示为业务名，同名对象可区分");
  checks.push("未知业务UUID、内联SQL与代码块中的已知ID均保留，只有恰为对象ID的inlineCode转成业务引用");
  await page.getByRole("button", { name: "显示技术标识", exact: true }).click();
  await until(async () => (await message.locator("p").first().innerText()).includes(tasks[0].task_id), "technical identifiers visible");
  assert.ok((await message.locator("p").allTextContents()).includes(`报告：${report.report_id}。`));
  assert.equal(await message.locator("p > code").first().textContent(), queries[0].id);
  await page.reload();
  await page.getByRole("button", { name: "隐藏技术标识", exact: true }).waitFor();
  assert.ok((await message.locator("p").first().innerText()).includes(tasks[0].task_id));
  await page.getByRole("button", { name: "隐藏技术标识", exact: true }).click();
  await normal();
  await page.reload();
  await normal();
  assert.equal((await h.snapshot(cid)).messages.findLast(value => value.role === "assistant").text, text);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: ".local/checks/object-references-browser.png", fullPage: true });
  checks.push("技术开关展示原文且按用户/空间保持刷新偏好；返回业务名后刷新一致，持久正文完全未改");
  passed = true;
} finally {
  await browser.close();
  await f.close();
  await writeFile(".local/checks/object-references-browser.json", JSON.stringify({ passed, checks, errors, observedDraftEvent, officialRequests: 0 }, null, 2) + "\n");
  console.log(JSON.stringify({ passed, checks, errors, officialRequests: 0 }));
}
