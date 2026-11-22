import assert from "node:assert/strict";
import { chromium } from "playwright";
import { harness } from "./harness.mjs";

const h = await harness({ capture: true, web: true, startWorker: false, env: { DATA_AGENT_LEASE_MS: "120000" } });
const browser = await chromium.launch();
try {
  const cid = await h.create();
  const login = await fetch(h.env.DATA_AGENT_API_URL + "/session", {
    method: "POST", headers: { authorization: "Bearer " + h.tokens.alice },
  });
  assert.equal(login.status, 200);
  const cookie = /^data_agent_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1];
  const pages = [];
  let snapshots = 0, queryLists = 0;
  // 本机 Vite 用 HTTP/1.1。同源六连接是浏览器上限，压测用 20 个独立客户端。
  for (let i = 0; i < 20; i++) {
    const context = await browser.newContext();
    await context.addCookies([{ name: "data_agent_session", value: cookie, url: h.url }]);
    await context.addInitScript(({ cid }) => {
      localStorage.setItem("data-agent.conversation." + JSON.stringify(["demo", "alice"]), cid);
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener("workbench_state", () => { window.workbenchEventsReady = true; });
        }
      };
    }, { cid });
    context.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/snapshot")) snapshots++;
      if (path.endsWith("/conversations/" + cid + "/queries")) queryLists++;
    });
    const page = await context.newPage();
    await page.goto(h.url + "/#workbench", { waitUntil: "domcontentloaded" });
    pages.push(page);
  }
  await Promise.all(pages.map(page => page.waitForFunction(() => window.workbenchEventsReady, undefined, { timeout: 45000 })));
  const initialReads = () => Number(h.sql(`SELECT JSON_OBJECT('count',COALESCE(SUM(p.COUNT_EXECUTE),0))
    FROM performance_schema.prepared_statements_instances p
    JOIN performance_schema.threads t ON t.THREAD_ID=p.OWNER_THREAD_ID
    WHERE t.PROCESSLIST_DB=DATABASE() AND p.SQL_TEXT LIKE 'SELECT %'
      AND (p.SQL_TEXT LIKE '%conversation_events%' OR p.SQL_TEXT LIKE '%user_sessions%')`)[0].count);
  const before = initialReads();
  assert.ok(before > 0, "捕获到实际建连鉴权与历史查询，避免空统计");
  await new Promise(resolve => setTimeout(resolve, 60000));
  const idleSql = initialReads() - before;
  assert.equal(idleSql, 0, "20 个空闲标签页不读事件表或登录会话表");

  await h.resumeWorker();
  const run = await h.capture(cid, "合成逐帧交付");
  await h.pauseWorker();
  const initialSnapshots = snapshots, initialQueryLists = queryLists;
  for (let i = 1; i <= 50; i++) {
    const result = await h.internal("/internal/outputs", {
      run_id: run.run_id, lease_epoch: run.lease_epoch, chunk_seq: String(i),
      text: "[" + i + "]",
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
  }
  const expected = Array.from({ length: 50 }, (_, i) => "[" + (i + 1) + "]").join("");
  await Promise.all(pages.map(page => page.getByText(expected, { exact: true }).waitFor()));
  assert.equal(snapshots - initialSnapshots, 0, "50 帧均直接合并，无快照刷新");
  assert.equal(queryLists - initialQueryLists, 0, "50 帧无 HTTP 查询列表刷新");
  // 模拟队列只交付补读信号，鉴权结果仍来自正式的会话读回。
  h.sql("UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id='alice'");
  const rejected = pages[0].waitForResponse(response => new URL(response.url()).pathname.endsWith("/snapshot") && response.status() === 401);
  const resync = await fetch(h.env.DATA_AGENT_API_URL + "/internal/live-changes", {
    method: "POST",
    headers: { authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify([{ kind: "resync" }]),
  });
  assert.equal(resync.status, 204);
  await rejected;
  await pages[0].getByText(expected, { exact: true }).waitFor({ state: "hidden" });
  console.log(JSON.stringify({ passed: true, browserClients: 20, idleSeconds: 60, idleSql, frames: 50, snapshotRefreshes: 0, queryListRefreshes: 0, revokedReplayCleared: true, officialRequests: 0 }));
} finally {
  await browser.close();
  await h.close();
}
