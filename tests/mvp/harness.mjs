import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import net from "node:net";
import { createDeliveryServer } from "../../apps/agent/transport/server.ts";
export async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new Error("timeout: " + label);
}
// 事件流是持续SSE：读完重放批次（收到数据后静默1.2秒）即取消连接，不能等正文结束。
// 只用于已结束的会话重放；调用方断言的是历史事件的取舍，不依赖后续新增事件。
export async function replayEvents(url, headers) {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 8000;
  let text = "";
  let pending = reader.read();
  try {
    while (Date.now() < deadline) {
      const quietFor = text ? 1200 : 3000;
      const timer = new Promise((resolve) => setTimeout(resolve, quietFor, "quiet"));
      const won = await Promise.race([pending, timer]);
      if (won === "quiet" || won.done) break;
      text += decoder.decode(won.value);
      pending = reader.read();
    }
  } finally {
    await reader.cancel();
  }
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
export async function harness(options = {}) {
  const root = process.cwd();
  const name = randomBytes(8).toString("hex");
  const database = options.database ?? "data_agent_test_" + name;
  assert.match(database,/^data_agent_(test|trial)_[a-f0-9]+$/);
  const container = execFileSync(
    "docker",
    [
      "--context",
      "colima-data-agent",
      "ps",
      "--filter",
      "label=com.docker.compose.project=data-agent",
      "--filter",
      "label=com.docker.compose.service=mysql",
      "--format",
      "{{.ID}}",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.match(container, /^[a-f0-9]+$/);
  const raw = (q) =>
    execFileSync(
      "docker",
      [
        "--context",
        "colima-data-agent",
        "exec",
        "-i",
        container,
        "mysql",
        "--defaults-extra-file=/run/secrets/mysql_root_client",
        "--batch",
        "--raw",
        "--default-character-set=utf8mb4",
        "--skip-column-names",
      ],
      { input: q, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  raw(
    "CREATE DATABASE " + (options.keep ? "IF NOT EXISTS " : "") +
      database +
      ";GRANT ALL ON " +
      database +
      ".* TO data_agent;",
  );
  const sql = (q) => {
    const r = raw("USE " + database + ";" + q);
    return r ? r.split("\n").map((s) => JSON.parse(s)) : [];
  };
  const apiPort = await freePort(),
    bridgePort = await freePort(),
    platformPort = await freePort(),
    webPort = await freePort();
  const tokens = {
    carol: randomBytes(32).toString("hex"),
    alice: randomBytes(32).toString("hex"),
    bob: randomBytes(32).toString("hex"),
  };
  const internal = randomBytes(32).toString("hex");
  const password = (
    await readFile(root + "/.local/infra/mysql-app-password", "utf8")
  ).trim();
  const directory = root + "/.local/checks/mvp-" + name;
  await mkdir(directory, { recursive: true });
  const platformDirectory = options.platformDirectory ?? directory + "/platform";
  const sourceSyncWorkers = [];
  const env = {
    ...process.env,
    PI_OFFLINE: "1",
    DATA_AGENT_MODE: "development",
    DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY: options.sourceDirectory ?? root + "/docs/sources",
    DATA_AGENT_DEMO_PROFILE: options.sourceDirectory ? JSON.parse(await readFile(options.sourceDirectory + "/knowledge-manifest.json", "utf8")).demo_profile ?? "retail" : "retail",
    DATA_AGENT_TOOLSET: "data",
    DATA_AGENT_SEMANTIC_SUPER_MAINTAINERS: JSON.stringify({demo: ["alice"]}),
    DATA_AGENT_DIAGNOSTICS: "1",
    DATA_AGENT_MODEL_KEY_FILE: directory + "/model-configuration.key",
    DATA_AGENT_DATABASE_URL:
      "mysql://data_agent:" +
      encodeURIComponent(password) +
      "@127.0.0.1:13306/" +
      database,
    DATA_AGENT_DEV_IDENTITIES: JSON.stringify({
      [tokens.alice]: "alice",
      [tokens.carol]: "carol",
      [tokens.bob]: "bob",
    }),
    DATA_AGENT_INTERNAL_TOKEN: internal,
    DATA_AGENT_API_PORT: String(apiPort),
    DATA_AGENT_API_URL: "http://127.0.0.1:" + apiPort,
    DATA_AGENT_BRIDGE_PORT: String(bridgePort),
    DATA_AGENT_BRIDGE_URL: "http://127.0.0.1:" + bridgePort,
    DATA_AGENT_PLATFORM_URL: "http://127.0.0.1:" + platformPort,
    DATA_AGENT_QUERY_DELAY_SECONDS: "1",
    ...options.env,
  };
  if (options.onDatabaseUrl)
    env.DATA_AGENT_DATABASE_URL = options.onDatabaseUrl(env.DATA_AGENT_DATABASE_URL);
  if (options.sourceDirectory) {
    assert.ok(!options.platformSourceDirectory || options.platformSourceDirectory === options.sourceDirectory,
      'sourceDirectory必须同时指定API、预填Worker与平台的同一资料包');
    env.DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY = options.sourceDirectory;
  }
  for (const k of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "DATA_AGENT_MODEL_PROFILE",
    "DATA_AGENT_MODEL_FAULT",
    "DATA_AGENT_FAULT",
    "DATABASE_URL",
  ])
    delete env[k];
  if (options.profile)
    env.DATA_AGENT_MODEL_PROFILE = JSON.stringify(options.profile);
  if(options.protocolProviderUrl){
    const url=new URL(options.protocolProviderUrl);
    assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'');assert.equal(url.password,'');
    env.DATA_AGENT_PROVIDER_TEST='1';env.DEEPSEEK_API_KEY='synthetic-protocol-key';env.DEEPSEEK_BASE_URL=url.origin;env.DEEPSEEK_MODEL='deepseek-flash';
  }
  const children = [];
  const logs = [];
  const start = (name, cmd, args = [], overrides = {}) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env: {...env, ...overrides},
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const log = { name, output: "" };
    logs.push(log);
    child.stdout.on("data", (d) => (log.output += d));
    child.stderr.on("data", (d) => (log.output += d));
    child.on("exit", (code, signal) => {
      log.output += `\n[${name} exited code=${code} signal=${signal}]\n`;
    });
    return child;
  };
  const stop = async (child) => {
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
  };
  const health = async (port, path = "/health") =>
    until(async () => {
      try {
        return (await fetch("http://127.0.0.1:" + port + path)).ok;
      } catch {
        return false;
      }
    }, "service health " + port, options.startupTimeout ?? 60000);
  const request = async (
    path,
    body,
    user = "alice",
    method = body ? "POST" : "GET",
  ) => {
    const r = await fetch(env.DATA_AGENT_API_URL + path, {
      method,
      headers: {
        authorization: "Bearer " + tokens[user],
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  const snapshot = async (cid, user = "alice") => {
    const r = await request("/conversations/" + cid + "/snapshot", undefined, user);
    assert.equal(r.status, 200);
    return r.value;
  };
  const send = async (cid, text, user = "alice") => {
    const r = await request("/conversations/" + cid + "/messages", {
      client_message_id: randomUUID(),
      text,
    }, user);
    assert.equal(r.status, 200);
    return r.value;
  };
  const create = async (user = "alice") => {
    const r = await request(
      "/conversations",
      { operation_id: randomUUID() },
      user,
    );
    assert.equal(r.status, 200);
    return r.value.conversation_id;
  };
  const finished = async (cid, count = 1, user = "alice") =>
    until(async () => {
      const s = await snapshot(cid, user);
      if (s.events.some((e) => e.type === "run_failed"))
        throw new Error(
          "agent failed: " + logs.map((l) => l.output).join("\n"),
        );
      return s.runs.filter((r) => r.state === "finished").length >= count
        ? s
        : false;
    }, "Pi round " + count);
  let worker, bridge, platform, apiProcess;
  const captured = [];
  const captureAborted = [];
  const release = [];
  let closing;
  const close = () => closing ??= (async () => {
    try {
      await writeFile(directory + "/service-logs.json", JSON.stringify(logs, null, 2));
    } finally {
      for (const child of [...children].reverse()) await stop(child);
      release.forEach((r) => r());
      if (bridge) await new Promise((r) => bridge.close(r));
      if (!options.keep) raw("DROP DATABASE " + database);
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
    }
  })();
  // 测试被中断也清理本次资源；正常close与信号共用同一次收尾，不吞失败退出码。
  const interrupted = code => {
    void close().then(() => process.exit(code), error => {
      console.error("test_resource_cleanup_failed", error);
      process.exit(1);
    });
  };
  const terminate = () => interrupted(143);
  const interrupt = () => interrupted(130);
  process.once("SIGTERM", terminate);
  process.once("SIGINT", interrupt);
  try {
    platform = start("platform", "python3", [
      "apps/platform-mock/server.py",
      "--directory",
      platformDirectory,
      "--port",
      String(platformPort),
    ], options.platformSourceDirectory ? {DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY:options.platformSourceDirectory} : {});
    await health(platformPort);
    apiProcess = start("api", options.apiBinary ?? "target/debug/data-agent-api");
    await health(apiPort);
    if (options.capture || options.deliveryDispatch) {
      bridge = createDeliveryServer(
        env.DATA_AGENT_API_URL,
        internal,
        options.deliveryDispatch ?? (async (run, _apiUrl, _token, _fault, signal) => {
          const error = options.captureError?.(run);
          if (error) throw error;
          captured.push(run);
          // 替身沿用正式Pi的取消协议，否则被取消的旧run会一直占住同对话的bridge。
          await new Promise((resolve) => {
            const complete = () => {
              if (signal?.aborted && !captureAborted.includes(run.run_id))
                captureAborted.push(run.run_id);
              signal?.removeEventListener("abort", complete);
              resolve();
            };
            release.push(complete);
            if (signal?.aborted) complete();
            else signal?.addEventListener("abort", complete, { once: true });
          });
        }),
      );
      await new Promise((r) => bridge.listen(bridgePort, "127.0.0.1", r));
    } else {
      start("bridge", "node", ["apps/agent/server.ts"]);
    }
    await health(bridgePort);
    if (options.startWorker !== false)
      worker = start("worker", "target/debug/data-agent-worker");
    if (options.web) {
      start("web", "node", [
        "node_modules/vite/bin/vite.js",
        "apps/web",
        "--config",
        "apps/web/vite.config.ts",
        "--port",
        String(webPort),
      ]);
      await health(webPort, "/");
    }
  } catch (e) {
    await writeFile(directory + "/startup-failure.json", JSON.stringify(logs, null, 2));
    console.error("startup diagnostics:", directory + "/startup-failure.json");
    await close();
    throw e;
  }
  return {
    request,
    sql,
    snapshot,
    send,
    create,
    finished,
    env,
    tokens,
    logs,
    directory,
    captured,
    captureAborted,
    releaseRun(runId) {
      const index = captured.findIndex((r) => r.run_id === runId);
      if (index >= 0) release[index]?.();
    },
    async internal(path, body) {
      const r = await fetch(env.DATA_AGENT_API_URL + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + internal,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, value: await r.json() };
    },
    async capture(cid, text, waitMs = 20000) {
      const message = await send(cid, text);
      return until(
        () => captured.find((run) => run.conversation_id === cid && run.message_id === message.message_id),
        "captured input " + message.message_id,
        waitMs,
      );
    },
    url: "http://127.0.0.1:" + webPort,
    async pausePlatform() {
      await stop(platform);
    },
    async restartApi(binary = "target/debug/data-agent-api") {
      await stop(apiProcess);
      apiProcess = start("api-resumed", binary);
      await health(apiPort);
    },
    async resumePlatform() {
      platform = start("platform-resumed", "python3", [
        "apps/platform-mock/server.py",
        "--directory",
        platformDirectory,
        "--port",
        String(platformPort),
      ], options.platformSourceDirectory ? {DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY:options.platformSourceDirectory} : {});
      await health(platformPort);
    },
    async resumeSourceSyncWorker(count = 1) {
      assert.ok(Number.isInteger(count) && count >= 1 && count <= 2);
      while (sourceSyncWorkers.length < count) {
        sourceSyncWorkers.push(start("source-sync-worker-" + sourceSyncWorkers.length, "target/debug/data-agent-worker", [], {DATA_AGENT_TEST_WORKER_ROLE:"source_sync"}));
      }
    },
    async pauseWorker() {
      await stop(worker);
    },
    async resumeWorker() {
      if(worker && worker.exitCode===null && worker.signalCode===null)return;
      worker = start("worker-resumed", "target/debug/data-agent-worker");
    },
    close,
  };
}
