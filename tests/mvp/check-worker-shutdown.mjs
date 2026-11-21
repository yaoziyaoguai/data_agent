import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { harness, until } from "./harness.mjs";

const h = await harness({ startWorker: false });
let holder;
try {
  const db = new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
  assert.match(db, /^data_agent_test_[a-f0-9]+$/);
  const expired = "e".repeat(64), revoked = "b".repeat(64), active = "c".repeat(64);
  h.sql(`INSERT INTO user_sessions(id,user_id,space_id,expires_at,revoked_at) VALUES
    ('${expired}','alice','demo',TIMESTAMPADD(DAY,-1,UTC_TIMESTAMP(3)),NULL),
    ('${revoked}','alice','demo',TIMESTAMPADD(DAY,1,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3)),
    ('${active}','alice','demo',TIMESTAMPADD(DAY,1,UTC_TIMESTAMP(3)),NULL)`);
  const indexes = h.sql(`SELECT JSON_OBJECT('index',INDEX_NAME,'columns',GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX))
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_sessions'
    GROUP BY INDEX_NAME`);
  assert.ok(indexes.some(value => value.index === "sessions_by_owner" && value.columns === "space_id,user_id"));
  assert.ok(indexes.some(value => value.index === "sessions_by_expiration" && value.columns === "expires_at"));

  const container = execFileSync("docker", ["--context", "colima-data-agent", "ps",
    "--filter", "label=com.docker.compose.project=data-agent",
    "--filter", "label=com.docker.compose.service=mysql", "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
  assert.match(container, /^[a-f0-9]+$/);
  holder = spawn("docker", ["--context", "colima-data-agent", "exec", "-i", container, "mysql",
    "--defaults-extra-file=/run/secrets/mysql_root_client", "--batch", "--unbuffered", "--skip-column-names"]);
  let output = "";
  holder.stdout.on("data", chunk => { output += chunk; });
  holder.stdin.write(`USE ${db}; START TRANSACTION; SELECT 'held' FROM user_sessions WHERE id='${expired}' FOR UPDATE;\n`);
  await until(() => output.includes("held"), "隔离会话行已锁");
  await h.resumeWorker();
  await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM performance_schema.data_lock_waits w
    JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
    WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='user_sessions'`)[0].n > 0,
    "Worker 已进入清理事务");
  const log = () => h.logs.filter(item => item.name === "worker-resumed").map(item => item.output).join("\n");
  let stopped = false;
  const stopping = h.pauseWorker().then(() => { stopped = true; });
  await until(() => log().includes("worker_shutdown_requested"), "SIGTERM 到达");
  assert.equal(stopped, false, "在途清理未结束时仍在等待");
  const released = once(holder, "exit");
  holder.stdin.end("COMMIT;\n");
  assert.equal((await released)[0], 0);
  await stopping;
  const names = ["source_sync", "prefill", "source_preparation", "source_fanout", "knowledge_index",
    "personal_memory", "query", "session_cleanup"];
  for (const name of names) assert.match(log(), new RegExp("worker_background_stopped name=" + name + "\\b"));
  assert.match(log(), /exited code=0 signal=null/);
  assert.deepEqual(h.sql("SELECT JSON_QUOTE(id) FROM user_sessions"), [active]);
  console.log(JSON.stringify({ passed: true, stopped: names, expiredAndRevokedRemoved: 2, liveSessionPreserved: true, officialRequests: 0 }));
} finally {
  if (holder && holder.exitCode === null) holder.stdin.end("ROLLBACK;\n");
  await h.close();
}
