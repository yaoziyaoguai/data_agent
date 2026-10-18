import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness } from "./harness.mjs";

const h = await harness({
  capture: true,
  startWorker: false,
  env: { DATA_AGENT_LEASE_MS: "120000" },
});
const checks = [];
const observations = {};
let passed = false,
  run;
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const object = (id, kind, name, body, related = []) => ({
  id,
  kind,
  name,
  version: "1",
  state: "enabled",
  entries: [
    {
      entry_id: "description",
      path: "description",
      label: "说明",
      effective_value: body,
      source_facts: { complete: false, gap: "独立合成检索夹具" },
      suggestion: {},
      human_override: { value: body, edited_by: "alice" },
      review_state: "confirmed",
    },
  ],
  related_ids: related,
  source_id: null,
  source_version: "0",
  updated_by: "synthetic-test",
});
const insert = (value, indexed = true) => {
  assert.match(value.id, /^[a-z0-9_-]+$/);
  const encoded = Buffer.from(JSON.stringify(value)).toString("hex");
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES('${value.id}','demo','${value.kind}','${value.name}',1,'enabled',CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_versions(object_id,version,body) SELECT id,version,body FROM knowledge_objects WHERE id='${value.id}';
    ${indexed ? `INSERT INTO retrieval_documents(object_id,space_id,version,body) SELECT id,space_id,version,body FROM knowledge_objects WHERE id='${value.id}';` : ""}
    INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) VALUES('demo','${value.id}','${value.id}','system','synthetic-test')`);
};
const search = async (query, limit = 10) => {
  const input = {
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(),
    tool_name: "search_knowledge",
    arguments: { query, limit },
    checkpoint: exportCheckpoint(
      SessionManager.inMemory("/synthetic/data-agent"),
    ),
  };
  ok(await h.internal("/internal/data/tool-calls", input));
  const result = ok(await h.internal("/internal/data/tools", input));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24576);
  return result.data;
};

try {
  const linked = ["rank-context-a", "rank-context-b"];
  for (const id of linked)
    insert(object(id, "document", "合成关联说明", "该表的补充背景。"));
  const fields = ["amount", "rate", "count"].map((field) =>
    object(
      "rank-field-" + field,
      "field",
      "refundcase sales " + field,
      "同一张虚构订单表的字段。",
      linked,
    ),
  );
  for (const field of fields) insert(field);
  for (const kind of [
    "table",
    "metric",
    "query_example",
    "document",
    "relationship",
    "term",
  ])
    insert(
      object(
        "rank-weak-" + kind,
        kind,
        "合成非目标资料",
        "偶然提及 refundcase，不提供所问字段。",
      ),
    );

  const expected = new Set(fields.map((item) => item.id));
  await h.resumeWorker();
  run = await h.capture(await h.create(), "核对合成退款字段");
  await h.pauseWorker();
  const first = await search("refundcase sales");
  assert.ok(
    fields.every((field) => first.objects.some((item) => item.id === field.id)),
    JSON.stringify(first.objects.map((item) => item.id)),
  );
  assert.deepEqual(
    new Set(first.objects.slice(0, 3).map((item) => item.id)),
    expected,
  );
  assert.equal(first.objects.length, 10);
  assert.ok(linked.every((id) => first.objects.some((item) => item.id === id)));
  assert.equal(first.reply_coverage.state, "complete");
  checks.push(
    "默认十条首次工具回执保全三个同类强字段，六类弱命中与两个关联对象不能挤掉前三",
  );

  const narrow = await search("refundcase sales", 4);
  assert.deepEqual(
    new Set(narrow.objects.slice(0, 3).map((item) => item.id)),
    expected,
  );
  assert.equal(narrow.objects.length, 4);
  assert.equal(
    narrow.objects.filter((item) => linked.includes(item.id)).length,
    1,
  );
  checks.push("limit=4时只用一个剩余位置补关联，前三不被二次截断");

  const sparse = ["one", "two"].map((name) =>
    object(
      "rank-sparse-" + name,
      "field",
      "sparsekey " + name,
      "同表字段",
      linked,
    ),
  );
  for (const value of sparse) insert(value);
  const filled = await search("sparsekey", 4);
  assert.deepEqual(
    new Set(filled.objects.map((item) => item.id)),
    new Set([...sparse.map((item) => item.id), ...linked]),
  );
  checks.push("只有两个直接命中时仍用两个余位补关联，不降低原有稀疏候选召回");

  // 用同一真实工具入口覆盖未建索引的正式正文，以及已索引的目标。
  // 关键业务词可以在自然问句首、中、尾，不能只查看前24个派生词项。
  const termTargets = [false, true].map((indexed) =>
    object(
      "terms-refund-" + (indexed ? "indexed" : "current"),
      "metric",
      "退款率",
      "Synthetic standalone fixture.",
    ),
  );
  termTargets.forEach((value, index) => insert(value, index === 1));
  const termQueries = {
    start:
      "退款率请先按照当前可见的业务资料帮我认真核对一下这张表在最近一个统计周期内的口径",
    middle:
      "请先按照当前可见的业务资料退款率帮我认真核对一下这张表在最近一个统计周期内的口径",
    end: "请先按照当前可见的业务资料帮我认真核对一下这张表在最近一个统计周期内的退款率",
  };
  observations.queryTermPositions = {};
  for (const [position, query] of Object.entries(termQueries)) {
    const found = await search(query);
    observations.queryTermPositions[position] = termTargets.every((target) =>
      found.objects.some((item) => item.id === target.id),
    );
    assert.ok(
      observations.queryTermPositions[position],
      `${position}: ${JSON.stringify(found.objects.map((item) => item.id))}`,
    );
  }
  checks.push(
    "长中文问句首中尾业务词均经正式工具候选路径召回，有无索引结果一致",
  );

  // 索引词项可以带别名；回源正文仍由完整问句计分，不能把评分也裁成24项。
  const indexAlias = object(
    "terms-index-alias",
    "metric",
    "qtoken45",
    "独立合成索引别名资料。",
  );
  insert(indexAlias);
  const aliasBody = Buffer.from(
    JSON.stringify({ ...indexAlias, name: "qtoken47" }),
  ).toString("hex");
  h.sql(
    `UPDATE retrieval_documents SET body=CAST(CONVERT(0x${aliasBody} USING utf8mb4) AS JSON) WHERE object_id='${indexAlias.id}'`,
  );
  const indexedTerms = await search(
    Array.from(
      { length: 48 },
      (_, i) => "qtoken" + String(i).padStart(2, "0"),
    ).join(" "),
  );
  assert.ok(indexedTerms.objects.some((item) => item.id === indexAlias.id));
  assert.equal(indexedTerms.search_coverage.query_terms_complete, false);
  assert.equal(indexedTerms.search_coverage.state, "bounded");
  checks.push(
    "索引独立召回尾部别名后，完整问句中的未选词仍参与正式正文计分；回执明示词项覆盖受限",
  );

  const repeated = await search("unusedprefix ".repeat(30) + "退款率");
  assert.ok(
    termTargets.every((target) =>
      repeated.objects.some((item) => item.id === target.id),
    ),
  );
  assert.equal(repeated.search_coverage.query_terms_complete, true);
  for (const query of ["退款率", "refundcase sales"]) {
    const short = await search(query);
    assert.equal(short.search_coverage.query_terms_complete, true);
    assert.equal(short.search_coverage.state, "complete");
  }
  checks.push(
    "重复词先去重不耗尽候选词预算，短查询完整覆盖且原评分与前三保护不变",
  );

  // 所有资料从零合成。1200个弱正文命中按ID排在前，唯一名称强匹配在末尾。
  const weak = object(
    "scale-placeholder",
    "document",
    "合成干扰资料",
    "偶然提及 largecatalog，其他内容无关。",
  );
  const encoded = Buffer.from(JSON.stringify(weak)).toString("hex");
  h.sql(`SET SESSION cte_max_recursion_depth=1300;
    INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
    WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i<1200)
    SELECT CONCAT('aa-rank-scale-',LPAD(i,4,'0')),'demo','document','合成干扰资料',1,'enabled',JSON_SET(CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),'$.id',CONCAT('aa-rank-scale-',LPAD(i,4,'0'))),NULL,0,'synthetic-test' FROM n;
    INSERT INTO retrieval_documents(object_id,space_id,version,body) SELECT id,space_id,version,body FROM knowledge_objects WHERE id LIKE 'aa-rank-scale-%';
    INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) SELECT space_id,id,id,'system','synthetic-test' FROM knowledge_objects WHERE id LIKE 'aa-rank-scale-%'`);
  const target = object(
    "zz-rank-scale-target",
    "metric",
    "largecatalog",
    "末尾唯一名称强匹配，同时含 tailrank。",
  );
  insert(target, false);
  const large = await search("largecatalog");
  assert.equal(large.objects[0].id, target.id);
  assert.equal(large.search_coverage.state, "candidate_limit");
  assert.equal(large.search_coverage.examined, undefined);
  assert.equal(large.search_coverage.rejected, undefined);
  assert.match(large.note, /空结果不能证明不存在/);
  checks.push(
    "1200个前置弱命中仍由名称优先召回末尾强项，同时明确候选覆盖不足且不泄漏过滤数量",
  );
  // 多词问句不再整体匹配目标名称；有界候选可能漏掉它，但必须明示覆盖不足。
  // 记录实际召回，不把“漏掉目标”固定为将来不得改善的预期。
  const broad = await search("largecatalog tailrank");
  assert.equal(broad.search_coverage.state, "candidate_limit");
  assert.equal(broad.search_coverage.examined, undefined);
  assert.equal(broad.search_coverage.rejected, undefined);
  assert.match(broad.note, /空结果不能证明不存在/);
  observations.broadQueryIncludedTarget = broad.objects.some(
    (item) => item.id === target.id,
  );
  checks.push(
    "1200对象的宽查询如实报告候选上限，不把名称优先冒称全库相关性排序",
  );

  passed = true;
  console.log(
    JSON.stringify({ passed, checks, observations, officialRequests: 0 }),
  );
} finally {
  if (run) h.releaseRun(run.run_id);
  await writeFile(
    ".local/checks/retrieval-ranking.json",
    JSON.stringify(
      { passed, checks, observations, officialRequests: 0 },
      null,
      2,
    ),
  );
  await h.close();
}
