import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createReuseFixture, reference } from "./check-knowledge-reuse.mjs";
import { ok } from "./skill-fixtures.mjs";
import { logoutWorkspace } from "./experience-navigation.mjs";
import { until } from "./harness.mjs";

const directory = ".local/checks/knowledge-reuse-browser";
await mkdir(directory, { recursive: true });
const fixture = await createReuseFixture({ web: true });
const { h, cid, source, draftInput } = fixture;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const checks = [],
  errors = [],
  responses = [],
  routeErrors = [];
let passed = false,
  releaseDelayed,
  delayedDone;
page.on("pageerror", (error) => errors.push(error.message));
const login = async (user) => {
  await page.getByLabel("演示登录凭据").fill(h.tokens[user]);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await page.getByLabel("你的数据问题").waitFor();
};
const knowledge = async (object) => {
  await page.goto(
    h.url +
      "/#knowledge?" +
      new URLSearchParams({
        object: object.id,
        scope: object.kind === "document" ? "documents" : "query_examples",
        tab: "概览",
      }),
  );
  await page.getByRole("heading", { name: object.name, exact: true }).waitFor();
};
const isImpact = (response) =>
  new URL(response.url()).pathname.endsWith("/maintenance-impact");
const readImpact = async (response) => {
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  const value = await result.json();
  assert.equal(value.scope, "direct_explicit_references");
  responses.push(value);
  return value;
};
const openImpact = async (scope = page) => {
  const details = scope.locator(".knowledge-maintenance-impact");
  if (await details.evaluate((element) => element.open)) {
    await details.locator(":scope > summary").click();
    await details
      .getByRole("tab", { name: "公共知识", exact: true })
      .waitFor({ state: "hidden" });
  }
  const response = page.waitForResponse(isImpact);
  await details.locator(":scope > summary").click();
  return readImpact(response);
};
try {
  await page.goto(h.url);
  await login("alice");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /我的积累/ })
    .click();
  await page.getByRole("tab", { name: /^我的 Skill/ }).click();
  const pending = page.getByRole("region", { name: "待确认的个人 Skill" });
  await pending.getByText(draftInput.name, { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".asset-grid > .asset-card")
      .filter({ hasText: draftInput.name })
      .count(),
    0,
  );
  await pending
    .getByRole("button", { name: "核对并保存", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "确认个人 Skill",
    exact: true,
  });
  await form.waitFor();
  assert.equal(
    await form.getByLabel("内容", { exact: true }).inputValue(),
    draftInput.body,
  );
  const confirmedBody =
    draftInput.body + "\n我补充的例外：关联可能重复时先查明粒度。";
  await form.getByLabel("内容", { exact: true }).fill(confirmedBody);
  const confirming = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/assets"),
  );
  await form
    .getByRole("button", { name: "保存为个人 Skill", exact: true })
    .click();
  const savedResponse = await confirming;
  assert.equal(savedResponse.status(), 200, await savedResponse.text());
  const saved = await savedResponse.json();
  assert.equal(saved.body, confirmedBody);
  assert.equal(saved.visibility, "personal");
  assert.equal(
    savedResponse.request().postDataJSON().draft_id,
    fixture.draft.draft_id,
  );
  await form.waitFor({ state: "detached" });
  await page.locator(".asset-card").filter({ hasText: saved.name }).waitFor();
  assert.equal(
    ok(await h.request(`/conversations/${cid}/skill-selections`)).selections
      .length,
    0,
  );
  assert.equal(
    ok(await h.request("/assets", undefined, "bob")).assets.some(
      (a) => a.id === saved.id,
    ),
    false,
  );
  checks.push(
    "本人草稿载入已有编辑表单，修改后真实POST确认保存；没有自动发布或选用",
  );

  await knowledge(source);
  await page.getByRole("button", { name: "录入查询案例", exact: true }).click();
  const creator = page.getByRole("dialog", {
    name: "录入查询案例",
    exact: true,
  });
  await creator
    .getByLabel("查询案例名称", { exact: true })
    .fill("可重复的参数案例");
  await creator
    .getByLabel("案例说明与适用限制", { exact: true })
    .fill("合成参数输出示例；只生成SQL，执行需聊天授权。");
  await creator
    .getByLabel("适用问题", { exact: true })
    .fill("需要给结果附上调用者传入的标记时使用。");
  await creator
    .getByLabel("结果粒度", { exact: true })
    .fill("一条结果行，每次只返回一个传入标记");
  await creator.getByRole("button", { name: "添加参数", exact: true }).click();
  await creator.getByLabel("参数名称 1", { exact: true }).fill("marker");
  await creator.getByLabel(/^参数类型 1\b/).selectOption("string");
  await creator
    .getByLabel("参数含义 1", { exact: true })
    .fill("只作为输出标记，不是查询过滤条件");
  await creator
    .getByLabel("案例 SQL", { exact: true })
    .fill("SELECT :marker AS marker");
  const dependencies = creator.getByRole("group", {
    name: "案例依赖",
    exact: true,
  });
  await dependencies
    .getByLabel("查找表、字段或业务资料", { exact: true })
    .fill(source.name);
  await dependencies
    .getByRole("button", { name: new RegExp(source.name) })
    .click();
  await dependencies
    .getByLabel(`依赖位置 ${source.name}`, { exact: true })
    .selectOption("body");
  const publishing = creator.getByRole("checkbox", {
    name: "我已核对这些内容可以在当前空间公开",
    exact: true,
  });
  const saveCase = creator.getByRole("button", {
    name: "保存查询案例",
    exact: true,
  });
  assert.equal(await saveCase.isDisabled(), true);
  await publishing.check();
  const creating = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/knowledge"),
  );
  await saveCase.click();
  const createdResponse = await creating;
  assert.equal(createdResponse.status(), 200, await createdResponse.text());
  const created = await createdResponse.json();
  const structure = created.entries.find(
    (entry) => entry.path === "body",
  ).effective_structure;
  assert.equal(created.kind, "query_example");
  assert.equal(structure.sql, "SELECT :marker AS marker");
  assert.equal(structure.parameters[0].name, "marker");
  assert.deepEqual(structure.dependencies, [reference(source)]);
  assert.equal(structure.verification, null);
  await creator.waitFor({ state: "detached" });
  await page
    .getByRole("heading", { name: created.name, exact: true })
    .waitFor();
  checks.push(
    "维护者实际录入适用问题、参数、SQL、粒度及文档位置；明确公共内容后保存，没有伪造核对认证",
  );

  // 实际编辑案例，正文与结构一起保存；SQL的独立预期不来自产品输出。
  const bodyLabel = created.entries.find((item) => item.path === "body").label;
  const entry = page.locator(".semantic-entry").filter({
    has: page.locator(".entry-head strong", { hasText: bodyLabel }),
  });
  await entry.getByRole("button", { name: "编辑", exact: true }).click();
  await entry
    .getByRole("textbox", { name: bodyLabel, exact: true })
    .fill("核对后的合成参数说明。");
  await entry
    .getByRole("checkbox", { name: "同时保存查询案例结构", exact: true })
    .check();
  await entry
    .getByLabel("案例 SQL", { exact: true })
    .fill("SELECT :marker AS marker, 1 AS verified_shape");
  const editing = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.endsWith(`/knowledge/${created.id}`),
  );
  await entry.getByRole("button", { name: "保存修改", exact: true }).click();
  const editedResponse = await editing;
  assert.equal(editedResponse.status(), 200, await editedResponse.text());
  const edited = await editedResponse.json();
  assert.equal(
    edited.entries.find((item) => item.path === "body").effective_structure.sql,
    "SELECT :marker AS marker, 1 AS verified_shape",
  );
  checks.push("案例正文与参数结构复用当前编辑入口，一次保存新修订");

  await knowledge(source);
  const result = await openImpact();
  assert.ok(result.items.some((item) => item.id === created.id));
  const impact = page.locator(".knowledge-maintenance-impact");
  await impact.locator(`[data-dependent-id="${created.id}"]`).waitFor();
  assert.match(await impact.innerText(), /直接引用/);
  const skillResponse = page.waitForResponse(isImpact);
  await impact
    .getByRole("tab", { name: "我的与公共 Skill", exact: true })
    .click();
  const skillResult = await skillResponse;
  assert.equal(skillResult.status(), 200);
  assert.ok(
    (await skillResult.json()).items.some((item) => item.id === saved.id),
  );
  await impact.locator(`[data-dependent-id="${saved.id}"]`).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const geometry = await impact.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    width: window.innerWidth,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1);
  assert.ok(geometry.overflow <= 1);
  await page.screenshot({ path: directory + "/mobile.png", fullPage: true });
  checks.push(
    "知识详情按需读取真实直接引用；公共知识/本人方法切换及390px没有页面水平溢出",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  // 只注入网络失败，成功读取仍来自真实API，失败不能冒充零依赖。
  let fail = true;
  await page.route("**/maintenance-impact?*", async (route) => {
    if (fail) {
      fail = false;
      await route.abort("failed");
    } else await route.continue();
  });
  await impact.getByRole("tab", { name: "公共知识", exact: true }).click();
  await impact.getByRole("alert").waitFor();
  assert.match(await impact.getByRole("alert").innerText(), /读取失败/);
  const retried = page.waitForResponse(isImpact);
  await impact
    .getByRole("button", { name: "重试读取维护影响", exact: true })
    .click();
  assert.equal((await retried).status(), 200);
  await impact.locator(`[data-dependent-id="${created.id}"]`).waitFor();
  await page.unroute("**/maintenance-impact?*");
  checks.push(
    "维护影响网络失败明确告知，重试读取真实结果，未把失败展示为没有引用",
  );

  await page.screenshot({ path: directory + "/desktop.png", fullPage: true });

  // 实际引用超过当前50条页面上限，不代换接口返回或假设随机ID的排序位置。
  const pagingObjects = [];
  for (let index = 0; index < 51; index++) {
    pagingObjects.push(
      ok(
        await h.request("/knowledge", {
          operation_id: randomUUID(),
          kind: "document",
          name: `维护影响分页样本${index + 1}`,
          body: "合成资料；引用关系通过显式关联记录。",
          related_ids: [source.id],
        }),
      ),
    );
  }
  await knowledge(source);
  const firstPage = await openImpact();
  assert.equal(firstPage.items.length, 50);
  assert.ok(firstPage.next_after_id);
  await until(
    async () => (await impact.locator("[data-dependent-id]").count()) === 50,
    "维护影响第一页50条实际引用已显示",
  );
  const nextResponse = page.waitForResponse(
    (response) =>
      isImpact(response) &&
      new URL(response.url()).searchParams.get("after_id") ===
        firstPage.next_after_id,
  );
  await impact
    .getByRole("button", { name: "加载更多直接引用", exact: true })
    .click();
  const nextPage = await readImpact(nextResponse);
  assert.equal(nextPage.next_after_id, null);
  assert.equal(nextPage.items.length, 2);
  const expectedIds = [
    created.id,
    ...pagingObjects.map((object) => object.id),
  ].sort();
  const returnedIds = [...firstPage.items, ...nextPage.items]
    .map((item) => item.id)
    .sort();
  assert.equal(new Set(returnedIds).size, expectedIds.length);
  assert.deepEqual(returnedIds, expectedIds);
  await until(
    async () =>
      (await impact.locator("[data-dependent-id]").count()) ===
      expectedIds.length,
    "维护影响第二页追加全部52条实际引用",
  );
  assert.deepEqual(
    (
      await impact
        .locator("[data-dependent-id]")
        .evaluateAll((elements) =>
          elements.map((element) => element.dataset.dependentId),
        )
    ).sort(),
    expectedIds,
  );
  assert.equal(
    await impact
      .getByRole("button", { name: "加载更多直接引用", exact: true })
      .count(),
    0,
  );
  checks.push(
    "51份实际HTTP创建的关联文档和查询案例跨两页读取；页面追加52条，游标不重复、不遗漏",
  );

  // 接受仅进入待修改；负责人在真实编辑弹窗核对维护影响后明确保存才改正式内容。
  const proposal = ok(
    await h.request(
      "/semantic-corrections",
      {
        operation_id: randomUUID(),
        object_id: source.id,
        base_version: source.version,
        entry_id: "body",
        value: "合成修正：一行是商品行，不能等同订单数。",
        reason: "核对合成资料的行粒度。",
        evidence: [reference(source)],
        share_confirmed: true,
      },
      "bob",
    ),
  );
  const accepted = ok(
    await h.request(`/semantic-corrections/${proposal.id}/review`, {
      operation_id: randomUUID(),
      expected_revision: proposal.revision,
      decision: "accepted",
      reason: "同意方向，编辑保存前再次核对",
    }),
  );
  assert.equal(accepted.state, "accepted");
  assert.equal(
    ok(await h.request(`/knowledge/${source.id}`)).version,
    source.version,
  );
  const correction = page
    .getByRole("region", { name: "语义纠错协作", exact: true })
    .locator(`[data-correction-id="${proposal.id}"]`);
  await correction
    .getByRole("button", { name: "核对并编辑保存", exact: true })
    .click();
  const reviewer = page.getByRole("dialog", {
    name: "核对并编辑正式语义",
    exact: true,
  });
  await reviewer.waitFor();
  const reviewImpact = await openImpact(reviewer);
  assert.deepEqual(
    reviewImpact.items.map((item) => item.id),
    firstPage.items.map((item) => item.id),
  );
  assert.equal(await reviewer.locator("[data-dependent-id]").count(), 50);
  const reviewSave = reviewer.getByRole("button", {
    name: "保存正式内容",
    exact: true,
  });
  assert.equal(await reviewSave.isDisabled(), true);
  const formalBody =
    "负责人核对后的合成口径：一行是商品行；订单数需要明确去重订单标识。";
  await reviewer.getByLabel(/^核对后保存的正式内容/).fill(formalBody);
  await reviewer
    .getByRole("checkbox", { name: "已核对当前版本与共享依据", exact: true })
    .check();
  const applying = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(
        `/semantic-corrections/${proposal.id}/apply`,
      ),
  );
  await reviewSave.click();
  const appliedResponse = await applying;
  assert.equal(appliedResponse.status(), 200, await appliedResponse.text());
  const applied = await appliedResponse.json();
  assert.equal(applied.state, "applied");
  assert.equal(applied.applied_value, formalBody);
  await reviewer.waitFor({ state: "detached" });
  const revisedSource = ok(await h.request(`/knowledge/${source.id}`));
  assert.equal(revisedSource.version, applied.applied_version);
  assert.notEqual(revisedSource.version, source.version);
  assert.equal(
    revisedSource.entries.find((item) => item.path === "body").effective_value,
    formalBody,
  );
  await knowledge(revisedSource);
  const reloadingSource = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.endsWith(`/knowledge/${source.id}`),
  );
  await page.reload();
  const sourceResponse = await reloadingSource;
  assert.equal(sourceResponse.status(), 200, await sourceResponse.text());
  assert.equal((await sourceResponse.json()).version, applied.applied_version);
  await page
    .locator(".knowledge-content .document-reading")
    .getByText(formalBody, { exact: true })
    .waitFor();
  await openImpact();
  const revisedSkills = page.waitForResponse(isImpact);
  await impact
    .getByRole("tab", { name: "我的与公共 Skill", exact: true })
    .click();
  const revisedSkillPage = await readImpact(revisedSkills);
  assert.ok(
    revisedSkillPage.items
      .find((item) => item.id === saved.id)
      .references.some(
        (ref) =>
          ref.referenced_version === source.version &&
          ref.reference_state === "version_changed",
      ),
  );
  await impact
    .locator(`[data-dependent-id="${saved.id}"]`)
    .locator('[data-reference-state="version_changed"]')
    .waitFor();
  checks.push(
    "建议应用弹窗实际读取直接维护影响；接受不改正文，编辑核对保存后旧依赖明确提示改版需核对",
  );

  // 用户切换时延迟原用户的真实列表，旧私人内容不能进入新页面。
  let oldListReceived = false;
  const holdOldList = new Promise((resolve) => {
    releaseDelayed = resolve;
  });
  let handled;
  delayedDone = new Promise((resolve) => {
    handled = resolve;
  });
  await page.route("**/api/assets", async (route) => {
    if (route.request().method() !== "GET" || oldListReceived)
      return route.continue();
    try {
      const response = await route.fetch();
      assert.ok(
        (await response.json()).assets.some((asset) => asset.id === saved.id),
      );
      oldListReceived = true;
      await holdOldList;
      await route.fulfill({ response });
    } catch (error) {
      routeErrors.push(String(error));
    } finally {
      handled();
    }
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /我的积累/ })
    .click();
  await until(() => oldListReceived, "原用户列表真实响应被延迟");
  await logoutWorkspace(page);
  await login("bob");
  const loadingBob = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.endsWith("/api/assets"),
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /我的积累/ })
    .click();
  await page.getByRole("tab", { name: /^我的 Skill/ }).click();
  const bobResponse = await loadingBob;
  assert.equal(bobResponse.status(), 200, await bobResponse.text());
  const bobAssets = (await bobResponse.json()).assets;
  assert.equal(
    bobAssets.some((asset) => asset.id === saved.id),
    false,
  );
  const bobSkills = bobAssets.filter(
    (asset) => asset.kind === "skill" && asset.visibility !== "space",
  );
  await until(
    async () =>
      (await page.locator(".asset-grid > .asset-card").count()) ===
      bobSkills.length,
    "新用户本人Skill实际列表已显示",
  );
  releaseDelayed();
  await delayedDone;
  await page.unroute("**/api/assets");
  assert.deepEqual(routeErrors, []);
  assert.equal(await page.getByText(saved.name, { exact: true }).count(), 0);
  assert.equal(
    await page.getByText(draftInput.name, { exact: true }).count(),
    0,
  );
  checks.push(
    "切换用户后原用户真实迟到列表不污染新页面，私人Skill及待确认内容不泄漏",
  );
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  releaseDelayed?.();
  if (delayedDone) await delayedDone;
  if (!passed)
    await page.screenshot({ path: directory + "/failure.png", fullPage: true });
  await writeFile(
    directory + "/result.json",
    JSON.stringify(
      { passed, checks, errors, routeErrors, officialRequests: 0, responses },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await fixture.close();
  console.log(JSON.stringify({ passed, checks, errors, officialRequests: 0 }));
}
