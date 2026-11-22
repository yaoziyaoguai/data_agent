import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { harness } from "./harness.mjs";

const slowRequested = Promise.withResolvers();
const releaseSlow = Promise.withResolvers();
const firstNotify = Promise.withResolvers();
const releaseNotify = Promise.withResolvers();
const resync = Promise.withResolvers();
let delayAlice = false;
let waitingForCatalog = 0;
const platform = createServer(async (request, response) => {
  assert.equal(request.url, "/catalog-access");
  let body = "";
  for await (const part of request) body += part;
  const { user_id, space_id } = JSON.parse(body);
  if (delayAlice && user_id === "alice") {
    if (++waitingForCatalog === 16) slowRequested.resolve();
    await releaseSlow.promise;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    user_id, space_id, namespace: "synthetic", table_ids: [],
    legacy_table_names: [], complete_access: true,
  }));
});
platform.listen(0, "127.0.0.1");
await once(platform, "listening");
const sink = createServer(async (request, response) => {
  assert.equal(request.url, "/internal/live-changes");
  let body = "";
  for await (const part of request) body += part;
  const changes = JSON.parse(body);
  if (changes.some(change => change.kind === "resync")) {
    response.writeHead(204).end();
    resync.resolve();
  } else {
    firstNotify.resolve(changes);
    await releaseNotify.promise;
    response.writeHead(204).end();
  }
});
sink.listen(0, "127.0.0.1");
await once(sink, "listening");
const streams = new AbortController();
let h;
let worker;
const bounded = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 1800);
    })]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  h = await harness({
    deliveryDispatch: async () => {}, startWorker: false,
    env: { DATA_AGENT_PLATFORM_URL: "http://127.0.0.1:" + platform.address().port },
  });
  const subscribe = async (cid, user) => {
    const response = await fetch(h.env.DATA_AGENT_API_URL + "/conversations/" + cid + "/events?view=workbench", {
      headers: { authorization: "Bearer " + h.tokens[user] },
      signal: streams.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (matches) => {
      for (;;) {
        const end = received.indexOf("\n\n");
        if (end !== -1) {
          const frame = received.slice(0, end);
          received = received.slice(end + 2);
          if (matches(frame)) return;
          continue;
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, "事件流提前结束");
        received += decoder.decode(value, { stream: true });
      }
    };
    await bounded(readUntil(frame => frame.includes("event: workbench_state")), "订阅未收到初始状态");
    return readUntil;
  };

  const alices = await Promise.all(Array.from({length:16}, () => h.create("alice")));
  const alice = alices[0];
  const bob = await h.create("bob");
  await Promise.all(alices.map(cid => subscribe(cid, "alice")));
  const readBob = await subscribe(bob, "bob");
  delayAlice = true;
  await h.send(alice, "合成等待权限投影", "alice");
  const fanout = await fetch(h.env.DATA_AGENT_API_URL + "/internal/live-changes", {
    method: "POST", headers: {"content-type": "application/json", authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN},
    body: JSON.stringify(alices.slice(1).map(conversation_id => ({kind:"activity",conversation_id}))),
  });
  assert.equal(fanout.status,204);
  await bounded(slowRequested.promise, "16 个同时等待的平台权限请求未到达");
  await h.send(bob, "合成独立对话实时消息", "bob");
  await bounded(readBob(frame => frame.includes("合成独立对话实时消息")), "Alice 的平台请求阻塞了 Bob 的事件流");
  await bounded(readBob(frame => {
    if (!frame.includes("event: workbench_state")) return false;
    const state = JSON.parse(frame.split("\n").find(line => line.startsWith("data: ")).slice(6));
    assert.ok(Array.isArray(state.tasks) && Array.isArray(state.runs));
    return true;
  }), "Alice 的平台请求阻塞了 Bob 的新工作台状态");
  assert.equal((await bounded(h.request("/conversations"), "历史列表等待了平台权限")).status, 200);
  releaseSlow.resolve();
  worker = spawn("target/debug/data-agent-worker", [], {
    env: { ...h.env, DATA_AGENT_DELIVERY_CONCURRENCY: "1",
      DATA_AGENT_API_URL: "http://127.0.0.1:" + sink.address().port },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const exited = once(worker, "exit");
  const delivery = await bounded(firstNotify.promise, "Worker 未发出已提交的派发通知");
  assert.ok(delivery.some(change => change.kind === "run"));
  worker.kill("SIGTERM");
  await bounded(resync.promise, "Worker 停机丢失了正在发送的通知");
  assert.deepEqual(await bounded(exited, "Worker 未在通知收尾后退出"), [0, null]);
  await h.restartApi();
  assert.match(h.logs.find(log => log.name === "api").output, /exited code=0 signal=null/);
  assert.ok((await h.request("/conversations", undefined, "bob")).value.conversations.some(entry => entry.id === bob));
  console.log(JSON.stringify({ passed: true, independentConversations: alices.length + 1, projectedWhileBusy: 1,
    shutdownResync: 1, apiStoppedWithLiveSubscriptions: true, officialRequests: 0 }));
} finally {
  releaseSlow.resolve();
  releaseNotify.resolve();
  streams.abort();
  if (worker?.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, "exit");
    worker.kill("SIGTERM");
    await exited;
  }
  if (h) await h.close();
  platform.close();
  platform.closeAllConnections();
  sink.close();
  sink.closeAllConnections();
}
