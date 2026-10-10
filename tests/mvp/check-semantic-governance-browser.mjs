import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { harness, until } from "./harness.mjs";
const h = await harness({
  web: true,
  capture: true,
  startWorker: false,
  startupTimeout: 60000,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("browser_error", e.message);
});
const table = "table-demo_order_detail";
const login = async (user) => {
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens[user]);
  await page.getByRole("button", { name: "进入工作台 →" }).click();
  await page
    .getByRole("button", { name: /语义管理/ })
    .first()
    .click();
  await page.getByRole("heading", { name: "语义管理", exact: true }).waitFor();
};
const logout = async () => {
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByLabel("演示登录凭据").waitFor();
};
const entry = () => page.locator(".semantic-entry").first();
try {
  const catalog = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/catalog", {
    method: "POST",
    headers: {
      authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: 50 }),
  }).then((r) => r.json());
  await writeFile(
    h.directory + "/platform/catalog.json",
    JSON.stringify({
      source_namespace: catalog.source_namespace,
      tables: catalog.tables.map((t) => ({
        ...t,
        maintainer_id: t.id === "demo_order_detail" ? "carol" : "alice",
      })),
    }),
  );
  assert.equal(
    (await h.request("/source-syncs", { operation_id: randomUUID() })).status,
    200,
  );
  const original = (await h.request("/knowledge/" + table)).value;
  await login("bob");
  await page
    .getByText(/负责人：carol/)
    .first()
    .waitFor();
  assert.equal(
    await entry().getByRole("button", { name: "编辑", exact: true }).count(),
    0,
  );
  await entry().getByRole("button", { name: "提出纠错", exact: true }).click();
  await page
    .getByRole("textbox", { name: "建议修改为", exact: true })
    .fill("浏览器合成建议：每行代表订单商品明细");
  await page
    .getByRole("textbox", { name: "修改理由", exact: true })
    .fill("浏览器私人草稿核对");
  await page
    .getByRole("button", { name: "仅保存私人草稿", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByText(/我的私人草稿 · 1/).click();
  await page.getByRole("button", { name: "整理并提交给负责人" }).click();
  let lostSubmissionResponse = false;
  await page.route("**/api/semantic-corrections", async (route) => {
    if (route.request().method() === "POST" && !lostSubmissionResponse) {
      lostSubmissionResponse = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel(/已核对以上内容可共享/).check();
  await page
    .getByRole("button", { name: "确认提交给负责人", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await page
    .getByRole("button", { name: "确认提交给负责人", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(
    (await h.request("/semantic-corrections", undefined, "bob")).value
      .corrections.length,
    1,
  );
  let correction = await until(async () => {
    const v = (await h.request("/semantic-corrections", undefined, "bob")).value
      .corrections;
    return v[0];
  }, "shared browser submission");
  let card = page.locator('[data-correction-id="' + correction.id + '"]');
  await card.getByRole("button", { name: "修订建议", exact: true }).click();
  await page
    .getByRole("textbox", { name: "修改理由", exact: true })
    .fill("浏览器补充依据，等待负责人审核");
  await page.getByLabel(/已核对以上内容可共享/).check();
  await page.getByRole("button", { name: "重新提交审核", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  correction = (
    await h.request("/semantic-corrections/" + correction.id, undefined, "bob")
  ).value;
  assert.equal(correction.revision, "2");
  await logout();
  await login("carol");
  card = page.locator('[data-correction-id="' + correction.id + '"]');
  await card.getByRole("button", { name: "接受，待修改", exact: true }).click();
  await page
    .getByRole("textbox", { name: "处理理由", exact: true })
    .fill("负责人同意，稍后核对正式措辞");
  await page.getByRole("button", { name: "确认接受", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(
    (await h.request("/knowledge/" + table)).value.version,
    original.version,
  );
  await card.getByText("已接受 · 待修改", { exact: true }).waitFor();
  assert.equal(await page.getByText(/我的私人草稿/).count(), 0);
  await card
    .getByRole("button", { name: "核对并编辑保存", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "核对后保存的正式内容", exact: true })
    .fill("负责人编辑确认：每行是订单商品明细，按联合键识别");
  await page.getByLabel("已核对当前版本与共享依据").check();
  await page
    .getByRole("button", { name: "保存正式内容", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await card.getByText("已保存到正式语义", { exact: true }).waitFor();
  const saved = (await h.request("/knowledge/" + table)).value;
  assert.equal(saved.version, String(Number(original.version) + 1));
  assert.equal(
    saved.entries[0].effective_value,
    "负责人编辑确认：每行是订单商品明细，按联合键识别",
  );
  const second = (
    await h.request(
      "/semantic-corrections",
      {
        operation_id: randomUUID(),
        object_id: table,
        base_version: saved.version,
        entry_id: saved.entries[0].entry_id,
        value: "待驳回合成建议",
        reason: "不完整的理由",
        evidence: [
          {
            object_id: table,
            version: saved.version,
            path: saved.entries[0].entry_id,
          },
        ],
        share_confirmed: true,
      },
      "bob",
    )
  ).value;
  const rejectedCard = page.locator('[data-correction-id="' + second.id + '"]');
  await rejectedCard.getByRole("button", { name: "驳回", exact: true }).click();
  await page
    .getByRole("textbox", { name: "处理理由", exact: true })
    .fill("请先补充独立依据");
  await page.getByRole("button", { name: "确认驳回", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await logout();
  await login("bob");
  await page
    .locator('[data-correction-id="' + second.id + '"]')
    .getByText("已驳回", { exact: true })
    .waitFor();
  await page.getByText(/请先补充独立依据/).waitFor();
  await mkdir(".local/checks/semantic-governance-browser", { recursive: true });
  await page.locator('[aria-label="语义纠错协作"]').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".local/checks/semantic-governance-browser/desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[aria-label="语义纠错协作"]').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".local/checks/semantic-governance-browser/mobile.png",
    fullPage: false,
  });
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.scroll <= dimensions.width + 1,
    JSON.stringify(dimensions),
  );
  assert.deepEqual(errors, []);
  await writeFile(
    ".local/checks/semantic-governance-browser/result.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "私人草稿显式提交",
          "提出者修订重审",
          "逐表负责人接受不生效",
          "负责人编辑保存",
          "驳回理由与提出者可见",
          "私人草稿对负责人不可见",
          "1440/390px 无横向溢出、无脚本错误",
        ],
        dimensions,
      },
      null,
      2,
    ),
  );
  console.log("语义协作浏览器流程通过");
} catch (error) {
  await mkdir(".local/checks/semantic-governance-browser", { recursive: true });
  await page.screenshot({
    path: ".local/checks/semantic-governance-browser/failure.png",
  });
  await writeFile(
    ".local/checks/semantic-governance-browser/failure.txt",
    await page.locator("body").innerText(),
  );
  throw error;
} finally {
  await browser.close();
  await h.close();
}
