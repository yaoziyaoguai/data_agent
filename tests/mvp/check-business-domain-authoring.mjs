import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness } from "./harness.mjs";

const h = await harness({capture: true, startWorker: false, env: {DATA_AGENT_LEASE_MS: "120000"}});
const checks = [];
let passed = false;
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response)); return response.value; };
const read = async id => ok(await h.request(`/knowledge/${id}`));
const domain = object => object.entries.find(entry => entry.path === "business_domain");
const input = (kind, name, extras = {}) => ({operation_id: randomUUID(), kind, name, body: "独立构造的归属测试资料", related_ids: [], ...extras});
const edit = (object, value, extras = {}, user = "alice") => h.request(`/knowledge/${object.id}`, {
  operation_id: randomUUID(), expected_version: object.version, entry_id: domain(object)?.entry_id ?? "business_domain", value, ...extras,
}, user, "PATCH");
try {
  const table = await read("table-demo_order_detail");
  const kinds = ["table", "field", "metric", "document", "relationship", "term", "query_example"];
  for (const kind of kinds) {
    const extras = kind === "query_example" ? {structured_value: {
      kind, applicable_question: "合成行数", parameters: [], sql: "SELECT COUNT(*) AS rows FROM demo_order_detail",
      grain: "单条汇总行", dependencies: [{object_id: table.id, version: table.version, path: "description"}],
      verification: {note: "独立合成验证", evidence_refs: [{object_id: table.id, version: table.version, path: "description"}]},
    }} : {};
    const object = ok(await h.request("/knowledge", input(kind, `domain-authoring-${kind}`, {...extras, business_domain: "合成履约"})));
    assert.equal(domain(object).effective_value, "合成履约");
    assert.equal(domain(object).human_override.edited_by, "alice");
    assert.equal(domain(object).review_state, "confirmed");
    assert.equal(domain(object).source_facts.complete, false);
    assert.equal(domain(object).source_facts.source_id, undefined);
    assert.equal(object.source_id, null);
    const changed = ok(await edit(object, "合成售后"));
    assert.equal(domain(changed).effective_value, "合成售后");
    assert.equal(domain(ok(await h.request(`/knowledge/${object.id}?version=${object.version}`))).effective_value, "合成履约");
  }
  checks.push("七种知识对象均可通过正式创建与编辑入口显式指定业务域；保存人工层和历史版本，不伪造来源");

  let legacy = ok(await h.request("/knowledge", input("document", "domain-scope-legacy", {related_ids: [table.id]})));
  assert.equal(domain(legacy), undefined);
  const initialVersion = legacy.version;
  const command = {operation_id: randomUUID(), expected_version: legacy.version, entry_id: "business_domain", value: "合成物流"};
  legacy = ok(await h.request(`/knowledge/${legacy.id}`, command, "alice", "PATCH"));
  assert.equal(BigInt(legacy.version), BigInt(initialVersion) + 1n);
  assert.equal(domain(legacy).effective_value, "合成物流");
  assert.deepEqual(ok(await h.request(`/knowledge/${legacy.id}`, command, "alice", "PATCH")), legacy);
  assert.equal((await edit(legacy, "越权覆盖", {}, "bob")).status, 403);
  assert.equal((await edit(legacy, "不接受旧版", {expected_version: initialVersion})).status, 409);
  assert.equal((await edit(legacy, "任意槽位", {entry_id: "unregistered_metadata"})).status, 400);
  for (const value of ["字".repeat(241), " 首尾空格 ", null, 42]) {
    assert.equal((await edit(legacy, value)).status, 400);
    assert.equal((await h.request("/knowledge", input("document", "invalid-domain", {business_domain: value}))).status, 400);
  }
  assert.equal((await read(legacy.id)).version, legacy.version);
  const competing = await Promise.all([edit(legacy, "并发甲"), edit(legacy, "并发乙")]);
  assert.deepEqual(competing.map(value => value.status).sort(), [200, 409]);
  legacy = await read(legacy.id);
  assert.equal(legacy.entries.filter(entry => entry.path === "business_domain").length, 1);
  checks.push("旧对象补录沿用权限、幂等、版本CAS与原子写入；未授权、非法字段/长度/类型和旧版本均拒绝");

  legacy = ok(await edit(legacy, ""));
  assert.equal(domain(legacy).effective_value, "");
  assert.equal(domain(legacy).human_override.value, "");
  const cleared = ok(await edit(legacy, "", {clear_override: true}));
  assert.equal(domain(cleared).human_override, null);
  assert.equal(domain(cleared).effective_value, "");
  const source = await read(table.id);
  const originalDomain = domain(source);
  assert.ok(originalDomain.source_facts.complete);
  const override = ok(await edit(source, "人工选择的范围"));
  assert.deepEqual(domain(override).source_facts, originalDomain.source_facts);
  const reanalyzed = ok(await h.request(`/knowledge/${source.id}/reanalyze`, {
    operation_id: randomUUID(), expected_version: override.version,
  }));
  assert.equal(domain(reanalyzed).effective_value, "人工选择的范围");
  assert.deepEqual(domain(reanalyzed).human_override, domain(override).human_override);
  assert.equal(domain(reanalyzed).review_state, "needs_review");
  const restored = ok(await edit(reanalyzed, "人工选择的范围", {clear_override: true}));
  assert.deepEqual(domain(restored).source_facts, originalDomain.source_facts);
  assert.equal(domain(restored).effective_value, originalDomain.effective_value);
  assert.equal(domain(restored).human_override, null);
  checks.push("显式空值保留为未分类；重新预填保留人工层并要求复核；清除覆盖恢复原始来源，旧对象无来源时保持空值");

  const scoped = ok(await h.request("/knowledge", input("document", "domain-scope-exact", {business_domain: "合成物流"})));
  const different = ok(await h.request("/knowledge", input("document", "domain-scope-other", {business_domain: "其他归属"})));
  const linked = ok(await h.request("/knowledge", input("document", "domain-scope-linked", {related_ids: [scoped.id]})));
  const empty = ok(await h.request("/knowledge", input("document", "domain-scope-empty", {business_domain: ""})));
  await h.resumeWorker();
  const run = await h.capture(await h.create(), "核对显式业务域检索边界");
  await h.pauseWorker();
  const request = {
    run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: "search_knowledge",
    arguments: {query: "domain-scope", business_domain: "合成物流", limit: 10},
    checkpoint: exportCheckpoint(SessionManager.inMemory("/synthetic/data-agent"), run.workspace_context.authority_revision, run.workspace_context.authority_snapshot),
  };
  ok(await h.internal("/internal/data/tool-calls", request));
  const result = ok(await h.internal("/internal/data/tools", request));
  const ids = result.data.objects.map(value => value.id);
  assert.ok(ids.includes(scoped.id));
  for (const object of [different, linked, empty, legacy]) assert.ok(!ids.includes(object.id), object.name);
  checks.push("正式检索返回显式域命中；其他域、未分类、清空归属、仅关联有域资料均不混入限定域");
  passed = true;
} finally {
  await writeFile(".local/checks/business-domain-authoring.json", JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
  await h.close();
  console.log(JSON.stringify({passed, checks}));
}
