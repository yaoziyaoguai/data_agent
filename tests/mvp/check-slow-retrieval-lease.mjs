import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { harness, until } from "./harness.mjs";

// 本地协议模型只选择工具；API、Pi bridge、Worker 和 MySQL 均走实际进程。
// 延迟位于锁外检索完成之后，停用反例验证的是提交重核，而非重新搜索过滤。
const retrievalDelayMs = 8000;
const leaseMs = 2400;
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 65536,
  output_limit: 2048,
  trial_call_limit: 24,
  trial_cost_micros: "300000",
  request_call_limit: 24,
  toolset: "data",
  payload_bytes_limit: 131072,
};
const checks = [];
const observations = [];
let active, providerFailure, calls = 0, h, passed = false;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-protocol-key");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    assert.ok(active, "请求必须属于已登记的合成场景");
    const position = active.requests++;
    let delta;
    if (position === 0) {
      delta = tool("update_analysis_task", {
        action: "route", task_id: null, expected_version: null, goal: "", options: [],
      });
    } else if (position === 1) {
      active.searchStartedAt = Date.now();
      delta = tool("search_knowledge", { query: active.query, kinds: [active.kind], limit: active.change === "dependency_source" ? 1 : 10 });
    } else {
      assert.equal(position, 2, "不允许计划外重试或重建任务掩盖失败");
      const last = body.messages.findLast((message) => message.role === "tool");
      assert.ok(last, "模型必须收到真实搜索工具回执");
      active.visibleResult = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      active.searchElapsedMs = Date.now() - active.searchStartedAt;
      if (active.change !== "none") {
        assert.match(active.visibleResult, /stale_knowledge/);
        assert.ok(!active.visibleResult.includes(active.marker), "拒绝回执不得混入已停用正文");
        delta = { role: "assistant", content: "检索期间资料已发生变化，本次未采用过期内容。" };
      } else {
        const result = JSON.parse(active.visibleResult);
        assert.ok(!result.error, active.visibleResult);
        assert.ok(result.hits.some((hit) => hit.ref?.object_id === active.document.id));
        assert.ok(active.visibleResult.includes(active.marker), "正常搜索必须实际交付命中文档正文");
        delta = { role: "assistant", content: "合成资料检索完成，当前资料有效。" };
      }
    }
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify({
      id: "synthetic-slow-retrieval", choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }],
    }) + "\n\n");
    response.write("data: " + JSON.stringify({
      id: "synthetic-slow-retrieval", choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
    }) + "\n\n");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    providerFailure = error;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "synthetic_protocol_assertion_failed" } }));
  }
});

function tool(name, args) {
  return { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
    function: { name, arguments: JSON.stringify(args) } }] };
}
function ok(response) {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
}

