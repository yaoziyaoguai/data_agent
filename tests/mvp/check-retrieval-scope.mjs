import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { validateContract } from "../../packages/contracts/validate.ts";
import { harness } from "./harness.mjs";

let preferredMemory;
const memoryServer = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const part of request) raw += part;
    const input = JSON.parse(raw);
    let value;
    if (request.url === "/search") {
      value = {
        candidates:
          input.query === "cursorneedle" && preferredMemory
            ? [
                {
                  asset_id: preferredMemory.id,
                  version: preferredMemory.version,
                },
              ]
            : [],
        bounded: false,
      };
    } else if (request.url === "/index") {
      value = { operation_id: input.operation_id, state: "ready" };
    } else {
      throw new Error("unexpected_memory_protocol_path");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  } catch (error) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "memory_unavailable" }));
  }
});
await new Promise((resolve) => memoryServer.listen(0, "127.0.0.1", resolve));
// 本地协议只固定候选排序，不使用模型提取或向量API。
const h = await harness({
  capture: true,
  startWorker: false,
  env: {
    DATA_AGENT_LEASE_MS: "120000",
    DATA_AGENT_MEMORY_URL: "http://127.0.0.1:" + memoryServer.address().port,
  },
});
const checks = [],
  sizes = [];
let passed = false,
  run;
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const create = async (kind, name, body, related = []) =>
  ok(
    await h.request("/knowledge", {
      operation_id: randomUUID(),
      kind,
      name,
      body,
      related_ids: related,
      source_url: null,
    }),
  );
const domainEntry = (domain) => ({
  entry_id: "business_domain",
  path: "business_domain",
  label: "业务域",
  effective_value: domain,
  source_facts: { complete: false, gap: "该业务域由本测试的维护者明确指定" },
  suggestion: {},
  human_override: { value: domain, edited_by: "alice" },
  review_state: "confirmed",
});
const setFixture = (object) => {
  const encoded = Buffer.from(JSON.stringify(object)).toString("hex");
  // 创建后、索引之前构造明确域条目，当前接口没有追加语义条目的写入口。
  h.sql(
    `UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${object.id}';UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}' AND version=${object.version};UPDATE retrieval_documents SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}' AND version=${object.version}`,
  );
};
const assignDomain = (object, domain) => {
  object.entries.push(domainEntry(domain));
  setFixture(object);
  return object;
};
const insertFixture = (object, space = "demo") => {
  assert.match(object.id, /^[A-Za-z0-9_-]+$/);
  assert.match(space, /^[A-Za-z0-9_-]+$/);
  const encoded = Buffer.from(JSON.stringify(object)).toString("hex");
  h.sql(
    `INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES('${object.id}','${space}','${object.kind}','${object.name}',1,'enabled',CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${object.id}',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${object.id}','${space}',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) VALUES('${space}','${object.id}','${object.id}','system','synthetic-test')`,
  );
};
const fixture = (id, name, body, domain, related = []) => ({
  id,
  kind: "document",
  name,
  version: "1",
  state: "enabled",
  entries: [
    {
      entry_id: "body",
      path: "body",
      label: "正文",
      effective_value: body,
      source_facts: { complete: false, gap: "独立合成检索夹具" },
      suggestion: {},
      human_override: { value: body, edited_by: "alice" },
      review_state: "confirmed",
    },
    domainEntry(domain),
  ],
  related_ids: related,
  source_id: null,
  source_version: "0",
  updated_by: "synthetic-test",
});
const invokeRaw = async (name, args, currentRun = run) => {
  const input = {
    run_id: currentRun.run_id,
    lease_epoch: currentRun.lease_epoch,
    sdk_tool_call_id: randomUUID(),
    tool_name: name,
    arguments: args,
    checkpoint: exportCheckpoint(
      SessionManager.inMemory("/synthetic/data-agent"),
      currentRun.workspace_context.authority_revision,
      currentRun.workspace_context.authority_snapshot,
    ),
  };
  ok(await h.internal("/internal/data/tool-calls", input));
  return h.internal(
    "/internal/data/tools",
    name === "search_knowledge" ? {
      ...input,
      // 24 KiB 验收计入 ToolOutput 信封，正文预算留出信封空间。
      response_budget: {max_bytes: 24320, estimated_tokens: 6144, projection_fingerprint: "0".repeat(64)},
    } : input,
  );
};
const invoke = async (name, args, currentRun = run) => {
  const response = ok(await invokeRaw(name, args, currentRun));
  if (name === "search_knowledge") {
    const size = Buffer.byteLength(JSON.stringify(response));
    sizes.push(size);
    assert.ok(size <= 24576, `完整ToolOutput为${size} UTF8 bytes`);
    validateContract("KnowledgeSearchReply", response.data);
  }
  return response.data;
};
const search = (args) => invoke("search_knowledge", { limit: 10, ...args });
const objectIds = (result) => [...new Set(result.hits
  .filter((hit) => hit.record_kind === "knowledge_entry")
  .map((hit) => hit.ref.object_id))];
