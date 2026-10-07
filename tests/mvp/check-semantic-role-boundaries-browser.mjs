import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { harness, until } from "./harness.mjs";

const h = await harness({ web: true, capture: true, startWorker: false, startupTimeout: 60000 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const directory = ".local/checks/semantic-role-browser";
await mkdir(directory, { recursive: true });
const checks = [];
const navigate = name => page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: new RegExp(name) }).click();
async function login(user) {
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens[user]);
  await page.getByRole("button", { name: "进入工作台 →" }).click();
  await navigate("语义管理");
  await page.getByRole("heading", { name: "语义管理", exact: true }).waitFor();
}
const heading = name => page.getByRole("heading", { name, exact: true });
const listed = name => page.getByRole("navigation", { name: "语义对象" }).getByRole("button").filter({ hasText: name });
try {
  const catalog = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/catalog", {
    method: "POST", headers: { authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ limit: 50 }),
  }).then(r => r.json());
  await writeFile(h.directory + "/platform/catalog.json", JSON.stringify({ source_namespace: catalog.source_namespace,
    tables: catalog.tables.map(t => ({ ...t, maintainer_id: "bob" })) }));
  assert.equal((await h.request("/source-syncs", { operation_id: randomUUID() })).status, 200);
  await login("bob");
  for (const kind of ["文档", "指标"]) {
    const name = "合成停用恢复" + kind;
    await page.getByRole("button", { name: kind === "文档" ? "录入业务文档" : "录入指标", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(kind + "名称", { exact: true }).fill(name);
    await dialog.getByLabel(kind === "文档" ? "正文（支持 Markdown 章节）" : "指标口径与计算 SQL", { exact: true }).fill("合成业务说明，验证负责人找回停用对象。");
    await dialog.getByLabel("关联对象 ID（逗号分隔，可关联多表或字段）", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "保存" + kind, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await heading(name).waitFor();
    await page.getByRole("button", { name: "停用", exact: true }).click();
    await page.getByRole("button", { name: "启用", exact: true }).waitFor();
    await navigate("工作台"); await navigate("语义管理");
    await page.getByLabel("语义目录范围", { exact: true }).selectOption("maintained");
    await page.getByLabel("管理目录状态").selectOption("disabled");
    await page.getByLabel("管理目录名称").fill(name);
    await listed(name).click();
    await heading(name).waitFor();
    await page.getByRole("button", { name: "启用", exact: true }).click();
    await page.getByRole("button", { name: "停用", exact: true }).waitFor();
    await listed(name).waitFor({ state: "detached" });
    await page.getByLabel("管理目录状态").selectOption("enabled");
    await listed(name).waitFor();
    checks.push(kind + "停用离页后由负责人找回并启用，名称与状态筛选有效");
  }
  const owned = await h.request("/knowledge", { operation_id: randomUUID(), kind: "document", name: "合成跨用户负责人刷新", body: "验证已读取的新负责人不会被旧目录覆盖。", related_ids: [] }, "bob");
  assert.equal(owned.status, 200);
  await page.getByLabel("语义目录范围", { exact: true }).selectOption("all");
  await page.getByLabel("管理目录名称").fill(owned.value.name);
  await listed(owned.value.name).click();
  await heading(owned.value.name).waitFor();
  const maintenance = page.locator(".knowledge-content .semantic-maintainer").first();
  await until(async () => (await maintenance.innerText()).includes("语义负责人：bob"), "directory records original owner");
  assert.equal((await h.request("/knowledge/" + owned.value.id + "/maintainer", { operation_id: randomUUID(), expected_version: owned.value.maintenance.version, maintainer_id: "carol" })).status, 200);
  await until(async () => (await maintenance.innerText()).includes("语义负责人：carol"), "page receives current owner");
  // 记录短暂回退，避免下一轮轮询恢复后掩盖旧目录覆盖新权限的问题。
  await page.evaluate(() => {
    window.ownershipRegressed = false;
    const content = document.querySelector(".knowledge-content");
    window.ownershipObserver = new MutationObserver(() => {
      if (content.querySelector(".semantic-maintainer")?.innerText.includes("语义负责人：bob") || [...content.querySelectorAll("button")].some(button => ["编辑", "停用"].includes(button.textContent.trim()))) window.ownershipRegressed = true;
    });
    window.ownershipObserver.observe(content, { childList: true, subtree: true, characterData: true });
  });
  await listed(owned.value.name).click();
  assert.match(await maintenance.innerText(), /语义负责人：carol/);
  assert.equal(await page.getByRole("button", { name: "编辑", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "停用", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => { window.ownershipObserver.disconnect(); return window.ownershipRegressed; }), false);
  assert.equal((await h.request("/knowledge/" + owned.value.id + "/disable", { operation_id: randomUUID(), expected_version: owned.value.version }, "bob")).status, 403);
  checks.push("跨用户改派后点击旧目录条目不恢复旧负责人或维护按钮，服务端仍拒绝旧负责人写入");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await login("alice");
  await page.getByLabel("语义目录范围", { exact: true }).selectOption("all");
  await page.getByLabel("管理目录名称").fill("合成停用恢复文档");
  await listed("合成停用恢复文档").click();
  await page.getByRole("button", { name: "指定负责人", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const selector = dialog.getByLabel("负责人", { exact: true });
  await selector.locator("option[value=carol]").waitFor({ state: "attached" });
  assert.deepEqual(await selector.locator("option").evaluateAll(options => options.map(o => o.value)), ["", "alice", "bob", "carol"]);
  await selector.selectOption("carol");
  await dialog.getByRole("button", { name: "保存负责人", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByText(/语义负责人：carol/).waitFor();
  checks.push("超级维护者从当前有效成员列表完成转交");

  const linked = await h.request("/knowledge", { operation_id: randomUUID(), kind: "document", name: "合成关联对象详情", body: "说明", related_ids: ["table-demo_order_detail"] }, "bob");
  assert.equal(linked.status, 200);
  // 重新进入默认样例表；内置资料和平台导入有同名表，不能按显示名猜测对象身份。
  await navigate("工作台"); await navigate("语义管理");
  const table = (await h.request("/knowledge/table-demo_order_detail")).value;
  await heading(table.name).waitFor();
  await page.getByRole("tab", { name: "业务文档", exact: true }).click();
  const related = page.locator(".semantic-object").filter({ hasText: "合成关联对象详情" });
  await related.getByRole("button", { name: "打开详情", exact: true }).click();
  await heading("合成关联对象详情").waitFor();
  checks.push("关联条目可以进入独立对象完整详情");

  await page.getByLabel("语义目录范围", { exact: true }).selectOption("all");
  await page.getByLabel("管理目录名称").fill("合成停用恢复");
  await listed("合成停用恢复文档").waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.getByLabel("管理目录名称").isVisible(), true);
    await page.screenshot({ path: `${directory}/${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  checks.push("1440/390管理控件可见、页面无横向溢出或脚本错误");
  await writeFile(directory + "/result.json", JSON.stringify({ passed: checks.length, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally {
  await browser.close(); await h.close();
}
