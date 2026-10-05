import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";
const h = await harness({
  capture: true,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "0.1" },
});
const checks = [];
const check = (name) => checks.push({ name, passed: true });
const manager = SessionManager.inMemory("/synthetic/data-agent");
let run;
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
  const r = await h.internal("/internal/data/tool-calls", input);
  assert.equal(r.status, 200);
  return { input, result: await h.internal("/internal/data/tools", input) };
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
  assert.equal(
    (
      await h.internal("/internal/outputs", {
        run_id: run.run_id,
        lease_epoch: run.lease_epoch,
        chunk_seq: "1",
        text: "边界测试已完成。",
      })
    ).status,
    200,
  );
  const f = await h.internal("/internal/finish", {
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    commit_id: run.output_id,
    final_text: "边界测试已完成。",
    checkpoint: exportCheckpoint(
      manager,
      run.workspace_context.authority_revision,
      run.workspace_context.authority_snapshot,
    ),
  });
  assert.equal(f.status, 200, JSON.stringify(f.value));
};
const conditions = () => ({
  time_start: "2026-01-01T00:00:00Z",
  time_end: "2026-02-01T00:00:00Z",
  timezone: "UTC",
  metric: "net_revenue",
  channel: null,
  group_by: [],
  filters: ["is_test=0"],
  knowledge_refs: [],
  notes: "",
});
try {
  const cid = await h.create();
  run = await h.capture(cid, "仅本次的边界测试，不要记住");
  await h.pauseWorker();
  const assetInput = {
    operation_id: randomUUID(),
    id: null,
    expected_version: null,
    kind: "skill",
    name: "受选用控制的方法",
    body: "始终展示SQL后确认",
    scope: "订单收入分析",
    verified: false,
    source_text: "用户主动录入",
    dependencies: [],
  };
  const skill = (await h.request("/assets", assetInput)).value;
  const readArgs = { object_id: "asset-" + skill.id };
  assert.equal(
    (await invoke("read_knowledge", readArgs)).result.value.code,
    "selection_required",
  );
  await h.request("/conversations/" + cid + "/skill-selections", {
    operation_id: randomUUID(),
    asset_id: skill.id,
    version: skill.version,
  });
  assert.equal((await invoke("read_knowledge", readArgs)).result.status, 200);
  await h.request("/assets/" + skill.id + "/disable", {
    operation_id: randomUUID(),
    expected_version: skill.version,
  });
  assert.equal((await invoke("read_knowledge", readArgs)).result.status, 404);
  check("工具侧拒绝未选用/停用Skill，选用当前版本才可读正文");
  const rejected = (
    await invoke("manage_personal_asset", {
      action: "save_memory",
      name: "不应保存",
      body: "默认渠道=app",
      scope: "仅本次",
      verified: false,
      dependencies: [],
    })
  ).result;
  assert.equal(rejected.value.code, "scope_incomplete");
  assert.equal((await h.request("/assets")).value.assets.length, 1);
  check("宿主拒绝把仅本次输入写成长期记忆");
  const obj = (await h.request("/knowledge/table-demo_order_detail")).value;
  const evidence = [
    { object_id: obj.id, version: obj.version, path: "description" },
  ];
  const p = (
    await invoke("propose_semantic_change", {
      object_id: obj.id,
      base_version: obj.version,
      entry_id: "description",
      value: "人工建议：一个订单商品行",
      reason: "核对合成DDL中的联合主键",
      evidence,
    })
  ).result;
  assert.equal(p.status, 200);
  assert.equal(
    (await h.request("/knowledge/" + obj.id)).value.version,
    obj.version,
  );
  const apply = { operation_id: randomUUID(), expected_version: obj.version };
  assert.equal(
    (
      await h.request("/knowledge-proposals/" + p.value.data.id + "/apply", {
        ...apply,
        expected_version: "0",
      })
    ).status,
    409,
  );
  const applied = await h.request(
    "/knowledge-proposals/" + p.value.data.id + "/apply",
    apply,
  );
  assert.equal(applied.status, 200);
  assert.deepEqual(
    (
      await h.request(
        "/knowledge-proposals/" + p.value.data.id + "/apply",
        apply,
      )
    ).value,
    applied.value,
  );
  assert.equal(
    (
      await invoke("propose_semantic_change", {
        object_id: obj.id,
        base_version: obj.version,
        entry_id: "description",
        value: "过期建议",
        reason: "过期",
        evidence,
      })
    ).result.status,
    409,
  );
  check("提案不直接改知识，明确应用、版本冲突与丢回执幂等");
  // 前段已改版知识与Skill，旧输入先合法撤回；取消续接使用新运行取得的当前依据。
  assert.equal(
    (await h.request(
      "/conversations/" + cid + "/messages/" + run.message_id + "/withdraw",
      { operation_id: randomUUID() },
    )).status,
    200,
  );
  h.releaseRun(run.run_id);
  await h.resumeWorker();
  run = await h.capture(cid, "同时准备任务A和任务B，随后只取消任务A");
  await h.pauseWorker();
  const task = (
    await invoke("update_analysis_task", {
      action: "create",
      task_id: null,
      expected_version: null,
      goal: "任务A",
      conditions: conditions(),
      question: null,
      options: [],
    })
  ).result.value.data;
  const qArgs = {
    task_id: task.task_id,
    condition_version: task.condition_version,
    sql: "SELECT -5 AS amount, 9007199254740993 AS exact_integer, NULL AS missing, '=SUM(A1)' AS formula_text",
    parameters: {},
    target_id: "synthetic-sqlite", replaces_query_id: null,
    summary: "精确值与导出边界",
    knowledge_refs: [],
  };
  const q = (await invoke("request_query", qArgs)).result.value.data;
  const saved = await invoke("request_query", {
    ...qArgs,
    sql: "SELECT 1 AS value",
  });
  assert.equal(saved.result.status, 200);
  await h.pausePlatform();
  assert.deepEqual(
    (await h.internal("/internal/data/tools", saved.input)).value,
    saved.result.value,
  );
  await h.resumePlatform();
  check("已保存SQL草稿回执重放不依赖平台再次可用");
  const taskB = (
    await invoke("update_analysis_task", {
      action: "create",
      task_id: null,
      expected_version: null,
      goal: "任务B",
      conditions: conditions(),
      question: null,
      options: [],
    })
  ).result.value.data;
  const qB = (
    await invoke("request_query", {
      ...qArgs,
      task_id: taskB.task_id,
      condition_version: taskB.condition_version,
      sql: "SELECT 2 AS value",
    })
  ).result.value.data;
  const interruptedRun=run;
  assert.equal((await h.request(
    "/conversations/" + cid + "/tasks/" + task.task_id + "/cancel",
    { operation_id: randomUUID(), expected_version: task.condition_version },
  )).status,200);
  assert.equal(
    (await h.request("/queries/" + q.id)).value.execution_state,
    "cancelled",
  );
  assert.equal(
    (await h.request("/queries/" + qB.id)).value.execution_state,
    "not_submitted",
  );
  check("取消任务A只取消A的查询，任务B保留");
  assert.equal((await h.internal('/internal/outputs',{run_id:interruptedRun.run_id,lease_epoch:interruptedRun.lease_epoch,chunk_seq:'1',text:'旧运行不得提交'})).value.code,'lease_lost');
  h.releaseRun(interruptedRun.run_id);
  await h.resumeWorker();
  run=await until(()=>h.captured.find(v=>v.message_id===interruptedRun.message_id&&v.run_id!==interruptedRun.run_id),'未取消任务B续接');
  await h.pauseWorker();
  assert.equal(run.message_id,interruptedRun.message_id);
  assert.equal(run.budget_scope_id,interruptedRun.budget_scope_id);
  assert.equal(run.recovery_chain_id,interruptedRun.recovery_chain_id);
  assert.deepEqual(new Set(run.workspace_context.input_task_ids),new Set([task.task_id,taskB.task_id]));
  const taskStates=(await h.snapshot(cid)).tasks;
  assert.equal(taskStates.length,2);
  assert.equal(taskStates.find(v=>v.id===task.task_id).lifecycle,'cancelled');
  assert.equal(taskStates.find(v=>v.id===taskB.task_id).lifecycle,'active');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE task_id='${taskB.task_id}'`)[0].n,1);
  assert.equal((await h.request('/queries/'+qB.id)).value.execution_state,'not_submitted');
  await finish();
  h.releaseRun(run.run_id);
  await h.resumeWorker();
  const accepted = await h.request("/queries/" + qB.id + "/confirm", {
    operation_id: randomUUID(),
    draft_version: qB.draft_version,
    condition_version: qB.condition_version,
  });
  assert.equal(accepted.status, 200);
  await until(
    async () =>
      (await h.request("/queries/" + qB.id)).value.execution_state ===
      "succeeded",
    "B query",
  );
  run = await until(
    () => h.captured.find((v) => v.conversation_id === cid && v.text.includes("query_id=" + qB.id)),
    "B结果唤醒",
  );
  await h.pauseWorker();
  await finish();
  h.releaseRun(run.run_id);
  const newCid = await h.create();
  await h.resumeWorker();
  run = await h.capture(newCid, "只输出文字，不登记归属");
  await h.pauseWorker();
  await h.internal("/internal/outputs", {
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    chunk_seq: "1",
    text: "已经修改。",
  });
  assert.equal(
    (
      await h.internal("/internal/finish", {
        run_id: run.run_id,
        lease_epoch: run.lease_epoch,
        commit_id: run.output_id,
        final_text: "已经修改。",
        checkpoint: exportCheckpoint(manager),
      })
    ).value.code,
    "message_pending",
  );
  assert.equal(
    (await h.request("/conversations/" + newCid + "/queries")).value
      .confirmation_blocked,
    true,
  );
  assert.equal(
    (
      await h.request(
        "/conversations/" +
          newCid +
          "/messages/" +
          run.message_id +
          "/withdraw",
        { operation_id: randomUUID() },
      )
    ).status,
    200,
  );
  assert.equal(
    (await h.request("/conversations/" + newCid + "/queries")).value
      .confirmation_blocked,
    false,
  );
  check("没有结构化归属不能消费输入；明确撤回留下合法处置并解除阻塞");
  const deleted = await h.request(
    "/conversations/" + cid,
    { operation_id: randomUUID() },
    "alice",
    "DELETE",
  );
  assert.equal(deleted.status, 200);
  assert.equal(
    (await h.request("/conversations/" + cid + "/snapshot")).status,
    404,
  );
  assert.equal((await h.request("/queries/" + qB.id + "/results")).status, 404);
  assert.equal(
    (
      await h.request(
        "/conversations/" + cid,
        { operation_id: randomUUID() },
        "alice",
        "DELETE",
      )
    ).status,
    200,
  );
  check("会话删除后禁止读取、模型续跑及结果访问，重复删除可恢复");
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      officialRequests: 0,
      mode: "host tool boundary",
    }),
  );
} finally {
  await writeFile(
    ".local/checks/mvp-boundaries.json",
    JSON.stringify({ passed: checks.length === 7, checks }, null, 2),
  );
  await h.close();
}
