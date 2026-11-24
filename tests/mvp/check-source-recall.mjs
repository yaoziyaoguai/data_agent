import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { harness } from "./harness.mjs";
import { embeddingProvider } from "./embedding-provider.mjs";
import { seedRawAllowedSources } from "./source-recall-fixtures.mjs";

const provider = await embeddingProvider();
const filter = process.argv[2];
const executed = [];
async function cargoTests(env, target, testFilter) {
  let output = "";
  const code = await new Promise((resolve, reject) => {
    const child = spawn(homedir() + "/.cargo/bin/cargo", ["test", "--offline", "--locked", "-p", "data-agent", ...target, "--", "--test-threads=1", "--show-output", ...(testFilter ? [testFilter] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
  const tests = [...output.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(match => match[1]);
  assert.ok(tests.length > 0, "筛选后必须实际执行Rust断言");
  executed.push(...tests);
}

const collection = "data_agent_test_" + randomUUID().replaceAll("-", "");
const token = (await readFile(".local/infra/milvus-root-password", "utf8")).trim();
let queries = 0;
let failedKnowledgeSparse = 0;
let successfulRawSparse = 0;
const sparseFaultQuery = "rawstagerawhealthyneedle";
const rawOnlyDenseQuery = "rawstageonlydenseprobe";
const rawOnlyDenseBody = "合成校准规定：设备校验完成之前不得投入使用。";
const rawOnlyDenseVector = Array.from({ length: 1024 }, (_, index) => Number(index === 37));
const rawOnlyDense = { sourceEmbeddings: 0, queryEmbeddings: 0, indexed: [], searches: [] };
const rawVersionQuery = "rawversionneedle";
const rawVersionRows = [];
const rawVersionSearches = [];
const isRawOnlyDenseVector = value => Array.isArray(value)
  && value.length === rawOnlyDenseVector.length
  && value.every((component, index) => component === rawOnlyDenseVector[index]);
const proxy = createServer(async (req, res) => {
  try {
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (req.url === "/embeddings") {
      const response = await fetch(provider.env.DATA_AGENT_EMBEDDING_URL, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      // 仅该反例的正文与查询使用固定单位向量，Milvus写入、排序及回源仍走真实链。
      for (const item of payload.data) {
        const text = input.input[item.index];
        if (text === rawOnlyDenseQuery || text.includes(rawOnlyDenseBody)) {
          item.embedding = rawOnlyDenseVector;
          if (text === rawOnlyDenseQuery) rawOnlyDense.queryEmbeddings++;
          else rawOnlyDense.sourceEmbeddings++;
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
      return;
    }
    if (req.url.endsWith("/upsert")) {
      const legacyRows = [];
      for (const row of input.data || []) {
        if (row.kind === "source_excerpt" && row.source_kind === "platform" && row.text.includes(rawOnlyDenseBody)) {
          rawOnlyDense.indexed.push({ id: row.id, source: row.object_id, controlledVector: isRawOnlyDenseVector(row.vector) });
        }
        if (row.kind === "source_excerpt" && row.text.includes(rawVersionQuery)) {
          rawVersionRows.push({ id: row.id, source: row.object_id, segmentationVersion: row.segmentation_version });
          legacyRows.push({ ...row, id: row.id + "-old", segmentation_version: "source-structure-0" });
          const missing = { ...row, id: row.id + "-missing" };
          delete missing.segmentation_version;
          legacyRows.push(missing);
        }
      }
      if (legacyRows.length) {
        input.data.push(...legacyRows);
        body = JSON.stringify(input);
      }
    }
    const faultQuery = req.url.endsWith("/search") && input.annsField === "sparse" && input.data?.[0] === sparseFaultQuery;
    const rawSearch = input.filter?.includes('kind == "source_excerpt"');
    if (faultQuery && !rawSearch) {
      failedKnowledgeSparse++;
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ code: 1, message: "synthetic knowledge sparse failure" }));
      return;
    }
    const response = await fetch("http://127.0.0.1:19531" + req.url, {
      method: "POST", headers: { "content-type": "application/json", authorization: req.headers.authorization }, body,
    });
    const result = await response.text();
    const payload = JSON.parse(result);
    if (payload.code !== 0) console.error(JSON.stringify({ path: req.url, code: payload.code, message: payload.message }));
    if (faultQuery && rawSearch && payload.code === 0) successfulRawSparse++;
    if (req.url.endsWith("/search") && rawSearch && rawVersionRows.some(row => input.filter.includes(JSON.stringify(row.source)))) {
      rawVersionSearches.push({ channel: input.annsField, filter: input.filter, outputFields: input.outputFields,
        ids: (payload.data || []).map(row => row.id) });
    }
    if (req.url.endsWith("/search") && rawSearch
      && ((input.annsField === "sparse" && input.data?.[0] === rawOnlyDenseQuery)
        || (input.annsField === "vector" && isRawOnlyDenseVector(input.data?.[0])))) {
      rawOnlyDense.searches.push({ channel: input.annsField, status: response.status, code: payload.code,
        filter: input.filter, ids: (payload.data || []).map(row => row.id) });
    }
    res.writeHead(response.status, { "content-type": "application/json" }).end(result);
    if (req.url.endsWith("/search") || req.url.endsWith("/query")) queries++;
  } catch { res.writeHead(503).end(); }
});
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
let h;
try {
  h = await harness({ startWorker: false, env: {
    ...provider.env,
    DATA_AGENT_EMBEDDING_URL: "http://127.0.0.1:" + proxy.address().port + "/embeddings",
    DATA_AGENT_VECTOR_URL: "http://127.0.0.1:" + proxy.address().port,
    DATA_AGENT_VECTOR_COLLECTION: collection,
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + "/.local/infra/milvus-root-password",
  } });
  const prepared = await h.request("/knowledge-index/rebuilds", { operation_id: randomUUID() });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  if (!filter || filter === "synchronized_document_recalls_its_own_windows_without_upstream_access") {
    // 仅在隔离库准备上游夹具；用例通过正式owner保存并索引派生文档。
    h.sql("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES('synchronized-document-upstream','demo',1,'synthetic')");
    h.sql("INSERT INTO source_revisions(source_id,version,body,archive_complete) VALUES('synchronized-document-upstream',1,CONCAT(REPEAT('无关背景。',300),' synchronizeddocumentneedle：复核完成后才可计入。',REPEAT('未选附录。',300)),TRUE)");
    await cargoTests(h.env, ["--lib"], "synchronized_document_recalls_its_own_windows_without_upstream_access");
  }
  if (!filter || filter === "raw_allowed_records_include_readable_heads_without_task_gate") {
    // 来源夹具只落本次隔离库；允许集查询只需要头部身份，合成正文留在owner表。
    seedRawAllowedSources(h);
    await cargoTests(h.env, ["--lib"], "raw_allowed_records_include_readable_heads_without_task_gate");
  }
  if (filter !== "raw_allowed_records_include_readable_heads_without_task_gate" && filter !== "synchronized_document_recalls_its_own_windows_without_upstream_access") {
    const before = queries;
    await cargoTests(h.env, ["--test", "source_excerpt_recall"], filter);
    if (!filter || filter.startsWith("raw_stage_") || filter === "gated_raw_source_round_trip_recalls_revision_and_reports_lag") {
      assert.ok(queries > before, "Rust子测试等待期间，父Node服务完成真实Milvus查询");
    }
  }
  if (executed.includes("raw_stage_keeps_healthy_raw_bm25_without_adding_sql_knowledge_vote")) {
    assert.ok(failedKnowledgeSparse > 0, "必须真实注入knowledge sparse失败");
    assert.ok(successfulRawSparse > 0, "同一查询的raw sparse必须成功透传真实Milvus");
  }
  if (executed.includes("raw_stage_launches_dense_for_raw_only_allowed_sources")) {
    assert.ok(rawOnlyDense.sourceEmbeddings > 0, "正式消费者必须实际嵌入本例原文");
    assert.equal(rawOnlyDense.queryEmbeddings, 1, "原launch必须实际发送raw-only查询Embedding一次");
    assert.equal(rawOnlyDense.indexed.length, 1, "正式消费者必须实际写入唯一raw片段");
    assert.ok(rawOnlyDense.indexed[0].controlledVector, "真实Milvus写入必须携带受控向量");
    const lexical = rawOnlyDense.searches.filter(request => request.channel === "sparse");
    const dense = rawOnlyDense.searches.filter(request => request.channel === "vector");
    assert.ok(lexical.length > 0 && lexical.every(request => request.status === 200
      && request.code === 0 && request.ids.length === 0), "无字面交集时BM25必须实际成功空");
    assert.ok(dense.length > 0 && dense.every(request => request.status === 200 && request.code === 0),
      "受控查询向量必须实际透传真实Milvus dense请求");
    assert.ok(dense.some(request => request.ids.includes(rawOnlyDense.indexed[0].id)),
      "真实dense结果必须包含正式消费者写入的raw片段");
    assert.ok(rawOnlyDense.searches.every(request => request.filter.includes('source_kind == "platform"')
      && request.filter.includes(JSON.stringify(rawOnlyDense.indexed[0].source))),
      "raw各路实际请求必须携带合法platform允许集");
  }
  if (executed.includes("raw_stage_filters_old_segmentation_before_candidates_and_owner_reads")) {
    assert.equal(rawVersionRows.length, 1);
    assert.equal(rawVersionRows[0].segmentationVersion, "source-structure-1", "正式writer须显式携带切块版本");
    assert.deepEqual(new Set(rawVersionSearches.map(request => request.channel)), new Set(["sparse", "vector"]));
    for (const request of rawVersionSearches) {
      assert.ok(request.filter.includes('segmentation_version == "source-structure-1"'), "各路须在召回前过滤切块表示版本");
      assert.ok(request.outputFields.includes("segmentation_version"));
      assert.deepEqual(request.ids, [rawVersionRows[0].id], "真实Milvus不得将旧版和缺版本行纳入候选");
    }
  }
  console.log(JSON.stringify({ passed: true, officialRequests: 0, tests: executed, failedKnowledgeSparse, successfulRawSparse, rawOnlyDense, rawVersionRows, rawVersionSearches }));
} catch (error) {
  console.error(JSON.stringify({ queries, failedKnowledgeSparse, successfulRawSparse, rawOnlyDense, rawVersionRows, rawVersionSearches }));
  throw error;
} finally {
  await h?.close();
  await provider.close();
  const response = await fetch("http://127.0.0.1:19531/v2/vectordb/collections/drop", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer root:" + token },
    body: JSON.stringify({ dbName: "default", collectionName: collection }),
  });
  assert.equal((await response.json()).code, 0);
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
}
