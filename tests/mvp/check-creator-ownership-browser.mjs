import {navigateWorkspace, logoutWorkspace} from './experience-navigation.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { harness } from "./harness.mjs";
const h = await harness({
  web: true,
  capture: true,
  startWorker: false,
  startupTimeout: 60000,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const directory = ".local/checks/creator-ownership-browser";
await mkdir(directory, { recursive: true });
async function login(user) {
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens[user]);
  await page.getByRole("button", { name: "进入工作台 →" }).click();
  await navigateWorkspace(page, '语义管理');
  await page.getByRole("heading", { name: "语义管理", exact: true }).waitFor();
}
async function logout() {
  await logoutWorkspace(page);
  await page.getByLabel("演示登录凭据").waitFor();
}
try {
  const catalog = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/catalog", {
    method: "POST",
    headers: {
      authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: 50 }),
  }).then((r) => r.json());
  const sync = async (peer = "alice") => {
    catalog.tables = catalog.tables.map(t => ({ ...t, platform_version: String(Number(t.platform_version) + 1) }));
    await writeFile(
      h.directory + "/platform/catalog.json",
      JSON.stringify({
        source_namespace: catalog.source_namespace,
        tables: catalog.tables.map((t) => ({
          ...t,
          maintainer_id: t.id === "demo_order_detail" ? "bob" : peer,
        })),
      }),
    );
    assert.equal(
      (await h.request("/source-syncs", { operation_id: randomUUID() })).status,
      200,
    );
  };
  await sync();
  await login("bob");
  await page.getByRole("button", { name: "录入业务文档", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(/首次保存后，你（bob）/).waitFor();
  await dialog.getByLabel("文档名称", { exact: true }).fill("合成创建者文档");
  await dialog
    .getByLabel("正文（支持 Markdown 章节）", { exact: true })
    .fill("合成文档说明：订单只按完成日期归属。");
  let lost = false,
    documentId;
  await page.route("**/api/knowledge", async (route) => {
    if (route.request().method() === "POST" && !lost) {
      lost = true;
      documentId = (await (await route.fetch()).json()).id;
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "保存文档", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "保存文档", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page
    .getByRole("heading", { name: "合成创建者文档", exact: true })
    .waitFor();
  await page
    .getByText(/负责人：bob/)
    .first()
    .waitFor();
  assert.equal(
    h.sql(
      "SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_objects WHERE name='合成创建者文档'",
    )[0].n,
    1,
  );
  const entry = page.locator(".document-reader").first();
  await entry.getByRole("button", { name: "编辑文档", exact: true }).click();
  await page.getByRole("dialog").getByLabel("文档正文", {exact:true}).fill("创建者核对后的合成业务文档。");
  await page.getByRole("dialog").getByRole("button", { name: "保存文档", exact: true }).click();
  await entry
    .getByText("创建者核对后的合成业务文档。", { exact: true })
    .waitFor();
  assert.equal(
    (await h.request("/knowledge/" + documentId, undefined, "bob")).value
      .maintenance.maintainer_id,
    "bob",
  );
  await page.getByRole("button", { name: "录入指标", exact: true }).click();
  await dialog.getByLabel("指标名称", { exact: true }).fill("合成完成订单数");
  await dialog
    .getByLabel("指标口径与计算 SQL", { exact: true })
    .fill("完成状态订单，按完成日期统计；COUNT(DISTINCT order_id)。");
  await dialog.getByRole("button", { name: "保存指标", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page
    .getByRole("heading", { name: "合成完成订单数", exact: true })
    .waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: `${directory}/${width}.png`,
      fullPage: true,
    });
  }
  await logout();
  await login("carol");
  assert.equal(
    await page
      .getByRole("button", { name: "录入业务文档", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "录入指标", exact: true })
      .isDisabled(),
    true,
  );
  await sync("carol");
  // 获取表维护资格后可创建自己的对象，但仍不能编辑 Bob 的文档。
  await page.getByLabel("搜索语义对象").fill("合成创建者文档");
  await page
    .locator(".object-list button")
    .filter({ hasText: "合成创建者文档" })
    .click();
  await page
    .getByRole("heading", { name: "合成创建者文档", exact: true })
    .waitFor();
  await page
    .getByText(/负责人：bob/)
    .first()
    .waitFor();
  const documentReader = page.locator('.document-reader');
  await documentReader.getByRole('heading', {name: '合成创建者文档', exact: true}).waitFor();
  await documentReader.getByText('维护与纠错', {exact: true}).click();
  assert.equal(
    await documentReader
      .getByRole("button", { name: "编辑文档", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await documentReader
      .getByRole("button", { name: "提出纠错", exact: true })
      .count(),
    1,
  );
  assert.equal(
    (await h.request("/semantic-access", undefined, "carol")).value.can_create,
    true,
  );
  assert.deepEqual(errors, []);
  const result = {
    passed: 6,
    checks: [
      "non-admin table maintainer creates document",
      "lost response reuses creation operation",
      "creator edits own document",
      "metric creator automatically owns metric",
      "ordinary and peer maintainers cannot edit others",
      "1440/390 layout and no page errors",
    ],
  };
  await writeFile(directory + "/result.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (e) {
  await page.screenshot({ path: directory + "/failure.png" });
  await writeFile(
    directory + "/failure.txt",
    await page.locator("body").innerText(),
  );
  throw e;
} finally {
  await browser.close();
  await h.close();
}