await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
try {
  h = await harness({
    capture: false,
    profile,
    protocolProviderUrl: "http://127.0.0.1:" + provider.address().port,
    env: {
      DATA_AGENT_LEASE_MS: String(leaseMs),
      DATA_AGENT_TEST_RETRIEVAL_DELAY_MS: String(retrievalDelayMs),
    },
  });
  for (const change of ["none", "disable", "dependency_source"]) {
    const query = "synthetic_retrieval_" + randomUUID().replaceAll("-", "");
    const marker = "完全合成的检索正文_" + randomUUID();
    const kind = change === "dependency_source" ? "relationship" : "document";
    let document = ok(await h.request("/knowledge", {
      operation_id: randomUUID(), kind, name: query,
      body: query + "：" + marker, related_ids: [], source_url: null,
    }));
    let source;
    if (change === "dependency_source") {
      const left = ok(await h.request("/knowledge/table-raw_order_lines"));
      const right = ok(await h.request("/knowledge/table-raw_payments"));
      source = left.source_id;
      assert.ok(source, "反例依赖必须有真实持久的来源头");
      document = ok(await h.request("/knowledge/" + document.id, {
        operation_id: randomUUID(), expected_version: document.version, entry_id: "body",
        value: query + "：" + marker,
        structured_value: {
          kind: "relationship", left_table: { object_id: left.id, version: left.version },
          right_table: { object_id: right.id, version: right.version },
          join_keys: [{ left_column: "order_id", right_column: "order_id" }, { left_column: "line_id", right_column: "line_id" }],
          cardinality: "one_to_many", scope: "合成付款事件",
        },
      }, "alice", "PATCH"));
    }
    const cid = await h.create();
    active = { change, kind, query, marker, document, requests: 0 };
    const message = await h.send(cid, "检索合成文档 " + query);
    const registered = await until(() => {
      if (providerFailure) throw providerFailure;
      return h.sql(`SELECT JSON_OBJECT('operation_id',t.operation_id,'run_id',t.origin_run_id,'state',t.state,
        'conversation_remaining_ms',TIMESTAMPDIFF(MICROSECOND,UTC_TIMESTAMP(3),c.lease_until)/1000,
        'job_remaining_ms',TIMESTAMPDIFF(MICROSECOND,UTC_TIMESTAMP(3),j.lease_until)/1000)
        FROM tool_calls t JOIN conversations c ON c.id=t.conversation_id
        JOIN agent_runs r ON r.id=t.origin_run_id JOIN background_jobs j ON j.id=r.job_id
        WHERE t.conversation_id='${cid}' AND t.tool_name='search_knowledge'`)[0];
    }, "search tool registered");
    observations.push({ phase: "search_registered", ...registered });
    assert.equal(registered.state, "registered");
    await until(() => h.logs.some((log) => log.name === "api"
      && log.output.includes("test_retrieval_stage_ready run=" + registered.run_id)),
    "lock-free retrieval stage ready");
    // h.sql 每次启动独立的 mysql 客户端；FOR UPDATE 成功既证明行存在，也证明未被慢检索持锁。
    // 设置一秒锁等待，持锁错误会使客户端非零退出，不能把超时或空结果当作通过。
    const probe = () => {
      const started = Date.now();
      const rows = h.sql(`SET SESSION innodb_lock_wait_timeout=1; START TRANSACTION;
        SELECT JSON_OBJECT('id',id,'epoch',lease_epoch,'owner',lease_owner,
          'expires_ms',CAST(UNIX_TIMESTAMP(lease_until)*1000 AS UNSIGNED),
          'remaining_ms',TIMESTAMPDIFF(MICROSECOND,UTC_TIMESTAMP(3),lease_until)/1000)
        FROM conversations WHERE id='${cid}' FOR UPDATE; COMMIT;`);
      observations.push({ phase: "conversation_lock_probe", rows, elapsedMs: Date.now() - started });
      assert.equal(rows.length, 1, "探针必须锁到实际存在的会话行");
      assert.equal(rows[0].id, cid);
      assert.equal(rows[0].owner, registered.run_id);
      assert.ok(rows[0].remaining_ms > 0, "检索期间租约仍然有效");
      return { ...rows[0], elapsedMs: Date.now() - started };
    };
    await delay(500);
    const before = probe();
    await delay(leaseMs + 700);
    const after = probe();
    assert.equal(after.epoch, before.epoch, "续租应保持原代次，不靠失败重派完成");
    assert.ok(after.expires_ms > before.expires_ms + leaseMs / 2, "超过TTL后租约到期时间必须推进");
    const pending = h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt)
      FROM tool_calls WHERE operation_id='${registered.operation_id}'`)[0];
    assert.equal(pending.state, "registered", "探针及停用必须发生在搜索回执提交前");
    assert.equal(pending.receipt, null);
    if (change === "disable") {
      ok(await h.request("/knowledge/" + document.id + "/disable", {
        operation_id: randomUUID(), expected_version: document.version,
      }));
    } else if (change === "dependency_source") {
      // 模拟已提交原文的新修订、知识尚未重整理的窗口；知识版本保持不变。
      assert.match(source, /^[\w-]+$/);
      h.sql(`INSERT INTO source_revisions(source_id,version,body)
        SELECT s.source_id,s.version+1,CONCAT(s.body,'\\n合成来源的新说明')
        FROM (SELECT source_id,version,body,archive_complete AS complete FROM source_revisions WHERE body IS NOT NULL) s JOIN source_heads h ON h.id=s.source_id AND h.version=s.version
        WHERE h.id='${source}'; UPDATE source_heads SET version=version+1 WHERE id='${source}';`);
    }
    const snapshot = await until(async () => {
      if (providerFailure) throw providerFailure;
      const value = await h.snapshot(cid);
      assert.ok(!value.events.some((event) => event.type === "run_failed"), "搜索不能因租约失效而失败");
      return value.runs.some((run) => run.state === "finished") && value;
    }, "slow search completes with renewed lease", 25000);
    assert.equal(active.requests, 3);
    assert.ok(active.searchElapsedMs >= retrievalDelayMs, "真实工具调用必须覆盖注入的慢读取时段");
    assert.ok(active.searchElapsedMs > leaseMs);
    const runs = h.sql(`SELECT JSON_OBJECT('id',id,'state',state,'epoch',lease_epoch)
      FROM agent_runs WHERE message_id='${message.message_id}'`);
    assert.equal(runs.length, 1, "不得用新run或换代重做慢搜索");
    assert.equal(runs[0].id, registered.run_id);
    assert.equal(runs[0].state, "finished");
    assert.equal(runs[0].epoch, before.epoch);
    const receipts = h.sql(`SELECT JSON_OBJECT('tool_name',tool_name,'state',state,'receipt',receipt)
      FROM tool_calls WHERE conversation_id='${cid}'`);
    assert.equal(receipts.length, 2, "登记归属和搜索各一次，不重复业务操作");
    const search = receipts.find((receipt) => receipt.tool_name === "search_knowledge");
    assert.equal(search.state, change !== "none" ? "rejected" : "succeeded");
    if (change !== "none") {
      assert.equal(search.receipt.data.error, "stale_knowledge");
      assert.ok(!JSON.stringify(search.receipt).includes(marker));
      assert.ok(!JSON.stringify(snapshot.messages).includes(marker));
    } else {
      assert.ok(search.receipt.data.hits.some((hit) => hit.ref?.object_id === document.id));
    }
    checks.push({
      name: change === "dependency_source" ? "结构依赖的原始来源改版也在检索提交前拒绝" : change === "disable" ? "提交前停用资料明确拒绝且不混正文" : "慢检索期间会话行可锁且Worker持续续租",
      passed: true, searchElapsedMs: active.searchElapsedMs,
      probeElapsedMs: [before.elapsedMs, after.elapsedMs], leaseRenewedMs: after.expires_ms - before.expires_ms,
      runCount: runs.length, toolCount: receipts.length,
    });
  }
  assert.equal(calls, 9);
  passed = true;
  console.log(JSON.stringify({ passed, checks, calls, leaseMs, retrievalDelayMs, officialRequests: 0 }));
} finally {
  if (h) await h.close();
  await new Promise((resolve) => provider.close(resolve));
  if (h) await writeFile(".local/checks/mvp-slow-retrieval-lease.json", JSON.stringify({
    passed, checks, calls, leaseMs, retrievalDelayMs, officialRequests: 0,
    observations,
    serviceLogs: h.directory + "/service-logs.json",
  }, null, 2));
}
