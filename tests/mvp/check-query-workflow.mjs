import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { harness, until } from "./harness.mjs";
const h = await harness();
const checks = [];
const check = (name) => checks.push({ name, passed: true });
try {
  const cid = await h.create();
  await h.send(cid, "查2026年1月净收入");
  await h.finished(cid);
  const list = async () => {
    const r = await h.request("/conversations/" + cid + "/queries");
    assert.equal(r.status, 200);
    return r.value;
  };
  let q = (await list()).queries[0];
  assert.equal(q.confirmation_state, "awaiting_confirmation");
  assert.equal(q.execution_state, "not_submitted");
  assert.match(q.sql, /paid_at/);
  assert.match(q.sql, /is_test = 0/);
  check("未确认不取数，SQL与口径来自合成语义");
  await h.pauseWorker();
  await h.send(cid, "仅看app渠道");
  assert.equal(
    (
      await h.request("/queries/" + q.id + "/confirm", {
        operation_id: randomUUID(),
        draft_version: q.draft_version,
        condition_version: q.condition_version,
      })
    ).value.code,
    "message_pending",
  );
  await h.resumeWorker();
  await h.finished(cid, 2);
  let qs = (await list()).queries;
  assert.equal(qs[0].confirmation_state, "superseded");
  q = qs[1];
  assert.equal(q.parameters.channel, "app");
  assert.equal(q.parameters.start, "2026-01-01T00:00:00Z");
  assert.equal(
    (
      await h.request("/queries/" + qs[0].id + "/confirm", {
        operation_id: randomUUID(),
        draft_version: qs[0].draft_version,
        condition_version: qs[0].condition_version,
      })
    ).status,
    409,
  );
  check("新消息暂缓确认，修订保留月份并拒绝旧SQL");
  const body = {
    operation_id: randomUUID(),
    draft_version: q.draft_version,
    condition_version: q.condition_version,
  };
  const confirmed = await h.request("/queries/" + q.id + "/confirm", body);
  assert.equal(confirmed.status, 200);
  const duplicate = await h.request("/queries/" + q.id + "/confirm", body);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.value.id, q.id);
  await until(async () => {
    const v = await h.request("/queries/" + q.id);
    return v.value.execution_state === "succeeded";
  }, "query succeeded");
  const result = await h.request("/queries/" + q.id + "/results");
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.value.rows,
    [["1600"]] /* 独立参考Q08：app渠道净收入1600分 */,
  );
  check("确认仅执行展示版本，重复确认不生成第二查询，实际合成数值正确");
  await h.finished(cid, 3);
  assert.ok(
    (await h.snapshot(cid)).events.some(
      (e) => e.type === "query_result" && e.payload.task_id === q.task_id,
    ),
  );
  const beforeReplay = (await h.snapshot(cid)).tasks.find(t => t.id === q.task_id);
  assert.equal(beforeReplay.phase, "answered");
  assert.equal((await h.request("/queries/" + q.id + "/confirm", body)).status, 200);
  assert.equal((await h.snapshot(cid)).tasks.find(t => t.id === q.task_id).phase, "answered");
  check("查询完成唤醒Pi解释，绑定原任务；完成后重复确认不倒退阶段");
  assert.equal(
    (await h.request("/queries/" + q.id, undefined, "bob")).status,
    404,
  );
  assert.equal(
    (await h.request("/queries/" + q.id + "/results", undefined, "bob")).status,
    404,
  );
  check("查询与结果按用户隔离");
  await h.send(cid, "查2026年1月支付客户数");
  await h.finished(cid, 4);
  qs = (await list()).queries;
  assert.equal(qs.length, 3);
  assert.notEqual(qs[2].task_id, q.task_id);
  check("同一对话持续多轮并保存多个独立分析任务");
  const ambiguous = await h.create();
  await h.send(ambiguous, "2026年1月退款率是多少");
  const s = await h.finished(ambiguous);
  assert.match(s.messages.at(-1).text, /分母/);
  assert.equal(
    (await h.request("/conversations/" + ambiguous + "/queries")).value.queries
      .length,
    0,
  );
  await h.send(ambiguous, "按订单计算");
  await h.finished(ambiguous, 2);
  const r = (await h.request("/conversations/" + ambiguous + "/queries")).value
    .queries[0];
  assert.match(r.sql, /COUNT\(DISTINCT/);
  check("影响结果的歧义先澄清，回答继续原任务");
  await h.request("/queries/" + r.id + "/cancel", {
    operation_id: randomUUID(),
  });
  assert.equal(
    (
      await h.request("/queries/" + r.id + "/confirm", {
        operation_id: randomUUID(),
        draft_version: r.draft_version,
        condition_version: r.condition_version,
      })
    ).status,
    409,
  );
  check("取消未确认请求后不能执行");
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      provider: "local_mock",
      platform: "executable synthetic SQLite",
      officialRequests: 0,
    }),
  );
} finally {
  await mkdir(".local/checks", { recursive: true });
  await writeFile(
    ".local/checks/mvp-query.json",
    JSON.stringify({ checks, passed: checks.length >= 8 }, null, 2),
  );
  await h.close();
}
