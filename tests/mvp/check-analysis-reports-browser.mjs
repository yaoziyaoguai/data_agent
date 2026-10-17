import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createReportFixture, ok } from "./check-analysis-reports.mjs";
import { logoutWorkspace } from "./experience-navigation.mjs";

const directory = ".local/checks/analysis-reports-browser";
await mkdir(directory, { recursive: true });
const fixture = await createReportFixture({ web: true });
const { h, cid, evidence, chart, reportPath, saveInput } = fixture;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const focusDiagnostics = [];
const layoutDiagnostics = [];
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
        ],
        charts: [
          chart(0),
          chart(1, { title: "205个合成分类点" }),
          chart(4, { kind: "bar", title: "精确金额对照" }),
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
    "真实聊天报告入口读到完整205点与原精确金额；正文不堆版本/技术ID；滚动、Tab圈与Escape返回保持原焦点和草稿",
  );

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
  const reportRoute = async (route) => {
    let handled;
    if (delayNext && route.request().method() === "GET") {
      delayedHandlerDone = new Promise((resolve) => {
        handled = resolve;
      });
      delayNext = false;
      heldResolve();
    }
    try {
      if (handled) await blocker;
      await route.continue();
    } catch (error) {
      errors.push("延迟请求处理失败：" + error.message);
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
  const lateResponse = page.waitForResponse(
    (response) =>
      isReport(response) && new URL(response.url()).pathname.includes(cid),
  );
  releaseDelayed();
  await delayedHandlerDone;
  assert.equal((await lateResponse).status(), 200);
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

  fixture.alterExpiry(fixture.queries[0], Date.now() / 1000 - 1);
  assert.equal((await focusRefresh()).status, "sources_unavailable");
  await dialog()
    .getByText(/报告依据暂不可用/)
    .waitFor();
  assert.equal(
    await dialog().getByRole("heading", { name: title, exact: true }).count(),
    0,
  );
  assert.equal(await dialog().getByRole("img").count(), 0);
  assert.ok(!(await dialog().innerText()).includes("134000"));
  assert.ok(!(await dialog().innerText()).includes("9007199254740993.01"));
  await page.screenshot({ path: directory + "/expired.png" });
  fixture.alterExpiry(fixture.queries[0], Date.now() / 1000 + 86400);
  assert.equal((await focusRefresh()).status, "available");
  await dialog().getByRole("heading", { name: title, exact: true }).waitFor();
  checks.push(
    "窗口刷新通过真实平台TTL核验；来源失效立即清理旧标题、数字和图表，只显示不可用说明（focus为受控事件）",
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
  assert.equal(await dialog().getByRole("img").count(), 0);
  assert.equal(
    await dialog().getByRole("heading", { name: title, exact: true }).count(),
    0,
  );
  assert.ok(!(await dialog().innerText()).includes("134000"));
  await page.screenshot({ path: directory + "/condition-changed.png" });
  await back().click();
  await dialog().waitFor({ state: "detached" });
  assert.equal(
    await page.getByLabel("你的数据问题").inputValue(),
    "这个补充尚未发送",
  );
  checks.push(
    "真实任务条件变更事件使已打开报告清掉旧正文与图表，说明需新分析；后台输入与未发送草稿保留",
  );

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
        officialRequests: 0,
        scope:
          "真实浏览器、Rust/MySQL与合成SQLite；网络仅受控延迟/焦点事件，不替换报告成功响应",
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await fixture.close();
}
