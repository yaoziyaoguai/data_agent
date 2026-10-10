import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { harness } from "./harness.mjs";

const h = await harness({
  capture: true,
  startWorker: false,
  startupTimeout: 60000,
});
const checks = [];
const command = () => ({ operation_id: randomUUID() });
const table = "table-demo_order_detail";
const quoted = (v) => "'" + v.replaceAll("'", "''") + "'";
async function ok(path, body, user = "alice", method = body ? "POST" : "GET") {
  const r = await h.request(path, body, user, method);
  assert.equal(r.status, 200, JSON.stringify({ path, ...r }));
  return r.value;
}
const createInput = (kind) => ({
  ...command(),
  kind,
  name: "合成" + kind + randomUUID(),
  body: "合成业务说明",
  related_ids: [table, "table-raw_payments"],
});
const read = (id, user = "bob") => ok("/knowledge/" + id, undefined, user);
const edit = (o, user) =>
  h.request(
    "/knowledge/" + o.id,
    {
      ...command(),
      expected_version: o.version,
      entry_id: "body",
      value: "更新的合成说明",
    },
    user,
    "PATCH",
  );
const assign = async (id, owner) => {
  const o = await read(id);
  return ok("/knowledge/" + id + "/maintainer", {
    ...command(),
    expected_version: o.maintenance.version,
    maintainer_id: owner,
  });
};
const counts = () =>
  h.sql(
    "SELECT JSON_OBJECT('objects',(SELECT COUNT(*) FROM knowledge_objects),'versions',(SELECT COUNT(*) FROM knowledge_versions),'jobs',(SELECT COUNT(*) FROM knowledge_index_jobs),'operations',(SELECT COUNT(*) FROM knowledge_operations))",
  )[0];
