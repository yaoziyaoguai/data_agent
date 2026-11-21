import assert from "node:assert/strict";
import { chromium } from "playwright";
import { harness } from "./harness.mjs";

const h = await harness({ web: true, startWorker: false });
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  const id = "field-quantity";
  const path = "/knowledge/" + id;
  const original = (await h.request(path)).value;
  const fieldType = original.entries.find(entry => entry.entry_id === "type");
  const requests = [];
  await page.route("**" + path + "/entries", async route => {
    requests.push(route.request().postDataJSON());
    const saved = await route.fetch();
    assert.equal(saved.status(), 200);
    if (requests.length === 1) await route.abort("failed"); // 已写入数据库，响应在返回途中丢失。
    else await route.fulfill({response: saved});
  });
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", {name: "进入工作台 →"}).click();
  await page.getByRole("navigation", {name: "会话历史"}).waitFor();
  await page.getByRole("button", {name: /语义管理/}).click();
  await page.locator(".object-list button").filter({hasText: "demo_order_detail"}).click();
  await page.getByRole("heading", {name: "demo_order_detail", exact: true}).waitFor();
  await page.getByRole("tab", {name: "字段语义"}).click();
  await page.getByLabel("批量修改").check();
  const field = page.locator(".field-object").filter({has: page.getByText("quantity", {exact: true})});
  await field.locator("details > summary").first().click();
  const entry = field.locator(".semantic-entry").filter({has: page.locator(".entry-head strong", {hasText: fieldType.label})});
  for (const [index, note] of ["首次校对", "再次校对"].entries()) {
    const value = fieldType.effective_value + " · " + note;
    await entry.getByRole("button", {name: "编辑", exact: true}).click();
    await entry.locator("textarea").fill(value);
    await entry.getByRole("button", {name: "暂存修改"}).click();
    await page.getByRole("button", {name: /查看本次修改/}).click();
    const submit = page.getByRole("button", {name: "提交全部修改"});
    if (index === 0) {
      const dropped = page.waitForEvent("requestfailed", req => req.url().endsWith(path + "/entries"));
      await submit.click(); await dropped;
    }
    await submit.click();
    await page.getByRole("dialog").waitFor({state: "detached"});
    const stored = (await h.request(path)).value;
    assert.equal(stored.entries.find(e => e.entry_id === "type").effective_value, value);
    assert.equal(BigInt(stored.version), BigInt(original.version) + BigInt(index + 1));
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.notEqual(requests[1].operation_id, requests[2].operation_id);
  console.log(JSON.stringify({passed: true, edits: 2, submissions: requests.length, officialRequests: 0}));
} catch (error) {
  await page.screenshot({path: h.directory + "/batch-edit-failure.png"});
  throw error;
} finally {
  await browser.close();
  await h.close();
}