const readKnowledge = async (ref, options = {}) => {
  const result = await invoke("read_knowledge", {items: [{kind: "knowledge", ref, ...options}]});
  return result.items[0];
};
const issue = () => h.internal("/internal/model/issue", {
  run_id: run.run_id,
  lease_epoch: run.lease_epoch,
  call_attempt_id: randomUUID(),
});
const replaceRun = async (text) => {
  ok(await h.request(
    `/conversations/${run.conversation_id}/messages/${run.message_id}/withdraw`,
    {operation_id: randomUUID()},
  ));
  h.releaseRun(run.run_id);
  await h.resumeWorker();
  run = await h.capture(await h.create(), text);
  await h.pauseWorker();
};
const asset = async (name, body, user = "alice") =>
  ok(
    await h.request(
      "/assets",
      {
        operation_id: randomUUID(),
        id: null,
        expected_version: null,
        kind: "memory",
        name,
        body,
        scope: "仅本人明确使用这份合成分析偏好时",
        verified: false,
        source_text: "本测试用户明确保存的虚构偏好",
        dependencies: [],
      },
      user,
    ),
  );

try {
  const left = ok(await h.request("/knowledge/table-demo_order_detail"));
  const right = ok(await h.request("/knowledge/table-raw_payments"));
  const leftDomain = "订单分析",
    rightDomain = "支付分析";
  const leftDoc = assignDomain(
    await create(
      "document",
      "scoped_same_rule",
      "独立订单口径，按订单商品行解释成功付款。",
      [left.id],
    ),
    leftDomain,
  );
  const rightDoc = assignDomain(
    await create(
      "document",
      "scoped_same_rule",
      "独立支付口径，按支付事件解释成功状态。",
      [right.id],
    ),
    rightDomain,
  );
  const metric = ok(
    await h.request("/knowledge", {
      operation_id: randomUUID(),
      kind: "metric",
      name: "scoped_same_rule",
      body: "按订单商品行汇总成功付款金额。",
      related_ids: [],
      structured_value: {
        kind: "metric",
        table: { object_id: left.id, version: left.version },
        expression:
          "SUM(paid_amount_cents) /* " +
          "仅按已经分摊到商品行的付款金额相加，须另行核对付款日期和适用范围。".repeat(
            20,
          ) +
          " */",
        input_grain: "订单商品行",
        time_column: "paid_at",
        unit: "分",
        required_filters: [],
        dimensions: [],
      },
    }),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(metric.entries[0].effective_structure)) >
      1024,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(metric.entries[0].effective_structure)) <
      8192,
  );
  assignDomain(metric, leftDomain);
  const longDomain = "跨地域业务".repeat(24);
  assert.equal([...longDomain].length, 120);
  const longDomainDoc = assignDomain(
    await create("document", "longdomainneedle", "长业务域的明确独立定义。"),
    longDomain,
  );
  const inferred = await create(
    "document",
    "inferredneedle",
    "文档提到订单分析，但没有维护者确认业务域。",
  );
  inferred.entries.push({
    ...domainEntry(leftDomain),
    human_override: null,
    review_state: "unverified",
    suggestion: { value: leftDomain },
  });
  setFixture(inferred);
  const confirmed = assignDomain(
    await create("document", "inferredneedle", "维护者确认这是订单分析资料。"),
    leftDomain,
  );
  const tailRule =
    "长文尾部规则：🌏发生跨期退款时必须先确认采用付款归属还是退款发生时间。";
  const tail = assignDomain(
    await create(
      "document",
      "scope_tail_document",
      "普通背景资料🙂。".repeat(300) + "\n" + tailRule,
      [left.id],
    ),
    leftDomain,
  );
  const stale = assignDomain(
    await create(
      "document",
      "index_revision_doc",
      "legacyneedle 正文仅存在于旧版本。",
    ),
    leftDomain,
  );
  const foreign = fixture(
    "scope-foreign-anchor",
    "scope_secret_anchor_name",
    "scope_hidden_body_marker",
    "隔离空间",
  );
  foreign.kind = "table";
  insertFixture(foreign, "isolated-space");
  const target = fixture(
    "zz-scope-domain-target",
    "precisionneedle",
    "precisionneedle 这是目标域的有效说明。",
    leftDomain,
    [left.id],
  );
  insertFixture(target);
  const filler = fixture(
    "bulk-placeholder",
    "precisionneedle",
    "precisionneedle 属于异域的有效资料。",
    rightDomain,
  );
  const encoded = Buffer.from(JSON.stringify(filler)).toString("hex");
  // 1000条都是有效异域对象，且ID排在前面；稍后用明确的任务许可验证候选前过滤。
  h.sql(
    `SET SESSION cte_max_recursion_depth=1200;INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i<1000) SELECT CONCAT('aa-scope-filler-',LPAD(i,4,'0')),'demo','document','precisionneedle',1,'enabled',JSON_SET(CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),'$.id',CONCAT('aa-scope-filler-',LPAD(i,4,'0'))),NULL,0,'synthetic-test' FROM n;INSERT INTO retrieval_documents(object_id,space_id,version,body) SELECT id,space_id,version,body FROM knowledge_objects WHERE id LIKE 'aa-scope-filler-%';INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) SELECT space_id,id,id,'system','synthetic-test' FROM knowledge_objects WHERE id LIKE 'aa-scope-filler-%'`,
  );
  const largeDocs = [],
    largeAssets = [];
  for (let index = 0; index < 30; index++) {
    largeDocs.push(
      assignDomain(
        await create(
          "document",
          "合成长业务说明_" + index,
          "可公开的长业务说明🌏。replybound 检索定位。" +
            "可公开的长业务说明🌏。".repeat(600) +
            "\n尾部补充：须依据当前资料确认计算范围。",
        ),
        "回执边界",
      ),
    );
    largeAssets.push(
      await asset(
        "replybound_" + index + "个人偏好名称".repeat(15),
        "replybound 本人可复用偏好🙂。".repeat(500),
      ),
    );
  }
  for (const object of largeDocs) {
    const body = object.entries[0].effective_value;
    assert.ok(!object.name.includes("replybound"));
    assert.equal(body.split("replybound").length - 1, 1);
    assert.ok([...body.slice(0, body.indexOf("replybound"))].length < 280);
    assert.ok([...body].length > 6000, "容量夹具仍须保留长正文");
  }
  const aliceAsset = await asset(
    "scope_personal_marker",
    "scope_personal_marker 仅Alice本人可读取。",
  );
  const bobAsset = await asset(
    "scope_personal_marker",
    "scope_personal_marker 仅Bob本人可读取。",
    "bob",
  );
  const cursorAssets = [];
  for (let index = 0; index < 12; index++) {
    cursorAssets.push(
      await asset("cursorneedle_" + index, "cursorneedle 的本人检查提醒。"),
    );
  }
  cursorAssets.sort((a, b) => a.id.localeCompare(b.id));
  preferredMemory = cursorAssets.at(-1);
  await h.resumeWorker();
  run = await h.capture(
    await h.create(),
    "查阅不同表与业务域的资料，并核对本人偏好",
  );
  await h.pauseWorker();
  // 故意模拟单个新对象的索引尚未写入，正式正文通道仍应按范围发现它。
  h.sql(`DELETE FROM retrieval_documents WHERE object_id='${leftDoc.id}'`);

  const leftRanked = await search({
    query: "scoped_same_rule",
    kinds: ["document"],
    hints: {related_object_ids: [left.id], business_domain: leftDomain},
  });
  assert.deepEqual(objectIds(leftRanked), [leftDoc.id, rightDoc.id]);
  const rightRanked = await search({
    query: "scoped_same_rule",
    kinds: ["document"],
    hints: {related_object_ids: [right.id], business_domain: rightDomain},
  });
  assert.deepEqual(objectIds(rightRanked), [rightDoc.id, leftDoc.id]);
  const structured = await search({
    query: "scoped_same_rule",
    kinds: ["metric"],
    hints: {related_object_ids: [left.id], business_domain: leftDomain},
  });
  assert.deepEqual(objectIds(structured), [metric.id]);
  const metricHit = structured.hits.find((hit) => hit.record_kind === "knowledge_entry"
    && hit.ref.object_id === metric.id && hit.ref.path === metric.entries[0].path);
  assert.ok(metricHit, "应返回带结构的指标定义条目");
  const metricRef = metricHit.ref;
  const metricPreview = await readKnowledge(metricRef, {structure_only: true, limit: 100});
  assert.equal(metricPreview.state, "ok");
  assert.equal(metricPreview.effective_structure, null);
  assert.equal(metricPreview.structure_page.complete, false);
  assert.equal(metricPreview.structure_page.offset, 0);
  assert.equal(metricPreview.structure_page.next_offset, 100);
  assert.ok(metricPreview.structure_dependencies.some(
    (reference) => reference.object_id === left.id && reference.version === left.version,
  ));
  const adopted = h.sql(
    `SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`,
  )[0];
  assert.ok(adopted.knowledge.some(
    (reference) => reference[0] === left.id && reference[1] === left.version,
  ));
  const union = await search({
    query: "scoped_same_rule",
    kinds: ["document", "metric"],
    hints: {related_object_ids: [left.id], business_domain: leftDomain},
  });
  assert.deepEqual(objectIds(union).sort(), [leftDoc.id, rightDoc.id, metric.id].sort());
  const notGuessed = await search({
    query: "inferredneedle",
    hints: {business_domain: leftDomain},
  });
  assert.deepEqual(objectIds(notGuessed), [confirmed.id, inferred.id]);
  checks.push("同名资料按表关联和已确认业务域排序，不缩小许可。索引积压时查正式正文，模型猜测不给域加权。");

  const longDomainResult = await search({
    query: "longdomainneedle",
    kinds: ["document"],
    hints: {business_domain: longDomain},
  });
  assert.deepEqual(objectIds(longDomainResult), [longDomainDoc.id]);
  const fullDomain = await readKnowledge({
    object_id: longDomainDoc.id, version: longDomainDoc.version, path: "business_domain",
  });
  assert.equal(fullDomain.state, "ok");
  assert.equal(fullDomain.content, longDomain);
  checks.push("120字符的业务域提示可用，正式域条目全文可逐字精读");

  const revisedTable = ok(
    await h.request(
      "/knowledge/" + left.id,
      {
        operation_id: randomUUID(),
        expected_version: left.version,
        entry_id: "description",
        value: "独立反例：当前表粒度仍为一张订单中的一个商品行，版本已修订。",
      },
      "alice",
      "PATCH",
    ),
  );
  assert.notEqual(revisedTable.version, left.version);
  ok(await issue());
  checks.push("结构局部交付登记派生表依赖，表改版后当前 run 仍可处理后续模型调用");
  // 实现设计 17.3.2：说明变更不撤下仍符合当前 DDL 的计算结构，旧版正文引用另行拒绝。
  const currentStructure = await readKnowledge(metricRef, {structure_only: true, limit: 100});
  assert.equal(currentStructure.state, "ok");
  assert.equal(currentStructure.structure_coverage.state, "complete");
  assert.ok(currentStructure.structure_dependencies.some((ref) =>
    ref.object_id === left.id && ref.version === revisedTable.version && ref.path === "ddl"));
  const oldTable = await readKnowledge({object_id: left.id, version: left.version, path: "ddl"});
  assert.equal(oldTable.state, "stale");
  assert.equal(Object.hasOwn(oldTable, "content"), false);
  checks.push("同DDL的表说明改版后重核当前结构，显式旧修订的精读仍被拒绝");

  await replaceRun("核对共享资料和停用过滤。");
  const broad = await search({
    query: "scoped_same_rule",
    kinds: ["document"],
  });
  assert.deepEqual(objectIds(broad).sort(), [leftDoc.id, rightDoc.id].sort());

  const located = await search({
    query: tailRule,
    kinds: ["document"],
    hints: {business_domain: leftDomain},
  });
  const tailHit = located.hits.find((hit) => hit.record_kind === "knowledge_entry"
    && hit.ref.object_id === tail.id && hit.ref.path === "body" && hit.definition.includes(tailRule));
  assert.ok(tailHit);
  assert.equal(tailHit.ref.version, tail.version);
  assert.equal(located.search_coverage.channels.find(({channel}) => channel === "bm25").state, "available");
  const text = tail.entries[0].effective_value;
  const index = text.indexOf(tailHit.definition);
  assert.ok(index >= 0);
  const offset = [...text.slice(0, index)].length;
  const length = [...tailHit.definition].length;
  assert.ok(offset > 600);
  assert.equal(tailHit.definition, [...text].slice(offset, offset + length).join(""));
  const page = await readKnowledge(tailHit.ref, {offset, limit: length});
  assert.equal(page.state, "ok");
  assert.equal(page.content, tailHit.definition);
  assert.equal(page.content_page.offset, offset);
  checks.push("词法命中长文Unicode尾部，片段位置来自同版正式正文，并可逐字补读");

  const oldIndex = Buffer.from(JSON.stringify(stale)).toString("hex");
  h.sql(
    `INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${stale.id}','demo',1,CAST(CONVERT(0x${oldIndex} USING utf8mb4) AS JSON)) ON DUPLICATE KEY UPDATE body=VALUES(body),version=1`,
  );
  ok(
    await h.request(
      "/knowledge/" + stale.id,
      {
        operation_id: randomUUID(),
        expected_version: stale.version,
        entry_id: "body",
        value: "当前说明已修订，不再适用先前定义。",
      },
      "alice",
      "PATCH",
    ),
  );
  const old = await search({
    query: "legacyneedle",
    hints: {business_domain: leftDomain},
  });
  assert.ok(!objectIds(old).includes(stale.id));
  assert.ok(!JSON.stringify(old).includes("正文仅存在于旧版本"));
  ok(
    await h.request("/knowledge/" + leftDoc.id + "/disable", {
      operation_id: randomUUID(),
      expected_version: leftDoc.version,
    }),
  );
  // broad 已交付旧回执。同一运行的新检索核对停用状态，旧回执不能阻断当前操作。
  const current = await search({
    query: "scoped_same_rule", hints: {business_domain: leftDomain},
  });
  assert.ok(!objectIds(current).includes(leftDoc.id));
  assert.ok(objectIds(current).includes(rightDoc.id));
  const denied = await h.request("/knowledge?related_id=" + foreign.id);
  assert.equal(denied.status, 404);
  assert.ok(!JSON.stringify(denied.value).includes(foreign.name));
  assert.ok(!JSON.stringify(denied.value).includes("scope_hidden_body_marker"));
  const foreignHint = await search({
    query: "scope_hidden_body_marker", hints: {related_object_ids: [foreign.id]},
  });
  assert.ok(!objectIds(foreignHint).includes(foreign.id));
  const foreignRead = await readKnowledge({object_id: foreign.id, version: foreign.version, path: "body"});
  assert.equal(foreignRead.state, "not_available");
  assert.equal(Object.hasOwn(foreignRead, "content"), false);
  assert.ok(!JSON.stringify(foreignHint).includes(foreign.name));
  assert.ok(!JSON.stringify(foreignHint).includes("scope_hidden_body_marker"));
  checks.push("旧索引不交付旧正文，停用即过滤。硬关联入口拒绝跨空间锚点，软提示也不泄露空间外内容");

  await replaceRun("核对本人可复用提醒的目录与补读。");
  const personal = await search({
    query: "scope_personal_marker",
    kinds: ["metric"],
    hints: {business_domain: rightDomain},
  });
  assert.ok(
    personal.personal_memories.some((value) => value.id === aliceAsset.id),
  );
  assert.ok(!JSON.stringify(personal).includes(bobAsset.id));
  assert.ok(!JSON.stringify(personal).includes("仅Bob本人可读取"));
  checks.push(
    "共享知识范围与本人资产分离；种类或域过滤不隐藏本人偏好，也不读取另一用户记忆",
  );

  const preferredPage = await search({ query: "cursorneedle", limit: 7 });
  assert.equal(preferredPage.memory_retrieval, "mem0_authoritative");
  assert.equal(preferredPage.personal_memories[0].id, preferredMemory.id);
  assert.deepEqual(
    preferredPage.personal_memories.map((value) => value.id).sort(),
    [...cursorAssets.slice(0, 7), preferredMemory]
      .map((value) => value.id)
      .sort(),
  );
  assert.equal(preferredPage.next_asset_after, cursorAssets[6].id);
  const combinedAssets = new Set(
    preferredPage.personal_memories.map((value) => value.id),
  );
  let directoryCursor = preferredPage.next_asset_after;
  while (directoryCursor) {
    const next = await search({
      query: "cursorneedle",
      limit: 7,
      asset_after: directoryCursor,
    });
    const ids = next.personal_memories.map((value) => value.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) combinedAssets.add(id);
    directoryCursor = next.next_asset_after;
  }
  assert.deepEqual(
    [...combinedAssets].sort(),
    cursorAssets.map((value) => value.id).sort(),
  );
  checks.push(
    "Mem0首候选不挤掉目录页末项；目录游标绑定已交付项，续页覆盖全部本人资产",
  );

  const publicArgs = {
    query: "replybound",
    limit: 30,
    kinds: ["document"],
    hints: {business_domain: "回执边界"},
  };
  const firstLarge = await search(publicArgs);
  const firstPublicIds = objectIds(firstLarge);
  const deliveredDocs = new Set(firstPublicIds);
  let cursor = firstLarge.search_coverage.next;
  let deferred = null;
  for (let index = 0; cursor && index < 35; index++) {
    assert.match(cursor, /^rc1:/);
    const next = await search({...publicArgs, cursor});
    for (const id of objectIds(next)) {
      assert.ok(!deliveredDocs.has(id), "公共游标不能重交已返回的窗口");
      deliveredDocs.add(id);
    }
    if (!deferred && next.hits.length > 0) deferred = next.hits[0].ref;
    assert.notEqual(next.search_coverage.next, cursor);
    cursor = next.search_coverage.next;
  }
  assert.equal(cursor, null);
  assert.deepEqual([...deliveredDocs].sort(), largeDocs.map((object) => object.id).sort());
  assert.ok(firstLarge.next_asset_after || firstLarge.search_coverage.next
    || firstLarge.personal_memories.some((memory) => !memory.content_page.complete));
  const supplement = await readKnowledge(deferred ?? firstLarge.hits[0].ref, {offset: 0, limit: 100});
  assert.equal(supplement.state, "ok");
  assert.ok(supplement.content.startsWith("可公开的长业务说明"));

  const largeAssetIds = new Set(largeAssets.map((asset) => asset.id));
  const deliveredAssets = new Set();
  let assetAfter;
  for (let index = 0; index < 35; index++) {
    const page = await search({query: "*", limit: 30, ...(assetAfter ? {asset_after: assetAfter} : {})});
    assert.deepEqual(page.hits, [], "只翻资产目录时不重复派发公共知识检索");
    for (const memory of page.personal_memories) {
      assert.ok(!deliveredAssets.has(memory.id), "资产游标不重复交付已读项");
      deliveredAssets.add(memory.id);
      if (largeAssetIds.has(memory.id)) {
        assert.equal(memory.version, "1");
        assert.ok(memory.content_page);
      }
    }
    if (!page.next_asset_after) {
      assetAfter = null;
      break;
    }
    assert.ok(page.personal_memories.some((memory) => memory.id === page.next_asset_after));
    assert.notEqual(page.next_asset_after, assetAfter);
    assetAfter = page.next_asset_after;
  }
  assert.equal(assetAfter, null);
  assert.ok(largeAssets.every(({id}) => deliveredAssets.has(id)));
  const memoryPreview = firstLarge.personal_memories[0];
  assert.ok(memoryPreview);
  const memorySupplement = (await invoke("read_knowledge", {items: [{
    kind: "memory", asset_ref: {id: memoryPreview.id, version: memoryPreview.version}, part: "body",
    offset: 0, limit: 100,
  }]})).items[0];
  assert.equal(memorySupplement.state, "ok");
  assert.ok(memorySupplement.asset.body.startsWith("replybound"));
  checks.push("30份长资料和30份个人记忆的完整工具回执保持24 KiB。两个游标独立推进，补读保留原版本。");

  await replaceRun("只看指定订单域目标文档，不读取其余来源。");
  const task = await invoke("update_analysis_task", {action: "create", goal: "只检索指定订单域文档", options: [],
    conditions: {time_start: null, time_end: null, timezone: "UTC", metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: "",
      source_limits: {allowed_sources: [{kind: "document", id: target.id}], origin_message_ids: [run.message_id]}}});
  assert.ok(task.task_id);
  assert.deepEqual(task.conditions.source_limits.allowed_sources, [{kind: "document", id: target.id}]);
  const afterThousand = await search({
    query: "precisionneedle", kinds: ["document"], hints: {business_domain: leftDomain},
  });
  assert.deepEqual(objectIds(afterThousand), [target.id]);
  assert.equal(afterThousand.search_coverage.examined, undefined);
  assert.equal(afterThousand.search_coverage.rejected, undefined);
  assert.ok(!JSON.stringify(afterThousand).includes("属于异域"));
  const narrow = await search({
    query: "scoped_same_rule", kinds: ["document"],
    hints: {related_object_ids: [right.id], business_domain: rightDomain},
  });
  assert.deepEqual(narrow.hits, []);
  assert.ok(!JSON.stringify(narrow).includes("独立支付口径"));
  checks.push("1000条异域资料排在前面，用户来源许可先于候选上限。软提示不能越过许可，空结果保留已应用范围且不泄露隐藏计数。");
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      checks,
      bytes: { max: Math.max(...sizes), all: sizes },
      officialRequests: 0,
    }),
  );
} finally {
  if (run) h.releaseRun(run.run_id);
  await writeFile(
    ".local/checks/retrieval-scope.json",
    JSON.stringify({ passed, checks, sizes, officialRequests: 0 }, null, 2),
  );
  await h.close();
  await new Promise((resolve) => memoryServer.close(resolve));
}
