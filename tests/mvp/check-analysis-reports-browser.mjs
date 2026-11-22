import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createReportFixture, ok } from "./check-analysis-reports.mjs";
import { logoutWorkspace } from "./experience-navigation.mjs";
import { until } from "./harness.mjs";

const directory = ".local/checks/analysis-reports-browser";
await mkdir(directory, { recursive: true });
const fixture = await createReportFixture({ web: true });
const { h, cid, evidence, chart, reportPath, saveInput } = fixture;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1279, height: 1000 } });
page.setDefaultTimeout(12000);
const focusDiagnostics = [];
const layoutDiagnostics = [];
const pollingDiagnostics = {};
const checks = [],
  errors = [],
  responses = [];
let passed = false,
  releaseDelayed,
  delayedHandlerDone;
page.on("pageerror", (error) => errors.push(error.message));
const isReport = (response) =>
  new URL(response.url()).pathname.endsWith("/report") &&
  response.request().method() === "GET";
const dialog = () =>
  page.getByRole("dialog", { name: "分析报告", exact: true });
const back = () =>
  dialog().getByRole("button", { name: "返回对话", exact: true }).last();
const entry = () =>
  page.getByRole("button", { name: "查看分析报告", exact: true });
const layout = async (label) => {
  const value = await page
    .locator(".conversation-scroll")
    .evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      rows: Array.from(element.querySelectorAll(".query-card")).map((card) => ({
        id: card.id,
        rows: card.querySelectorAll("tbody tr").length,
      })),
    }));
  const measured = { label, ...value, entry: await entry().boundingBox() };
  layoutDiagnostics.push(measured);
  return measured;
};
const reportKeyboardFocus = async (key) => {
  const focus = () =>
    dialog().evaluate((element) => ({
      inside: element.contains(document.activeElement),
      activeTag: document.activeElement?.tagName,
      activeId: document.activeElement?.id,
      hasFocus: document.hasFocus(),
      open: element.open,
      modal: element.matches(":modal"),
    }));
  await page.keyboard.press(key);
  let state = await focus();
  focusDiagnostics.push({ key, state });
  if (!state.inside) {
    // 同Chromium独立原生dialog基线：Tab可以先进入浏览器工具栏，背景控件仍不可获焦。
    assert.equal(state.activeTag, "BODY");
    assert.equal(state.hasFocus, false);
    assert.equal(state.open, true);
    assert.equal(state.modal, true);
    await page.keyboard.press(key);
    state = await focus();
    focusDiagnostics.push({ key, afterBrowserToolbar: true, state });
  }
  assert.equal(state.inside, true);
  assert.equal(state.hasFocus, true);
};
const selectConversation = async (text) => {
  const menu = page.getByRole("button", { name: "展开导航", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "会话历史" })
    .getByRole("button", { name: new RegExp(text) })
    .click();
};
const open = async () => {
  const response = page.waitForResponse(isReport);
  await entry().click();
  await dialog().waitFor();
  const value = await response;
  assert.equal(value.status(), 200, await value.text());
  const view = await value.json();
  responses.push(view);
  return view;
};
const focusRefresh = async () => {
  const response = page.waitForResponse(isReport);
  // 受控focus事件仅验证刷新处理；返回内容仍由真实API/平台决定。
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const value = await response;
  assert.equal(value.status(), 200, await value.text());
  const view = await value.json();
  responses.push(view);
  return view;
};
try {
  const title = "一季度收入与变化报告";
  ok(
    await h.request(
      reportPath(),
      saveInput({
        title,
        evidence_ids: [
          evidence[0].evidence_id,
          evidence[1].evidence_id,
          evidence[4].evidence_id,
          fixture.foreignEvidence.evidence_id,
        ],
        charts: [
          chart(0),
          chart(1, { title: "205个合成分类点" }),
          chart(4, { kind: "bar", title: "精确金额对照" }),
          { kind: "bar", title: "独立任务来源对照", query_id: fixture.foreignQuery.id, result_ref: fixture.foreignEvidence.result_dependencies[0].result_ref, dimension_column: "category", measure_column: "amount" },
        ],
      }),
    ),
  );
  const otherCid = await h.create();
  await fixture.begin(otherCid, "另一段报告浏览对话，暂时不做分析。");
  await fixture.invoke("update_analysis_task", {
    action: "route",
    task_id: null,
    expected_version: null,
    goal: "",
    options: [],
  });
  await fixture.finish("这是另一段独立对话。");
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await selectConversation("一季度分析报告");
  await entry().waitFor();
  for (const query of [
    fixture.queries[0],
    fixture.queries[1],
    fixture.queries[2],
    fixture.queries[4],
    fixture.foreignQuery,
  ])
    await page
      .locator("#query-" + query.id)
      .locator("tbody tr")
      .first()
      .waitFor();
  await page.getByLabel("你的数据问题").fill("这个补充尚未发送");
  await entry().scrollIntoViewIfNeeded();
  await layout("before-open");
  const originalPosition = await entry().boundingBox();
  const originalScroll = await page
    .locator(".conversation-scroll")
    .evaluate((element) => element.scrollTop);
  const view = await open();
  assert.equal(view.status, "available");
  assert.equal(
    view.chart_results.find(
      (result) => result.query_id === fixture.queries[1].id,
    ).rows.length,
    205,
  );
  assert.equal(
    view.chart_results.find(
      (result) => result.query_id === fixture.queries[4].id,
    ).rows[0][1],
    "9007199254740993.01",
  );
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  assert.equal(await dialog().locator(".report-source").count(), 4);
  const independentSource = dialog().getByRole("region", { name: "来源 4", exact: true });
  await independentSource.getByText("应用", { exact: true }).waitFor();
  await independentSource.getByText("category", { exact: true }).waitFor();
  assert.equal(await dialog().getByRole("region", { name: "来源 1", exact: true }).getByText("应用", { exact: true }).count(), 0);
  await dialog().getByRole("figure", { name: /独立任务来源对照/ }).getByText("来源 4", { exact: true }).waitFor();
  const exactFigure = dialog().getByRole("figure", { name: /精确金额对照/ });
  await exactFigure
    .getByRole("listitem")
    .getByText("9007199254740993.01", { exact: true })
    .waitFor();
  assert.equal(await dialog().getByRole("img").count(), 2);
  const pointsFigure = dialog().getByRole("img", {
    name: /205个合成分类点，共 205 个点/,
  });
  assert.equal(await pointsFigure.locator("circle").count(), 205);
  assert.ok(
    !(await dialog().innerText()).match(
      /版本\s*[1-9]|revision|report_id|condition_version/,
    ),
  );
  await page.screenshot({ path: directory + "/desktop.png" });
  await dialog()
    .locator(".modal-body")
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  const backBox = await back().boundingBox();
  assert.ok(
    backBox.y >= 0 && backBox.y + backBox.height <= page.viewportSize().height,
  );
  await back().focus();
  await reportKeyboardFocus("Tab");
  await reportKeyboardFocus("Shift+Tab");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached" });
  await layout("after-return");
  assert.ok(
    await entry().evaluate((element) => element === document.activeElement),
  );
  assert.ok(Math.abs((await entry().boundingBox()).y - originalPosition.y) < 3);
  assert.ok(
    Math.abs(
      (await page
        .locator(".conversation-scroll")
        .evaluate((element) => element.scrollTop)) - originalScroll,
    ) < 3,
  );
  assert.equal(
    await page.getByLabel("你的数据问题").inputValue(),
    "这个补充尚未发送",
  );
  checks.push(
    "真实聊天报告入口读到完整205点与原精确金额；跨任务来源各自显示条件且图表关联正确来源，正文不堆版本/技术ID；滚动、Tab圈与Escape返回保持原焦点和草稿",
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await open();
  const composer = page.getByLabel("你的数据问题");
  const originalDraft = await composer.inputValue();
  const [dockBox, inputBox] = await Promise.all([dialog().boundingBox(), composer.boundingBox()]);
  assert.ok(dockBox.x >= inputBox.x + inputBox.width, "报告在输入框右侧停靠");
  assert.ok(dockBox.width >= 570 && dockBox.y + dockBox.height <= 900, "右栏有效宽度且在视口内");
  assert.equal(await dialog().evaluate(element => element.matches(":modal")), false);
  await composer.fill("查阅报告时仍能补充");
  assert.equal(await composer.inputValue(), "查阅报告时仍能补充");
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: directory + "/docked-report.png" });
  await back().click();
  await dialog().waitFor({state:"detached"});
  assert.equal(await composer.inputValue(), "查阅报告时仍能补充");
  await composer.fill(originalDraft);
  checks.push("1440×900 报告停靠右栏，左栏输入可编辑，关闭后保留草稿");

  const wideResult = page.getByRole("dialog", {name:"查询结果", exact:true});
  const resultEntry = page.locator("#query-" + fixture.queries[1].id).getByRole("button", {name:"查看完整表格"});
  await resultEntry.click();
  await wideResult.getByRole("region", {name:"查询结果表格", exact:true}).waitFor();
  assert.equal(await wideResult.evaluate(element => element.matches(":modal")), false);
  const resultTable = wideResult.getByRole("region", {name:"查询结果表格", exact:true});
  assert.equal(await resultTable.locator("tbody tr").count(), 100, "宽表使用完整结果页");
  await wideResult.getByText("列统计 · 本页 100 行", {exact:true}).click();
  const columnStats = wideResult.getByRole("region", {name:"查询列统计"});
  const points = columnStats.getByRole("listitem").filter({has:page.getByText("point", {exact:true})});
  for (const label of ["最小", "最大", "空值", "不同值"])
    await points.getByText(label, {exact:true}).waitFor();
  assert.deepEqual(await points.locator("dd").allTextContents(), ["1", "100", "0", "100"]);
  await wideResult.getByRole("button", {name:"下一页", exact:true}).click();
  await wideResult.getByText("第 2 页 · 100 行", {exact:true}).waitFor();
  await wideResult.getByText("列统计 · 本页 100 行", {exact:true}).click();
  assert.deepEqual(await points.locator("dd").allTextContents(), ["101", "200", "0", "100"]);
  await wideResult.getByRole("button", {name:"下一页", exact:true}).click();
  await wideResult.getByText("第 3 页 · 5 行", {exact:true}).waitFor();
  assert.equal(await resultTable.locator("tbody tr").count(), 5);
  await wideResult.getByText("列统计 · 本页 5 行", {exact:true}).click();
  assert.deepEqual(await points.locator("dd").allTextContents(), ["201", "205", "0", "5"]);
  await wideResult.getByRole("button", {name:"上一页", exact:true}).click();
  await wideResult.getByText("第 2 页 · 100 行", {exact:true}).waitFor();
  const exported = page.waitForEvent("download");
  await wideResult.getByRole("link", {name:/下载 CSV/}).click();
  const file = await readFile(await (await exported).path());
  assert.deepEqual([...file.subarray(0,3)], [239,187,191], "CSV 含 UTF-8 BOM");
  assert.equal(file.toString("utf8").trimEnd().split("\r\n").length, 206, "CSV 包含列头和 205 条实际结果");
  await wideResult.getByRole("button", {name:"返回对话", exact:true}).last().click();
  await wideResult.waitFor({state:"detached"});
  checks.push("宽表停靠展示完整页和真实列统计，浏览器下载带 BOM 的全部 205 条真实结果");

  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  assert.ok(
    await dialog().evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  await dialog()
    .locator(".modal-body")
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  const mobileBack = await back().boundingBox();
  assert.ok(mobileBack.y >= 0 && mobileBack.y + mobileBack.height <= 844);
  await page.screenshot({ path: directory + "/mobile.png" });
  await back().click();
  await dialog().waitFor({ state: "detached" });
  assert.ok(
    await entry().evaluate((element) => element === document.activeElement),
  );
  checks.push(
    "390px报告窗口无页面横向溢出，正文滚动后返回入口仍可见，关闭恢复原入口焦点",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  let delayNext = true;
  let heldResolve;
  const held = new Promise((resolve) => {
    heldResolve = resolve;
  });
  const blocker = new Promise((resolve) => {
    releaseDelayed = resolve;
  });
  let heldRequest;
  const reportRoute = async (route) => {
    let handled;
    if (delayNext && route.request().method() === "GET") {
      delayedHandlerDone = new Promise((resolve) => {
        handled = resolve;
      });
      delayNext = false;
      heldRequest = route.request();
      heldResolve();
    }
    try {
      if (handled) await blocker;
      await route.continue();
    } catch (error) {
      const failure = route.request().failure();
      if (!failure || !/ERR_ABORTED/.test(failure.errorText)) errors.push("延迟请求处理失败：" + error.message);
    } finally {
      if (handled) handled();
    }
  };
  await page.route("**/tasks/*/report", reportRoute);
  await entry().click();
  await held;
  await dialog().waitFor();
  await back().click();
  await dialog().waitFor({ state: "detached" });
  await selectConversation("另一段报告浏览对话");
  await page.getByText("这是另一段独立对话。", { exact: true }).waitFor();
  releaseDelayed();
  await delayedHandlerDone;
  const lateResponse = await heldRequest.response();
  if (lateResponse) assert.equal(lateResponse.status(), 200);
  else assert.match(heldRequest.failure()?.errorText ?? "", /ERR_ABORTED/);
  pollingDiagnostics.closedRead = lateResponse ? { status: lateResponse.status() } : { canceled: heldRequest.failure() };
  await page.unroute("**/tasks/*/report", reportRoute);
  assert.equal(
    await page.getByRole("dialog", { name: "分析报告", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("heading", { name: title, exact: true }).count(),
    0,
  );
  assert.equal(await entry().count(), 0);
  await selectConversation("一季度分析报告");
  await entry().waitFor();
  await open();
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  checks.push(
    "关闭加载窗口后切换真实会话，释放原报告GET的真实迟到响应不会恢复旧窗口或私人正文；返回原对话可重新打开",
  );

  const setPermissions = async denied => {
    const response = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/permissions", {
      method: "POST",
      headers: { authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({space_id: "demo", denied_query_users: denied}),
    });
    assert.equal(response.status, 200, "平台撤权及变更事件已提交");
  };
  const queryCard = page.locator("#query-" + fixture.queries[0].id);
  await queryCard.getByRole("region", {name: "查询结果表格"}).waitFor();
  pollingDiagnostics.permission = { before: ok(await h.request(reportPath())).status };
  try {
    await setPermissions(["alice"]);
    const forbiddenCsv = await fetch(h.env.DATA_AGENT_API_URL + "/queries/" + fixture.queries[0].id + "/export.csv",
      {headers:{authorization:"Bearer " + h.tokens.alice}});
    assert.equal(forbiddenCsv.status, 403, "撤权后的 CSV 直接请求必须拒绝");
    assert.equal(forbiddenCsv.headers.get("content-disposition"), null);
    await forbiddenCsv.arrayBuffer();
    const denied = ok(await h.request(reportPath()));
    assert.equal(denied.status, "sources_unavailable");
    assert.equal(Object.hasOwn(denied, "report"), false);
    pollingDiagnostics.permission.denied = denied.status;
    // 不触发 focus 或重开。平台主动通知撤权，报告与查询卡同时重核。
    await dialog().getByRole("heading", { name: "报告依据暂不可用", exact: true }).waitFor();
    assert.equal(await dialog().locator(".analysis-report-body").count(), 0);
    assert.equal(await dialog().getByRole("img").count(), 0);
    await queryCard.getByText("当前无权读取此查询结果。", {exact:true}).waitFor();
    assert.equal(await queryCard.getByRole("region", {name:"查询结果表格"}).count(), 0);
    assert.ok(!(await dialog().innerText()).includes("9007199254740993.01"));
    await page.screenshot({ path: directory + "/permission-denied.png" });
  } catch (error) {
    pollingDiagnostics.permission.deniedDialog = await dialog().innerText();
    await page.screenshot({ path: directory + "/permission-denied-failure.png" });
    throw error;
  } finally {
    await setPermissions([]);
  }
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  await until(async () => await dialog().getByRole("img").count() === 2, "恢复权限事件恢复全部图表");
  assert.ok((await dialog().innerText()).includes("9007199254740993.01"));
  pollingDiagnostics.permission.restored = ok(await h.request(reportPath())).status;
  await queryCard.getByRole("region", {name:"查询结果表格"}).waitFor();
  checks.push("保持报告和查询卡打开，平台权限事件撤下报告正文、图表及查询结果，CSV 返回 403，恢复后自动读回");

  let refreshHeld = false, releaseRefresh, refreshError;
  let activeReads = 0, maxActiveReads = 0;
  const refreshStarts = [];
  const refreshBlocker = new Promise(resolve => { releaseRefresh = resolve; });
  const refreshRoute = async route => {
    const index = refreshStarts.push(Date.now()) - 1;
    ++activeReads; maxActiveReads = Math.max(maxActiveReads, activeReads);
    try {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      if (index === 0) { refreshHeld = true; await refreshBlocker; }
      await route.fulfill({ response });
    } catch (error) { refreshError = error; }
    finally { --activeReads; }
  };
  await page.route("**/api" + reportPath(), refreshRoute);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(() => refreshHeld || refreshError, "普通刷新真实请求已到达受控慢读取");
    if (refreshError) throw refreshError;
    await page.evaluate(() => {
      for (let index = 0; index < 3; index++) {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    await page.waitForTimeout(2400);
    assert.equal(refreshStarts.length, 1, "同一在途读取期间 focus 与 visibility 不重复发出请求");
    assert.equal(maxActiveReads, 1);
    assert.equal(await dialog().locator(".analysis-report-body").count(), 1, "普通慢读取期间保留当前合法正文，避免阅读位置闪动");
    const releasedAt = Date.now(); releaseRefresh();
    await until(() => activeReads === 0 || refreshError, "慢读取完成");
    await page.waitForTimeout(2400);
    assert.equal(refreshStarts.length, 1, "前次读取完成后空闲不再定时重读");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(() => refreshStarts.length === 2 && activeReads === 0 || refreshError, "重新聚焦核对");

    if (refreshError) throw refreshError;
    assert.equal(maxActiveReads, 1);
    pollingDiagnostics.singleRead = { refreshStarts, releasedAt, maxActiveReads };
  } finally {
    releaseRefresh();
    await until(() => activeReads === 0, "受控报告读取清理完成");
    await page.unroute("**/api" + reportPath(), refreshRoute);
  }
  checks.push("focus 与 visibility 复核共用一次在途读取，慢读期间保留正文，空闲时没有后续请求");

  fixture.alterExpiry(fixture.queries[0], Date.now() / 1000 - 1);
  // 结果过期只局部受影响（04切片7）：报告仍available，过期图表数据省略并提示，正文与其余图表保留。
  assert.equal((await focusRefresh()).status, "available");
  await dialog()
    .getByText(/该图表的数据暂不可用/)
    .waitFor();
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  assert.equal(await dialog().getByRole("img").count(), 1);
  // 正文与figure保留的记录数字仍在；只有过期图表的数据点被省略（不整份隐藏）。
  assert.ok((await dialog().innerText()).includes("9007199254740993.01"));
  await page.screenshot({ path: directory + "/expired.png" });
  fixture.alterExpiry(fixture.queries[0], Date.now() / 1000 + 86400);
  assert.equal((await focusRefresh()).status, "available");
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  await until(async () => await dialog().getByRole("img").count() === 2, "TTL恢复后的合并刷新呈现完整图表");
  checks.push(
    "窗口刷新通过真实平台TTL核验；结果过期只省略该图表数据并提示，正文与其余图表保留，恢复后回到完整（focus为受控事件）",
  );

  await fixture.begin(cid, "只看app，更新本次分析条件，先不要执行。");
  fixture.task = await fixture.invoke("update_analysis_task", {
    action: "revise",
    task_id: fixture.task.task_id,
    expected_version: fixture.task.condition_version,
    goal: "app新条件报告",
    condition_patch: { set: { channel: "app" }, unset: [] },
    options: [],
  });
  await fixture.finish("已更新条件，需要采用新条件分析后再保存报告。");
  await dialog()
    .getByText(/分析条件已更新/)
    .waitFor();
  // 条件变更按历史记录展示（04切片7）：正文与图表保留并明确仅供回顾，不整份清空。
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  assert.ok((await dialog().innerText()).includes("9007199254740993.01"));
  assert.ok((await dialog().innerText()).includes("仅供回顾"));
  await page.screenshot({ path: directory + "/condition-changed.png" });
  await back().click();
  await dialog().waitFor({ state: "detached" });
  assert.equal(
    await page.getByLabel("你的数据问题").inputValue(),
    "这个补充尚未发送",
  );
  checks.push(
    "真实任务条件变更事件使已打开报告按历史记录展示：提示条件已更新并保留已存正文与图表仅供回顾；后台输入与未发送草稿保留",
  );

  // 条件变化后重开：正文未核验完成前只提示条件已更新，不声称"以下为已存内容"；
  // 真实响应核验通过后才出现已存正文说明。
  let holdChangedRead = true;
  let changedHeld;
  const changedHeldPromise = new Promise((resolve) => { changedHeld = resolve; });
  let changedRelease;
  const changedBlocker = new Promise((resolve) => { changedRelease = resolve; });
  let changedHandlerDone;
  const changedReadRoute = async (route) => {
    let handled;
    if (holdChangedRead && route.request().method() === "GET") {
      changedHandlerDone = new Promise((resolve) => { handled = resolve; });
      holdChangedRead = false;
      changedHeld();
    }
    try {
      if (handled) await changedBlocker;
      await route.continue();
    } finally { if (handled) handled(); }
  };
  await page.route("**/tasks/*/report", changedReadRoute);
  await entry().click();
  await changedHeldPromise;
  await dialog().getByText(/分析条件已更新/).waitFor();
  assert.ok(!(await dialog().innerText()).includes("以下为已存内容"),
    "正文未经本次核验前不得声称以下为已存内容");
  changedRelease();
  await changedHandlerDone;
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  assert.ok((await dialog().innerText()).includes("以下为已存内容"),
    "真实响应核验后才声明已存内容");
  await page.screenshot({ path: directory + "/condition-changed-reopen.png" });
  await page.unroute("**/tasks/*/report", changedReadRoute);
  await back().click();
  await dialog().waitFor({ state: "detached" });
  checks.push("条件变化报告重开：加载期间只提示条件已更新，真实正文核验通过后才声明以下为已存内容");

  let failHistoricalRead = true;
  const historicalReadRoute = async (route) => {
    if (failHistoricalRead && route.request().method() === "GET") {
      // 按AppError合同构造合法服务错误；坏响应另设场景分开报告。
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        code: "unavailable", message: "合成服务暂不可用", request_id: randomUUID(), retryable: true }) });
    } else await route.continue();
  };
  await page.route("**/tasks/*/report", historicalReadRoute);
  await entry().click();
  await dialog().getByRole("alert").getByText("暂时无法核对报告与数据依据，请重试。", { exact: true }).waitFor();
  assert.equal(await dialog().getByRole("heading", { name: title, exact: true }).count(), 0);
  failHistoricalRead = false;
  const retriedReport = page.waitForResponse(isReport);
  await dialog().getByRole("button", { name: "重新读取报告", exact: true }).click();
  assert.equal((await retriedReport).status(), 200);
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  assert.ok((await dialog().innerText()).includes("9007199254740993.01"));
  assert.ok((await dialog().innerText()).includes("仅供回顾"));
  await page.unroute("**/tasks/*/report", historicalReadRoute);
  await back().click();
  await dialog().waitFor({ state: "detached" });
  checks.push("旧条件报告读取失败显示错误与重试；重试从真实API恢复原报告正文和历史提示");

  // 非合同坏响应与合法服务错误分开：解码失败分支同样只显示错误与重试。
  let failMalformedRead = true;
  const malformedReadRoute = async (route) => {
    if (failMalformedRead && route.request().method() === "GET") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ oops: true }) });
    } else await route.continue();
  };
  await page.route("**/tasks/*/report", malformedReadRoute);
  await entry().click();
  await dialog().getByRole("alert").getByText("暂时无法核对报告与数据依据，请重试。", { exact: true }).waitFor();
  failMalformedRead = false;
  await dialog().getByRole("button", { name: "重新读取报告", exact: true }).click();
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  await page.unroute("**/tasks/*/report", malformedReadRoute);
  await back().click();
  await dialog().waitFor({ state: "detached" });
  checks.push("非合同503坏响应单独场景：解码失败同样显示错误与重试，重试经真实API恢复");

  const activityCid = await h.create();
  const activityPrompt = "选取这张合成表并核对一项业务定义";
  await fixture.begin(activityCid, activityPrompt);
  const activityTask = await fixture.invoke("update_analysis_task", {
    action:"create", goal:"核对合成表定义", options:[],
    conditions:{...fixture.conditions, time_start:null, time_end:null, metric:null, group_by:[], filters:[], notes:""},
  });
  const table = ok(await h.request("/knowledge/table-demo_order_detail"));
  const description = table.entries.find(item => item.path === "description");
  const tableRef = {object_id:table.id, version:table.version, path:description.path};
  const sourceQuery = await fixture.invoke("request_query", {
    task_id: activityTask.task_id, condition_version: activityTask.condition_version,
    sql:"SELECT COUNT(*) AS row_count FROM demo_order_detail", parameters:{},
    target_id:"synthetic-sqlite", summary:"核对正式表说明的查询。", knowledge_refs:[tableRef],
    replaces_query_id:null,
  });
  await page.reload();
  await selectConversation(activityPrompt);
  const progress = page.getByRole("region", {name:"运行进度", exact:true});
  await progress.waitFor();
  const read = await fixture.invoke("read_knowledge", {items:[{kind:"knowledge", ref:tableRef}]});
  assert.equal(read.items[0].state, "ok");
  await progress.getByText("正在阅读知识对象", {exact:true}).waitFor();
  await progress.getByText(/已完成 [1-9][0-9]* 步/).click();
  const renderedSteps = progress.getByRole("list", {name:"已完成的运行步骤"}).getByRole("listitem");
  const readStep = renderedSteps.filter({hasText:/阅读知识对象/});
  await readStep.waitFor();
  assert.match(await readStep.innerText(), /\d+ ms/);
  assert.ok((await readStep.innerText()).includes(table.name));
  const sourceCard = page.locator("#query-" + sourceQuery.id);
  await sourceCard.getByText("查看口径依据", {exact:true}).click();
  await sourceCard.getByRole("button", {name:new RegExp(table.name)}).click();
  const sourcePanel = page.getByRole("dialog", {name:"口径依据", exact:true});
  await sourcePanel.getByRole("heading", {name:table.name, exact:true}).waitFor();
  assert.equal(await sourcePanel.evaluate(element => element.matches(":modal")), false);
  assert.ok((await sourcePanel.boundingBox()).x > (await composer.boundingBox()).x);
  await sourcePanel.getByRole("button", {name:"返回对话", exact:true}).click();
  await sourcePanel.waitFor({state:"detached"});
  checks.push("真实查询的口径依据在大屏打开右栏，保留左侧输入");
  await fixture.finish("已核对合成表定义。");
  await progress.waitFor({state:"detached"});
  checks.push("活跃运行显示最新读取动作，展开已完成步骤可见真实授权表名和毫秒用时");

  const graph = ok(await h.request("/knowledge/" + table.id + "/lineage"));
  assert.ok(graph.upstream.length && graph.downstream.length, "实际血缘包含上下游");
  await page.getByRole("navigation", {name:"主导航"}).getByRole("button", {name:"语义管理"}).click();
  const tableEntry = page.getByRole("navigation", {name:"语义对象"}).getByRole("button", {name:new RegExp(table.name)});
  await tableEntry.click();
  await page.getByRole("tab", {name:"血缘与加工"}).click();
  const lineage = page.getByRole("group", {name:"血缘流向", exact:true});
  await lineage.getByRole("region", {name:"上游来源表"}).getByRole("button", {name:graph.upstream[0].name, exact:true}).waitFor();
  await lineage.getByRole("region", {name:"当前对象"}).getByText(table.name, {exact:true}).waitFor();
  await lineage.getByRole("region", {name:"下游指标与受影响资产"}).getByRole("button", {
    name:graph.downstream.find(edge => edge.kind !== "skill").name, exact:true,
  }).waitFor();
  assert.equal(await lineage.locator("svg").count(), 2);
  const setTableReaders = async table_readers => {
    const response = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/permissions", {
      method:"POST",
      headers:{authorization:"Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type":"application/json"},
      body:JSON.stringify({space_id:"demo", denied_query_users:[], table_readers}),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  };
  try {
    await setTableReaders({alice:["raw_payments"]});
    const hiddenGraph = await h.request("/knowledge/" + table.id + "/lineage");
    assert.equal(hiddenGraph.status, 404, "撤销本表读权后的血缘端点不泄露对象");
    assert.ok(!JSON.stringify(hiddenGraph.value).includes(table.name));
  } finally {
    await setTableReaders({});
  }
  assert.equal((await h.request("/knowledge/" + table.id + "/lineage")).status, 200);
  checks.push("真实语义对象渲染三栏及 SVG 流向，撤销当前表读权返回 404，恢复后重新可读");

  await page.getByRole("navigation", {name:"主导航"}).getByRole("button", {name:"工作台"}).click();
  await logoutWorkspace(page);
  await page.getByLabel("演示登录凭据").fill(h.tokens.bob);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await page.getByLabel("你的数据问题").waitFor();
  assert.equal(await entry().count(), 0);
  assert.equal(
    await page.getByRole("heading", { name: title, exact: true }).count(),
    0,
  );
  assert.equal((await h.request(reportPath(), undefined, "bob")).status, 404);
  checks.push("切换到另一用户不会保留本人的报告入口/正文，真实API也拒绝读取");
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} catch (error) {
  errors.push("场景失败：" + error.message);
  throw error;
} finally {
  if (releaseDelayed) releaseDelayed();
  if (delayedHandlerDone) await delayedHandlerDone;
  if (!passed)
    await page
      .screenshot({ path: directory + "/failure.png" })
      .catch((error) => errors.push(error.message));
  await writeFile(
    directory + "/result.json",
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        responses,
        focusDiagnostics,
        layoutDiagnostics,
        pollingDiagnostics,
        officialRequests: 0,
        scope:
          "真实浏览器、Rust/MySQL与合成SQLite；网络受控延迟、503与焦点事件，不替换报告成功响应",
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await fixture.close();
}
