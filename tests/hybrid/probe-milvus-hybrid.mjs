import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// 05切片1：用本地实际REST请求验证当前Milvus(v3.0.2)对Jieba中文分析、BM25函数/sparse、
// 1024维dense与标量过滤的支持。仅使用专用测试集合，结束即删；不触碰现有公共/个人集合。
// 结论写入 .local/checks/milvus-hybrid-capabilities.json，供后续切片与08记录引用。
const base = "http://127.0.0.1:19531/v2/vectordb/";
const token = (await readFile(".local/infra/milvus-root-password", "utf8")).trim();
const headers = { "content-type": "application/json", authorization: "Bearer root:" + token };
const collection = "da_hybrid_probe_" + randomUUID().replaceAll("-", "").slice(0, 16);

const call = async (path, body) => {
  const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await response.json();
  return result;
};
// 执行包要求保留中文原文含义词：否定/首次/最终/除外，以及完整标识和别名。
const documents = [
  { id: "refund_rule_v1", kind: "policy", text: "退款金额按实付金额计算；未付款订单不产生退款，首次退款免手续费。" },
  { id: "refund_rule_v2", kind: "policy", text: "退款金额按实付金额计算；已付款订单可退款，最终退款扣除手续费，运费除外。" },
  { id: "metric_alias", kind: "metric", text: "完成金额（别名：成交金额、成交额）统计已结算订单，不含取消订单。" },
  { id: "unrelated", kind: "note", text: "本周例会纪要：讨论了货架摆放与值班安排。" },
];
// 确定性伪向量：与真实Qwen embedding维度一致但值只来自id哈希，只证明REST链路不证明语义质量。
const pseudoVector = id => Array.from({ length: 1024 }, (_, i) => ((Math.sin(i * 0.37 + id.length) + 1) / 2));

const schema = {
  collectionName: collection,
  schema: {
    autoId: false,
    fields: [
      { fieldName: "id", dataType: "VarChar", isPrimary: true, elementTypeParams: { max_length: 128 } },
      { fieldName: "vector", dataType: "FloatVector", elementTypeParams: { dim: 1024 } },
      { fieldName: "sparse", dataType: "SparseFloatVector" },
      { fieldName: "text", dataType: "VarChar", elementTypeParams: { max_length: 8192, enable_analyzer: true, analyzer_params: { type: "chinese" } } },
      { fieldName: "kind", dataType: "VarChar", elementTypeParams: { max_length: 64 } },
    ],
    functions: [{ name: "text_bm25", type: "BM25", inputFieldNames: ["text"], outputFieldNames: ["sparse"] }],
  },
  indexParams: [
    { fieldName: "vector", indexType: "AUTOINDEX", metricType: "COSINE" },
    { fieldName: "sparse", indexType: "SPARSE_INVERTED_INDEX", metricType: "BM25" },
  ],
};

