import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {chromium} from 'playwright';
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";
const h = await harness({
  web: true,
  capture: true,
  env: {
    DATA_AGENT_LEASE_MS: "120000",
    DATA_AGENT_QUERY_DELAY_SECONDS: "0.1",
    DATA_AGENT_RESULT_TTL_SECONDS: "10",
  },
});
const manager = SessionManager.inMemory("/synthetic/data-agent");
let run;
let passed = false;
const checks = [];
const condition = {
  time_start: "2026-01-01T00:00:00Z",
  time_end: "2026-02-01T00:00:00Z",
  timezone: "UTC",
  metric: "net_revenue",
  channel: null,
  group_by: [],
  filters: [],
  knowledge_refs: [],
  notes: "",
};
const invoke = async (name, args, sdk = randomUUID()) => {
  const input = {
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    sdk_tool_call_id: sdk,
    tool_name: name,
    arguments: name === "manage_personal_asset" && args.action !== "disable_memory" ? {...args,instruction_quote:run.text}:args,
    checkpoint: exportCheckpoint(
      manager,
      run.workspace_context.authority_revision,
      run.workspace_context.authority_snapshot,
    ),
  };
  assert.equal(
    (await h.internal("/internal/data/tool-calls", input)).status,
    200,
  );
  const result = await h.internal("/internal/data/tools", input);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return { input, value: result.value.data };
};
const finish = async () => {
  await invoke("update_analysis_task", {
    action: "route",
    task_id: null,
    expected_version: null,
    goal: "",
    question: null,
    options: [],
  });
  await h.internal("/internal/outputs", {
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    chunk_seq: "1",
    text: "边界已保存。",
  });
  assert.equal(
    (
      await h.internal("/internal/finish", {
        run_id: run.run_id,
        lease_epoch: run.lease_epoch,
        commit_id: run.output_id,
        final_text: "边界已保存。",
        checkpoint: exportCheckpoint(
          manager,
          run.workspace_context.authority_revision,
          run.workspace_context.authority_snapshot,
        ),
      })
    ).status,
    200,
  );
  h.releaseRun(run.run_id);
};
const confirm = async (q) => {
  assert.equal(
    (
      await h.request("/queries/" + q.id + "/confirm", {
        operation_id: randomUUID(),
        draft_version: q.draft_version,
        condition_version: q.condition_version,
      })
    ).status,
    200,
  );
};
const withdrawExplanations = async (cid) => {
  for (const m of h.sql(`SELECT JSON_OBJECT('id',id) FROM conversation_messages WHERE conversation_id='${cid}' AND client_key LIKE 'server:query-result:%' AND disposition='pending'`)) {
    assert.equal((await h.request(`/conversations/${cid}/messages/${m.id}/withdraw`,{operation_id:randomUUID()})).status,200);
    for(const captured of h.captured.filter(r=>r.message_id===m.id)) h.releaseRun(captured.run_id);
  }
};
try {
  const cid = await h.create();
  run = await h.capture(cid, "请检查边界");
  await h.pauseWorker();
  const task = (
    await invoke("update_analysis_task", {
      action: "create",
      task_id: null,
      expected_version: null,
      goal: "查询边界",
      conditions: condition,
      question: null,
      options: [],
    })
  ).value;
  const draft = async (sql) =>
    (
      await invoke("request_query", {
        task_id: task.task_id,
        condition_version: task.condition_version,
        sql,
        parameters: {},
        target_id: "synthetic-sqlite", replaces_query_id: null,
        summary: "边界结果",
        knowledge_refs: [],
      })
    ).value;
  const q = await draft(
    "SELECT -5 AS amount, 9007199254740993 AS exact_integer, NULL AS missing, '=SUM(A1)' AS formula_text",
  );
  const many = await draft(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1005) SELECT x FROM n",
  );
  const missing = await draft("SELECT 42 AS value");
  const memory = await invoke("manage_personal_asset", {
    action: "save_memory",
    name: "本人渠道偏好",
    body: "默认渠道=app",
    scope: "订单分析未指定渠道时",
    verified: false,
    dependencies: [],
  });
  assert.deepEqual(
    (await h.internal("/internal/data/tools", memory.input)).value.data,
    memory.value,
  );
  assert.equal((await h.request("/assets")).value.assets.length, 1);
  checks.push({ name: "纠错写入后回执重放仅保留一份个人资产", passed: true });
  await finish();
  await confirm(q);
  await h.resumeWorker();
  await until(
    async () =>
      (await h.request("/queries/" + q.id)).value.execution_state ===
      "succeeded",
    "precision query",
  );
  await h.pauseWorker();
  let result = (await h.request("/queries/" + q.id + "/results")).value;
  await withdrawExplanations(cid);
  assert.deepEqual(result.rows, [["-5", "9007199254740993", null, "=SUM(A1)"]]);
  const csv = await fetch(
    h.env.DATA_AGENT_API_URL + "/queries/" + q.id + "/export.csv",
    { headers: { authorization: "Bearer " + h.tokens.alice } },
  );
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.ok(text.includes("-5"));
  assert.ok(text.includes("9007199254740993"));
  assert.ok(text.includes("'=SUM(A1)"));
  checks.push({
    name: "大整数与NULL保真，CSV负数保留且文本公式转义",
    passed: true,
  });
  await confirm(many);
  await h.resumeWorker();
  await until(
    async () =>
      (await h.request("/queries/" + many.id)).value.execution_state ===
      "succeeded",
    "truncated query",
  );
  await h.pauseWorker();
  result = (await h.request("/queries/" + many.id + "/results")).value;
  await withdrawExplanations(cid);
  assert.equal(result.truncated, true);
  assert.equal(result.result_complete, false);
  assert.equal(result.rows.length, 100);
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();
    await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
    await page.getByLabel('你的数据问题').waitFor();
    await page.evaluate(id=>localStorage.setItem('data-agent.conversation.alice',id),cid);await page.reload();
    const card=page.getByRole('region',{name:/SQL草稿版本/}).filter({hasText:'WITH RECURSIVE'});
    await card.getByRole('button',{name:'查看结果',exact:true}).click();await card.getByText('已截断',{exact:false}).waitFor();
    assert.equal(await card.locator('tbody tr').count(),100);
    await card.getByRole('button',{name:'加载下一页',exact:true}).click();
    await until(async()=>await card.locator('tbody tr').count()===200,'结果下一页追加');
    const pending=await h.send(cid,'合成未完成输入');
    h.sql(`INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) SELECT '${randomUUID()}',id,event_seq+1,'run_failed',JSON_OBJECT('message_id','${pending.message_id}','code','unavailable') FROM conversations WHERE id='${cid}';UPDATE conversations SET event_seq=event_seq+1 WHERE id='${cid}';`);
    await page.getByRole('button',{name:'撤回未完成输入',exact:true}).click();
    await page.getByRole('button',{name:'撤回未完成输入',exact:true}).waitFor({state:'detached'});
    assert.ok((await h.snapshot(cid)).events.some(e=>e.type==='message_withdrawn'&&e.payload.message_id===pending.message_id));
    checks.push({name:'实际浏览器加载查询下一页；合成失败事件后点击撤回，正式消息状态更新',passed:true});
  } finally {await browser.close();}
  const tail = (await h.request("/queries/" + many.id + "/results?cursor=900"))
    .value;
  assert.equal(tail.result_complete, false);
  assert.equal(tail.fetched_offset, "900");
  assert.equal(tail.next_cursor, null);
  checks.push({
    name: "1000行截断与分页范围明确，单独尾页不声称结果完整",
    passed: true,
  });
  await h.pausePlatform();
  await confirm(missing);
  await h.resumeWorker();
  await until(
    async () =>
      (await h.request("/queries/" + missing.id)).value.execution_state ===
      "submission_unknown",
    "unknown submission",
  );
  await h.pauseWorker();
  await h.request("/queries/" + missing.id + "/cancel", {
    operation_id: randomUUID(),
  });
  await h.resumePlatform();
  await h.resumeWorker();
  await until(
    async () =>
      (await h.request("/queries/" + missing.id)).value.execution_state ===
      "cancelled",
    "confirmed absent cancellation",
  );
  await h.pauseWorker();
  const lookup = await fetch(h.env.DATA_AGENT_PLATFORM_URL + "/lookup", {
    method: "POST",
    headers: {
      authorization: "Bearer " + h.env.DATA_AGENT_INTERNAL_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query_id: missing.id, owner_id: "alice" }),
  });
  assert.equal(lookup.status, 409);
  await withdrawExplanations(cid);
  checks.push({
    name: "提交未知但平台确认未接收，取消进入终态且没有重新提交",
    passed: true,
  });
  const ordered = await h.create();
  const a = await h.send(ordered, "先收到的条件");
  const b = await h.send(ordered, "后收到的条件");
  h.sql(
    `UPDATE background_jobs SET id='zz-first-job' WHERE message_id='${a.message_id}';UPDATE background_jobs SET id='aa-second-job' WHERE message_id='${b.message_id}';`,
  );
  const count = h.captured.length;
  await h.resumeWorker();
  run = await until(() => h.captured[count], "ordered first");
  assert.equal(run.text, "先收到的条件");
  await h.pauseWorker();
  await finish();
  await h.resumeWorker();
  run = await until(() => h.captured[count + 1], "ordered second");
  assert.equal(run.text, "后收到的条件");
  await h.pauseWorker();
  await finish();
  checks.push({
    name: "两条连续输入即使job ID反序也按接收顺序处理",
    passed: true,
  });
  const eventCid = await h.create();
  const values = Array.from(
    { length: 1101 },
    (_, i) =>
      `('${randomUUID()}','${eventCid}',${i + 1},'message',JSON_OBJECT('text','分页消息${i + 1}','message_id','fake-${i + 1}'))`,
  ).join(",");
  h.sql(
    `INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) VALUES ${values};UPDATE conversations SET event_seq=1101 WHERE id='${eventCid}';`,
  );
  const latest = await h.snapshot(eventCid);
  assert.equal(latest.events.at(-1).event_seq, "1101");
  assert.equal(latest.has_older, true);
  assert.equal(latest.events.at(-1).payload.text, "分页消息1101");
  const earlier = (
    await h.request(
      "/conversations/" +
        eventCid +
        "/snapshot?before_seq=" +
        latest.first_event_seq,
    )
  ).value;
  assert.equal(earlier.events[0].event_seq, "1");
  assert.ok(BigInt(earlier.events.at(-1).event_seq) < BigInt(latest.first_event_seq));
  checks.push({
    name: "超过1000事件时快照读取真正最新内容，更早页可回看且不重复",
    passed: true,
  });
  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} finally {
  await writeFile(
    ".local/checks/mvp-query-boundaries.json",
    JSON.stringify({ passed, checks }, null, 2),
  );
  await h.close();
}
