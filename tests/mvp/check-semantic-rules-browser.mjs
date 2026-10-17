import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { harness } from "./harness.mjs";

const output = ".local/checks/semantic-rules-browser";
await mkdir(output, { recursive: true });
const h = await harness({ web: true, startWorker: false, capture: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let passed = false;
const checks = [];
try {
  const sync = await h.request("/source-syncs", { operation_id: randomUUID() });
  assert.equal(sync.status, 200, JSON.stringify(sync.value));
  const target = h.sql(
    "SELECT body FROM knowledge_objects WHERE kind='table' AND name='demo_order_detail' AND source_id LIKE 'catalog-%'",
  )[0];
  assert.ok(target);
  const read = async () => {
    const response = await h.request("/knowledge/" + target.id);
    assert.equal(response.status, 200);
    return response.value;
  };
  const initial = await read();
  assert.equal(initial.maintenance.can_edit, true);
  assert.ok(!initial.entries.some((entry) => entry.effective_structure));
  await page.goto(h.url);
  await page.getByLabel("演示登录凭据").fill(h.tokens.alice);
  await page.getByRole("button", { name: "进入工作台 →", exact: true }).click();
  await page.getByLabel("你的数据问题").waitFor();
  await page.goto(
    h.url +
      "/#knowledge?" +
      new URLSearchParams({ object: target.id, scope: "tables", tab: "概览" }),
  );
  await page.reload();
  await page
    .getByRole("heading", { name: "demo_order_detail", exact: true })
    .waitFor();
  const entry = page
    .locator(".semantic-entry")
    .filter({ has: page.locator(".entry-head strong", { hasText: "表说明" }) });
  await entry.getByText("计算规则 · 尚未补充", { exact: true }).waitFor();
  assert.equal(await page.locator(".technical-source[open]").count(), 0);
  await entry.getByRole("button", { name: "编辑", exact: true }).click();
  const humanText = "人工核对：一行是订单中的一个商品行，按成功付款时间分析。";
  await entry
    .getByRole("textbox", { name: "表说明", exact: true })
    .fill(humanText);
  await entry.locator(".semantic-structure > summary").click();
  await entry
    .getByRole("checkbox", { name: "同时保存计算规则", exact: true })
    .check();
  await entry
    .getByLabel("每行代表什么", { exact: true })
    .fill("订单中的一个商品行");
  await entry
    .getByLabel("唯一键（每行一组）", { exact: true })
    .fill("order_id, line_id");
  await entry
    .getByRole("button", { name: "添加时间字段", exact: true })
    .click();
  await entry.getByLabel("时间字段 1", { exact: true }).fill("paid_at");
  await entry
    .getByLabel("时间用途 1", { exact: true })
    .fill("首笔成功付款时间");
  await entry
    .getByLabel("必要过滤（每行一条）", { exact: true })
    .fill("is_test = 0");
  await entry
    .getByLabel("已知约束（每行一条）", { exact: true })
    .fill("金额以整数分保存");
  const expected = {
    kind: "table",
    grain: "订单中的一个商品行",
    unique_keys: [["order_id", "line_id"]],
    time_columns: [{ column: "paid_at", role: "首笔成功付款时间" }],
    default_filters: ["is_test = 0"],
    constraints: ["金额以整数分保存"],
  };
  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.endsWith("/knowledge/" + target.id),
  );
  await entry.getByRole("button", { name: "保存修改", exact: true }).click();
  const savedResponse = await saving;
  assert.equal(savedResponse.status(), 200, await savedResponse.text());
  assert.deepEqual(
    savedResponse.request().postDataJSON().structured_value,
    expected,
  );
  await entry
    .getByRole("textbox", { name: "表说明", exact: true })
    .waitFor({ state: "detached" });
  const saved = await read();
  const savedEntry = saved.entries.find(
    (item) => item.entry_id === "description",
  );
  assert.equal(BigInt(saved.version), BigInt(initial.version) + 1n);
  assert.equal(savedEntry.effective_value, humanText);
  assert.deepEqual(savedEntry.effective_structure, expected);
  assert.deepEqual(savedEntry.human_override.structured_value, expected);
  checks.push(
    "维护者用正常字段填写计算规则，与说明通过一次真实API请求同版保存",
  );

  await page.reload();
  await entry.getByText(humanText, { exact: true }).waitFor();
  await entry.locator(".semantic-structure > summary").click();
  await entry.getByText("order_id + line_id", { exact: true }).waitFor();
  await entry.getByText("paid_at：首笔成功付款时间", { exact: true }).waitFor();
  await page.screenshot({ path: output + "/saved-structure.png" });
  await entry.getByRole("button", { name: "编辑", exact: true }).click();
  await entry
    .getByText(
      "已有计算规则。请一同核对后保存；只保存说明时，原规则将暂时停用。",
      { exact: true },
    )
    .waitFor();
  const textOnly = "人工补充：这份说明仍需核对退款归属范围。";
  await entry
    .getByRole("textbox", { name: "表说明", exact: true })
    .fill(textOnly);
  const textOnlySaving = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.endsWith("/knowledge/" + target.id),
  );
  await entry.getByRole("button", { name: "保存修改", exact: true }).click();
  const textOnlyResponse = await textOnlySaving;
  assert.equal(textOnlyResponse.status(), 200, await textOnlyResponse.text());
  assert.equal(
    textOnlyResponse.request().postDataJSON().structured_value,
    null,
  );
  await entry
    .getByRole("textbox", { name: "表说明", exact: true })
    .waitFor({ state: "detached" });
  const changed = await read();
  assert.equal(
    changed.entries.find((item) => item.entry_id === "description")
      .effective_value,
    textOnly,
  );
  assert.equal(
    changed.entries.find((item) => item.entry_id === "description")
      .effective_structure,
    null,
  );
  await entry.getByText("计算规则 · 尚未补充", { exact: true }).waitFor();
  checks.push(
    "重开可读自然语言规则摘要；仅改说明会保存明确结构缺口，旧规则不会继续生效",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await entry.getByRole("button", { name: "编辑", exact: true }).click();
  const summary = entry.locator(".semantic-structure > summary");
  await summary.focus();
  await summary.press("Space");
  const confirm = entry.getByRole("checkbox", {
    name: "同时保存计算规则",
    exact: true,
  });
  await confirm.focus();
  await confirm.press("Space");
  assert.equal(await confirm.isChecked(), true);
  const grain = entry.getByLabel("每行代表什么", { exact: true });
  await grain.focus();
  await grain.fill("订单中的一个商品行");
  await entry
    .getByLabel("唯一键（每行一组）", { exact: true })
    .fill("order_id, line_id");
  const narrowSaving = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.endsWith("/knowledge/" + target.id),
  );
  const save = entry.getByRole("button", { name: "保存修改", exact: true });
  await save.focus();
  await save.press("Enter");
  const narrowResponse = await narrowSaving;
  assert.equal(narrowResponse.status(), 200, await narrowResponse.text());
  await entry
    .getByRole("textbox", { name: "表说明", exact: true })
    .waitFor({ state: "detached" });
  const narrowSaved = await read();
  assert.equal(
    narrowSaved.entries.find((item) => item.entry_id === "description")
      .effective_structure.grain,
    "订单中的一个商品行",
  );
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(widths.content <= widths.viewport + 1, JSON.stringify(widths));
  await page.screenshot({ path: output + "/narrow-structure.png" });
  checks.push(
    "390px窄屏通过键盘展开、选择并保存计算规则，页面没有额外横向溢出",
  );
  // 目录真实分页：字段占满普通页；分组页仍可能被文档占满，选择器必须允许续查。
  const selectorName = "selection_scope_table";
  const selectorColumns = Array.from({ length: 101 }, (_, index) => ({
    id: "column_" + index,
    name: "column_" + index,
    data_type: "INTEGER",
    nullable: false,
    comment: "",
  }));
  await writeFile(
    h.directory + "/platform/catalog.json",
    JSON.stringify({
      source_namespace: "semantic-selector-browser",
      authoritative: true,
      tables: [
        {
          id: selectorName,
          name: selectorName,
          platform_version: "1",
          maintainer_id: "alice",
          comment: "引用选择分页用合成元数据",
          columns: selectorColumns,
          ddl:
            "CREATE TABLE " +
            selectorName +
            " (" +
            selectorColumns
              .map((column) => column.name + " INTEGER NOT NULL")
              .join(", ") +
            ");",
          node: null,
        },
      ],
    }),
  );
  assert.equal(
    (await h.request("/source-syncs", { operation_id: randomUUID() })).status,
    200,
  );
  const ungrouped = (
    await h.request("/knowledge?directory=all&state=enabled&q=selection_scope")
  ).value;
  assert.equal(ungrouped.objects.length, 100);
  assert.ok(ungrouped.objects.every((object) => object.kind === "field"));
  assert.ok(ungrouped.next_after_id);
  const grouped = (
    await h.request(
      "/knowledge?directory=all&directory_view=grouped&state=enabled&q=selection_scope",
    )
  ).value;
  assert.equal(grouped.objects.length, 1);
  assert.equal(grouped.objects[0].kind, "table");
  for (let index = 0; index < 101; index++) {
    const document = await h.request("/knowledge", {
      operation_id: randomUUID(),
      kind: "document",
      name: "selection_scope_reference_" + index,
      body: "合成分页资料；仅用于检验引用选择，不定义计算口径。",
      related_ids: [],
    });
    assert.equal(document.status, 200);
  }
  const crowded = (
    await h.request(
      "/knowledge?directory=all&directory_view=grouped&state=enabled&q=selection_scope",
    )
  ).value;
  assert.equal(crowded.objects.length, 100);
  assert.ok(crowded.objects.every((object) => object.kind === "document"));
  assert.ok(crowded.next_after_id);
  const selectorField = h.sql(
    "SELECT body FROM knowledge_objects WHERE kind='field' AND name='selection_scope_table.column_0'",
  )[0];
  assert.ok(selectorField);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    h.url +
      "/#knowledge?" +
      new URLSearchParams({
        object: selectorField.id,
        scope: "all",
        tab: "概览",
      }),
  );
  await page.reload();
  await page.getByRole("heading", { name: selectorField.name, exact: true }).waitFor();
  await page.locator(".field-object > details > summary").click();
  const unitEntry = page
    .locator(".semantic-entry")
    .filter({
      has: page.locator(".entry-head strong", { hasText: "单位与精度" }),
    });
  await unitEntry.getByRole("button", { name: "编辑", exact: true }).click();
  await unitEntry
    .getByRole("textbox", { name: "单位与精度", exact: true })
    .fill("人工核对：该字段使用整数分。");
  await unitEntry.locator(".semantic-structure > summary").click();
  await unitEntry
    .getByRole("checkbox", { name: "同时保存计算规则", exact: true })
    .check();
  const picker = unitEntry.locator(".semantic-table-picker");
  await picker.getByLabel("所属表", { exact: true }).fill("selection_scope");
  await picker
    .getByText("当前已读取的结果中没有匹配的表，可继续查找。", { exact: true })
    .waitFor();
  assert.equal(
    await picker
      .getByText("没有匹配的表，请换个名称。", { exact: true })
      .count(),
    0,
  );
  const continuing = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/knowledge" &&
      url.searchParams.get("directory_view") === "grouped" &&
      url.searchParams.has("after_id")
    );
  });
  await picker.getByRole("button", { name: "继续查找表", exact: true }).click();
  assert.equal((await continuing).status(), 200);
  await picker.getByRole("button", { name: "selection_scope_table · 平台元数据", exact: true }).waitFor();
  await page.screenshot({ path: output + "/table-reference-pagination.png" });
  await picker
    .getByRole("button", {
      name: "selection_scope_table · 平台元数据",
      exact: true,
    })
    .click();
  await unitEntry.getByLabel("单位", { exact: true }).fill("分");
  const fieldSaving = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.endsWith(
        "/knowledge/" + selectorField.id,
      ),
  );
  await unitEntry
    .getByRole("button", { name: "保存修改", exact: true })
    .click();
  const fieldResponse = await fieldSaving;
  assert.equal(fieldResponse.status(), 200, await fieldResponse.text());
  const fieldSaved = (
    await h.request("/knowledge/" + selectorField.id)
  ).value.entries.find((value) => value.entry_id === "unit");
  assert.equal(
    fieldSaved.effective_structure.table.object_id,
    grouped.objects[0].id,
  );
  assert.equal(fieldSaved.effective_structure.unit, "分");
  checks.push(
    "表引用查找排除字段占页，并在文档占满首100项时明确续页，用户可选后页表并真实保存字段单位",
  );
  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} finally {
  await writeFile(
    output + "/result.json",
    JSON.stringify({ passed, checks, officialRequests: 0 }, null, 2),
  );
  await browser.close();
  await h.close();
}
