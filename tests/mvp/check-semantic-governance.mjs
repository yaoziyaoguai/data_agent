import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { harness, until } from "./harness.mjs";
const chosen = process.argv.includes("--case")
  ? process.argv[process.argv.indexOf("--case") + 1]
  : null;
const h = await harness({
  capture: ["GOV01", "GOV04", "GOV05"].includes(chosen),
  startWorker: !["GOV01", "GOV04", "GOV05"].includes(chosen),
  startupTimeout: 60000,
});
const checks = [];
const table = "table-demo_order_detail";
const quoted = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const command = () => ({ operation_id: randomUUID() });
async function ok(path, body, user = "alice", method = body ? "POST" : "GET") {
  const r = await h.request(path, body, user, method);
  assert.equal(r.status, 200, JSON.stringify({ path, ...r }));
  return r.value;
}
const read = (object = table, user = "alice") =>
  ok("/knowledge/" + object, undefined, user);
const edit = (o, user, value) =>
  h.request(
    "/knowledge/" + o.id,
    {
      ...command(),
      expected_version: o.version,
      entry_id: o.entries[0].entry_id,
      value,
    },
    user,
    "PATCH",
  );
const versions = () =>
  h.sql(
    `SELECT JSON_OBJECT('versions',(SELECT COUNT(*) FROM knowledge_versions),'jobs',(SELECT COUNT(*) FROM knowledge_index_jobs),'objects',(SELECT COUNT(*) FROM knowledge_objects))`,
  )[0];
const content = (o) => ({
  object_id: o.id,
  base_version: o.version,
  entry_id: o.entries[0].entry_id,
  value: "合成修正：一个订单中的商品行",
  reason: "核对合成资料的行粒度。",
  evidence: [
    { object_id: o.id, version: o.version, path: o.entries[0].entry_id },
  ],
});
const submit = async (user = "carol") =>
  ok(
    "/semantic-corrections",
    { ...command(), ...content(await read()), share_confirmed: true },
    user,
  );
const review = (p, decision = "accepted", user = "bob") =>
  ok(
    "/semantic-corrections/" + p.id + "/review",
    {
      ...command(),
      expected_revision: p.revision,
      decision,
      reason:
        decision === "accepted"
          ? "同意方向，编辑保存前再次核对"
          : "依据不足，请补充",
    },
    user,
  );
const apply = (p, body = {}, user = "bob") =>
  h.request(
    "/semantic-corrections/" + p.id + "/apply",
    {
      ...command(),
      expected_revision: p.revision,
      expected_version: p.base_version,
      value: "负责人核对后的正式说明",
      ...body,
    },
    user,
  );
let catalog;
async function synchronize(owner = "bob") {
  if (!catalog) {
    const r = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/catalog", {
      method: "POST",
      headers: {
        authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: 50 }),
    });
    catalog = await r.json();
  }
  const tables = catalog.tables.map((t) => ({
    ...t,
    maintainer_id: t.name === "demo_order_detail" ? owner : "alice",
  }));
  // 元数据版本随真实目录快照推进；不通过本系统 assignment 接口改表负责人。
  for (const t of tables)
    t.platform_version = String(Number(t.platform_version) + 1);
  catalog = { ...catalog, tables };
  await writeFile(
    h.directory + "/platform/catalog.json",
    JSON.stringify({ source_namespace: catalog.source_namespace, tables }),
  );
  await ok("/source-syncs", command());
}