const notes = [];
const passed = [];
let ok = true;
const expectOk = async (label, result) => {
  assert.equal(result.code, 0, label + " " + JSON.stringify(result).slice(0, 300));
  passed.push(label);
};
try {
  const create = await call("collections/create", schema);
  await expectOk("REST创建带chinese分析器+BM25函数+1024维dense的专用集合", create);

  const describe = await call("collections/describe", { collectionName: collection });
  await expectOk("describe可读回集合形状", describe);

  const insert = await call("entities/insert", {
    collectionName: collection,
    data: documents.map(d => ({ id: d.id, text: d.text, kind: d.kind, vector: pseudoVector(d.id) })),
  });
  await expectOk("insert写入中文原文（sparse由BM25函数生成，不显式写入）", insert);
  await new Promise(r => setTimeout(r, 1500));

  // BM25全文检索：中文否定区分（未付款 vs 已付款）与含义词保留。
  const bm25Negation = await call("entities/search", {
    collectionName: collection,
    data: ["未付款订单是否退款"],
    annsField: "sparse",
    limit: 4,
    outputFields: ["id", "kind", "text"],
    consistencyLevel: "Strong",
  });
  await expectOk("BM25检索中文查询（未付款）", bm25Negation);
  const negationTop = bm25Negation.data?.results?.[0] ?? bm25Negation.data?.[0];
  assert.ok(negationTop, "bm25 result shape " + JSON.stringify(bm25Negation).slice(0, 200));
  const negationIds = (bm25Negation.data.results ?? bm25Negation.data).map(h => h.id);
  assert.equal(negationIds.indexOf("refund_rule_v1") >= 0 && negationIds.indexOf("refund_rule_v1") < negationIds.indexOf("refund_rule_v2"), true,
    "含『未付款』原文应比不含者更相关: " + JSON.stringify(negationIds));
  passed.push("Jieba+BM25保留中文否定区分（未付款 v1 排在 v2 之前）");

  const bm25Alias = await call("entities/search", {
    collectionName: collection, data: ["成交额怎么算"], annsField: "sparse", limit: 4,
    outputFields: ["id"], consistencyLevel: "Strong",
  });
  await expectOk("BM25检索别名（成交额→metric_alias）", bm25Alias);
  const aliasIds = (bm25Alias.data.results ?? bm25Alias.data).map(h => h.id);
  assert.equal(aliasIds[0], "metric_alias", JSON.stringify(aliasIds));
  passed.push("别名（成交额）命中同义原文");

  // dense检索 + 标量过滤：filter在向量检索上执行。
  const denseFiltered = await call("entities/search", {
    collectionName: collection, data: [pseudoVector("refund_rule_v1")], annsField: "vector",
    filter: 'kind == "policy"', limit: 4, outputFields: ["id", "kind"], consistencyLevel: "Strong",
  });
  await expectOk("dense检索叠加标量过滤（kind=policy）", denseFiltered);
  const filteredIds = (denseFiltered.data.results ?? denseFiltered.data).map(h => h.id);
  assert.ok(filteredIds.every(id => documents.find(d => d.id === id)?.kind === "policy"), JSON.stringify(filteredIds));
  passed.push("dense+标量过滤只返回policy记录");

  // BM25 + 标量过滤组合。
  const bm25Filtered = await call("entities/search", {
    collectionName: collection, data: ["退款"], annsField: "sparse",
    filter: 'kind == "note"', limit: 4, outputFields: ["id"], consistencyLevel: "Strong",
  });
  if (bm25Filtered.code === 0) {
    const emptyIds = (bm25Filtered.data.results ?? bm25Filtered.data);
    assert.equal(emptyIds.length, 0, "BM25+过滤不应命中无关note: " + JSON.stringify(emptyIds));
    passed.push("BM25+标量过滤组合执行（过滤后无note命中）");
  } else {
    notes.push("BM25+filter组合返回 code=" + bm25Filtered.code + " " + (bm25Filtered.message ?? ""));
  }

  // RunAnalyzer直接观察Jieba词项（执行包要求记录实际词项）。
  const analyzer = await call("common/run_analyzer", {
    collectionName: collection, fieldName: "text", text: ["未付款订单不产生退款，首次免手续费。"], withDetail: true,
  });
  if (analyzer.code === 0) {
    const tokens = JSON.stringify(analyzer.data);
    assert.ok(tokens.includes("未付款") || tokens.includes("退款") || tokens.includes("手续费"), tokens.slice(0, 300));
    passed.push("run_analyzer返回实际Jieba词项（记录于证据文件）");
    notes.push("analyzer tokens: " + tokens.slice(0, 600));
  } else {
    notes.push("run_analyzer不可用: " + (analyzer.message ?? analyzer.code));
  }
} catch (error) {
  ok = false;
  notes.push("failure: " + error.message);
} finally {
  const drop = await call("collections/drop", { collectionName: collection });
  const dropped = drop.code === 0 && !(await call("collections/has", { collectionName: collection })).data.has;
  await mkdir(".local/checks", { recursive: true });
  await writeFile(".local/checks/milvus-hybrid-capabilities.json", JSON.stringify({
    ok: ok && dropped, collectionRemoved: dropped, image: "milvusdb/milvus:v3.0.2",
    restBase: "http://127.0.0.1:19531/v2/vectordb",
    createRequestShape: {
      fieldAnalyzer: { elementTypeParams: { enable_analyzer: true, analyzer_params: { type: "chinese" } } },
      bm25Function: { name: "text_bm25", type: "BM25", inputFieldNames: ["text"], outputFieldNames: ["sparse"] },
      sparseIndex: { indexType: "SPARSE_INVERTED_INDEX", metricType: "BM25" },
      note: "REST v2顶层enableAnalyzer/analyzerParams不被解析，必须放elementTypeParams；BM25函数不接受params(k1/b)。",
    },
    passed, notes, officialRequests: 0,
  }, null, 2));
  console.log(JSON.stringify({ ok: ok && dropped, passed, notes: notes.slice(0, 3) }));
  if (!ok || !dropped) process.exitCode = 1;
}
