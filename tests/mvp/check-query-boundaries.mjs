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
  const draft = async (sql, replacesQueryId = null, summary = "边界结果") =>
    (
      await invoke("request_query", {
        task_id: task.task_id,
        condition_version: task.condition_version,
        sql,
        parameters: {},
        target_id: "synthetic-sqlite", replaces_query_id: replacesQueryId,
        summary,
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
  const previews = [
    {count:25, query:await draft("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<25) SELECT x, 9007199254740993 AS original_integer_without_precision_loss, 'synthetic_text_for_horizontal_scroll' AS original_text_without_wrapping, NULL AS missing_value_for_preview, -5 AS negative_amount_in_original_unit FROM n")},
    {count:5, query:await draft("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5) SELECT x FROM n")},
    {count:0, query:await draft("SELECT 1 AS value WHERE 0")},
  ];
  const overflow = await draft("SELECT SUM(x) AS value FROM (SELECT 9223372036854775807 AS x UNION ALL SELECT 9223372036854775807)");
  const previous = await draft("SELECT 7 AS previous_value", null, "旧稿定位检查");
  await draft("SELECT 8 AS replacement_value", previous.id);
  await invoke("cancel_query", {query_id: previous.id});
  assert.equal((await h.request('/queries/'+previous.id)).value.confirmation_state, 'superseded');
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
  const tail = (await h.request("/queries/" + many.id + "/results?cursor=900")).value;
  assert.equal(tail.result_complete, false);
  assert.equal(tail.fetched_offset, "900");
  assert.equal(tail.next_cursor, null);
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();
    await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
    await page.getByLabel('你的数据问题').waitFor();
    await page.evaluate(id=>localStorage.setItem('data-agent.conversation.alice',id),cid);await page.reload();
    const card=page.locator('#query-'+many.id);
    await card.getByText('已截断',{exact:false}).waitFor();
    assert.equal(await card.locator('tbody tr').count(),10);
    assert.equal(await card.getByRole('button',{name:'加载下一页',exact:true}).count(),0);
    const downloadPromise=page.waitForEvent('download');
    await card.getByRole('link',{name:/下载 CSV/}).click();
    const download=await downloadPromise;
    assert.equal(await download.failure(),null);
    const stream=await download.createReadStream(); const chunks=[];
    for await(const chunk of stream)chunks.push(chunk);
    const exported=Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'').trim().split('\r\n');
    assert.equal(exported.length,1001);assert.equal(exported.at(-1),'"1000"');
    const pending=await h.send(cid,'合成未完成输入');
    h.sql(`INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) SELECT '${randomUUID()}',id,event_seq+1,'run_failed',JSON_OBJECT('message_id','${pending.message_id}','code','unavailable') FROM conversations WHERE id='${cid}';UPDATE conversations SET event_seq=event_seq+1 WHERE id='${cid}';`);
    await page.getByRole('button',{name:'撤回未完成输入',exact:true}).click();
    await page.getByRole('button',{name:'撤回未完成输入',exact:true}).waitFor({state:'detached'});
    assert.ok((await h.snapshot(cid)).events.some(e=>e.type==='message_withdrawn'&&e.payload.message_id===pending.message_id));
    checks.push({name:'实际浏览器仅预览10行、CSV下载1000行并提示截断；合成失败事件后点击撤回，正式消息状态更新',passed:true});
    for(const sample of previews) {
      await confirm(sample.query);await h.resumeWorker();
      await until(async()=>(await h.request('/queries/'+sample.query.id)).value.execution_state==='succeeded','预览样例完成');
      await h.pauseWorker();await withdrawExplanations(cid);
      const view=page.locator('#query-'+sample.query.id);
      await view.locator('.result-panel').waitFor();
      assert.equal(await view.locator('tbody tr').count(),Math.min(10,sample.count));
      const downloadPromise=page.waitForEvent('download');await view.getByRole('link',{name:/下载 CSV/}).click();
      const download=await downloadPromise;assert.equal(await download.failure(),null);
      const stream=await download.createReadStream();const chunks=[];
      for await(const chunk of stream)chunks.push(chunk);
      const csv=Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'').trim().split('\r\n');
      assert.equal(csv.length,sample.count+1);
      if(sample.count===25) {
        assert.match(csv.at(-1),/^"25","9007199254740993"/);
        assert.equal(await view.getByText(/结果已截断/).count(),0);
        await page.setViewportSize({width:390,height:1000});
        const scroll=view.locator('.table-scroll');
        const left=await scroll.evaluate(el=>{el.scrollLeft=250;return el.scrollLeft;});assert.ok(left>0);
        await page.waitForResponse(r=>r.url().includes('/snapshot'));
        assert.equal(await scroll.evaluate(el=>el.scrollLeft),left);
        await view.getByRole('button',{name:'图表',exact:true}).click();
        assert.equal(await view.locator('.chart-row').count(),10);
        assert.equal(await view.getByLabel('图表指标').locator('option').filter({hasText:'original_integer_without_precision_loss'}).count(),0,'不能把超大整数转为图表浮点数');
        await view.getByLabel('图表指标').selectOption({label:'negative_amount_in_original_unit'});
        assert.equal(await view.locator('.chart-row i.negative').count(),10);
        await view.getByRole('button',{name:'表格',exact:true}).click();
        for(const width of [1440,390]) {
          await page.setViewportSize({width,height:1000});
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
          await view.screenshot({path:'.local/checks/result-preview-'+width+'.png'});
        }
        await page.setViewportSize({width:1440,height:1000});
      }
      if(sample.count===0) {
        await view.getByText('查询成功，暂无符合条件的记录。',{exact:true}).waitFor();
        assert.equal(await view.getByRole('button',{name:'图表',exact:true}).isEnabled(),false);
      }
    }
    checks.push({name:'25/5/0行结果分别预览10/5/0行，下载为25/5/0行；图表同10行、横向滚动经刷新保持，桌面和手机无页面溢出',passed:true});
    await confirm(overflow);await h.resumeWorker();
    await until(async()=>(await h.request('/queries/'+overflow.id)).value.execution_state==='failed','平台执行失败');
    await h.pauseWorker();await withdrawExplanations(cid);
    const failed=page.locator('#query-'+overflow.id);
    await failed.getByRole('heading',{name:'查询失败',exact:true}).waitFor();
    assert.equal(await failed.locator('.result-panel').count(),0);
    assert.equal(await failed.getByRole('link',{name:/下载 CSV/}).count(),0);
    await page.locator('.query-notice').getByText(/查询失败/).waitFor();
    checks.push({name:'真实SQL整数溢出产生失败通知，不展示成功结果或下载入口',passed:true});
  } finally {await browser.close();}
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
  const historyBrowser=await chromium.launch();
  try {
    const page=await historyBrowser.newPage({viewport:{width:1440,height:1000}});
    await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
    await page.getByLabel('你的数据问题').waitFor();
    await page.evaluate(id=>localStorage.setItem('data-agent.conversation.alice',id),cid);await page.reload();
    const previousCard=page.locator('#query-'+previous.id);
    const folded=page.locator('details.previous-query').filter({has:previousCard});
    await folded.waitFor();assert.equal(await folded.evaluate(el=>el.open),false);
    await page.locator('.query-notice').filter({hasText:'旧稿定位检查'}).getByRole('button',{name:'查看查询',exact:true}).click();
    assert.equal(await folded.evaluate(el=>el.open),true);
    assert.equal(await previousCard.locator('pre').isVisible(),true);
    assert.equal(await previousCard.evaluate(el=>el===document.activeElement),true);
    checks.push({name:'旧SQL默认折叠，取消通知的查看查询操作展开并聚焦正确SQL',passed:true});
    await page.evaluate(id=>localStorage.setItem('data-agent.conversation.alice',id),eventCid);await page.reload();
    const older=page.getByRole('button',{name:'加载更早的消息',exact:true});await older.waitFor();
    await page.locator('.conversation-scroll').evaluate(el=>{el.scrollTop=0;});
    const anchor=page.getByText(latest.events[0].payload.text,{exact:true});
    const before=await anchor.boundingBox();await older.click();await older.waitFor({state:'detached'});
    const after=await anchor.boundingBox();assert.ok(Math.abs(after.y-before.y)<3,'补入更早页保留原首条可见消息位置');
    assert.equal(await page.locator('.message.user').count(),1101);
  } finally {await historyBrowser.close();}
  checks.push({
    name: "超过1000事件时快照读取最新内容；真实浏览器加载更早页不重复且保留首条可见消息位置",
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
