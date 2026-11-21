import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { harness } from "./harness.mjs";

const h = await harness({ web: true, startWorker: false });
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  const id = "field-quantity";
  const path = "/knowledge/" + id;
  const batch = "/knowledge/batch-entries";
  const original = (await h.request(path)).value;
  const fieldType = original.entries.find(entry => entry.entry_id === "type");
  const requests = [];
  await page.route("**" + batch, async route => {
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
    if (index === 0) {
      await page.getByRole("button", {name: "我的积累", exact: true}).click();
      const guard = page.getByRole("dialog", {name: "保留刚才的修改吗？"});
      await guard.getByRole("button", {name: "继续编辑"}).click();
      assert.equal(await page.getByRole("button", {name: "查看本次修改（1）"}).count(), 1);
      assert.equal(await page.evaluate(() => {
        const event = new Event("beforeunload", {cancelable: true});
        return !window.dispatchEvent(event);
      }), true);
    }
    await page.getByRole("button", {name: /查看本次修改/}).click();
    const submit = page.getByRole("button", {name: "提交全部修改"});
    if (index === 0) {
      const dropped = page.waitForEvent("requestfailed", req => req.url().endsWith(batch));
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

  const storedBeforeStructure = (await h.request(path)).value;
  const structured = storedBeforeStructure.entries.find(item => item.path === 'meaning');
  const meaningEditor = field.locator('.semantic-entry').filter({has: page.locator('.entry-head strong', {hasText: structured.label})});
  await meaningEditor.getByRole('button', {name: '编辑', exact: true}).click();
  await meaningEditor.locator('textarea').first().fill('单位仍按本表件数定义');
  await meaningEditor.getByText('补充或核对计算规则', {exact: true}).click();
  await meaningEditor.getByLabel('同时保存计算规则').check();
  await meaningEditor.getByLabel('单位', {exact: true}).fill('合成件');
  await meaningEditor.getByRole('button', {name: '暂存修改'}).click();
  assert.equal(requests.length, 3);
  assert.equal((await h.request(path)).value.version, storedBeforeStructure.version);
  const catalog = await fetch(h.env.DATA_AGENT_API_URL + '/workspace/events', {
    headers: {authorization: 'Bearer ' + h.tokens.bob}, signal: AbortSignal.timeout(15000),
  });
  assert.equal(catalog.status, 200);
  await page.getByRole('button', {name: '查看本次修改（1）'}).click();
  await page.getByRole('button', {name: '提交全部修改'}).click();
  await page.getByRole('dialog').waitFor({state: 'detached'});
  assert.equal(requests.length, 4);
  const [structureEdit] = requests[3].objects[0].edits;
  assert.equal(structureEdit.entry_id, structured.entry_id);
  assert.equal(structureEdit.structured_value.unit, '合成件');
  const updatedMeaning = (await h.request(path)).value.entries.find(item => item.path === 'meaning');
  assert.equal(updatedMeaning.effective_value, '单位仍按本表件数定义');
  assert.equal(updatedMeaning.effective_structure.unit, '合成件');
  const reader = catalog.body.getReader();
  try {
    const decoder = new TextDecoder();
    let event = '';
    while (!event.includes('\n\n')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      event += decoder.decode(chunk.value, {stream: true});
    }
    assert.match(event, /event: catalog_changed\ndata: \{\}\n/);
  } finally {
    await reader.cancel();
  }

  const tableId = "table-demo_order_detail";
  const [fieldNow, table] = (await Promise.all([h.request(path), h.request("/knowledge/" + tableId)])).map(response => {
    assert.equal(response.status, 200);
    return response.value;
  });
  const meaning = fieldNow.entries.find(entry => entry.path === "meaning");
  assert.ok(meaning.effective_structure, "真实字段已有结构化说明");
  const overview = table.entries.find(entry => !["business_domain", "ddl", "lineage"].includes(entry.path));
  const changes = [
    { object_id: id, expected_version: fieldNow.version, edits: [
      {entry_id: "type", value: "BIGINT"},
      {entry_id: meaning.entry_id, value: "校对后的件数", structured_value: meaning.effective_structure},
    ] },
    { object_id: tableId, expected_version: table.version, edits: [{entry_id: overview.entry_id, value: "校对后的订单明细"}] },
  ];
  const put = (objects, operation_id = randomUUID()) => h.request(batch, {operation_id, objects}, "alice", "PATCH");
  const incompatible = structuredClone(changes);
  incompatible[1].expected_version = (BigInt(table.version) + 1n).toString();
  assert.equal((await put(incompatible)).value.code, "version_conflict");
  assert.equal((await h.request(path)).value.version, fieldNow.version);
  assert.equal((await h.request("/knowledge/" + tableId)).value.version, table.version);
  const badEntry = structuredClone(changes);
  badEntry[1].edits[0].entry_id = "nonexistent-entry";
  assert.equal((await put(badEntry)).status, 400);
  assert.equal((await h.request(path)).value.version, fieldNow.version);
  const operation = randomUUID();
  const saved = await put(changes, operation);
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.deepEqual((await put(changes, operation)).value, saved.value);
  const savedField = saved.value.objects.find(object => object.id === id);
  assert.equal(BigInt(savedField.version), BigInt(fieldNow.version) + 1n);
  assert.equal(savedField.entries.find(entry => entry.path === "meaning").effective_structure.unit, meaning.effective_structure.unit);
  const revisions = h.sql(`SELECT JSON_OBJECT('id',object_id,'n',COUNT(*)) FROM knowledge_index_jobs
    WHERE target_kind='knowledge_entry' AND ((object_id='${id}' AND version>${fieldNow.version})
      OR (object_id='${tableId}' AND version>${table.version})) GROUP BY object_id ORDER BY object_id`);
  assert.deepEqual(revisions, [{id,n:1},{id:tableId,n:1}]);
  console.log(JSON.stringify({passed: true, edits: 2, structuredDraft: true, catalogSignalWithoutObjectIds: true, submissions: requests.length, leaveGuard: true,
    atomicObjects: saved.value.objects.length, rollbackCases: 2, finalIndexTargets: revisions.length, officialRequests: 0}));
} catch (error) {
  await page.screenshot({path: h.directory + "/batch-edit-failure.png"});
  throw error;
} finally {
  await browser.close();
  await h.close();
}
