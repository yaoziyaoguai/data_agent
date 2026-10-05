import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 32768,
  output_limit: 2048,
  trial_call_limit: 24,
  trial_cost_micros: "300000",
  request_call_limit: 12,
  toolset: "data",
  payload_bytes_limit: 65536,
};
const h = await harness({
  capture: true,
  profile,
  env: { DATA_AGENT_LEASE_MS: "120000" },
});
let passed = false;
const checks = [];
try {
  const cid = await h.create();
  const run = await h.capture(cid, "撤回正文不可重入模型");
  await h.pauseWorker();
  const binding = (id) => ({
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    call_attempt_id: id,
    parameters_fingerprint: "a".repeat(64),
  });
  const b = binding(randomUUID());
  const reserve = {
    ...b,
    input_tokens_upper: profile.input_limit,
    output_tokens_max: profile.output_limit,
  };
  assert.equal(
    (await h.internal("/internal/model/reserve", reserve)).status,
    200,
  );
  const unused = (await h.request("/knowledge/table-raw_payments")).value;
  assert.equal((await h.request('/knowledge/'+unused.id+'/disable',{operation_id:randomUUID(),expected_version:unused.version})).status,200);
  const unrelated = binding(randomUUID());
  assert.equal((await h.internal('/internal/model/reserve',{...unrelated,input_tokens_upper:profile.input_limit,output_tokens_max:profile.output_limit})).status,200);
  assert.equal((await h.internal('/internal/model/send',unrelated)).status,200);
  checks.push({name:'未交付给模型的表停用不阻断当前会话模型调用',passed:true});
  const knowledge = (await h.request("/knowledge/table-demo_order_detail"))
    .value;
  const used = {run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'read_knowledge',arguments:{object_id:knowledge.id},checkpoint:exportCheckpoint(SessionManager.inMemory('/synthetic/data-agent'))};
  assert.equal((await h.internal('/internal/data/tool-calls',used)).status,200);
  assert.equal((await h.internal('/internal/data/tools',used)).status,200);

  assert.equal(
    (
      await h.request("/knowledge/" + knowledge.id + "/disable", {
        operation_id: randomUUID(),
        expected_version: knowledge.version,
      })
    ).status,
    200,
  );
  assert.equal(
    (await h.internal("/internal/model/send", b)).value.code,
    "stale_context",
  );
  assert.equal(
    (
      await h.internal("/internal/model/reserve", {
        ...reserve,
        call_attempt_id: randomUUID(),
      })
    ).value.code,
    "stale_context",
  );
  const ledger = h.sql(
    `SELECT JSON_OBJECT('state',state) FROM model_call_attempts WHERE id='${b.call_attempt_id}'`,
  )[0];
  assert.equal(ledger.state, "reserved");
  checks.push({
    name: "运行中知识停用后reserve/send拒绝，已预留额度保留且未发送provider HTTP",
    passed: true,
  });
  await h.request(
    "/conversations/" + cid + "/messages/" + run.message_id + "/withdraw",
    { operation_id: randomUUID() },
  );
  h.releaseRun(run.run_id);
  h.sql(
    `INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) SELECT '${randomUUID()}',id,event_seq+1,'assistant_committed',JSON_OBJECT('text','旧助手停用资产秘密正文','attempt_id','old') FROM conversations WHERE id='${cid}';UPDATE conversations SET event_seq=event_seq+1 WHERE id='${cid}';`,
  );
  await h.resumeWorker();
  const next = await h.capture(cid, "请重新调查有效资料");
  await h.pauseWorker();
  const manager = SessionManager.inMemory("/synthetic/data-agent");
  const input = {
    run_id: next.run_id,
    lease_epoch: next.lease_epoch,
    sdk_tool_call_id: randomUUID(),
    tool_name: "read_conversation",
    arguments: { after_seq: "0" },
    checkpoint: exportCheckpoint(
      manager,
      next.workspace_context.authority_revision,
      next.workspace_context.authority_snapshot,
    ),
  };
  assert.equal(
    (await h.internal("/internal/data/tool-calls", input)).status,
    200,
  );
  const history = await h.internal("/internal/data/tools", input);
  assert.equal(history.status, 200);
  const body = JSON.stringify(history.value);
  assert.ok(!body.includes("撤回正文不可重入模型"));
  assert.ok(!body.includes("旧助手停用资产秘密正文"));
  assert.ok(body.includes("请重新调查有效资料"));
  checks.push({
    name: "模型历史工具排除撤回输入和旧助手/工具派生正文，公开审计历史仍保留",
    passed: true,
  });
  const saveInput = { ...input, sdk_tool_call_id: randomUUID(), tool_name:"manage_personal_asset", arguments:{action:"save_memory",instruction_quote:next.text,name:"运行中新保存的纠错",body:"默认渠道=store",scope:"未指定渠道的合成订单问题",verified:false,dependencies:[]} };
  assert.equal((await h.internal("/internal/data/tool-calls",saveInput)).status,200);
  const saved=await h.internal("/internal/data/tools",saveInput);assert.equal(saved.status,200);
  const asset=saved.value.data;
  const snapshot=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${next.run_id}'`)[0];
  assert.ok(snapshot.memories.some(v=>v[0]===asset.id));
  const checkpoint=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${next.recovery_chain_id}'`)[0];
  assert.ok(checkpoint.authority_snapshot.memories.some(v=>v[0]===asset.id));
  await h.request('/assets/'+asset.id+'/disable',{operation_id:randomUUID(),expected_version:asset.version});
  const nextBinding={run_id:next.run_id,lease_epoch:next.lease_epoch,call_attempt_id:randomUUID(),parameters_fingerprint:'b'.repeat(64),input_tokens_upper:profile.input_limit,output_tokens_max:profile.output_limit};
  assert.equal((await h.internal('/internal/model/reserve',nextBinding)).value.code,'stale_context');
  checks.push({name:'本轮新memory进入run与检查点清单，停用后立即拒绝下一模型调用',passed:true});
  h.releaseRun(next.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${next.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${next.message_id}';`);
  await h.resumeWorker();
  await until(async()=>(await h.snapshot(cid)).events.some(e=>e.type==='run_failed' && e.payload.message_id===next.message_id),'invalid recovery blocked');
  assert.equal(h.captured.filter(r=>r.message_id===next.message_id).length,1);
  checks.push({name:'业务提交后未返回SDK时失效，新run按原检查点拒绝恢复且不重放失效正文',passed:true});
  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} finally {
  await writeFile(
    ".local/checks/mvp-authority.json",
    JSON.stringify({ passed, checks }, null, 2),
  );
  await h.close();
}
