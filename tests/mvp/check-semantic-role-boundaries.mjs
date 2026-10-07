import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { harness, until } from "./harness.mjs";

const selected = process.argv[process.argv.indexOf("--case") + 1];
assert.ok(["sync", "members", "directory"].includes(selected));
const h = await harness({ capture: true, startWorker: false, startupTimeout: 60000 });
const checks = [];
const command = () => ({ operation_id: randomUUID() });
async function ok(path, body, user = "alice", method = body ? "POST" : "GET") {
  const r = await h.request(path, body, user, method);
  assert.equal(r.status, 200, JSON.stringify({ path, ...r }));
  return r.value;
}
const read = (id, user = "bob") => ok("/knowledge/" + id, undefined, user);
const create = (name, user = "bob", kind = "document") => ok("/knowledge", {
  ...command(), kind, name, body: "从零构造的角色边界说明", related_ids: [],
}, user);

async function checkPermissionSnapshotDuringAssignment() {
  const table = await read("table-demo_order_detail");
  assert.equal((await ok("/semantic-access", undefined, "bob")).can_create, true);
  const correction = await ok("/semantic-corrections", {
    ...command(), object_id: table.id, base_version: table.version,
    entry_id: table.entries[0].entry_id, value: "合成建议", reason: "验证同步时读取",
    evidence: [{ object_id: table.id, version: table.version, path: table.entries[0].entry_id }], share_confirmed: true,
  }, "carol");
  const database = new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
  const container = execFileSync("docker", ["--context", "colima-data-agent", "ps", "--filter", "label=com.docker.compose.project=data-agent", "--filter", "label=com.docker.compose.service=mysql", "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
  const writer = spawn("docker", ["--context", "colima-data-agent", "exec", "-i", container, "mysql", "--defaults-extra-file=/run/secrets/mysql_root_client", "--batch", "--raw", "--unbuffered", "--skip-column-names", database], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "";
  writer.stdout.on("data", data => { output += data; });
  writer.stderr.on("data", data => { error += data; });
  const ended = new Promise(resolve => writer.on("exit", code => resolve(code)));
  const pending = [];
  try {
    writer.stdin.write("START TRANSACTION; UPDATE semantic_ownership SET maintainer_id='carol',version=version+1 WHERE space_id='demo' AND source='datasight' AND authority_id=object_id AND maintainer_id='bob' ORDER BY object_id; SELECT 'assignment_held';\n");
    await until(() => output.includes("assignment_held"), "hold uncommitted assignment");
    // 真实页面读取应看到已提交的 Bob 归属，不等待未提交改派，更不能脏读 Carol。
    for (const path of ["/knowledge?directory=all&q=demo_order_detail", "/knowledge?directory=maintained&q=demo_order_detail", "/knowledge/" + table.id, "/semantic-corrections", "/semantic-corrections/" + correction.id, "/semantic-access"]) {
      const request = h.request(path, undefined, "bob");
      pending.push(request);
      let timer;
      try {
        const response = await Promise.race([request, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("display waited for assignment lock: " + path)), 8000);
        })]);
        assert.equal(response.status, 200, JSON.stringify(response));
        const value = response.value;
        if (value.objects) assert.equal(value.objects.find(o => o.id === table.id)?.maintenance.maintainer_id, "bob");
        else if (value.maintenance) assert.equal(value.maintenance.maintainer_id, "bob");
        else if (value.corrections) assert.equal(value.corrections.find(p => p.id === correction.id)?.can_review, true);
        else if ("can_create" in value) assert.equal(value.can_create, true);
        else assert.equal(value.can_review, true);
      } finally { clearTimeout(timer); }
    }
    const edit = h.request("/knowledge/" + table.id + "/disable", { ...command(), expected_version: table.version }, "bob");
    const review = h.request("/semantic-corrections/" + correction.id + "/review", { ...command(), expected_revision: correction.revision, decision: "accepted", reason: "权限必须重新核对" }, "bob");
    const createName = "合成撤权后拒绝创建";
    const creation = h.request("/knowledge", { ...command(), kind: "document", name: createName, body: "验证创建等待当前授权", related_ids: [] }, "bob");
    pending.push(edit, review, creation);
    await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks b ON b.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID WHERE b.OBJECT_SCHEMA='${database}' AND b.OBJECT_NAME='semantic_ownership'`)[0].n >= 3, "mutations wait for current authorization");
    writer.stdin.end("COMMIT;\n");
    assert.equal(await ended, 0, error);
    assert.equal((await edit).status, 403);
    assert.equal((await review).status, 404);
    assert.equal((await creation).status, 403);
    assert.equal((await ok("/semantic-access", undefined, "bob")).can_create, false);
    assert.equal((await ok("/knowledge?directory=all&q=" + encodeURIComponent(createName), undefined, "bob")).objects.length, 0);
    assert.equal((await read(table.id)).state, table.state);
    assert.equal((await ok("/semantic-corrections/" + correction.id, undefined, "carol")).state, "submitted");
    assert.equal((await h.request("/semantic-corrections/" + correction.id, undefined, "bob")).status, 404);
    checks.push("目录/详情/建议/创建资格展示读取已提交权限快照；编辑、审核和创建等待改派提交后重验并拒绝撤权者");
  } finally {
    if (!writer.stdin.writableEnded) writer.stdin.end("ROLLBACK;\n");
    await ended;
    await Promise.allSettled(pending);
  }
}
let server;
try {
  await ok("/source-syncs", command());
  const catalog = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/catalog", {
    method: "POST", headers: { authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ limit: 50 }),
  }).then(r => r.json());
  const saveCatalog = tables => writeFile(h.directory + "/platform/catalog.json", JSON.stringify({ source_namespace: catalog.source_namespace, tables }));
  const snapshot = () => h.sql("SELECT JSON_OBJECT('id',object_id,'owner',maintainer_id,'version',CAST(version AS CHAR)) FROM semantic_ownership WHERE source='datasight' AND authority_id=object_id ORDER BY object_id");
  const setBob = async () => {
    const tables = catalog.tables.map(t => ({ ...t, platform_version: "2", maintainer_id: "bob" }));
    await saveCatalog(tables); await ok("/source-syncs", command()); return tables;
  };
  if (selected === "sync") {
    const original = snapshot();
    const tables = structuredClone(catalog.tables);
    tables[0].platform_version = "2";
    tables[0].maintainer_id = "bob";
    tables[1].comment = "同版本冲突的合成注释";
    await saveCatalog(tables);
    const failed = await h.request("/source-syncs", command());
    assert.equal(failed.status, 409); assert.equal(failed.value.code, "version_conflict");
    assert.deepEqual(snapshot(), original);
    assert.equal((await ok("/semantic-access", undefined, "bob")).can_create, false);
    assert.equal((await h.request("/knowledge", { ...command(), kind: "document", name: "拒绝未完成同步授权", body: "合成", related_ids: [] }, "bob")).status, 403);
    checks.push("后续表冲突不会提交前面表的负责人或创建资格");

    await h.pausePlatform();
    let calls = 0;
    server = createServer(async (req, res) => {
      for await (const _ of req) {}
      const first = calls++ === 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schema_version: 1, source_namespace: catalog.source_namespace, snapshot_id: "incomplete-role-snapshot", tables: first ? [tables[0]] : [], next_cursor: first ? "next" : "broken", complete: false, authoritative: true }));
    });
    await new Promise(r => server.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port), "127.0.0.1", r));
    assert.notEqual((await h.request("/source-syncs", command())).status, 200);
    assert.deepEqual(snapshot(), original);
    server.closeAllConnections(); await new Promise(r => server.close(r)); server = undefined;
    await h.resumePlatform();
    checks.push("分页未完整结束时负责人保持上一成功快照");

    for (const t of tables) { t.platform_version = "3"; t.maintainer_id = "bob"; }
    await saveCatalog(tables);
    h.sql("\nDELIMITER $$\nCREATE TRIGGER reject_completed_role_sync BEFORE UPDATE ON catalog_imports FOR EACH ROW BEGIN IF NEW.state='succeeded' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic completion failure'; END IF; END$$\nDELIMITER ;\n");
    try {
      assert.equal((await h.request("/source-syncs", command())).status, 503);
      assert.deepEqual(snapshot(), original);
    } finally { h.sql("DROP TRIGGER reject_completed_role_sync"); }
    await ok("/source-syncs", command());
    assert.equal((await ok("/semantic-access", undefined, "bob")).can_create, true);
    assert.ok(snapshot().every(o => o.owner === "bob"));
    await saveCatalog([]); await ok("/source-syncs", command());
    assert.ok(snapshot().every(o => o.owner === null));
    assert.equal((await ok("/semantic-access", undefined, "bob")).can_create, false);
    checks.push("成功回执与授权原子提交；最终事务失败可安全重试，完整空目录统一撤权");
  } else if (selected === "members") {
    await setBob();
    assert.deepEqual(await ok("/semantic-members"), { user_ids: ["alice", "bob", "carol"] });
    assert.equal((await h.request("/semantic-members", undefined, "bob")).status, 403);
    const doc = await create("合成成员转交文档");
    const invalid = { ...command(), expected_version: doc.maintenance.version, maintainer_id: "nonexistent-member" };
    assert.equal((await h.request("/knowledge/" + doc.id + "/maintainer", invalid)).status, 400);
    assert.deepEqual((await read(doc.id)).maintenance, doc.maintenance);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM semantic_owner_operations WHERE operation_id='${invalid.operation_id}'`)[0].n, 0);
    const assign = { ...command(), expected_version: doc.maintenance.version, maintainer_id: "carol" };
    assert.equal((await h.request("/knowledge/" + doc.id + "/maintainer", assign, "bob")).status, 403);
    const assigned = await ok("/knowledge/" + doc.id + "/maintainer", assign);
    assert.deepEqual(await ok("/knowledge/" + doc.id + "/maintainer", assign), assigned);
    assert.equal((await read(doc.id, "carol")).maintenance.can_edit, true);
    assert.equal((await read(doc.id, "bob")).maintenance.can_edit, false);
    assert.equal((await ok("/semantic-access", undefined, "carol")).can_create, false);
    await ok("/knowledge/" + doc.id + "/maintainer", { ...command(), expected_version: assigned.version, maintainer_id: null });
    assert.equal((await read(doc.id, "carol")).maintenance.can_edit, false);
    checks.push("仅超级维护者列出成员与转交；无效目标无写入，有效成员转交/撤销/重试保持语义");
  } else {
    await setBob();
    const prefix = "合成停用管理" + randomUUID();
    const docs = [];
    for (const [i, kind] of ["document", "metric"].entries()) {
      const o = await create(prefix + i, "bob", kind);
      const enabled = await ok("/knowledge?q=" + encodeURIComponent(o.name), undefined, "bob");
      assert.ok(enabled.objects.some(candidate => candidate.id === o.id));
      docs.push(await ok("/knowledge/" + o.id + "/disable", { ...command(), expected_version: o.version }, "bob"));
    }
    const endpoint = "/knowledge?directory=maintained&state=disabled&q=" + encodeURIComponent(prefix);
    const mine = await ok(endpoint, undefined, "bob");
    assert.deepEqual(mine.objects.map(o => o.id).sort(), docs.map(o => o.id).sort());
    assert.equal((await ok(endpoint, undefined, "carol")).objects.length, 0);
    const retrieved = await ok("/knowledge?q=" + encodeURIComponent(prefix), undefined, "bob");
    assert.ok(retrieved.objects.every(o => o.state === "enabled" && !docs.some(disabled => disabled.id === o.id)));
    assert.equal((await ok("/knowledge?directory=all&state=disabled&q=" + encodeURIComponent(prefix), undefined, "carol")).objects.length, 2);
    for (const o of docs) {
      const input = { ...command(), expected_version: o.version };
      assert.equal((await h.request("/knowledge/" + o.id + "/enable", input, "carol")).status, 403);
      await ok("/knowledge/" + o.id + "/enable", input, "bob");
    }
    assert.equal((await ok(endpoint, undefined, "bob")).objects.length, 0);
    for (const params of ["state=disabled", "directory=all&related_id=table-demo_order_detail", "directory=unknown", "directory=all&state=deleted"]) {
      assert.equal((await h.request("/knowledge?" + params)).status, 400);
    }
    const pagePrefix = "合成目录分页" + randomUUID();
    // 实际API构造跨页数据，结果预期仅根据创建身份，不由目录返回反写。
    const ids = [];
    for (let i = 0; i < 103; i++) ids.push((await create(pagePrefix + i)).id);
    const first = await ok("/knowledge?directory=maintained&q=" + pagePrefix, undefined, "bob");
    assert.equal(first.objects.length, 100); assert.ok(first.next_after_id);
    const second = await ok("/knowledge?directory=maintained&q=" + pagePrefix + "&after_id=" + first.next_after_id, undefined, "bob");
    assert.equal(second.next_after_id, null);
    assert.deepEqual([...first.objects, ...second.objects].map(o => o.id).sort(), ids.sort());
    checks.push("按当前负责人、名称、状态和分页找回独立对象；普通读者无启用权，Agent检索不召回停用项");
    await checkPermissionSnapshotDuringAssignment();
  }
  const result = { passed: checks.length, case: selected, checks, evidence: "isolated MySQL and synthetic platform; no model calls" };
  await writeFile(`.local/checks/semantic-role-${selected}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await h.close();
}
