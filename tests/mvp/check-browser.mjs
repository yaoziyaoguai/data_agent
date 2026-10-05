import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { harness, until } from "./harness.mjs";
const h = await harness({ web: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();
const checks = [];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (name) => checks.push({ name, passed: true });
let passed = false;
const screenshot = async (name) =>
  page.screenshot({
    path: ".local/checks/mvp-" + name + ".png",
    fullPage: true,
    animations: "disabled",
  });
const send = async (text) => {
  await page.getByLabel("你的数据问题").fill(text);
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
};
try {
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await page.getByRole("heading", { name: "把数据问题， 说清楚。" }).waitFor();
  await screenshot("welcome-desktop");
  await send("查2026年1月净收入");
  await page.getByRole("button", { name: "执行查询", exact: true }).waitFor();
  const sql = page.getByRole("region", { name: /SQL草稿版本/ }).first();
  assert.match(await sql.locator("pre").innerText(), /is_test = 0/);
  await page.reload();
  await page.getByRole("button", { name: "执行查询", exact: true }).waitFor();
  await screenshot("sql-desktop");
  check("正式页面登录、提问、展示完整SQL，刷新接回待确认草稿");
  let releaseSave;
  let savedResponse;
  const saved = new Promise(r => { savedResponse=r; });
  const delayed = new Promise(r => { releaseSave=r; });
  await page.route("**/api/conversations/*/messages", async route => {
    const response = await route.fetch();
    savedResponse();
    await delayed;
    await route.fulfill({ response });
  }, { times:1 });
  await send("谢谢");
  await saved;
  await page.getByLabel("你的数据问题").fill("保存期间写下的新草稿");
  releaseSave();
  await page.getByRole("button", {name:"发送 ↑",exact:true}).waitFor();
  assert.equal(await page.getByLabel("你的数据问题").inputValue(),"保存期间写下的新草稿");
  await page.reload();
  assert.equal(await page.getByLabel("你的数据问题").inputValue(),"保存期间写下的新草稿");
  await page.getByLabel("你的数据问题").fill("");
  check("同会话保存回执迟到时不清掉新草稿，刷新后仍保留");
  await page.getByRole("button", { name: "执行查询", exact: true }).click();
  await page.getByRole("button", { name: "查看结果", exact: true }).waitFor();
  await page.getByRole("button", { name: "查看结果", exact: true }).click();
  await page.getByRole("cell", { name: "12400", exact: true }).waitFor();
  await page.getByRole("button", { name: "图表", exact: true }).click();
  await page.getByRole("img", { name: "查询结果柱状图" }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /导出此查询/ }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /csv$/);
  assert.equal(await download.failure(), null);
  await screenshot("result-desktop");
  check("用户确认后取数，独立参考12400分、图表与同查询CSV可读取");
  await send("查2026年1月支付客户数");
  await page.getByRole("button", { name: "执行查询", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("region", { name: /SQL草稿版本/ }).count(),
    2,
  );
  await page.getByLabel("你的数据问题").fill("未发送的补充");
  await page.getByRole("button", { name: "语义管理", exact: false }).click();
  await page.getByRole("heading", { name: "语义管理", exact: true }).waitFor();
  await page
    .locator(".object-list button")
    .filter({ hasText: "demo_order_detail" })
    .click();
  const description = page
    .locator(".semantic-entry")
    .filter({ has: page.locator(".entry-head strong", { hasText: "表含义" }) })
    .first();
  await page.getByLabel("搜索语义对象").fill("demo_order_detail");
  const searchTable=page.locator('.object-list button').filter({hasText:'demo_order_detail'}).first();
  await searchTable.waitFor();
  const preferenceSwitch=page.getByRole("switch",{name:"常用表优先分析"});
  await preferenceSwitch.waitFor();
  assert.equal(await preferenceSwitch.getAttribute("aria-checked"),"false");
  let releaseOldPreference;
  let oldPreferenceArrived;
  const oldPreferenceReady=new Promise(r=>{oldPreferenceArrived=r;});
  const oldPreferenceDelay=new Promise(r=>{releaseOldPreference=r;});
  await page.route("**/api/knowledge/table-demo_order_detail",async route=>{
    const response=await route.fetch();oldPreferenceArrived();await oldPreferenceDelay;await route.fulfill({response});
  },{times:1});
  await oldPreferenceReady;
  await preferenceSwitch.click();
  await until(async()=>await preferenceSwitch.getAttribute("aria-checked")==="true","常用范围已保存");
  releaseOldPreference();
  await page.waitForTimeout(250);
  assert.equal(await preferenceSwitch.getAttribute("aria-checked"),"true");
  assert.match(await searchTable.innerText(),/常用/);
  assert.equal((await h.request('/knowledge/table-demo_order_detail')).value.analysis_preference.preferred,true);
  await preferenceSwitch.click();
  await until(async()=>await preferenceSwitch.getAttribute("aria-checked")==="false","常用范围已关闭");
  assert.doesNotMatch(await searchTable.innerText(),/常用/);
  await page.getByLabel("搜索语义对象").fill("");
  check("常用表开关持久保存、目录标识更新，晚到旧轮询不回退配置，关闭仍保留语义");
  let releaseOldKnowledge;
  let oldKnowledgeArrived;
  const oldKnowledgeReady = new Promise(r => { oldKnowledgeArrived = r; });
  const oldKnowledgeDelay = new Promise(r => { releaseOldKnowledge = r; });
  await page.route(/\/api\/knowledge$/, async route => {
    const response = await route.fetch();
    oldKnowledgeArrived();
    await oldKnowledgeDelay;
    await route.fulfill({ response });
  }, { times: 1 });
  await oldKnowledgeReady;
  await description.getByRole("button", { name: "编辑", exact: true }).click();
  await description.getByRole("textbox").fill("人工核对：订单商品行");
  await description
    .getByRole("button", { name: "保存修改", exact: true })
    .click();
  await description.getByText("人工修改", { exact: true }).waitFor();
  releaseOldKnowledge();
  await page.waitForTimeout(250);
  assert.equal(await description.locator(".entry-value").innerText(), "人工核对：订单商品行");
  check("保存后旧轮询响应晚到不回退语义值和版本");
  await page.getByRole("tab", { name: "字段语义", exact: true }).click();
  assert.ok((await page.locator(".semantic-object details").count()) > 1);
  await page
    .locator(".semantic-object details")
    .first()
    .locator(":scope > summary")
    .click();
  await screenshot("knowledge-desktop");
  check("语义可人工编辑并标记，字段语义完整展开");
  await page
    .getByRole("button", { name: "工作台", exact: false })
    .first()
    .click();
  await until(async () => await page.getByLabel("你的数据问题").inputValue() === "未发送的补充", "draft restored");
  check("页面切换保留当前对话及未发送草稿");
  await page.getByRole("button", { name: "我的积累", exact: false }).click();
  await page.getByRole("tab", { name: /我的 Skill/ }).click();
  await page.getByRole("button", { name: "新增Skill", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("渠道分析方法");
  await page.getByLabel("适用范围与例外").fill("订单收入分析");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("heading", { name: "渠道分析方法" }).waitFor();
  await screenshot("assets-desktop");
  await page.getByRole("button", { name: "在当前对话选用" }).click();
  await page.getByLabel("你的数据问题").waitFor();
  await page.getByRole("button", { name: "查看全部会话 ↗" }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  check("个人Skill录入、明确选用、工作台历史弹层与Escape关闭");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("workbench-mobile");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.getByRole("button", { name: "我的积累", exact: false }).click();
  await page.getByRole("heading", { name: "我的积累", exact: true }).waitFor();
  await page.getByRole("tab", { name: /我的 Skill/ }).click();
  await page.getByRole("heading", { name: "渠道分析方法" }).waitFor();
  await screenshot("assets-mobile");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.getByRole("button", { name: "语义管理", exact: false }).click();
  await page.locator(".object-list button").filter({ hasText: "demo_order_detail" }).click();
  await page.getByRole("heading", { name: "demo_order_detail", exact: true }).waitFor();
  await page.getByText("人工核对：订单商品行", { exact: true }).waitFor();
  await screenshot("knowledge-mobile");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  check("手机三个正式入口可操作，页面无整体横向溢出");
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} finally {
  await writeFile(
    ".local/checks/mvp-browser.json",
    JSON.stringify({ passed, checks, errors }, null, 2),
  );
  await browser.close();
  await h.close();
}
