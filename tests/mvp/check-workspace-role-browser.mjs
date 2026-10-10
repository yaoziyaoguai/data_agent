import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { harness, until } from "./harness.mjs";

const h = await harness({ web: true, capture: true, startWorker: false, startupTimeout: 60000 });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const directory = ".local/checks/workspace-role";
await mkdir(directory, { recursive: true });
const checks = [], errors = [];
let passed = false;
page.on("pageerror", e => errors.push(e.message));
const badge = page.getByRole("status", { name: "当前空间最高角色" });
const command = () => ({ operation_id: randomUUID() });
async function ok(path, body, user = "alice") {
  const response = await h.request(path, body, user);
  assert.equal(response.status, 200, JSON.stringify({ path, ...response }));
  return response.value;
}
async function login(user) {
  await page.getByLabel("演示登录凭据").fill(h.tokens[user]);
  await page.getByRole("button", { name: "进入工作台 →" }).click();
  await until(async () => await page.locator(".identity strong").innerText() === user, "current identity");
}
const logout = () => page.getByRole("button", { name: "退出", exact: true }).click();
const expectRole = label => until(async () => await badge.innerText() === label, "role is " + label);
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
async function screenshots(name) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await badge.isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${directory}/${name}-${width}.png`, fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
// 持有一份已从真实服务端读出的旧响应，其他请求照常通过。
async function holdRoleResponse() {
  let held;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const handler = async route => {
    if (held) return route.continue();
    held = { route };
    const response = await route.fetch();
    held.response = response;
    release();
  };
  await page.route("**/api/semantic-access", handler);
  await refresh();
  await ready;
  return async () => {
    const received = page.waitForResponse(response => response.url().endsWith("/api/semantic-access"));
    await held.route.fulfill({ response: held.response });
    await (await received).finished();
    await page.unroute("**/api/semantic-access", handler);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
}

try {
  // 其他空间的归属不提升当前空间角色。
  h.sql("INSERT INTO semantic_ownership(space_id,object_id,authority_id,maintainer_id,source,updated_by) VALUES('other-space','foreign-document','foreign-document','bob','creator','test')");
  assert.deepEqual(await ok("/semantic-access", undefined, "bob"), { can_admin: false, can_create: false, highest_role: "user" });
  await page.goto(h.url);
  await login("bob"); await expectRole("普通用户"); await screenshots("user");
  await logout(); await login("alice"); await expectRole("超级维护者"); await screenshots("super-maintainer");
  checks.push("普通用户与超级维护者由服务端识别；其他空间的归属不提升当前角色，换用户不沿用旧身份");

  const catalog = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/catalog", {
    method: "POST", headers: { authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ limit: 50 }),
  }).then(response => response.json());
  let version = 1;
  async function synchronize(owner) {
    await writeFile(h.directory + "/platform/catalog.json", JSON.stringify({
      source_namespace: catalog.source_namespace,
      tables: catalog.tables.map(table => ({ ...table, platform_version: String(++version), maintainer_id: owner })),
    }));
    await ok("/source-syncs", command());
  }
  await synchronize("bob");
  assert.deepEqual(await ok("/semantic-access", undefined, "bob"), { can_admin: false, can_create: true, highest_role: "maintainer" });
  await logout(); await login("bob"); await expectRole("语义维护者"); await screenshots("maintainer");
  for (const name of ["我的积累", "语义管理", "工作台"]) {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: new RegExp(name) }).click();
    await expectRole("语义维护者");
  }
  checks.push("已同步的表负责人显示语义维护者，三个主入口都显示角色，三类身份在1440/390画面无横向溢出");

  const doc = await ok("/knowledge", { ...command(), kind: "document", name: "合成角色标识说明", body: "验证文档负责人身份。", related_ids: [] }, "bob");
  await synchronize("alice");
  assert.deepEqual(await ok("/semantic-access", undefined, "bob"), { can_admin: false, can_create: false, highest_role: "maintainer" });
  await refresh(); await expectRole("语义维护者");
  assert.equal((await ok("/knowledge/" + doc.id, undefined, "bob")).maintenance.can_edit, true);
  assert.equal((await h.request("/knowledge", { ...command(), kind: "metric", name: "合成无资格新建", body: "说明", related_ids: [] }, "bob")).status, 403);
  assert.equal((await ok("/knowledge/table-demo_order_detail", undefined, "bob")).maintenance.can_edit, false);
  checks.push("仅负责独立文档的人仍显示维护者；不能创建新对象或编辑他人的表，角色摘要不扩大权限");

  const releaseOldRole = await holdRoleResponse();
  await ok("/knowledge/" + doc.id + "/maintainer", { ...command(), expected_version: doc.maintenance.version, maintainer_id: null });
  assert.equal((await ok("/semantic-access", undefined, "bob")).highest_role, "user");
  await refresh(); await expectRole("普通用户");
  await releaseOldRole();
  assert.equal(await badge.innerText(), "普通用户");
  checks.push("撤销最后一个负责对象后刷新为普通用户，晚到的旧维护者响应不能覆盖新角色");

  const unavailable = route => route.abort("failed");
  await page.route("**/api/semantic-access", unavailable);
  await refresh(); await expectRole("角色暂不可用");
  await page.unroute("**/api/semantic-access", unavailable);
  await refresh(); await expectRole("普通用户");
  checks.push("角色读取失败明确显示暂不可用，恢复读取后显示真实角色");

  await logout(); await login("alice"); await expectRole("超级维护者");
  const releasePreviousUser = await holdRoleResponse();
  await logout(); await login("bob"); await expectRole("普通用户");
  await releasePreviousUser();
  assert.equal(await badge.innerText(), "普通用户");
  assert.equal(await page.locator(".identity strong").innerText(), "bob");
  checks.push("退出换用户后，即使上一用户的超级维护者响应晚到，也不能污染当前身份标识");
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) await page.screenshot({ path: directory + "/failure.png", fullPage: true }).catch(() => {});
  await writeFile(directory + "/report.json", JSON.stringify({ passed, checks, errors, officialRequests: 0 }, null, 2));
  await browser.close(); await h.close();
  console.log(JSON.stringify({ passed, checks, errors, officialRequests: 0 }));
}