async function checkConcurrentRemoval() {
  await h.pausePlatform();
  let responses = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    responses.push(res);
    if (responses.length < 2) return;
    const pair = responses;
    responses = [];
    for (const [index, response] of pair.entries()) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          schema_version: 1,
          source_namespace: catalog.source_namespace,
          snapshot_id: randomUUID(),
          tables: index === 0 ? [] : catalog.tables,
          next_cursor: null,
          complete: true,
          authoritative: true,
        }),
      );
    }
  });
  await new Promise((resolve) =>
    server.listen(
      Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),
      "127.0.0.1",
      resolve,
    ),
  );
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      catalog.tables = catalog.tables.map((t) => ({
        ...t,
        platform_version: String(Number(t.platform_version) + 1),
        maintainer_id: "carol",
      }));
      catalog.tables.push({
        ...catalog.tables[0],
        id: "concurrent-added-" + attempt,
        name: "concurrent_added_" + attempt,
      });
      // 两次采集先取得各自基线，再同时收到“移除”与“保留改派”的权威快照。
      const results = await Promise.all(
        [1, 2].map(() => h.request("/source-syncs", command())),
      );
      assert.ok(
        results.some((r) => r.status === 200),
        JSON.stringify(results),
      );
      assert.ok(
        results.every(
          (r) =>
            r.status === 200 ||
            (r.status === 409 && r.value.code === "version_conflict"),
        ),
        JSON.stringify(results),
      );
      const imported = h.sql(
        `SELECT JSON_OBJECT('id',k.id) FROM knowledge_objects k JOIN catalog_platform_heads c ON c.source_id=k.source_id WHERE k.kind='table' AND c.platform_table_id='demo_order_detail' AND c.namespace=${quoted(catalog.source_namespace)}`,
      )[0];
      const current = await read(imported.id, "carol");
      assert.equal(
        current.maintenance.maintainer_id,
        current.state === "enabled" ? "carol" : null,
      );
      assert.equal(
        (await read()).maintenance.maintainer_id,
        current.maintenance.maintainer_id,
      );
      if (current.state === "disabled") {
        assert.equal(
          h.sql(
            `SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_objects k JOIN catalog_platform_heads c ON c.source_id=k.source_id WHERE k.kind='table' AND k.state='enabled' AND c.namespace=${quoted(catalog.source_namespace)}`,
          )[0].n,
          0,
        );
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await h.resumePlatform();
  }
  await synchronize("bob");
}
try {
  await synchronize();
  if (!["GOV01", "GOV04", "GOV05"].includes(chosen)) await h.pauseWorker();
  for (const group of ["GOV01", "GOV02", "GOV03", "GOV04", "GOV05"]) {
    if (chosen && chosen !== group) continue;
    if (group === "GOV01") {
      let o = await read();
      assert.equal(o.maintenance.maintainer_id, "bob");
      assert.equal(o.maintenance.source, "datasight");
      assert.equal((await read(table, "bob")).maintenance.can_edit, true);
      assert.equal((await edit(o, "carol", "越权")).status, 403);
      assert.equal((await edit(o, "bob", "负责人编辑")).status, 200);
      o = await read();
      assert.equal((await edit(o, "alice", "超级维护者编辑")).status, 200);
      assert.equal(
        (await edit(await read("table-raw_payments"), "bob", "越权跨表"))
          .status,
        403,
      );
      const fields = (
        await ok("/knowledge?related_id=" + table)
      ).objects.filter((o) => o.kind === "field");
      assert.ok(fields.length);
      assert.equal(
        (await edit(fields[0], "bob", "所属表负责人维护字段")).status,
        200,
      );
      assert.equal(
        (
          await h.request("/knowledge/" + table + "/maintainer", {
            ...command(),
            expected_version: o.maintenance.version,
            maintainer_id: "carol",
          })
        ).status,
        403,
      );
      const doc = await ok("/knowledge", {
        ...command(),
        kind: "document",
        name: "合成跨表说明",
        body: "共享对象独立负责",
        related_ids: [table, "table-raw_payments"],
      });
      assert.equal(doc.created_by, "alice");
      assert.equal(doc.maintenance.maintainer_id, null);
      assert.equal((await edit(doc, "bob", "引用表不授予编辑权")).status, 403);
      const assign = {
        ...command(),
        expected_version: doc.maintenance.version,
        maintainer_id: "carol",
      };
      const assigned = await ok("/knowledge/" + doc.id + "/maintainer", assign);
      assert.deepEqual(
        await ok("/knowledge/" + doc.id + "/maintainer", assign),
        assigned,
      );
      assert.equal(
        (await edit(await read(doc.id), "carol", "独立负责人编辑")).status,
        200,
      );
      const updated = await read(doc.id);
      assert.equal(updated.created_by, "alice");
      assert.equal(updated.updated_by, "carol");
      assert.equal(updated.maintenance.maintainer_id, "carol");
      assert.equal((await edit(updated, "bob", "越权")).status, 403);
      assert.equal(
        (await h.request("/source-syncs", command(), "bob")).status,
        403,
      );
      await synchronize("carol");
      assert.equal((await edit(await read(), "bob", "同步撤权")).status, 403);
      assert.equal((await read(table, "carol")).maintenance.can_edit, true);
      await synchronize("bob");
      const template = catalog.tables.find((t) => t.id === "demo_order_detail");
      const collisions = [
        { ...template, id: "collision-a", maintainer_id: "bob" },
        { ...template, id: "collision-b", maintainer_id: "carol" },
      ];
      await writeFile(
        h.directory + "/platform/catalog.json",
        JSON.stringify({
          source_namespace: catalog.source_namespace,
          tables: [...catalog.tables, ...collisions],
        }),
      );
      await ok("/source-syncs", command());
      const imported = (platformId, namespace = catalog.source_namespace) =>
        h.sql(
          `SELECT JSON_OBJECT('id',k.id) FROM knowledge_objects k JOIN catalog_platform_heads c ON c.source_id=k.source_id WHERE k.kind='table' AND c.platform_table_id=${quoted(platformId)} AND c.namespace=${quoted(namespace)}`,
        )[0].id;
      assert.equal(
        (await read(imported("collision-a"), "bob")).maintenance.can_edit,
        true,
      );
      assert.equal(
        (await read(imported("collision-a"), "carol")).maintenance.can_edit,
        false,
      );
      assert.equal(
        (await read(imported("collision-b"), "carol")).maintenance.can_edit,
        true,
      );
      assert.equal((await read(table)).maintenance.maintainer_id, "bob");
      await writeFile(
        h.directory + "/platform/catalog.json",
        JSON.stringify({
          source_namespace: "synthetic-secondary",
          tables: [{ ...template, maintainer_id: "carol" }],
        }),
      );
      await ok("/source-syncs", command());
      assert.equal(
        (
          await read(
            imported("demo_order_detail", "synthetic-secondary"),
            "carol",
          )
        ).maintenance.can_edit,
        true,
      );
      assert.equal((await read(table)).maintenance.maintainer_id, "bob");
      await synchronize("bob");
      // 权威目录移除的旧表不能保留维护权。
      assert.equal(
        (await read(imported("collision-a"), "bob")).maintenance.can_edit,
        false,
      );
      checks.push({
        group,
        name: "Datasource 负责人同步、字段继承、跨表隔离、独立对象授权、录入/修改/维护人分离、超级权限",
        passed: true,
      });
    }
    if (group === "GOV02") {
      await h.resumeWorker();
      await writeFile(
        h.directory + "/platform/permissions.json",
        JSON.stringify({ denied_query_users: ["alice", "bob"] }),
      );
      for (const user of ["alice", "bob", "carol"]) {
        const cid = await h.create(user);
        await h.send(cid, "查2026年1月净收入", user);
        await h.finished(cid, 1, user);
        const q = (
          await ok("/conversations/" + cid + "/queries", undefined, user)
        ).queries[0];
        assert.ok(q);
        assert.equal(q.confirmation_state, "awaiting_confirmation");
        assert.equal(q.execution_state, "not_submitted");
        await ok(
          "/queries/" + q.id + "/confirm",
          {
            ...command(),
            condition_version: q.condition_version,
            draft_version: q.draft_version,
          },
          user,
        );
        const completed = await until(async () => {
          const v = await ok("/queries/" + q.id, undefined, user);
          return ["failed", "succeeded"].includes(v.execution_state) && v;
        }, "platform permission " + user);
        assert.equal(
          completed.execution_state,
          user === "carol" ? "succeeded" : "failed",
          JSON.stringify(completed),
        );
        if (user !== "carol") assert.equal(completed.error, "forbidden");
      }
      assert.equal(
        (await edit(await read(), "carol", "查询权不提供语义编辑")).status,
        403,
      );
      if (!["GOV01", "GOV04", "GOV05"].includes(chosen)) await h.pauseWorker();
      checks.push({
        group,
        name: "系统超级/表维护者在平台拒绝时执行失败，普通用户可执行仍不能编辑语义；未确认均未提交",
        passed: true,
      });
    }
    if (group === "GOV03") {
      const baseline = versions(),
        o = await read();
      const p = await submit();
      assert.deepEqual(versions(), baseline);
      assert.ok(
        (await ok("/semantic-corrections", undefined, "bob")).corrections.some(
          (v) => v.id === p.id,
        ),
      );
      const accepted = await review(p);
      assert.equal(accepted.state, "accepted");
      assert.deepEqual(versions(), baseline);
      assert.equal((await read()).version, o.version);
      assert.equal(
        (await ok("/semantic-corrections/" + p.id, undefined, "carol")).state,
        "accepted",
      );
      const rejected = await review(await submit(), "rejected");
      assert.equal(rejected.state, "rejected");
      assert.equal(
        (await ok("/semantic-corrections/" + rejected.id, undefined, "carol"))
          .review_reason,
        "依据不足，请补充",
      );
      // 提交后继续同一会话的 SQL 生成不依赖处理状态。
      await h.resumeWorker();
      const cid = await h.create("carol");
      await h.send(cid, "查2026年1月净收入", "carol");
      await h.finished(cid, 1, "carol");
      assert.equal(
        (await ok("/conversations/" + cid + "/queries", undefined, "carol"))
          .queries[0].confirmation_state,
        "awaiting_confirmation",
      );
      if (!["GOV01", "GOV04", "GOV05"].includes(chosen)) await h.pauseWorker();
      checks.push({
        group,
        name: "提出者到负责人的提交/接受/驳回及状态可见；接受不改语义或索引；本次 SQL 可继续",
        passed: true,
      });
    }
    if (group === "GOV04") {
      let p = await review(await submit());
      const counts = versions();
      const revision = {
        ...command(),
        expected_revision: p.revision,
        ...content(await read()),
        reason: "补充依据后重新审核",
        share_confirmed: true,
      };
      const revised = await ok(
        "/semantic-corrections/" + p.id,
        revision,
        "carol",
        "PATCH",
      );
      assert.equal(revised.state, "submitted");
      assert.equal((await apply(p)).status, 409);
      p = await review(revised);
      const older = p;
      await ok(
        "/knowledge/" + table,
        {
          ...command(),
          expected_version: p.base_version,
          entry_id: p.entry_id,
          value: "另一笔正式变更",
        },
        "bob",
        "PATCH",
      );
      assert.equal((await apply(older)).status, 409);
      p = await review(await submit());
      await synchronize("carol");
      assert.equal((await apply(p)).status, 404);
      await synchronize("bob");
      p = await review(await submit());
      const before = versions(),
        applyCommand = {
          ...command(),
          expected_revision: p.revision,
          expected_version: p.base_version,
          value: "已核对的正式说明",
        };
      h.sql(
        "CREATE TRIGGER fail_semantic_apply BEFORE UPDATE ON semantic_corrections FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic_transaction_failure'",
      );
      const failed = await h.request(
        "/semantic-corrections/" + p.id + "/apply",
        applyCommand,
        "bob",
      );
      assert.equal(failed.status, 503);
      assert.deepEqual(versions(), before);
      assert.equal((await read()).version, p.base_version);
      assert.equal(
        (await ok("/semantic-corrections/" + p.id, undefined, "carol")).state,
        "accepted",
      );
      h.sql("DROP TRIGGER fail_semantic_apply");
      const applied = await ok(
        "/semantic-corrections/" + p.id + "/apply",
        applyCommand,
        "bob",
      );
      assert.equal(applied.state, "applied");
      assert.equal((await read()).version, applied.applied_version);
      assert.equal(
        (await read()).entries.find((e) => e.entry_id === p.entry_id)
          .effective_value,
        applyCommand.value,
      );
      assert.deepEqual(versions(), {
        ...before,
        versions: before.versions + 1,
        jobs: before.jobs + 1,
      });
      assert.deepEqual(
        await ok(
          "/semantic-corrections/" + p.id + "/apply",
          applyCommand,
          "bob",
        ),
        applied,
      );
      assert.equal(
        (
          await h.request(
            "/semantic-corrections/" + p.id + "/apply",
            { ...applyCommand, value: "异参重放" },
            "bob",
          )
        ).status,
        409,
      );
      assert.ok(versions().versions > counts.versions);
      let racing = await submit();
      const decisions = await Promise.all(
        [1, 2].map(() =>
          h.request(
            "/semantic-corrections/" + racing.id + "/review",
            {
              ...command(),
              expected_revision: racing.revision,
              decision: "accepted",
              reason: "并发核对",
            },
            "bob",
          ),
        ),
      );
      assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
      racing = await ok(
        "/semantic-corrections/" + racing.id,
        undefined,
        "carol",
      );
      const revisionContent = content(await read());
      const parallel = await Promise.all([
        apply(racing),
        h.request(
          "/semantic-corrections/" + racing.id,
          {
            ...command(),
            expected_revision: racing.revision,
            ...revisionContent,
            reason: "并发补充信息",
            share_confirmed: true,
          },
          "carol",
          "PATCH",
        ),
      ]);
      assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 409]);
      const afterRace = await ok(
        "/semantic-corrections/" + racing.id,
        undefined,
        "carol",
      );
      assert.ok(["submitted", "applied"].includes(afterRace.state));
      // 一边同步撤权，一边提交/正式保存；只能成功或明确冲突/拒绝，不得发生存储死锁。
      for (let attempt = 0; attempt < 3; attempt++) {
        const p = await review(await submit());
        const input = {
          ...command(),
          ...content(await read()),
          share_confirmed: true,
        };
        const results = await Promise.all([
          h.request("/semantic-corrections", input, "carol"),
          apply(p),
          synchronize("carol"),
        ]);
        assert.ok(
          [200, 409].includes(results[0].status),
          JSON.stringify(results[0]),
        );
        assert.ok(
          [200, 403, 404, 409].includes(results[1].status),
          JSON.stringify(results[1]),
        );
        await synchronize("bob");
      }
      await checkConcurrentRemoval();
      checks.push({
        group,
        name: "建议修订/旧语义/撤权冲突，事务故障完整回滚；编辑保存新版本与索引原子写入、幂等",
        passed: true,
      });
    }
    if (group === "GOV05") {
      const o = await read();
      const privateDraft = await ok(
        "/knowledge-proposals",
        { ...command(), ...content(o), reason: "私人草稿不共享" },
        "carol",
      );
      assert.ok(
        (await ok("/knowledge-proposals", undefined, "carol")).proposals.some(
          (p) => p.id === privateDraft.id,
        ),
      );
      assert.equal(
        (await ok("/knowledge-proposals", undefined, "bob")).proposals.length,
        0,
      );
      assert.equal((await ok("/knowledge-proposals")).proposals.length, 0);
      const p = await submit("carol");
      assert.equal(
        (await h.request("/semantic-corrections/" + p.id, undefined, "nobody"))
          .status,
        401,
      );
      // bob 失去维护权后不可读；提出者与超级维护者仍仅能看到独立共享内容。
      await synchronize("alice");
      assert.equal(
        (await h.request("/semantic-corrections/" + p.id, undefined, "bob"))
          .status,
        404,
      );
      assert.ok(
        !(await ok("/semantic-corrections", undefined, "bob")).corrections.some(
          (c) => c.id === p.id,
        ),
      );
      await synchronize("bob");
      const cid = await h.create("carol");
      assert.equal(
        (await h.request("/conversations/" + cid + "/snapshot")).status,
        404,
      );
      const asset = await ok(
        "/assets",
        {
          ...command(),
          id: null,
          expected_version: null,
          kind: "memory",
          name: "私人合成说明",
          body: "此内容不可共享",
          scope: "本人",
          verified: false,
          source_text: "合成手工输入",
          dependencies: [],
        },
        "carol",
      );
      assert.ok(asset.id);
      assert.equal((await ok("/assets")).assets.length, 0);
      const visible = await ok(
        "/semantic-corrections/" + p.id,
        undefined,
        "bob",
      );
      assert.ok(!JSON.stringify(visible).includes("此内容不可共享"));
      assert.ok(!JSON.stringify(visible).includes(cid));
      const marker = "合成待审内容xyzz";
      const pending = await ok(
        "/semantic-corrections",
        {
          ...command(),
          ...content(await read()),
          value: marker,
          share_confirmed: true,
        },
        "carol",
      );
      await review(pending);
      const result = await ok("/knowledge?q=" + marker);
      assert.ok(!JSON.stringify(result).includes(marker));
      const invalid = {
        ...command(),
        ...content(await read()),
        share_confirmed: true,
        evidence: [
          { object_id: "asset-" + asset.id, version: "1", path: "body" },
        ],
      };
      assert.equal(
        (await h.request("/semantic-corrections", invalid, "carol")).status,
        404,
      );
      checks.push({
        group,
        name: "旧私人草稿隔离、负责人撤权、超级角色不能读取他人聊天/记忆，未生效建议不入共享召回",
        passed: true,
      });
    }
  }
  await mkdir(".local/checks", { recursive: true });
  await writeFile(
    ".local/checks/semantic-governance-" + (chosen ?? "all") + ".json",
    JSON.stringify(
      {
        checks,
        environment:
          "isolated MySQL + synthetic platform + Pi mock; no official model calls",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await h.close();
}
