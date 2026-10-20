import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { harness } from "./harness.mjs";

const output = ".local/checks/knowledge-authoring-browser";
await mkdir(output, {recursive: true});
const h = await harness({web: true, startWorker: false, capture: true});
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const checks = [];
let passed = false;
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response)); return response.value; };
const create = async (name, extras = {}) => ok(await h.request("/knowledge", {
  operation_id: randomUUID(), kind: "document", name, body: "完全合成的文档内容", related_ids: [], ...extras,
}));
const read = async id => ok(await h.request(`/knowledge/${id}`));
const domain = object => object.entries.find(entry => entry.path === "business_domain");
try {
  const objects = [];
  for (let index = 0; index < 105; index++) objects.push(await create(`PickerDense ${String(index).padStart(3, "0")}`));
  const alternate = await create("UniqueAlternate");
  const firstPage = ok(await h.request("/knowledge?directory=all&state=enabled&q=PickerDense"));
  assert.equal(firstPage.objects.length, 100);
  assert.ok(firstPage.next_after_id);
  const lastPage = ok(await h.request(`/knowledge?directory=all&state=enabled&q=PickerDense&after_id=${firstPage.next_after_id}`));
  assert.equal(lastPage.objects.length, 5);
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", {name: "进入工作台 →", exact: true}).click();
  await page.getByRole("button", {name: /语义管理/}).click();
  await page.getByRole("button", {name: "录入业务文档", exact: true}).click();
  const dialog = page.getByRole("dialog", {name: "录入业务文档", exact: true});
  await dialog.getByLabel("文档名称", {exact: true}).fill("浏览器创建的有域资料");
  await dialog.getByLabel("正文（支持 Markdown 章节）", {exact: true}).fill("人工确认的完全合成说明");
  await dialog.getByLabel("业务域（可选）", {exact: true}).fill("合成物流");
  const picker = dialog.locator(".knowledge-picker");
  // 从表详情发起录入会预选当前表；本回归单独验证后续跨页选择集合。
  while (await picker.getByRole("button", {name: "移除关联资料", exact: true}).count()) {
    await picker.getByRole("button", {name: "移除关联资料", exact: true}).first().click();
  }
  const search = picker.getByRole("textbox", {name: "查找表、字段或业务资料", exact: true});
  await search.fill("PickerDense");
  await picker.getByRole("button", {name: "加载更多资料", exact: true}).waitFor();
  assert.equal(await picker.locator(".knowledge-picker-results button").count(), 100);
  const select = async object => picker.locator(".knowledge-picker-results button").filter({hasText: object.name}).click();
  await select(firstPage.objects[0]);
  assert.equal(await search.inputValue(), "PickerDense");
  let failedOnce = false;
  await page.route("**/api/knowledge?*", async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("q") === "PickerDense" && params.has("after_id")) {
      if (!failedOnce) { failedOnce = true; await route.abort("failed"); return; }
      const response = await route.fetch();
      const value = await response.json();
      // 单页重叠不能导致重复按钮或重复选择。
      value.objects.unshift(firstPage.objects[1]);
      await route.fulfill({response, json: value});
      return;
    }
    await route.continue();
  });
  await picker.getByRole("button", {name: "加载更多资料", exact: true}).click();
  await picker.getByRole("button", {name: "重试查找资料", exact: true}).waitFor();
  assert.equal(await picker.locator(".knowledge-picker-results button").count(), 99);
  await picker.getByRole("button", {name: "重试查找资料", exact: true}).click();
  await picker.locator(".knowledge-picker-results button").filter({hasText: lastPage.objects[4].name}).waitFor();
  assert.equal(await picker.locator(".knowledge-picker-results button").count(), 104);
  await select(lastPage.objects[4]);
  assert.equal(await picker.getByRole("button", {name: "移除关联资料", exact: true}).count(), 2);
  checks.push("105条真实目录支持前后页多选；选择保留搜索，失败页保留前页与已选且可重试，重复页对象去重");
  await page.unroute("**/api/knowledge?*");

  // 后页在搜索范围切换后返回，不得覆盖新查询或污染新游标。
  let releaseOldPage, oldPageArrived;
  const arrived = new Promise(resolve => { oldPageArrived = resolve; });
  const release = new Promise(resolve => { releaseOldPage = resolve; });
  await search.fill("UniqueAlternate");
  await picker.locator(".knowledge-picker-results button").filter({hasText: alternate.name}).waitFor();
  await search.fill("PickerDense");
  await picker.getByRole("button", {name: "加载更多资料", exact: true}).waitFor();
  await page.route("**/api/knowledge?*", async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("q") === "PickerDense" && params.has("after_id")) {
      const response = await route.fetch(); oldPageArrived(); await release;
      await route.fulfill({response}); return;
    }
    await route.continue();
  });
  await picker.getByRole("button", {name: "加载更多资料", exact: true}).click();
  await arrived;
  await search.fill("UniqueAlternate");
  await picker.locator(".knowledge-picker-results button").filter({hasText: alternate.name}).waitFor();
  const oldPageReceived = page.waitForResponse(response => new URL(response.url()).searchParams.has("after_id") && response.url().includes("PickerDense"));
  releaseOldPage(); await oldPageReceived;
  await page.waitForTimeout(100);
  assert.equal(await picker.locator(".knowledge-picker-results button").count(), 1);
  assert.equal(await picker.getByRole("button", {name: "加载更多资料", exact: true}).count(), 0);
  assert.equal(await picker.getByRole("button", {name: "移除关联资料", exact: true}).count(), 2);
  await page.unroute("**/api/knowledge?*");
  checks.push("搜索切换隔离迟到后页，旧页不污染新结果/游标，已选择项继续保留");
  let failedFirst = false;
  await page.route("**/api/knowledge?*", async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("q") === "PickerDense" && !params.has("after_id") && !failedFirst) {
      failedFirst = true; await route.abort("failed"); return;
    }
    await route.continue();
  });
  await search.fill("PickerDense");
  await picker.getByRole("button", {name: "重试查找资料", exact: true}).waitFor();
  assert.equal(await picker.getByRole("button", {name: "移除关联资料", exact: true}).count(), 2);
  await picker.getByRole("button", {name: "重试查找资料", exact: true}).click();
  await picker.getByRole("button", {name: "加载更多资料", exact: true}).waitFor();
  assert.equal(await picker.locator(".knowledge-picker-results button").count(), 99);
  await page.unroute("**/api/knowledge?*");
  checks.push("第一页失败可独立重试，旧选择保留，恢复后仍能继续分页");

  const createdResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/knowledge");
  await dialog.getByRole("button", {name: "保存文档", exact: true}).click();
  const created = await (await createdResponse).json();
  assert.equal(domain(created).effective_value, "合成物流");
  assert.deepEqual(new Set(created.related_ids), new Set([firstPage.objects[0].id, lastPage.objects[4].id]));
  await dialog.waitFor({state: "detached"});
  const editor = page.getByRole("region", {name: `${created.name}的业务域`, exact: true});
  await editor.getByText("合成物流", {exact: true}).waitFor();
  await editor.getByRole("button", {name: "编辑业务域", exact: true}).click();
  await editor.getByLabel("业务域", {exact: true}).fill("未保存的改变");
  await editor.getByRole("button", {name: "取消业务域编辑", exact: true}).click();
  await page.getByRole("dialog", {name: "保留刚才的修改吗？", exact: true}).getByRole("button", {name: "放弃修改", exact: true}).click();
  assert.equal(domain(await read(created.id)).effective_value, "合成物流");
  await editor.getByRole("button", {name: "编辑业务域", exact: true}).click();
  await editor.getByLabel("业务域", {exact: true}).fill("合成售后");
  await editor.getByRole("button", {name: "保存业务域", exact: true}).click();
  await editor.getByText("合成售后", {exact: true}).waitFor();
  await page.reload();
  await editor.getByText("合成售后", {exact: true}).waitFor();
  await editor.getByRole("button", {name: "编辑业务域", exact: true}).click();
  await editor.getByLabel("业务域", {exact: true}).fill("");
  await editor.getByRole("button", {name: "保存业务域", exact: true}).click();
  await editor.getByText("未分类", {exact: true}).waitFor();
  assert.equal(domain(await read(created.id)).human_override.value, "");
  checks.push("正常录入可保存业务域及跨页关联；取消不修改持久状态，修改刷新后保留，清空显式保存为未分类");
  await page.screenshot({path: output + "/domain-cleared.png", fullPage: true});

  // 未设置业务域的历史文档仍可补录；普通读者看得到归属但不能修改。
  await page.goto(h.url + "/#knowledge?" + new URLSearchParams({object: alternate.id, scope: "all", tab: "概览"}));
  await page.reload();
  const legacyEditor = page.getByRole("region", {name: `${alternate.name}的业务域`, exact: true});
  await legacyEditor.getByRole("button", {name: "编辑业务域", exact: true}).click();
  await legacyEditor.getByLabel("业务域", {exact: true}).fill("旧文档补录范围");
  await legacyEditor.getByRole("button", {name: "保存业务域", exact: true}).click();
  await legacyEditor.getByText("旧文档补录范围", {exact: true}).waitFor();
  const reader = await browser.newPage();
  await reader.goto(h.url);
  await reader.getByLabel("演示登录凭据").fill(h.tokens.bob);
  await reader.getByRole("button", {name: "进入工作台 →", exact: true}).click();
  await reader.getByLabel("你的数据问题").waitFor();
  await reader.goto(h.url + "/#knowledge?" + new URLSearchParams({object: alternate.id, scope: "all", tab: "概览"}));
  await reader.reload();
  const readonly = reader.getByRole("region", {name: `${alternate.name}的业务域`, exact: true});
  await readonly.getByText("旧文档补录范围", {exact: true}).waitFor();
  assert.equal(await readonly.getByRole("button", {name: "编辑业务域", exact: true}).count(), 0);
  checks.push("历史无域文档可在详情补录；普通读者只读，维护权仍由服务端与页面共同呈现");
  await reader.close();

  const grouped = ok(await h.request("/knowledge/document-guide-1/document"));
  assert.ok(grouped.parts.length > 1);
  const [firstPart, secondPart] = grouped.parts;
  await page.goto(h.url + "/#knowledge?" + new URLSearchParams({object: firstPart.id, scope: "all", tab: "概览"}));
  await page.reload();
  await page.getByText("章节业务域", {exact: true}).click();
  const partEditor = page.getByRole("region", {name: `${firstPart.name}的业务域`, exact: true});
  await partEditor.getByRole("button", {name: "编辑业务域", exact: true}).click();
  await partEditor.getByLabel("业务域", {exact: true}).fill("合成章节范围");
  await partEditor.getByRole("button", {name: "保存业务域", exact: true}).click();
  await partEditor.getByText("合成章节范围", {exact: true}).waitFor();
  assert.equal((await read(secondPart.id)).version, secondPart.version);
  assert.equal(domain(await read(secondPart.id)).effective_value, domain(secondPart).effective_value);
  await page.getByRole("button", {name: "编辑文档", exact: true}).click();
  const documentDialog = page.getByRole("dialog", {name: `编辑文档 · ${grouped.title}`, exact: true});
  await documentDialog.getByLabel("文档正文", {exact: true}).fill(grouped.body + "\n\n补充完全合成的全文维护说明。\n");
  await documentDialog.getByRole("button", {name: "保存文档", exact: true}).click();
  await documentDialog.waitFor({state: "detached"});
  assert.equal(domain(await read(firstPart.id)).effective_value, "合成章节范围");
  assert.equal(domain(await read(secondPart.id)).effective_value, domain(secondPart).effective_value);
  await partEditor.getByRole("button", {name: "编辑业务域", exact: true}).click();
  await partEditor.getByRole("button", {name: "清除业务域人工覆盖", exact: true}).click();
  await partEditor.getByText(domain(firstPart).effective_value, {exact: true}).first().waitFor();
  assert.equal(domain(await read(firstPart.id)).human_override, null);
  checks.push("组合文档每个章节独立维护业务域；修改一个章节不传播到其它章节，全文保存保留各自人工层，清除覆盖恢复来源");
  await page.screenshot({path: output + "/grouped-document-domain.png", fullPage: true});
  passed = true;
} finally {
  if (!passed) await page.screenshot({path: output + "/failure.png", fullPage: true});
  await writeFile(output + "/report.json", JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
  await browser.close(); await h.close();
  console.log(JSON.stringify({passed, checks}));
}
