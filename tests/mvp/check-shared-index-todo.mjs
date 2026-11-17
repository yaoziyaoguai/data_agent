import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { harness, until } from "./harness.mjs";
import { embeddingProvider } from "./embedding-provider.mjs";

// 公共索引待办的登记与统一消费：平台与文档同ID为独立目标、新登记不进旧队列、
// 统一消费者完成切块/向量写入/投影进度并让原文通道可召回。
const targets = ["source_index_registration", "raw_index_handover", "index_recovery"];
const target = process.argv.find(value => value.startsWith("--target="))?.slice(9);
const filter = process.argv.find(value => value.startsWith("--filter="))?.slice(9);
if (target) assert.ok(targets.includes(target), "未知测试target");
if (filter) {
  assert.ok(target, "精确filter必须指定target");
  assert.match(filter, /^[a-z0-9_]+$/);
}
for (const argument of process.argv.slice(2)) {
  assert.ok(argument === "--target=" + target || argument === "--filter=" + filter, "未知参数：" + argument);
}
const provider = await embeddingProvider();
const collection = "data_agent_test_" + randomUUID().replaceAll("-", "");
const token = (await readFile(".local/infra/milvus-root-password", "utf8")).trim();
let queries = 0;
const proxy = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const response = await fetch("http://127.0.0.1:19531" + req.url, {
      method: "POST", headers: { "content-type": "application/json", authorization: req.headers.authorization }, body,
    });
    const result = await response.text();
    res.writeHead(response.status, { "content-type": "application/json" }).end(result);
    if (req.url.endsWith("/search") || req.url.endsWith("/query")) queries++;
  } catch { res.writeHead(503).end(); }
});
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));

