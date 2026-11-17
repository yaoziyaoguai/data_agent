import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { harness, until } from "./harness.mjs";
import { embeddingProvider } from "./embedding-provider.mjs";

const provider = await embeddingProvider();
const collection = "da_target_" + randomUUID().replaceAll("-", "");
const token = (await readFile(".local/infra/milvus-root-password", "utf8")).trim();
const requests = [];
let failDescribe = false;
const proxy = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ path: req.url, collection: body.collectionName });
  if (failDescribe && req.url.endsWith("/describe")) {
    res.writeHead(503).end();
    return;
  }
  try {
    const response = await fetch("http://127.0.0.1:19531" + req.url, {
      method: "POST", headers: { "content-type": "application/json", authorization: req.headers.authorization }, body: raw,
    });
    res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
  } catch { res.writeHead(503).end(); }
});
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
const milvus = async (path, body = {}) => {
  const response = await fetch("http://127.0.0.1:19531/v2/vectordb/" + path, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer root:" + token },
    body: JSON.stringify({ dbName: "default", collectionName: collection, ...body }),
  });
  const result = await response.json();
  assert.equal(result.code, 0);
  return result.data;
};
let h, passed = false;
const checks = [];
const search = async () => {
  const response = await h.request("/knowledge?q=" + encodeURIComponent("净收入"));
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value.search_coverage;
};
try {
  h = await harness({ startWorker: false, env: { ...provider.env,
    DATA_AGENT_VECTOR_URL: "http://127.0.0.1:" + proxy.address().port,
    DATA_AGENT_VECTOR_COLLECTION: collection,
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + "/.local/infra/milvus-root-password",
  } });
  assert.equal((await milvus("collections/has")).has, false);
  assert.equal((await search()).vector_state, "unavailable");
  assert.equal((await milvus("collections/has")).has, false, "查询不能创建缺失集合");
  assert.ok(requests.every(request => !request.path.endsWith("/create")));
  checks.push("缺失集合只报告不可用，普通检索没有创建或切换目标");

  const prepared = await h.request("/knowledge-index/rebuilds", { operation_id: randomUUID() });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  assert.equal((await milvus("collections/has")).has, true);
  await h.resumeWorker();
  await until(() => h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE vector_state<>'indexed'")[0].n === 0, "显式目标完成实际索引", 60000);
  await h.pauseWorker();
  await until(async () => (await search()).vector_state === "available", "显式目标可检索", 15000);
  const identity = (await milvus("collections/describe")).collectionID;
  const creates = requests.filter(request => request.path.endsWith("/create")).length;
  failDescribe = true;
  assert.equal((await search()).vector_state, "unavailable");
  assert.equal(requests.filter(request => request.path.endsWith("/create")).length, creates);
  failDescribe = false;
  assert.equal((await milvus("collections/describe")).collectionID, identity);
  checks.push("显式维护准备配置集合；读取故障不触发重建，不改变集合身份");

  await milvus("collections/drop");
  await milvus("collections/create", { dimension: 1024, idType: "VarChar", autoID: false,
    primaryFieldName: "id", vectorFieldName: "vector", metricType: "COSINE", params: { max_length: "128", enableDynamicField: true } });
  const legacy = (await milvus("collections/describe")).collectionID;
  assert.equal((await search()).vector_state, "unavailable");
  const incompatible = await h.request("/knowledge-index/rebuilds", { operation_id: randomUUID() });
  assert.notEqual(incompatible.status, 200);
  assert.equal(incompatible.value.code, "vector_schema_mismatch");
  assert.equal((await milvus("collections/describe")).collectionID, legacy);
  assert.ok(requests.every(request => request.collection === collection));
  checks.push("旧dense集合明确不兼容；不加后缀、不改旧集合，也不创建替代集合");

  const document = await h.request("/knowledge", { operation_id: randomUUID(), kind: "document", name: "合成旧集合拒写", body: "原文只写入已明确准备的公共索引目标。", source_url: null, related_ids: [] });
  assert.equal(document.status, 200);
  const beforeEmbedding = provider.requests.length;
  const beforeRequests = requests.length;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(homedir() + "/.cargo/bin/cargo", ["test", "--offline", "--locked", "-p", "data-agent", "--test", "raw_index_target"], { env: h.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0);
  assert.equal(provider.requests.length, beforeEmbedding, "不兼容目标不产生Embedding调用");
  assert.ok(requests.slice(beforeRequests).every(request => !request.path.endsWith("/upsert")));
  const job = h.sql(`SELECT JSON_OBJECT('state',vector_state,'attempts',vector_attempts) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id='${document.value.id}' AND version=1`)[0];
  assert.equal(job.state, "pending");
  assert.equal(job.attempts, 0);
  checks.push("统一消费者领取前拒绝不兼容目标，原待办保持pending且未消耗重试或Embedding");
  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} finally {
  await h?.close();
  if ((await milvus("collections/has")).has) await milvus("collections/drop");
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  await provider.close();
  await writeFile(".local/checks/index-target.json", JSON.stringify({ passed, checks, officialRequests: 0 }, null, 2));
}
