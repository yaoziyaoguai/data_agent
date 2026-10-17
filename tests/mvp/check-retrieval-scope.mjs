import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
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
    `UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${object.id}';UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}' AND version=${object.version};UPDATE retrieval_documents SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${object.id}' AND version=${object.version}`,
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
    `INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES('${object.id}','${space}','${object.kind}','${object.name}',1,'enabled',CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');INSERT INTO knowledge_versions(object_id,version,body) VALUES('${object.id}',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${object.id}','${space}',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) VALUES('${space}','${object.id}','${object.id}','system','synthetic-test')`,
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
  return h.internal("/internal/data/tools", input);
};
const invoke = async (name, args, currentRun = run) => {
  const response = ok(await invokeRaw(name, args, currentRun));
  if (name === "search_knowledge") {
    const size = Buffer.byteLength(JSON.stringify(response));
    sizes.push(size);
    assert.ok(size <= 24576, `完整ToolOutput为${size} UTF8 bytes`);
    assert.deepEqual(response.data.search_scope, {
      kinds: args.kinds ?? [],
      related_object_id: args.related_object_id ?? null,
      business_domain: args.business_domain ?? null,
    });
  }
  return response.data;
};
const search = (args) => invoke("search_knowledge", { limit: 10, ...args });
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
  // 1000条均合法但属异域；目标ID排在后面，过滤后才应用候选上限。
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
          "replybound_" + index,
          "可公开的长业务说明🌏。".repeat(600) +
            "\nreplybound 尾部补充：须依据当前资料确认计算范围。",
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

  const leftOnly = await search({
    query: "scoped_same_rule",
    kinds: ["document"],
    related_object_id: left.id,
    business_domain: leftDomain,
  });
  assert.deepEqual(
    leftOnly.objects.map((object) => object.id),
    [leftDoc.id],
  );
  const rightOnly = await search({
    query: "scoped_same_rule",
    kinds: ["document"],
    related_object_id: right.id,
    business_domain: rightDomain,
  });
  assert.deepEqual(
    rightOnly.objects.map((object) => object.id),
    [rightDoc.id],
  );
  const structured = await search({
    query: "scoped_same_rule",
    kinds: ["metric"],
    related_object_id: left.id,
    business_domain: leftDomain,
  });
  assert.deepEqual(
    structured.objects.map((object) => object.id),
    [metric.id],
  );
  const metricPreview = structured.objects[0];
  assert.equal(metricPreview.entries[0].effective_structure, null);
  assert.equal(metricPreview.entries[0].structure_page.complete, false);
  assert.equal(metricPreview.entries[0].structure_page.next_offset, 0);
  assert.ok(
    metricPreview.structure_dependencies.some(
      (reference) =>
        reference.object_id === left.id && reference.version === left.version,
    ),
  );
  const adopted = h.sql(
    `SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`,
  )[0];
  assert.ok(
    adopted.knowledge.some(
      (reference) => reference[0] === left.id && reference[1] === left.version,
    ),
  );
  const union = await search({
    query: "scoped_same_rule",
    kinds: ["document", "metric"],
    related_object_id: left.id,
    business_domain: leftDomain,
  });
  assert.deepEqual(
    union.objects.map((object) => object.id).sort(),
    [leftDoc.id, metric.id].sort(),
  );
  const notGuessed = await search({
    query: "inferredneedle",
    business_domain: leftDomain,
  });
  assert.deepEqual(notGuessed.objects, []);
  checks.push(
    "同名对象由种类、实际关联和人工明确业务域共同过滤；单对象索引积压仍可查当前正式正文；有效结构中的表引用可作为关联；模型猜测不能确定业务域",
  );
  const longDomainResult = await search({
    query: "longdomainneedle",
    kinds: ["document"],
    business_domain: longDomain,
  });
  assert.deepEqual(
    longDomainResult.objects.map((object) => object.id),
    [longDomainDoc.id],
  );
  assert.equal(longDomainResult.search_scope.business_domain, longDomain);
  checks.push("合法120字符业务域仍完整回执并匹配，展示裁剪不能改变已应用范围");

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
  const blockedModelCall = await h.internal("/internal/model/issue", {
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    call_attempt_id: randomUUID(),
  });
  assert.equal(
    blockedModelCall.value.code,
    "stale_context",
    JSON.stringify(blockedModelCall.value),
  );
  checks.push(
    "大有效结构正文省略后仍登记派生表依赖；表改版阻止旧上下文继续发往模型",
  );
  // 上一轮已读取旧表/指标；改版后按正式入口开新轮，保留上下文有效性校验。
  ok(
    await h.request(
      `/conversations/${run.conversation_id}/messages/${run.message_id}/withdraw`,
      { operation_id: randomUUID() },
    ),
  );
  h.releaseRun(run.run_id);
  await h.resumeWorker();
  run = await h.capture(await h.create(), "核对当前版本表关联的指标与本人提醒");
  await h.pauseWorker();
  const staleStructure = await search({
    query: "scoped_same_rule",
    kinds: ["metric"],
    related_object_id: left.id,
    business_domain: leftDomain,
  });
  assert.ok(!staleStructure.objects.some((object) => object.id === metric.id));
  checks.push(
    "仅靠结构关联且没有related_ids的指标，在引用表改版后不能借已失效结构进入关联范围",
  );

  const afterThousand = await search({
    query: "precisionneedle",
    kinds: ["document"],
    business_domain: leftDomain,
  });
  assert.deepEqual(
    afterThousand.objects.map((object) => object.id),
    [target.id],
  );
  assert.equal(afterThousand.search_coverage.examined, undefined);
  assert.equal(afterThousand.search_coverage.rejected, undefined);
  checks.push(
    "1000条有效异域资料排在前面，域过滤在候选上限前执行，目标仍可找到且不交付隐藏计数",
  );
  const narrow = await search({
    query: "scoped_same_rule",
    kinds: ["document"],
    related_object_id: left.id,
    business_domain: rightDomain,
  });
  assert.deepEqual(narrow.objects, []);
  assert.match(narrow.note, /空结果不能证明不存在/);
  const broad = await search({
    query: "scoped_same_rule",
    kinds: ["document"],
  });
  assert.deepEqual(
    broad.objects.map((object) => object.id).sort(),
    [leftDoc.id, rightDoc.id].sort(),
  );
  checks.push(
    "窄范围无结果有明确已应用范围与覆盖说明，移除范围后可补查另一表及另一域",
  );

  const located = await search({
    query: tailRule,
    kinds: ["document"],
    business_domain: leftDomain,
  });
  const tailHit = located.objects.find((object) => object.id === tail.id);
  assert.ok(tailHit);
  assert.equal(tailHit.retrieval.channel, "lexical");
  const excerpt = tailHit.retrieval.excerpts.find(
    (value) => value.entry_id === "body" && value.text.includes(tailRule),
  );
  assert.ok(excerpt);
  assert.ok(excerpt.offset > 600);
  assert.equal(
    excerpt.text,
    [...tail.entries[0].effective_value]
      .slice(excerpt.offset, excerpt.offset + excerpt.length)
      .join(""),
  );
  const page = await invoke("read_knowledge", {
    object_id: tailHit.id,
    version: tailHit.version,
    entry_id: excerpt.entry_id,
    offset: excerpt.offset,
    limit: excerpt.length,
  });
  assert.equal(page.entries[0].effective_value, excerpt.text);
  checks.push(
    "词法命中长文Unicode尾部，片段位置来自同版正式正文，并可逐字补读",
  );

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
    business_domain: leftDomain,
  });
  assert.ok(!old.objects.some((object) => object.id === stale.id));
  assert.ok(!JSON.stringify(old).includes("正文仅存在于旧版本"));
  ok(
    await h.request("/knowledge/" + leftDoc.id + "/disable", {
      operation_id: randomUUID(),
      expected_version: leftDoc.version,
    }),
  );
  // broad已把leftDoc实际交付给本run；停用后必须先拒绝旧上下文，再验证新轮过滤。
  const staleRun = await invokeRaw("search_knowledge", {
    query: "scoped_same_rule",
    business_domain: leftDomain,
  });
  assert.equal(staleRun.status, 409);
  assert.equal(staleRun.value.code, "stale_context");
  ok(
    await h.request(
      `/conversations/${run.conversation_id}/messages/${run.message_id}/withdraw`,
      { operation_id: randomUUID() },
    ),
  );
  h.releaseRun(run.run_id);
  await h.resumeWorker();
  run = await h.capture(
    await h.create(),
    "核对停用过滤与本人可复用提醒的当前目录",
  );
  await h.pauseWorker();
  assert.ok(
    !(
      await search({ query: "scoped_same_rule", business_domain: leftDomain })
    ).objects.some((object) => object.id === leftDoc.id),
  );
  const denied = await invokeRaw("search_knowledge", {
    query: "scope_hidden_body_marker",
    related_object_id: foreign.id,
  });
  assert.equal(denied.status, 404);
  assert.ok(!JSON.stringify(denied.value).includes(foreign.name));
  assert.ok(!JSON.stringify(denied.value).includes("scope_hidden_body_marker"));
  checks.push(
    "旧索引不交付已撤正文，停用对象立即过滤，跨空间关联锚点拒绝且不泄露名称或内容",
  );

  const personal = await search({
    query: "scope_personal_marker",
    kinds: ["metric"],
    business_domain: rightDomain,
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

  let cursor;
  const deliveredAssets = new Set();
  let firstLarge;
  for (let index = 0; index < 35; index++) {
    const current = await search({
      query: "replybound",
      limit: 30,
      kinds: ["document"],
      business_domain: "回执边界",
      ...(cursor ? { asset_after: cursor } : {}),
    });
    if (!firstLarge) firstLarge = current;
    assert.ok(["complete", "bounded"].includes(current.reply_coverage.state));
    assert.equal(current.reply_coverage.byte_limit, 24576);
    const visible = new Set([
      ...current.objects.map((object) => object.id),
      ...current.reply_coverage.omitted_objects.map((value) => value.object_id),
    ]);
    assert.deepEqual(
      [...visible].sort(),
      largeDocs.map((object) => object.id).sort(),
    );
    for (const memory of current.personal_memories) {
      assert.ok(!deliveredAssets.has(memory.id), "资产游标不重复交付已读项");
      deliveredAssets.add(memory.id);
      assert.equal(memory.version, "1");
      assert.ok(memory.content_page);
    }
    if (!current.next_asset_after) break;
    assert.ok(
      current.personal_memories.some(
        (memory) => memory.id === current.next_asset_after,
      ),
      "游标不能指向未交付项",
    );
    assert.notEqual(current.next_asset_after, cursor);
    cursor = current.next_asset_after;
  }
  assert.equal(firstLarge.reply_coverage.state, "bounded");
  assert.equal(deliveredAssets.size, largeAssets.length);
  const deferred =
    firstLarge.reply_coverage.omitted_objects[0] ?? firstLarge.objects[0];
  assert.ok(deferred);
  const supplement = await invoke("read_knowledge", {
    object_id: deferred.object_id ?? deferred.id,
    version: deferred.version,
    entry_id: "body",
    offset: 0,
    limit: 100,
  });
  assert.ok(
    supplement.entries[0].effective_value.startsWith("可公开的长业务说明"),
  );
  const memoryPreview = firstLarge.personal_memories[0];
  assert.ok(memoryPreview);
  const memorySupplement = await invoke("read_knowledge", {
    object_id: memoryPreview.object_id,
    version: memoryPreview.version,
    offset: 0,
    limit: 100,
  });
  assert.ok(memorySupplement.body.startsWith("replybound"));
  checks.push(
    "30份大共享对象和30份个人记忆的完整工具JSON回执<=24KiB；被裁对象保留同版补读引用，资产游标逐页完整且不跳项",
  );
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