// 只延迟真实知识轮询响应；其快照已产生后再经正式HTTP提交新文档。
// 后续领取、来源头、Embedding和Milvus均透传，不能制造数据库结果。
const sockets = new Set(), databaseEvents = [], proxyErrors = [];
let armed = false, held = false, releasePoll, pollReady;
const pollHeld = new Promise(resolve => { pollReady = resolve; });
const frames = observe => {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUIntLE(0, 3) + 4;
      if (pending.length < size) break;
      const frame = pending.subarray(0, size);
      pending = pending.subarray(size);
      observe(frame, frame.subarray(4));
    }
  };
};
const sqlProxy = net.createServer(socket => {
  const upstream = net.connect(13306, "127.0.0.1");
  for (const connection of [socket, upstream]) {
    sockets.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => sockets.delete(connection));
  }
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  const statements = new Map(), buffered = [];
  let authenticated = false, hello = false, preparing, current, buffering = false;
  const classify = sql => sql.startsWith("SELECT DISTINCT k.id FROM knowledge_objects k JOIN knowledge_index_jobs j") ? "knowledge-poll"
    : sql.startsWith("SELECT source_kind,object_id,version,state,vector_state,vector_attempts,vector_target,lease_epoch") ? "raw-claim"
    : sql.startsWith("SELECT space_id,version FROM knowledge_objects WHERE id=? AND state='enabled'") ? "source-head" : null;
  const client = frames((frame, payload) => {
    if (!authenticated) { hello = true; upstream.write(frame); return; }
    if (payload[0] === 0x16) { preparing = classify(payload.subarray(1).toString()); current = null; }
    else if (payload[0] === 0x19) statements.delete(payload.readUInt32LE(1));
    else if (payload[0] === 0x17 || payload[0] === 0x03) {
      current = payload[0] === 0x17 ? statements.get(payload.readUInt32LE(1)) : classify(payload.subarray(1).toString());
      if (current && armed) databaseEvents.push({ kind: current, stage: "requested", at: Date.now() });
      if (armed && !held && current === "knowledge-poll") buffering = true;
    }
    upstream.write(frame);
  });
  const server = frames((frame, payload) => {
    if (!authenticated) { if (hello && payload[0] === 0) authenticated = true; socket.write(frame); return; }
    if (preparing && frame[3] === 1) {
      if (payload[0] === 0) statements.set(payload.readUInt32LE(1), preparing);
      preparing = null;
    }
    if (buffering) {
      buffered.push(frame);
      if (!held) {
        held = true;
        databaseEvents.push({ kind: current, stage: "actual-response-held", at: Date.now() });
        releasePoll = () => {
          if (!buffering) return;
          buffering = false;
          for (const value of buffered) socket.write(value);
          buffered.length = 0;
          databaseEvents.push({ kind: "knowledge-poll", stage: "released", at: Date.now() });
        };
        pollReady();
      }
    } else socket.write(frame);
  });
  socket.on("data", chunk => {
    try { client(chunk); } catch (error) { proxyErrors.push(error.message); socket.destroy(); upstream.destroy(); }
  });
  upstream.on("data", chunk => {
    try { server(chunk); } catch (error) { proxyErrors.push(error.message); socket.destroy(); upstream.destroy(); }
  });
});
await new Promise(resolve => sqlProxy.listen(0, "127.0.0.1", resolve));
let h;
try {
  h = await harness({ startWorker: false, onDatabaseUrl: value => {
    const url = new URL(value);
    url.port = String(sqlProxy.address().port);
    url.searchParams.set("ssl-mode", "DISABLED");
    return url.toString();
  }, env: {
    ...provider.env,
    DATA_AGENT_VECTOR_URL: "http://127.0.0.1:" + proxy.address().port,
    DATA_AGENT_VECTOR_COLLECTION: collection,
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + "/.local/infra/milvus-root-password",
  } });
  const prepared = await h.request("/knowledge-index/rebuilds", { operation_id: randomUUID() });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  for (const selected of target ? [target] : targets) {
    let output = "";
    const result = await new Promise((resolve, reject) => {
      const child = spawn(homedir() + "/.cargo/bin/cargo", ["test", "--offline", "--locked", "-p", "data-agent", "--test", selected,
        ...(filter ? [filter] : []), "--", ...(filter ? ["--exact"] : []), "--test-threads=1", "--nocapture"], { env: h.env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
      child.stderr.on("data", chunk => { output += chunk; process.stderr.write(chunk); });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    console.log(JSON.stringify({ target: selected, filter, ...result }));
    if (result.code !== 0) process.exitCode = result.code ?? 1;
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.match(output, /test result: ok\. [1-9]\d* passed; 0 failed/);
    assert.doesNotMatch(output, /running 0 tests/);
  }
  if (!target) {
  assert.ok(queries > 0, "子测试期间完成真实Milvus检索");
  const database = h.sql("SELECT JSON_OBJECT('isolation',@@transaction_isolation,'version',VERSION())")[0];
  assert.equal(database.isolation, "REPEATABLE-READ");
  await h.resumeWorker();
  await until(() => h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE vector_state IN ('pending','sending','unknown')")[0].n === 0, "初始索引待办完成", 60000);
  armed = true;
  let timer;
  try {
    await Promise.race([pollHeld, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("未观察到真实知识轮询响应")), 10000);
    })]);
  } finally { clearTimeout(timer); }
  const body = "开头说明。" + Array.from({ length: 400 }, (_, i) => "第" + i + "行常规填充内容，用于把标记推到原文末尾。").join("") + "末尾专有标记：尾部锚点漂移校准专用词。";
  const saved = await h.request("/knowledge", {
    operation_id: randomUUID(), kind: "document", name: "long_tail_marker", body, source_url: null, related_ids: [],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const document = saved.value;
  databaseEvents.push({ kind: "document", stage: "committed", at: Date.now() });
  assert.ok(databaseEvents.findIndex(event => event.stage === "actual-response-held") < databaseEvents.length - 1);
  releasePoll();
  const jobs = () => h.sql(`SELECT JSON_OBJECT('kind',target_kind,'state',vector_state,'attempts',vector_attempts,'error',vector_error,'receipt',vector_receipt) FROM knowledge_index_jobs WHERE object_id='${document.id}' ORDER BY target_kind`);
  await until(() => {
    const state = jobs();
    return state.length === 2 && state.every(row => !["pending", "sending", "unknown"].includes(row.state));
  }, "并发保存文档的两个索引目标完成", 30000);
  const state = jobs();
  console.log(JSON.stringify({ stage: "concurrent-source-index", database, jobs: state, events: databaseEvents, proxyErrors, officialRequests: 0 }));
  assert.deepEqual(proxyErrors, []);
  assert.equal(state.find(row => row.kind === "knowledge_entry").state, "indexed");
  assert.equal(state.find(row => row.kind === "source_excerpt").state, "indexed", "旧知识轮询快照不得把随后提交的新文档原文退役");
  assert.ok(state.every(row => row.attempts === 1 && row.error === null), "正常新文档只领取一次、不靠重试修补误退役");
  const claimed = databaseEvents.findIndex(event => event.kind === "raw-claim");
  const sourceHead = databaseEvents.findIndex(event => event.kind === "source-head");
  assert.ok(claimed > databaseEvents.findIndex(event => event.kind === "document") && sourceHead > claimed);
  const projection = h.sql(`SELECT JSON_OBJECT('revision',revision,'position',applied_position,'complete',complete) FROM retrieval_source_projections WHERE source_kind='document' AND source_id='${document.id}'`);
  assert.deepEqual(projection, [{ revision: 1, position: [...body].length, complete: 1 }]);
  const response = await fetch("http://127.0.0.1:19531/v2/vectordb/entities/query", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer root:" + token },
    body: JSON.stringify({ dbName: "default", collectionName: collection, filter: `kind == "source_excerpt" && object_id == "${document.id}"`, outputFields: ["id", "char_offset", "char_length", "text"], limit: 64, consistencyLevel: "Strong" }),
  });
  const indexed = await response.json();
  assert.equal(indexed.code, 0, JSON.stringify(indexed));
  assert.ok(indexed.data.some(row => row.text.includes("尾部锚点漂移校准")), "真实原文尾段必须可见");
  assert.equal(Math.max(...indexed.data.map(row => Number(row.char_offset) + Number(row.char_length))), [...body].length);
  await h.pauseWorker();
  armed = false;
  console.log(JSON.stringify({ passed: true, officialRequests: 0, checks: [
    "平台/文档同ID是两个独立索引目标；新登记不再进入旧raw队列",
    "统一消费者完成文档原文切块、向量写入、投影进度与尾部覆盖，原文通道可召回",
    "旧raw积压有界移交：事务中断无双领取记录、重复移交幂等、有效租约不抢、移交后可领取",
    "知识轮询后并发提交的新文档原文不误退役，一次领取后完整尾部可见",
  ] }));
  }
} finally {
  releasePoll?.();
  await h?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => sqlProxy.close(resolve));
  const response = await fetch("http://127.0.0.1:19531/v2/vectordb/collections/drop", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer root:" + token },
    body: JSON.stringify({ dbName: "default", collectionName: collection }),
  });
  assert.equal((await response.json()).code, 0);
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  await provider.close();
}
