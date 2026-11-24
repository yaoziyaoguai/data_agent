import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createReportFixture, ok } from "./check-analysis-reports.mjs";
import { until } from "./harness.mjs";

// 有效查询和报告均走真实API；这里只控制到达时刻，避免观察动作替用户滚动。
const queryResultsOnly = process.argv.includes("--query-results");
const directory = queryResultsOnly ? ".local/checks/query-results-browser" : ".local/checks/report-reading-position";
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
  // 同一真实分页夹具的结果卡子集，不重跑报告窗口已通过的分支。
  if (queryResultsOnly) {
    const resultRequests = [];
    const observeResult = response => {
      const url = new URL(response.url());
      const match = /\/api\/queries\/([^/]+)\/results$/.exec(url.pathname);
      if (match && response.request().method() === "GET") resultRequests.push({ at: Date.now(), query_id: match[1], cursor: url.searchParams.get("cursor"), status: response.status() });
    };
    page.on("response", observeResult); measurements.resultRequests = resultRequests;
    // point是数值，205行样本只核分页；图表状态沿既有month文本分类检查。
    const selected = fixture.queries[1];
    const selectedCard = page.locator("#query-" + selected.id);
    const chartCard = page.locator("#query-" + fixture.queries[0].id);
    const resultPath = "/queries/" + selected.id + "/results";
    const firstPage = ok(await h.request(resultPath));
    const preview = await selectedCard.locator("tbody tr").allTextContents();
    assert.equal(preview.length, Math.min(10, firstPage.rows.length));
    await composer.fill("结果当前页回读时保留未发送草稿。");
    await chartCard.getByRole("button", { name: "图表", exact: true }).click();
    const dimension = chartCard.getByRole("combobox", { name: "图表分类", exact: true });
    const measure = chartCard.getByRole("combobox", { name: "图表指标", exact: true });
    await dimension.focus();
    await feed.evaluate(element => { element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 3); });
    const before = { ...await geometry(), dimension: await dimension.inputValue(), measure: await measure.inputValue() };
    let active = 0, maxActive = 0, held = false, routeError, release;
    const starts = [], pages = [];
    const blocker = new Promise(resolve => { release = resolve; });
    const slowRead = async route => {
      const index = starts.push(Date.now()) - 1; ++active; maxActive = Math.max(maxActive, active);
      try {
        assert.equal(new URL(route.request().url()).searchParams.has("cursor"), false, "回读当前页不能遍历后续页");
        const response = await route.fetch(); assert.equal(response.status(), 200);
        const value = await response.json(); pages.push({ rows: value.rows.length, has_next_cursor: !!value.next_cursor });
        if (index === 0) { held = true; await blocker; }
        await route.fulfill({ response });
      } catch (error) { routeError = error; }
      finally { --active; }
    };
    await page.route("**/api" + resultPath + "*", slowRead);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await until(() => held || routeError, "当前页慢读取已到达"); if (routeError) throw routeError;
      await page.evaluate(() => { for (let i = 0; i < 3; i++) { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); } });
      await page.waitForTimeout(2400);
      assert.equal(starts.length, 1); assert.equal(maxActive, 1);
      assert.equal(await selectedCard.locator("tbody tr").count(), preview.length, "当前页在途读取保留已读行");
      assert.equal(await chartCard.getByRole("img").count(), 1, "已有合法分类图表保持当前选择");
      const releasedAt = Date.now(); release();
      await until(() => active === 0 || routeError, "当前页读取完成"); if (routeError) throw routeError;
      // 结果卡不定时再读：读完后空闲没有新请求，窗口唤醒只补一次当前页读取。
      await page.waitForTimeout(2400);
      assert.equal(starts.length, 1, "前次读取完成后空闲不再定时重读");
      await refresh();
      await until(() => starts.length >= 2 && active === 0 || routeError, "重新聚焦后核对当前页", 40000); if (routeError) throw routeError;
      assert.equal(maxActive, 1);
      const after = { ...await geometry(), dimension: await dimension.inputValue(), measure: await measure.inputValue() };
      assert.ok(Math.abs(after.top - before.top) < 3); assert.ok(Math.abs(after.composer.y - before.composer.y) < 3);
      assert.equal(after.draft, before.draft); assert.equal(after.dimension, before.dimension); assert.equal(after.measure, before.measure);
      assert.equal(await dimension.evaluate(element => element === document.activeElement), true);
      measurements.results = { before, after, starts, releasedAt, maxActive, pages, paged_query_id: selected.id, chart_query_id: fixture.queries[0].id };
    } finally { release(); await until(() => active === 0, "当前页读取清理"); await page.unroute("**/api" + resultPath + "*", slowRead); }
    await chartCard.getByRole("button", { name: "表格", exact: true }).click();
    assert.deepEqual(await selectedCard.locator("tbody tr").allTextContents(), preview);
    await page.screenshot({ path: directory + "/current-page.png" });
    checks.push("已读当前页慢读取合并focus/visibility，读完后空闲不再定时重读，窗口唤醒补读一次；保留10行预览、分页元数据、表图选择、焦点、会话滚动与草稿，不读取后续页");

    const state = () => h.sql("SELECT JSON_OBJECT('runs',(SELECT COUNT(*) FROM agent_runs),'submissions',(SELECT SUM(submission_attempts) FROM query_requests))")[0];
    const domainBefore = state();
    const setPermissions = async denied => {
      const response = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/permissions", {
        method: "POST",
        headers: { authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ space_id: "demo", denied_query_users: denied }),
      });
      assert.equal(response.status, 200, "平台撤权及变更事件已提交");
    };
    try {
      await setPermissions(["alice"]);
      const denied = await h.request(resultPath); assert.equal(denied.status, 403); assert.equal(denied.value.code, "forbidden");
      // 不触发 focus 或重开：平台主动通知撤权，每张已打开的结果卡各自重验。
      await until(async () => await page.locator(".result-panel").count() === 0, "权限通知撤下全部已读结果表格与图表", 40000);
      assert.equal(await page.getByRole("link", { name: "下载 CSV ↓", exact: true }).count(), 0);
      assert.ok(resultRequests.some(read => read.status === 403), "记录实际浏览器结果读取的权限拒绝");
      measurements.resultPermission = { before: 200, denied: denied.status };
      await page.screenshot({ path: directory + "/permission-denied.png" });
    } finally { await setPermissions([]); }
    for (const query of [...fixture.queries.filter((_, index) => index !== 3), fixture.foreignQuery])
      await page.locator("#query-" + query.id).locator("tbody tr").first().waitFor();
    assert.deepEqual(await selectedCard.locator("tbody tr").allTextContents(), preview);
    assert.deepEqual(state(), domainBefore, "权限回读不能发起模型运行或重复提交SQL");
    assert.equal(await composer.inputValue(), before.draft);
    checks.push("真实结果200→403→200，权限通知撤下已读表格/图表/下载入口并自动恢复原页，保留草稿，模型运行与SQL提交数不变");

    let lateHeld = false, releaseLate, lateDone = false, lateError, lateRequest;
    const lateBlocker = new Promise(resolve => { releaseLate = resolve; });
    const lateRead = async route => {
      lateRequest = route.request();
      try {
        const response = await route.fetch(); assert.equal(response.status(), 200); lateHeld = true;
        await lateBlocker; await route.fulfill({ response });
      } catch (error) { if (!/ERR_ABORTED/.test(route.request().failure()?.errorText ?? "")) lateError = error; }
      finally { lateDone = true; }
    };
    await page.route("**/api" + resultPath + "*", lateRead);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await until(() => lateHeld || lateError, "离开前当前页读取被延迟"); if (lateError) throw lateError;
      await page.getByRole("button", { name: /新对话/ }).first().click();
      await until(async () => await page.locator(".query-card").count() === 0, "离开原查询结果");
      releaseLate(); await until(() => lateDone, "迟到读取已结束"); if (lateError) throw lateError;
      const response = await lateRequest.response();
      if (response) assert.equal(response.status(), 200); else assert.match(lateRequest.failure()?.errorText ?? "", /ERR_ABORTED/);
      assert.equal(await page.locator(".query-card").count(), 0); assert.equal(await page.locator(".result-panel").count(), 0);
      measurements.closedResultRead = response ? { status: response.status() } : { canceled: lateRequest.failure() };
    } finally { releaseLate(); await page.unroute("**/api" + resultPath + "*", lateRead); }
    page.off("response", observeResult);
    assert.ok(resultRequests.every(read => read.cursor === null), "所有自动读取均留在已有当前页");
    checks.push("离开对话取消或忽略当前页迟到响应，旧结果不会恢复到新对话");
  } else {
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
  await page.unroute("**/api" + reportPath(), delayed);
  const reportBody = dialog.locator(".modal-body");
  const detail = dialog.locator(".report-evidence").first();
  const summary = detail.locator("summary");
  await summary.click();
  await summary.focus();
  await reportBody.evaluate(element => { element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2); });
  const readingBefore = { ...await geometry(), reportTop: await reportBody.evaluate(element => element.scrollTop) };
  assert.ok(readingBefore.reportTop > 10, "报告正文确实处于滚动阅读位置");
  const periodicReads = [];
  const observeRead = response => {
    if (response.request().method() === "GET" && new URL(response.url()).pathname.endsWith(reportPath()))
      periodicReads.push({ at: Date.now(), status: response.status() });
  };
  page.on("response", observeRead);
  try { await until(() => periodicReads.length >= 2, "报告打开期间完成两次普通刷新", 40000); }
  finally { page.off("response", observeRead); }
  assert.ok(periodicReads.every(read => read.status === 200));
  const readingAfter = { ...await geometry(), reportTop: await reportBody.evaluate(element => element.scrollTop) };
  measurements.periodicRead = { before: readingBefore, after: readingAfter, reads: periodicReads };
  assert.ok(Math.abs(readingAfter.reportTop - readingBefore.reportTop) < 3, "普通刷新不能重置报告正文滚动位置");
  assert.ok(Math.abs(readingAfter.top - readingBefore.top) < 3);
  assert.ok(Math.abs(readingAfter.composer.y - readingBefore.composer.y) < 3);
  assert.equal(readingAfter.draft, readingBefore.draft);
  assert.equal(await detail.evaluate(element => element.open), true);
  assert.equal(await summary.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: directory + "/periodic-report-read.png" });
  checks.push("报告滚动阅读时两次普通刷新保留正文位置、已展开依据、当前焦点、背景会话位置和未发送草稿");
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
  }
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
