import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createReportFixture, ok } from "./check-analysis-reports.mjs";
import { until } from "./harness.mjs";

// 有效查询和报告均走真实API；这里只控制到达时刻，避免观察动作替用户滚动。
const directory = ".local/checks/report-reading-position";
await mkdir(directory, { recursive: true });
const fixture = await createReportFixture({ web: true });
const { h, cid, reportPath, saveInput } = fixture;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const checks = [], measurements = {}, errors = [];
let passed = false, releaseRead;
page.on("pageerror", error => errors.push(error.message));
const feed = page.locator(".conversation-scroll");
const composer = page.getByRole("textbox", { name: "你的数据问题", exact: true });
const geometry = async () => ({
  ...await feed.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight })),
  composer: await composer.boundingBox(),
  draft: await composer.inputValue(),
  inputFocused: await composer.evaluate(element => element === document.activeElement),
});
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
try {
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await page.getByRole("navigation", { name: "会话历史" }).getByRole("button", { name: /一季度分析报告/ }).click();
  for (const query of [...fixture.queries.filter((_, index) => index !== 3), fixture.foreignQuery])
    await page.locator("#query-" + query.id).locator("tbody tr").first().waitFor();
  await composer.fill("异步整理报告期间保留这段未发送的补充条件。");
  await composer.focus();
  await until(() => feed.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 3), "加载完成后跟随最新内容");
  // 输入框已聚焦后再真实离开底部；不能用仅有overflow推断正在回看历史。
  await feed.evaluate(element => { element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 3); });
  await until(() => feed.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight > 100), "确实正在回看历史");
  const anchorIndex = await page.locator(".messages > .message").evaluateAll(nodes => {
    const viewport = document.querySelector(".conversation-scroll").getBoundingClientRect();
    return nodes.findIndex(node => { const rect = node.getBoundingClientRect(); return rect.bottom > viewport.top + 30 && rect.top < viewport.bottom - 30; });
  });
  assert.ok(anchorIndex >= 0);
  const anchor = page.locator(".messages > .message").nth(anchorIndex);
  const before = { ...await geometry(), anchor: await anchor.boundingBox() };
  assert.equal(before.inputFocused, true);
  const report = ok(await h.request(reportPath(), saveInput()));
  await refresh();
  await until(async () => await page.getByRole("button", { name: "查看分析报告", exact: true }).count() === 1, "异步保存的报告入口到达");
  const after = { ...await geometry(), anchor: await anchor.boundingBox() };
  measurements.history = { before, after };
  assert.ok(Math.abs(after.anchor.y - before.anchor.y) < 3, "有效报告到达不能改变正在阅读的历史消息位置");
  assert.ok(Math.abs(after.composer.y - before.composer.y) < 3);
  assert.equal(after.draft, before.draft);
  assert.equal(after.inputFocused, true);
  assert.ok(after.height - after.top - after.viewport > 100);
  checks.push("真实离开底部阅读历史时，异步有效报告保存保留可见消息锚点、输入框位置、未发送草稿及焦点");
  await page.screenshot({ path: directory + "/history-report-arrival.png" });

  // 同一条规律也允许底部跟随：scrollTop变化不等于抢走阅读位置。
  await feed.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await until(() => feed.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 3), "回到底部");
  const following = await geometry();
  ok(await h.request(`/conversations/${cid}/tasks/${fixture.otherTask.task_id}/report`, {
    operation_id: randomUUID(), task_id: fixture.otherTask.task_id, condition_version: fixture.otherTask.condition_version,
    expected_version: null, title: "独立来源报告", evidence_ids: [fixture.foreignEvidence.evidence_id], charts: [],
  }));
  await refresh();
  await until(async () => await page.getByRole("button", { name: "查看分析报告", exact: true }).count() === 2, "第二份报告到达");
  await until(() => feed.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 3), "新增报告保持底部跟随");
  const followed = await geometry();
  measurements.following = { before: following, after: followed };
  assert.ok(followed.height > following.height);
  assert.ok(Math.abs((followed.top - following.top) - (followed.height - following.height)) < 3);
  assert.equal(followed.draft, following.draft);
  assert.equal(followed.inputFocused, true);
  checks.push("原本在底部时新报告到达继续跟随，scrollTop随内容高度增加且草稿、输入焦点不变");

  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const held = new Promise(resolve => { releaseRead = resolve; });
  const delayed = async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).reference.report_id, report.report_id);
    readStarted();
    await held;
    await route.fulfill({ response });
  };
  await page.route("**/api" + reportPath(), delayed);
  const entry = page.getByRole("button", { name: "查看分析报告", exact: true }).first();
  // 点击入口的主动定位单独记录，不把Playwright自动滚入视口记为异步滚动缺陷。
  await entry.click();
  await started;
  const opened = { ...await geometry(), entry: await entry.boundingBox() };
  const dialog = page.getByRole("dialog", { name: "分析报告", exact: true });
  await dialog.getByText("正在核对报告与数据依据…", { exact: true }).waitFor();
  releaseRead();
  await dialog.getByRole("heading", { name: "一季度净收入分析", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "返回对话", exact: true }).last().click();
  await dialog.waitFor({ state: "detached" });
  await page.unroute("**/api" + reportPath(), delayed);
  const closed = { ...await geometry(), entry: await entry.boundingBox() };
  measurements.read = { opened, closed };
  assert.ok(Math.abs(closed.top - opened.top) < 3);
  assert.ok(Math.abs(closed.entry.y - opened.entry.y) < 3);
  assert.ok(Math.abs(closed.composer.y - opened.composer.y) < 3);
  assert.equal(closed.draft, opened.draft);
  assert.equal(await entry.evaluate(element => element === document.activeElement), true);
  checks.push("延迟真实有效报告GET后正常呈现；返回对话恢复入口焦点、原阅读位置及草稿，主动点击滚动与异步变化分开计量");
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  releaseRead?.();
  if (!passed) await page.screenshot({ path: directory + "/failure.png" }).catch(() => {});
  await writeFile(directory + "/report.json", JSON.stringify({ passed, checks, measurements, errors, officialRequests: 0 }, null, 2) + "\n");
  await browser.close();
  await fixture.close();
  console.log(JSON.stringify({ passed, checks, errors, officialRequests: 0 }));
}