try {
  assert.deepEqual(await ok("/semantic-access", undefined, "bob"), {
    can_admin: false,
    can_create: false,
    highest_role: "user",
  });
  assert.equal(
    (await h.request("/knowledge", createInput("document"), "bob")).status,
    403,
  );
  const catalog = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/catalog", {
    method: "POST",
    headers: {
      authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: 50 }),
  }).then((r) => r.json());
  async function synchronize(owner) {
    catalog.tables = catalog.tables.map(t => ({ ...t, platform_version: String(Number(t.platform_version) + 1) }));
    await writeFile(
      h.directory + "/platform/catalog.json",
      JSON.stringify({
        source_namespace: catalog.source_namespace,
        tables: catalog.tables.map((t) => ({
          ...t,
          maintainer_id: t.id === "demo_order_detail" ? owner : "alice",
        })),
      }),
    );
    await ok("/source-syncs", command());
  }
  await synchronize("bob");
  assert.deepEqual(await ok("/semantic-access", undefined, "bob"), {
    can_admin: false,
    can_create: true,
    highest_role: "maintainer",
  });
  assert.deepEqual(await ok("/semantic-access"), {
    can_admin: true,
    can_create: true,
    highest_role: "super_maintainer",
  });
  h.sql(
    "INSERT INTO semantic_ownership(space_id,object_id,authority_id,maintainer_id,source,updated_by) VALUES('other-space','foreign-table','foreign-table','carol','datasight','test')",
  );
  assert.equal(
    (await ok("/semantic-access", undefined, "carol")).can_create,
    false,
  );
  assert.equal(
    (await h.request("/knowledge", createInput("metric"), "carol")).status,
    403,
  );
  assert.equal(
    (
      await h.request(
        "/knowledge",
        { ...createInput("metric"), maintainer_id: "carol" },
        "bob",
      )
    ).status,
    400,
  );
  for (const kind of ["table", "field"])
    assert.equal(
      (await h.request("/knowledge", createInput(kind), "bob")).status,
      403,
    );
  checks.push(
    "creation eligibility comes from current-space Datasight table maintainers; ordinary users and forged ownership are denied",
  );

  const bodies = [],
    objects = [];
  for (const kind of ["metric", "document", "term", "relationship"]) {
    const input = createInput(kind);
    bodies.push(input);
    const o = await ok("/knowledge", input, "bob");
    objects.push(o);
    assert.equal(o.created_by, "bob");
    assert.equal(o.maintenance.maintainer_id, "bob");
    assert.equal(o.maintenance.source, "creator");
    assert.equal(o.maintenance.can_edit, true);
    assert.equal((await edit(o, "bob")).status, 200);
    assert.equal((await edit(await read(o.id), "carol")).status, 403);
  }
  assert.equal((await read("table-raw_payments")).maintenance.can_edit, false);
  const concurrent = createInput("document");
  const pair = await Promise.all([
    ok("/knowledge", concurrent, "bob"),
    ok("/knowledge", concurrent, "bob"),
  ]);
  assert.equal(pair[0].id, pair[1].id);
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_versions WHERE object_id=${quoted(pair[0].id)}`,
    )[0].n,
    1,
  );
  assert.equal(
    (await h.request("/knowledge", { ...concurrent, body: "不同输入" }, "bob"))
      .status,
    409,
  );
  checks.push(
    "each independent kind belongs to its creator; references grant no table authority; concurrent replay creates one version",
  );

  await assign(objects[0].id, "carol");
  const replay = await ok("/knowledge", bodies[0], "bob");
  assert.equal(replay.maintenance.maintainer_id, "carol");
  assert.equal(replay.created_by, "bob");
  assert.equal((await edit(await read(objects[0].id), "bob")).status, 403);
  assert.equal((await edit(await read(objects[0].id), "carol")).status, 200);
  assert.equal(
    (await ok("/semantic-access", undefined, "carol")).can_create,
    false,
  );
  await assign(objects[0].id, null);
  assert.equal(
    (await ok("/knowledge", bodies[0], "bob")).maintenance.maintainer_id,
    null,
  );
  checks.push(
    "admin transfer and revocation survive create replay; independent ownership does not grant pool membership",
  );

  const before = counts();
  const retry = createInput("document");
  h.sql(
    "CREATE TRIGGER creator_registration_failure BEFORE INSERT ON semantic_ownership FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic creator registration failure'",
  );
  try {
    const failure = await h.request("/knowledge", retry, "bob");
    assert.equal(failure.status, 503);
    assert.equal(failure.value.code, "unavailable");
    assert.deepEqual(counts(), before);
  } finally {
    h.sql("DROP TRIGGER creator_registration_failure");
  }
  assert.equal(
    (await ok("/knowledge", retry, "bob")).maintenance.maintainer_id,
    "bob",
  );
  checks.push(
    "creation, ownership, version, index job and operation receipt roll back together",
  );

  const legacy = await ok("/knowledge", createInput("document"), "bob");
  const revoked = await ok("/knowledge", createInput("document"), "bob");
  await assign(revoked.id, null);
  const transferred = await ok("/knowledge", createInput("document"), "bob");
  await assign(transferred.id, "carol");
  h.sql(
    `UPDATE semantic_ownership SET maintainer_id=NULL,source='system',version=1 WHERE object_id=${quoted(legacy.id)}`,
  );
  const migration = await readFile(
    "migrations/202610070001_creator_ownership.sql",
    "utf8",
  );
  // 只在本测试随机创建的数据库中重建索引并执行原始升级 SQL。
  h.sql("DROP INDEX semantic_creator_pool ON semantic_ownership;" + migration);
  assert.equal((await read(legacy.id)).maintenance.maintainer_id, "bob");
  assert.equal((await read(legacy.id)).maintenance.source, "creator");
  assert.equal((await read(revoked.id)).maintenance.maintainer_id, null);
  assert.equal((await read(transferred.id)).maintenance.maintainer_id, "carol");
  const seeded = (await ok("/knowledge")).objects.filter(
    (o) => !o.created_by || o.source_id,
  );
  for (const o of seeded) assert.notEqual(o.maintenance.source, "creator");
  checks.push(
    "upgrade assigns untouched human-created records, preserves explicit transfer/revocation, and leaves imported objects alone",
  );

  await synchronize("carol");
  assert.equal((await ok("/semantic-access", undefined, "bob")).highest_role, "maintainer");
  assert.equal(
    (await ok("/semantic-access", undefined, "bob")).can_create,
    false,
  );
  assert.equal(
    (await h.request("/knowledge", createInput("document"), "bob")).status,
    403,
  );
  assert.equal(
    (await ok("/semantic-access", undefined, "carol")).can_create,
    true,
  );
  assert.equal((await read(objects[1].id)).maintenance.maintainer_id, "bob");
  assert.equal((await edit(await read(objects[1].id), "bob")).status, 200);
  assert.equal((await edit(await read(objects[1].id), "carol")).status, 403);
  checks.push(
    "table handover updates pool eligibility without transferring independent objects",
  );
  await mkdir(".local/checks", { recursive: true });
  await writeFile(
    ".local/checks/creator-ownership.json",
    JSON.stringify(
      {
        checks,
        passed: checks.length,
        evidence: "isolated MySQL and synthetic platform; no model calls",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally {
  await h.close();
}
