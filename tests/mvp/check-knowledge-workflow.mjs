import {synchronizeSources} from './source-sync.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { harness } from "./harness.mjs";
const dir = ".local/checks/synthetic-sources-" + randomUUID();
await mkdir(dir, { recursive: true });
for (const name of [
  "schema.sql",
  "seed.sql",
  "etl.sql",
  "business-guide.md",
  "semantic-catalog.json",
])
  await copyFile("docs/sources/" + name, dir + "/" + name);
const h = await harness({
  startupTimeout: 60000,
  env: { DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY: process.cwd() + "/" + dir, DATA_AGENT_PUBLIC_CONTENT_RETENTION: "archive" },
  // 内置来源版本测试独立于平台的固定执行快照；平台漂移拒绝另有专门测试。
  platformSourceDirectory: process.cwd() + "/docs/sources",
});
const checks = [];
const check = (name) => checks.push({ name, passed: true });
const command = (version) => ({
  operation_id: randomUUID(),
  expected_version: version,
});
try {
  await h.pauseWorker();
  h.sql("DELETE FROM knowledge_index_jobs;DELETE FROM knowledge_versions;DELETE FROM knowledge_revisions;DELETE FROM knowledge_objects;DELETE FROM source_current;DELETE FROM source_revisions;DELETE FROM source_heads;DELETE FROM source_snapshots;");
  const importCommands=[1,2].map(()=>({operation_id:randomUUID()}));
  await h.resumeSourceSyncWorker(2);
  const imports=await Promise.all(importCommands.map(command=>synchronizeSources(h,command.operation_id)));
  assert.ok(imports.some(v=>v.value.status==='completed'),JSON.stringify(imports));
  assert.ok(imports.every(v=>v.status===200&&(v.value.status==='completed'||v.value.status==='failed'&&v.value.error_code==='version_conflict')),JSON.stringify(imports));
  const expectedTables=['customer_tags','demo_order_detail','dim_customers','raw_order_lines','raw_payments'];
  const platformHeads=h.sql("SELECT JSON_OBJECT('id',source_id,'table_id',platform_table_id,'version',platform_version) FROM catalog_platform_heads ORDER BY platform_table_id");
  assert.deepEqual(platformHeads.map(v=>v.table_id),expectedTables);
  // 血缘修订后的合成平台元数据为第2版；来源快照仍从各自首版开始。
  assert.ok(platformHeads.every(v=>v.version===2));
  const snapshots=()=>h.sql("SELECT JSON_OBJECT('id',source_id,'version',version) FROM source_snapshots ORDER BY source_id,version");
  assert.deepEqual(snapshots(),[...['schema','etl','business-guide','semantic-catalog'],...platformHeads.map(v=>v.id)].sort().map(id=>({id,version:1})));
  const initialVersions=h.sql("SELECT JSON_OBJECT('heads',(SELECT COUNT(*) FROM knowledge_objects),'versions',(SELECT COUNT(*) FROM knowledge_versions))")[0];
  assert.ok(initialVersions.heads>20);assert.equal(initialVersions.versions,initialVersions.heads);
  const initialObjects=h.sql("SELECT JSON_OBJECT('id',id,'version',version,'state',state,'body',body) FROM knowledge_objects ORDER BY id");
  const initialSnapshots=snapshots();
  const initialJobs=h.sql("SELECT JSON_OBJECT('id',id,'object_id',object_id,'version',expected_version) FROM prefill_attempts ORDER BY id");
  for(const [index,command] of importCommands.entries()){
    const state=h.sql(`SELECT JSON_OBJECT('state',state,'error',error_code,'receipt',receipt,'baseline',baseline,'namespace',namespace_baseline) FROM catalog_imports WHERE operation_id='${command.operation_id}'`)[0];
    if(imports[index].value.status==='completed'){assert.equal(state.state,'completed');assert.deepEqual(state.receipt,{sync_id:imports[index].value.sync_id,status:'completed'});}
    else{assert.equal(state.state,'failed');assert.equal(state.error,'version_conflict');}
    const replay=await h.request('/source-syncs',command);
    assert.equal(replay.status,202);
    assert.equal(replay.value.sync_id,imports[index].value.sync_id);
    assert.equal(replay.value.status,imports[index].value.status);
    assert.deepEqual((await synchronizeSources(h,command.operation_id)).value,imports[index].value);
    assert.deepEqual(h.sql(`SELECT JSON_OBJECT('state',state,'error',error_code,'receipt',receipt,'baseline',baseline,'namespace',namespace_baseline) FROM catalog_imports WHERE operation_id='${command.operation_id}'`)[0],state);
  }
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  assert.deepEqual(snapshots(),initialSnapshots);
  assert.deepEqual(h.sql("SELECT JSON_OBJECT('id',id,'version',version,'state',state,'body',body) FROM knowledge_objects ORDER BY id"),initialObjects);
  assert.deepEqual(h.sql("SELECT JSON_OBJECT('id',id,'object_id',object_id,'version',expected_version) FROM prefill_attempts ORDER BY id"),initialJobs);
  assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_versions")[0].n,initialVersions.versions);
  await h.resumeWorker();
  checks.push({name:'并发首次同步允许明确CAS冲突；四个内置来源和五个平台来源唯一，原operation保持回执及基线、新采集不增加版本或待办',passed:true,imports:importCommands.map((command,index)=>({command,response:imports[index]}))});
  const first = await h.request("/knowledge");
  assert.equal(first.status, 200);
  assert.ok(first.value.objects.length > 20);
  const id = "table-demo_order_detail";
  let table = (await h.request("/knowledge/" + id)).value;
  let input = {
    ...command(table.version),
    entry_id: "description",
    value: "人工核对：一行一个订单商品行",
    clear_override: false,
  };
  let edited = await h.request("/knowledge/" + id, input, "alice", "PATCH");
  assert.equal(edited.status, 200);
  assert.equal(
    edited.value.entries.find((e) => e.entry_id === "description")
      .human_override.edited_by,
    "alice",
  );
  assert.deepEqual(
    (await h.request("/knowledge/" + id, input, "alice", "PATCH")).value,
    edited.value,
  );
  assert.equal(
    (
      await h.request(
        "/knowledge/" + id,
        { ...input, operation_id: randomUUID() },
        "alice",
        "PATCH",
      )
    ).value.code,
    "version_conflict",
  );
  assert.equal(
    (
      await h.request(
        "/knowledge/" + id,
        { ...input, ...command(edited.value.version) },
        "bob",
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (await h.request("/knowledge/" + id + "?version=1")).value.entries.find(
      (e) => e.entry_id === "description",
    ).human_override,
    null,
  );
  check("首次导入、条目人工记录、不可变历史、幂等和维护权限");
  let filled = await h.request(
    "/knowledge/" + id + "/reanalyze",
    command(edited.value.version),
  );
  assert.equal(filled.status, 200);
  assert.equal(
    filled.value.entries.find((e) => e.entry_id === "description")
      .effective_value,
    input.value,
  );
  assert.equal(
    filled.value.entries.find((e) => e.entry_id === "description").review_state,
    "needs_review",
  );
  check("重新预填保留人工值并标记待复核");
  await h.pauseWorker();
  const catalogOnly = JSON.parse(await readFile(dir + "/semantic-catalog.json", "utf8"));
  const catalogOnlyObject = catalogOnly.objects.find(object => object.id === id);
  catalogOnlyObject.name = "demo_order_detail · 合成订单商品行";
  await writeFile(dir + "/semantic-catalog.json", JSON.stringify(catalogOnly));
  const beforeCatalogVersion = filled.value.version;
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  table = (await h.request('/knowledge/' + id)).value;
  assert.equal(BigInt(table.version), BigInt(beforeCatalogVersion) + 1n);
  assert.equal(table.entries.find(entry => entry.entry_id === 'description').effective_value, input.value);
  assert.equal(table.name, catalogOnlyObject.name);
  assert.equal((await h.request('/sources/semantic-catalog')).value.version, '2');
  assert.deepEqual(h.sql("SELECT JSON_OBJECT('id',source_id,'version',version) FROM source_snapshots WHERE source_id IN ('schema','etl','business-guide') ORDER BY source_id"), ['business-guide', 'etl', 'schema'].map(id => ({ id, version: 1 })));
  const afterCatalog = table;
  const catalogJobs = h.sql("SELECT JSON_OBJECT('id',id,'object_id',object_id,'version',expected_version) FROM prefill_attempts ORDER BY id");
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  assert.deepEqual((await h.request('/knowledge/' + id)).value, afterCatalog);
  assert.deepEqual(h.sql("SELECT JSON_OBJECT('id',id,'object_id',object_id,'version',expected_version) FROM prefill_attempts ORDER BY id"), catalogJobs);
  check('仅semantic-catalog改版刷新已有候选且保留人工值，原始来源不升版；重复同步不增加对象版本或预填作业');
  filled = { ...filled, value: afterCatalog };
  await writeFile(
    dir + "/schema.sql",
    (await readFile(dir + "/schema.sql", "utf8")) + "\n-- 合成来源新增说明\n",
  );
  const catalog = JSON.parse(
    await readFile(dir + "/semantic-catalog.json", "utf8"),
  );
  const candidate = catalog.objects.find((o) => o.id === id);
  candidate.entries.find((e) => e.entry_id === "description").effective_value =
    "来源新版候选值";
  await writeFile(dir + "/semantic-catalog.json", JSON.stringify(catalog));
  const concurrentSync=await Promise.all([1,2].map(()=>synchronizeSources(h)));
  assert.ok(concurrentSync.some(v=>v.value.status==='completed'),JSON.stringify(concurrentSync));
  assert.ok(concurrentSync.every(v=>v.status===200&&(v.value.status==='completed'||v.value.status==='failed'&&v.value.error_code==='version_conflict')),JSON.stringify(concurrentSync));
  table = (await h.request("/knowledge/" + id)).value;
  assert.equal(BigInt(table.version),BigInt(filled.value.version)+1n);
  assert.deepEqual(h.sql("SELECT JSON_OBJECT('version',version) FROM source_snapshots WHERE source_id='schema' ORDER BY version"),[{version:1},{version:2}]);
  assert.equal(table.source_version, "2");
  assert.equal(
    table.entries.find((e) => e.entry_id === "description").effective_value,
    input.value,
  );
  assert.equal((await h.request("/sources/schema")).value.version, "2");
  assert.equal(
    (await h.request("/sources/schema?version=1")).value.current_version,
    "2",
  );
  assert.equal(
    table.entries.find((e) => e.source_facts.source_id === "business-guide")
      .source_facts.version,
    "1",
  );
  assert.equal(
    table.entries.find((e) => e.source_facts.source_id === "schema")
      .source_facts.version,
    "2",
  );
  for (const source of ["etl", "business-guide"]) {
    const file = source === "etl" ? "etl.sql" : "business-guide.md";
    const oldVersion = table.version;
    await writeFile(
      dir + "/" + file,
      (await readFile(dir + "/" + file, "utf8")) + "\n-- 合成来源单独改版\n",
    );
    assert.equal((await synchronizeSources(h)).value.status, 'completed');
    table = (await h.request("/knowledge/" + id)).value;
    assert.ok(BigInt(table.version) > BigInt(oldVersion));
    assert.equal(
      table.entries.find((e) => e.source_facts.source_id === source)
        .source_facts.version,
      "2",
    );
    assert.equal(
      table.entries.find((e) => e.entry_id === "description").effective_value,
      input.value,
    );
  }
  check("主来源及跨来源单独改版都重预填，各条目来源版本正确且人工覆盖保留");
  const removedCatalog = JSON.parse(await readFile(dir + "/semantic-catalog.json", "utf8"));
  const metricId = "metric-net_revenue";
  const beforeRemoval = (await h.request("/knowledge/" + id)).value;
  const metricBeforeRemoval = (await h.request("/knowledge/" + metricId)).value;
  const aliasesBeforeRemoval = metricBeforeRemoval.entries.find(entry => entry.entry_id === "aliases");
  assert.ok(aliasesBeforeRemoval.effective_value.trim());
  assert.equal(aliasesBeforeRemoval.human_override, null);
  removedCatalog.objects.find(object => object.id === id).entries = removedCatalog.objects.find(object => object.id === id).entries.filter(entry => entry.entry_id !== "description");
  removedCatalog.objects.find(object => object.id === metricId).entries = removedCatalog.objects.find(object => object.id === metricId).entries.filter(entry => entry.entry_id !== "aliases");
  await writeFile(dir + "/semantic-catalog.json", JSON.stringify(removedCatalog));
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  table = (await h.request("/knowledge/" + id)).value;
  const retainedDescription = table.entries.find(entry => entry.entry_id === "description");
  assert.equal(BigInt(table.version), BigInt(beforeRemoval.version) + 1n);
  assert.equal(retainedDescription.effective_value, input.value);
  assert.equal(retainedDescription.human_override.edited_by, "alice");
  assert.equal(retainedDescription.review_state, "needs_review");
  assert.equal(retainedDescription.source_facts.complete, false);
  assert.match(retainedDescription.source_facts.gap, /来源已撤下此条目/);
  const metricAfterRemoval = (await h.request("/knowledge/" + metricId)).value;
  assert.equal(BigInt(metricAfterRemoval.version), BigInt(metricBeforeRemoval.version) + 1n);
  assert.ok(!metricAfterRemoval.entries.some(entry => entry.entry_id === "aliases"));
  assert.deepEqual(metricAfterRemoval.entries.find(entry => entry.entry_id === "sql"), metricBeforeRemoval.entries.find(entry => entry.entry_id === "sql"));
  check("目录撤下条目后保留人工说明并明确待复核，未人工维护的旧别名移除，指标SQL不变");
  const guideId = "document-guide-1";
  const guideBeforeEdit = (await h.request("/knowledge/" + guideId)).value;
  const manualRelated = ["table-raw_payments"];
  const guideWithRelated = await h.request("/knowledge/" + guideId, {
    ...command(guideBeforeEdit.version), entry_id: "body", value: guideBeforeEdit.entries[0].effective_value,
    clear_override: false, related_ids: manualRelated,
  }, "alice", "PATCH");
  assert.equal(guideWithRelated.status, 200);
  assert.deepEqual(guideWithRelated.value.related_ids, manualRelated);
  assert.deepEqual(guideWithRelated.value.entries[0].human_override.related_ids, manualRelated);
  const bodyOnlyText = guideWithRelated.value.entries[0].effective_value + "\n\n人工补充：维护文档正文时保留已指定的关联。";
  const guideBodyOnly = await h.request("/knowledge/" + guideId, {
    ...command(guideWithRelated.value.version), entry_id: "body", value: bodyOnlyText, clear_override: false,
  }, "alice", "PATCH");
  assert.equal(guideBodyOnly.status, 200);
  assert.equal(guideBodyOnly.value.entries[0].effective_value, bodyOnlyText);
  assert.deepEqual(guideBodyOnly.value.entries[0].human_override.related_ids, manualRelated);
  // 整篇文档入口也允许只改正文；多章节保存仍须保留各章节已有的人工关联标记。
  const guideDocument = (await h.request("/knowledge/" + guideId + "/document")).value;
  const documentBody = "人工补充：文档关联由维护者明确指定。\n\n" + guideDocument.body;
  const guideDocumentSaved = await h.request("/knowledge/" + guideId + "/document", {
    operation_id: randomUUID(), body: documentBody,
    parts: guideDocument.parts.map(part => ({ id: part.id, expected_version: part.version })),
  }, "alice", "PATCH");
  assert.equal(guideDocumentSaved.status, 200);
  const guideAfterBodyEdit = (await h.request("/knowledge/" + guideId)).value;
  assert.ok(guideAfterBodyEdit.entries[0].effective_value.startsWith("人工补充：文档关联由维护者明确指定。"));
  assert.deepEqual(guideAfterBodyEdit.related_ids, manualRelated);
  assert.deepEqual(guideAfterBodyEdit.entries[0].human_override.related_ids, manualRelated);
  const guideCatalog = JSON.parse(await readFile(dir + "/semantic-catalog.json", "utf8"));
  guideCatalog.objects.find(object => object.id === guideId).name += " · 目录修订";
  await writeFile(dir + "/semantic-catalog.json", JSON.stringify(guideCatalog));
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  const guideAfterRefresh = (await h.request("/knowledge/" + guideId)).value;
  assert.equal(BigInt(guideAfterRefresh.version), BigInt(guideAfterBodyEdit.version) + 1n);
  assert.deepEqual(guideAfterRefresh.related_ids, manualRelated);
  assert.deepEqual(guideAfterRefresh.entries[0].human_override.related_ids, manualRelated);
  assert.equal(guideAfterRefresh.entries[0].effective_value, guideAfterBodyEdit.entries[0].effective_value);
  table = (await h.request("/knowledge/" + id)).value;
  check("文档显式指定关联后，条目和整篇正文编辑省略related_ids均保留人工标记，目录重分析不覆盖关联或正文");
  // 改名同步的断言已完成；正常查询前恢复与独立DDL一致的物理表名。
  guideCatalog.objects.find(object => object.id === id).name = "demo_order_detail";
  await writeFile(dir + "/semantic-catalog.json", JSON.stringify(guideCatalog));
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  table = (await h.request("/knowledge/" + id)).value;
  assert.equal(table.name, "demo_order_detail");
  assert.match(table.entries.find(entry => entry.path === "ddl").effective_value, /CREATE TABLE demo_order_detail\s*\(/);
  // 前面的来源同步已改版表；依据 business-guide §5.1 与结构附录重新核对，不能直接采用旧表引用。
  const metric = (await h.request("/knowledge/" + metricId)).value;
  const metricDefinition =
    "支付归属净收入：按 paid_at 选支付期间，排除测试交易；SUM(paid_amount_cents - refunded_amount_cents)，单位分，输入粒度为订单商品行。全退订单保留，退款按原付款期间归属。";
  const metricRule = {
    kind: "metric",
    table: { object_id: table.id, version: table.version },
    expression: "SUM(paid_amount_cents - refunded_amount_cents)",
    input_grain: "订单商品行",
    time_column: "paid_at",
    unit: "分",
    required_filters: ["is_test = 0", "paid_amount_cents > 0"],
    dimensions: ["channel", "region"],
  };
  assert.notEqual(table.version, "1");
  const staleMetric = await h.request("/knowledge/" + metricId, {
    ...command(metric.version), entry_id: "definition", value: metricDefinition,
    structured_value: { ...metricRule, table: { object_id: table.id, version: "1" } },
    clear_override: false,
  }, "alice", "PATCH");
  assert.equal(staleMetric.status, 409, JSON.stringify(staleMetric.value));
  assert.equal(staleMetric.value.code, "stale_knowledge");
  assert.deepEqual((await h.request("/knowledge/" + metricId)).value, metric);
  const confirmedMetric = await h.request("/knowledge/" + metricId, {
    ...command(metric.version), entry_id: "definition", value: metricDefinition,
    structured_value: metricRule, clear_override: false,
  }, "alice", "PATCH");
  assert.equal(confirmedMetric.status, 200, JSON.stringify(confirmedMetric.value));
  const confirmedDefinition = (await h.request("/knowledge/" + metricId)).value.entries
    .find(entry => entry.entry_id === "definition");
  assert.equal(confirmedDefinition.effective_value, metricDefinition);
  assert.deepEqual(confirmedDefinition.effective_structure, metricRule);
  assert.equal(confirmedDefinition.review_state, "confirmed");
  await h.resumeWorker();
  const long =
    "章节信息\n".repeat(700) +
    "\n## 退款分母说明\n修订检索专用术语：星河分母，按订单ID去重。";
  const create = {
    operation_id: randomUUID(),
    kind: "document",
    name: "跨表业务手册",
    body: long,
    related_ids: [id, "table-raw_payments"],
    source_url: null,
  };
  const doc = await h.request("/knowledge", create);
  assert.equal(doc.status, 200);
  assert.equal(doc.value.entries[0].effective_value, long);
  assert.equal(
    (await h.request("/knowledge?q=" + encodeURIComponent("星河分母"))).value
      .objects[0].id,
    doc.value.id,
  );
  assert.deepEqual((await h.request("/knowledge", create)).value, doc.value);
  check("长文正文末段可检索与完整回读，多表关联及重复创建");
  const linked = (await h.request("/knowledge", { ...create, operation_id: randomUUID(), name:"仅链接说明", body:"", source_url:"https://example.org/synthetic-guide" })).value;
  assert.equal(linked.entries[0].effective_value, "");
  assert.match(linked.entries[0].source_facts.gap, /正文尚未录入/);
  const linkedEdit = await h.request("/knowledge/"+linked.id, { ...command(linked.version), entry_id:"body", value:"现在录入合成正文", clear_override:false }, "alice", "PATCH");
  assert.equal(linkedEdit.status,200);
  assert.equal(linkedEdit.value.entries[0].human_override.source_url,"https://example.org/synthetic-guide");
  assert.ok(!linkedEdit.value.entries[0].source_facts.gap.includes("正文尚未录入"));
  assert.equal((await h.request("/knowledge/"+linked.id)).value.entries[0].human_override.source_url,"https://example.org/synthetic-guide");
  assert.equal((await h.request("/knowledge", { ...create, operation_id:randomUUID(), source_url:"javascript:alert(1)" })).status,400);
  check("仅链接记录正文缺口，补正文保留安全来源链接并回读，拒绝脚本URL");
  const memory = {
    operation_id: randomUUID(),
    id: null,
    expected_version: null,
    kind: "memory",
    name: "本人渠道偏好",
    body: "默认渠道=web",
    scope: "订单分析未指定渠道时；明确输入优先",
    verified: false,
    source_text: "本人明确保存",
    dependencies: [
      { object_id: id, version: table.version, path: "description" },
    ],
  };
  let asset = (await h.request("/assets", memory)).value;
  assert.ok(asset.id);
  assert.equal((await h.request("/assets", memory)).value.id, asset.id);
  assert.equal(
    (await h.request("/assets", undefined, "bob")).value.assets.length,
    0,
  );
  assert.equal(
    (
      await h.request(
        "/assets/" + asset.id + "/disable",
        command(asset.version),
        "bob",
      )
    ).status,
    404,
  );
  check("个人资产幂等且按用户隔离");
  const cid = await h.create();
  await h.send(cid, "查2026年1月净收入");
  await h.finished(cid);
  assert.equal(
    (await h.request("/conversations/" + cid + "/queries")).value.queries[0]
      .parameters.channel,
    "web",
  );
  let disabled = await h.request(
    "/assets/" + asset.id + "/disable",
    command(asset.version),
  );
  assert.equal(disabled.status, 200);
  const other = await h.create();
  await h.send(other, "查2026年1月净收入");
  await h.finished(other);
  assert.equal(
    (await h.request("/conversations/" + other + "/queries")).value.queries[0]
      .parameters.channel,
    undefined,
  );
  check("跨会话复用纠错偏好，停用后不再采用");
  const once = await h.create();
  await h.send(once, "仅本次默认只看app渠道，不要记住，查2026年1月净收入");
  await h.finished(once);
  assert.equal((await h.request("/assets")).value.assets.length, 1);
  check("仅本次条件不长期保存，保存失败不冒称记住");
  const corrected = await h.create();
  await h.send(corrected, "以后默认只看app渠道，查2026年1月净收入");
  await h.finished(corrected);
  const memories = (await h.request("/assets")).value.assets;
  assert.equal(memories.length, 2);
  assert.ok(
    (await h.snapshot(corrected)).events.some((e) => e.type === "memory_saved"),
  );
  assert.match((await h.snapshot(corrected)).messages.at(-1).text, /已保存/);
  check("用户可复用纠错经真实工具保存，成功后告知");
  const skill = (
    await h.request("/assets", {
      ...memory,
      operation_id: randomUUID(),
      kind: "skill",
      name: "我的渠道分析",
      body: "# 渠道方法\n只采用当前口径，所有SQL都展示后确认",
      dependencies: [],
    })
  ).value;
  const choose = {
    operation_id: randomUUID(),
    asset_id: skill.id,
    version: skill.version,
  };
  assert.equal(
    (
      await h.request(
        "/conversations/" + corrected + "/skill-selections",
        choose,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.request("/conversations/" + corrected + "/skill-selections", {
        ...choose,
        version: "0",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.request(
        "/conversations/" + corrected + "/skill-selections",
        choose,
        "bob",
      )
    ).status,
    404,
  );
  const changed = (
    await h.request("/assets", {
      ...memory,
      operation_id: randomUUID(),
      id: skill.id,
      expected_version: skill.version,
      kind: "skill",
      name: skill.name,
      body: "新版方法",
      dependencies: [],
    })
  ).value;
  assert.equal(changed.version, "2");
  check("Skill显式选择、用户隔离、版本变更需重新选择");
  // 首个查询的个人记忆已经停用；选没有该记忆来源的查询，单独验证知识停用的影响。
  const stale = (await h.request("/conversations/" + other + "/queries")).value
    .queries[0];
  const readable = await h.request("/queries/" + stale.id);
  assert.equal(readable.status, 200);
  assert.notEqual(readable.value.text_unavailable, true);
  assert.match(readable.value.sql, /demo_order_detail/);
  assert.equal(readable.value.confirmation_state, "awaiting_confirmation");
  assert.equal(readable.value.execution_state, "not_submitted");
  const currentMetric = (await h.request("/knowledge/" + metricId)).value;
  assert.deepEqual(currentMetric.entries.find(entry => entry.entry_id === "definition")
    .effective_structure.table, { object_id: id, version: table.version });
  const queryAuthority = h.sql(`SELECT text_authority FROM query_requests WHERE id='${stale.id}'`)[0];
  assert.ok(queryAuthority.knowledge.some(([objectId, version]) => objectId === id && version === table.version));
  assert.deepEqual(queryAuthority.memories, []);
  const queryState = () => h.sql(`SELECT JSON_OBJECT('confirmation',confirmation_state,'execution',execution_state,'key',confirmation_key,'lease',lease_epoch) FROM query_requests WHERE id='${stale.id}'`)[0];
  const beforeDisable = queryState();
  assert.equal(beforeDisable.key, null);
  assert.equal(beforeDisable.lease, 0);
  assert.equal(
    (await h.request("/knowledge/" + id + "/disable", command(table.version)))
      .status,
    200,
  );
  const refusedConfirmation = await h.request("/queries/" + stale.id + "/confirm", {
    operation_id: randomUUID(),
    draft_version: stale.draft_version,
    condition_version: stale.condition_version,
  });
  assert.equal(refusedConfirmation.status, 409, JSON.stringify(refusedConfirmation.value));
  assert.equal(refusedConfirmation.value.code, "stale_context");
  assert.deepEqual(queryState(), beforeDisable);
  check("知识停用后旧SQL不能确认");
  console.log(JSON.stringify({ passed: true, checks, officialRequests: 0 }));
} finally {
  await writeFile(
    ".local/checks/mvp-knowledge.json",
    JSON.stringify({ passed: checks.length === 15, checks }, null, 2),
  );
  await h.close();
}
