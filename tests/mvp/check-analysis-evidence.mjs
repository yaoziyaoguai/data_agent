import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";

// 手动受控工具证明证据保存和权限边界；模型规划由另一份Pi本地协议测试覆盖。
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: "evidence_" + randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 65536,
  output_limit: 2048,
  trial_call_limit: 80,
  trial_cost_micros: "1000000",
  request_call_limit: 24,
  toolset: "data",
  payload_bytes_limit: 131072,
};
const sourceDirectory = resolve("docs/sources/analysis");
const h = await harness({
  capture: true,
  profile,
  sourceDirectory,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "0.1" },
});
let run,
  manager,
  passed = false;
const checks = [];
const conditions = {
  time_start: "2026-01-01T00:00:00Z",
  time_end: "2026-04-01T00:00:00Z",
  timezone: "UTC",
  metric: "net_revenue",
  channel: null,
  group_by: ["month"],
  filters: ["is_test=0", "paid_amount_cents>0"],
  knowledge_refs: [],
  notes: "截至快照，按付款月份归属退款。",
};
const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const attach = (value) => {
  run = value;
  manager = SessionManager.inMemory("/synthetic/data-agent");
};
const binding = () => ({ run_id: run.run_id, lease_epoch: run.lease_epoch });
const checkpoint = () =>
  exportCheckpoint(
    manager,
    run.workspace_context.authority_revision,
    run.workspace_context.authority_snapshot,
  );
const rawTool = async (name, args, sdk = randomUUID()) => {
  const input = {
    ...binding(),
    sdk_tool_call_id: sdk,
    tool_name: name,
    arguments: args,
    checkpoint: checkpoint(),
  };
  const registered = await h.internal("/internal/data/tool-calls", input);
  return {
    input,
    response:
      registered.status === 200
        ? await h.internal("/internal/data/tools", input)
        : registered,
  };
};
const tool = async (name, args) =>
  ok((await rawTool(name, args)).response).data;
const route = (task) =>
  tool("update_analysis_task", {
    action: "route",
    task_id: task.task_id,
    expected_version: task.condition_version,
    goal: "",
    options: [],
  });
const finish = async () => {
  const text = "已核对本次合成验证，保留原操作和条件归属。";
  ok(
    await h.internal("/internal/outputs", {
      ...binding(),
      chunk_seq: "1",
      text,
    }),
  );
  ok(
    await h.internal("/internal/finish", {
      ...binding(),
      commit_id: run.output_id,
      final_text: text,
      checkpoint: checkpoint(),
    }),
  );
  h.releaseRun(run.run_id);
};
const begin = async (cid, text, user = "alice") => {
  await h.resumeWorker();
  const message = await h.send(cid, text, user);
  try {
    attach(
      await until(
        () =>
          h.captured.find(
            (value) =>
              value.conversation_id === cid &&
              value.message_id === message.message_id,
          ),
        "evidence input",
        40000,
      ),
    );
  } catch (error) {
    await writeFile(
      h.directory + "/input-timeout.json",
      JSON.stringify(
        {
          cid,
          message_id: message.message_id,
          snapshot: await h.request(
            `/conversations/${cid}/snapshot`,
            undefined,
            user,
          ),
          captured: h.captured.map((value) => ({
            run_id: value.run_id,
            message_id: value.message_id,
            conversation_id: value.conversation_id,
          })),
        },
        null,
        2,
      ),
    );
    throw error;
  }
  await h.pauseWorker();
};
const assertRebuiltContext = async () => {
  const checkpoint =
    run.checkpoint?.storage?.kind === "host_checkpoint"
      ? ok(await h.internal("/internal/checkpoints/read", binding()))
      : run.checkpoint;
  if (checkpoint) {
    assert.ok(
      checkpoint.entries.every((entry) => entry.type === "session"),
      "重建只允许SDK空会话头，不能包含旧消息、工具、压缩摘要或分支",
    );
    assert.equal(checkpoint.leaf_id, null);
    assert.equal(checkpoint.storage, undefined);
    assert.deepEqual(checkpoint.authority_snapshot.query_results, []);
  }
  assert.deepEqual(run.workspace_context.authority_snapshot.query_results, []);
  assert.ok(
    run.workspace_context.recent_messages.every(
      (message) => message.role === "user",
    ),
    "重建不能混入无依赖标识的旧助手正文；本人安全用户输入可以续接",
  );
  for (const observation of run.workspace_context.query_observations)
    assert.deepEqual(Object.keys(observation).sort(), [
      "condition_version",
      "execution_state",
      "id",
      "task_id",
    ]);
};
const draft = (task, sql) =>
  tool("request_query", {
    task_id: task.task_id,
    condition_version: task.condition_version,
    sql,
    parameters: {},
    target_id: "synthetic-sqlite",
    summary: "独立合成证据验证SQL",
    knowledge_refs: [],
    replaces_query_id: null,
  });
const confirm = (query) =>
  h.request("/queries/" + query.id + "/confirm", {
    operation_id: randomUUID(),
    draft_version: query.draft_version,
    condition_version: query.condition_version,
  });
const readQuery = (query) => h.request("/queries/" + query.id);
const evidenceInput = (task, query, result, overrides = {}) => ({
  task_id: task.task_id,
  condition_version: task.condition_version,
  data_range: "独立合成数据，按查询明确的时间与过滤条件。",
  findings: [
    {
      text: "依据实际查询结果记录观察，不能据此推断业务因果。",
      calculation: "直接引用已保存结果中的值。",
      limitations: ["只覆盖本次查询范围。"],
      query_refs: [
        {
          query_id: query.id,
          result_ref: result.result_ref,
          columns: result.columns.map((column) => column.name),
        },
      ],
      knowledge_refs: [],
      figures: [],
    },
  ],
  ...overrides,
});
const countEvidence = () =>
  h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence")[0].n;
const rejectEvidence = async (input, code = "invalid_evidence") => {
  const before = countEvidence();
  const response = (await rawTool("save_analysis_evidence", input)).response;
  assert.equal(response.value.code, code, JSON.stringify(response.value));
  assert.equal(countEvidence(), before);
};
const modelBinding = () => ({
  ...binding(),
  call_attempt_id: randomUUID(),
  parameters_fingerprint: "a".repeat(64),
});
const reserve = (attempt) =>
  h.internal("/internal/model/reserve", {
    ...attempt,
    input_tokens_upper: 65536,
    output_tokens_max: 2048,
  });
const alterExpiry = (query, timestamp) =>
  execFileSync("python3", [
    "-c",
    "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('UPDATE submissions SET expires_at=? WHERE id=?',(float(sys.argv[3]),sys.argv[2])); d.commit()",
    h.directory + "/platform/submissions.sqlite",
    query.id,
    String(timestamp),
  ]);

try {
  const cid = await h.create();
  await begin(cid, "准备合成依据验证SQL，暂不执行。");
  const task = await tool("update_analysis_task", {
    action: "create",
    goal: "独立三个月分析证据",
    conditions,
    options: [],
  });
  const monthlySql = await readFile(
    sourceDirectory + "/evaluation/queries/monthly-net.sql",
    "utf8",
  );
  const sqls = [
    monthlySql,
    "SELECT '9007199254740993.01' AS amount",
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<205) SELECT x FROM n",
    "SELECT 1 AS value WHERE 0",
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1005) SELECT x FROM n",
  ];
  const queries = [];
  for (const sql of sqls) queries.push(await draft(task, sql));
  const otherTask = await tool("update_analysis_task", {
    action: "create",
    goal: "同会话另一任务",
    conditions,
    options: [],
  });
  const otherQuery = await draft(otherTask, "SELECT 7 AS other_task_value");
  await finish();
  for (const query of [...queries, otherQuery]) ok(await confirm(query));
  await h.resumeWorker();
  for (const query of [...queries, otherQuery])
    await until(
      async () => ok(await readQuery(query)).execution_state === "succeeded",
      "evidence query completes",
      40000,
    );
  attach(
    await until(
      () =>
        h.captured.find(
          (value) =>
            value.conversation_id === cid && value.text.includes("query_id="),
        ),
      "evidence result run",
      40000,
    ),
  );
  await h.pauseWorker();
  await route(task);
  const resultData = [];
  for (const query of queries)
    resultData.push((await tool("get_query", { query_id: query.id })).results);
  const [monthly, exact, pages, empty, partial] = resultData;
  assert.ok(monthly.result_ref);
  assert.equal(monthly.data_freshness, "synthetic_snapshot_2026-04-04");
  assert.deepEqual(
    monthly.rows.map((row) => row[3]),
    ["102000", "113000", "134000"],
  );
  assert.equal(exact.rows[0][0], "9007199254740993.01");
  const baseline = evidenceInput(task, queries[0], monthly);
  baseline.findings[0].figures = [
    {
      label: "三月净收入（分）",
      query_id: queries[0].id,
      column: "net_cents",
      row_index: 2,
      value: "134000",
    },
  ];
  const saved = await rawTool("save_analysis_evidence", baseline);
  const reference = ok(saved.response).data;
  assert.deepEqual(Object.keys(reference).sort(), [
    "condition_version",
    "conversation_id",
    "evidence_id",
    "result_dependencies",
    "task_id",
  ]);
  assert.deepEqual(reference.result_dependencies, [
    { query_id: queries[0].id, result_ref: monthly.result_ref },
  ]);
  assert.equal(reference.task_id, task.task_id);
  assert.ok(
    (
      await tool("read_analysis_task", { task_id: task.task_id })
    ).evidence_refs.some(
      (value) => value.evidence_id === reference.evidence_id,
    ),
  );
  const stored = h.sql(
    `SELECT body FROM analysis_evidence WHERE id='${reference.evidence_id}'`,
  )[0];
  assert.deepEqual(stored.conditions, conditions);
  assert.equal(stored.findings[0].figures[0].value, "134000");
  assert.equal(stored.rows, undefined);
  assert.deepEqual(
    ok(await h.internal("/internal/data/tools", saved.input)).data,
    reference,
  );
  const changedInput = {
    ...saved.input,
    arguments: { ...baseline, data_range: "换一个范围" },
  };
  assert.equal(
    (await h.internal("/internal/data/tool-calls", changedInput)).value.code,
    "idempotency_conflict",
  );
  assert.equal(countEvidence(), 1);
  checks.push(
    "同任务同条件的成功查询、真实result_ref与精确行列保存为轻量引用；只存当前条件/结论，不复制完整结果；同操作幂等且异参拒绝",
  );

  const corrupt = (mutation) => {
    const value = structuredClone(baseline);
    mutation(value.findings[0]);
    return value;
  };
  await rejectEvidence(
    corrupt(
      (finding) => (finding.query_refs[0].result_ref = "fake-result-reference"),
    ),
  );
  await rejectEvidence(
    corrupt((finding) => (finding.query_refs[0].columns = ["missing_column"])),
  );
  await rejectEvidence(
    corrupt((finding) => (finding.figures[0].column = "paid_cents")),
  );
  await rejectEvidence(
    corrupt((finding) => (finding.figures[0].row_index = 3)),
  );
  await rejectEvidence(
    corrupt((finding) => (finding.figures[0].value = 134000)),
  );
  await rejectEvidence(
    corrupt((finding) => (finding.figures[0].value = "134000.00")),
  );
  const otherResult = ok(
    await h.request("/queries/" + otherQuery.id + "/results"),
  );
  await rejectEvidence(evidenceInput(task, otherQuery, otherResult));
  const noSource = structuredClone(baseline);
  noSource.findings[0].query_refs = [];
  noSource.findings[0].figures = [];
  await rejectEvidence(noSource);
  checks.push(
    "伪造结果版本、缺失列、未引用列、越界行号、数字强转及不精确字符串都拒绝；另一任务及无来源结论不能保存",
  );

  const exactInput = evidenceInput(task, queries[1], exact);
  exactInput.findings[0].figures = [
    {
      label: "精确金额",
      query_id: queries[1].id,
      column: "amount",
      row_index: 0,
      value: "9007199254740993.01",
    },
  ];
  ok((await rawTool("save_analysis_evidence", exactInput)).response);
  const pageInput = evidenceInput(task, queries[2], pages);
  pageInput.findings[0].limitations = [];
  pageInput.findings[0].figures = [
    {
      label: "绝对第205行",
      query_id: queries[2].id,
      column: "x",
      row_index: 204,
      value: "205",
    },
  ];
  ok((await rawTool("save_analysis_evidence", pageInput)).response);
  const emptyInput = evidenceInput(task, queries[3], empty);
  emptyInput.findings[0].limitations = [];
  await rejectEvidence(emptyInput);
  emptyInput.findings[0].limitations = [
    "查询为空，不能据此判断范围外没有数据。",
  ];
  ok((await rawTool("save_analysis_evidence", emptyInput)).response);
  const partialInput = evidenceInput(task, queries[4], partial);
  partialInput.findings[0].limitations = [];
  await rejectEvidence(partialInput);
  partialInput.findings[0].limitations = [
    "源查询超过1000行，只覆盖已保存前1000行。",
  ];
  partialInput.findings[0].figures = [
    {
      label: "已保存末行",
      query_id: queries[4].id,
      column: "x",
      row_index: 999,
      value: "1000",
    },
  ];
  ok((await rawTool("save_analysis_evidence", partialInput)).response);
  checks.push(
    "大于安全整数的精确金额字符串保留；205行的完整保存按绝对行号核对；空/1000行截断必须说明限制",
  );

  const table = ok(await h.request("/knowledge/table-demo_order_detail"));
  const knowledgeInput = {
    task_id: task.task_id,
    condition_version: task.condition_version,
    data_range: "资料解释范围",
    findings: [
      {
        text: "表的一行是订单商品行。",
        calculation: "查阅当前资料，不包含查询数字。",
        limitations: [],
        query_refs: [],
        knowledge_refs: [
          { object_id: table.id, version: table.version, path: "description" },
        ],
        figures: [],
      },
    ],
  };
  ok((await rawTool("save_analysis_evidence", knowledgeInput)).response);
  const staleKnowledge = structuredClone(knowledgeInput);
  staleKnowledge.findings[0].knowledge_refs[0].version = "9999";
  await rejectEvidence(staleKnowledge, "stale_knowledge");
  assert.equal(
    (await h.request("/conversations/" + cid + "/snapshot", undefined, "bob"))
      .status,
    404,
  );
  assert.equal(
    (
      await h.request(
        "/queries/" + queries[0].id + "/results",
        undefined,
        "bob",
      )
    ).status,
    404,
  );
  const revised = await tool("update_analysis_task", {
    action: "revise",
    task_id: task.task_id,
    expected_version: task.condition_version,
    goal: "只看app",
    condition_patch: { set: { channel: "app" }, unset: [] },
    options: [],
  });
  await rejectEvidence(baseline, "version_conflict");
  await rejectEvidence({
    ...baseline,
    condition_version: revised.condition_version,
  });
  assert.deepEqual(
    (await tool("read_analysis_task", { task_id: task.task_id })).evidence_refs,
    [],
  );
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence WHERE id='${reference.evidence_id}'`,
    )[0].n,
    1,
  );
  const aliceRun = run,
    aliceManager = manager;
  const bobCid = await h.create("bob");
  await begin(bobCid, "不能采用另一用户的私人查询来保存本人分析。", "bob");
  const beforeForeignSave = countEvidence();
  const foreignSave = (await rawTool("save_analysis_evidence", baseline))
    .response;
  assert.equal(foreignSave.status, 404, JSON.stringify(foreignSave.value));
  assert.equal(countEvidence(), beforeForeignSave);
  assert.ok(!JSON.stringify(foreignSave.value).includes("134000"));
  const foreignStop = (
    await rawTool("cancel_query", { query_id: queries[0].id })
  ).response;
  assert.equal(foreignStop.status, 404, JSON.stringify(foreignStop.value));
  assert.ok(!JSON.stringify(foreignStop.value).includes("134000"));
  ok(
    await h.request(
      `/conversations/${bobCid}/messages/${run.message_id}/withdraw`,
      { operation_id: randomUUID() },
      "bob",
    ),
  );
  h.releaseRun(run.run_id);
  run = aliceRun;
  manager = aliceManager;
  checks.push(
    "资料-only观察也核对正式版本，跨用户无法读原会话/结果；改条件后的当前任务不挂旧证据，旧稿不能改标新条件",
  );

  const attempt = modelBinding();
  ok(await reserve(attempt));
  alterExpiry(queries[0], Date.now() / 1000 - 1);
  assert.equal(
    (await h.internal("/internal/model/send", attempt)).value.code,
    "stale_context",
  );
  assert.equal((await reserve(modelBinding())).value.code, "stale_context");
  const evidenceCountBeforeExpiry = countEvidence();
  const expiredSave = (await rawTool("save_analysis_evidence", baseline))
    .response;
  assert.equal(
    expiredSave.value.code,
    "stale_context",
    JSON.stringify(expiredSave.value),
  );
  assert.equal(countEvidence(), evidenceCountBeforeExpiry);
  const terminalStop = await rawTool("cancel_query", {
    query_id: queries[0].id,
  });
  const sanitizedStop = ok(terminalStop.response).data;
  assert.deepEqual(Object.keys(sanitizedStop).sort(), [
    "cancel_state",
    "condition_version",
    "execution_state",
    "id",
    "task_id",
  ]);
  assert.equal(sanitizedStop.execution_state, "succeeded");
  assert.deepEqual(
    ok(await h.internal("/internal/data/tools", terminalStop.input)).data,
    sanitizedStop,
  );
  assert.ok(!JSON.stringify(sanitizedStop).includes("134000"));
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('state',state) FROM model_call_attempts WHERE id='${attempt.call_attempt_id}'`,
    )[0].state,
    "reserved",
  );
  checks.push(
    "已采用的结果过期后reserve/send及新证据都拒绝旧上下文，既有预留不冒称发送；本人终态停止返回无SQL/结果的控制状态并幂等，保留succeeded；他人停止仍拒绝（运行中停止另由连续Pi流程验证）",
  );

  // 只恢复此测试时间夹具，再独立检验真实平台撤权；不会恢复任何用户生产数据。
  alterExpiry(queries[0], Date.now() / 1000 + 86400);
  const revokedAttempt = modelBinding();
  ok(await reserve(revokedAttempt));
  await writeFile(
    h.directory + "/platform/permissions.json",
    JSON.stringify({ denied_query_users: ["alice"] }),
  );
  assert.equal(
    (await h.internal("/internal/model/send", revokedAttempt)).value.code,
    "stale_context",
  );
  assert.equal((await reserve(modelBinding())).value.code, "stale_context");
  const previousRun = run;
  h.releaseRun(previousRun.run_id);
  h.sql(
    `UPDATE agent_runs SET state='interrupted' WHERE id='${previousRun.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${previousRun.message_id}';`,
  );
  await h.restartApi();
  const countBefore = h.captured.length;
  await h.resumeWorker();
  await until(
    () =>
      h
        .sql(
          `SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE message_id='${previousRun.message_id}'`,
        )
        .some((value) => value.state === "failed"),
    "撤权后原输入恢复被拒绝",
    40000,
  );
  await h.pauseWorker();
  assert.ok(
    h.logs.some((log) =>
      log.output
        .split("\n")
        .some(
          (line) =>
            line.includes("delivery_rejected") &&
            line.includes("stale_context"),
        ),
    ),
  );
  assert.ok(
    !h.captured
      .slice(countBefore)
      .some((value) => value.message_id === previousRun.message_id),
  );
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence WHERE id='${reference.evidence_id}'`,
    )[0].n,
    1,
  );
  // 已应用半轮不换身份重做；沿正式取消入口关闭原任务，再处理同对话的新输入。
  for (const active of [revised, otherTask])
    ok(
      await h.request(`/conversations/${cid}/tasks/${active.task_id}/cancel`, {
        operation_id: randomUUID(),
        expected_version: active.condition_version,
      }),
    );
  // 只清理应用已结束的手动通知替身；不能靠release替代正式取消仍活动的run。
  const fixtureStates = h.sql(
    `SELECT JSON_OBJECT('run_id',r.id,'state',r.state,'message_id',m.id,'disposition',m.disposition,'routed_task_id',m.routed_task_id) FROM agent_runs r JOIN conversation_messages m ON m.id=r.message_id WHERE r.conversation_id='${cid}'`,
  );
  await writeFile(
    h.directory + "/fixture-release.json",
    JSON.stringify(
      {
        fixtureStates,
        captureAborted: h.captureAborted,
      },
      null,
      2,
    ),
  );
  for (const fixture of h.captured.filter(
    (value) => value.conversation_id === cid,
  )) {
    const state = fixtureStates.find(
      (value) => value.run_id === fixture.run_id,
    );
    assert.ok(
      state &&
        ["finished", "failed", "cancelled", "interrupted"].includes(
          state.state,
        ),
      "捕获替身释放前应用run必须已经结束：" + JSON.stringify(state),
    );
    h.releaseRun(fixture.run_id);
  }
  await begin(cid, "之前分析停止，重新解释当前可读资料；不要引用旧查询结果。");
  await assertRebuiltContext();
  checks.push(
    "平台撤权阻止已预留发送和新调用；原输入恢复不得替换操作身份继续使用旧结果，同对话的新输入重建上下文并排除旧结果",
  );
  h.releaseRun(run.run_id);
  ok(
    await h.request(
      "/conversations/" + cid,
      { operation_id: randomUUID() },
      "alice",
      "DELETE",
    ),
  );
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence WHERE conversation_id='${cid}'`,
    )[0].n,
    0,
  );
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence_operations WHERE conversation_id='${cid}'`,
    )[0].n,
    0,
  );
  checks.push(
    "删除会话一并清理所有条件的分析证据及幂等命令引用，不能靠私人派生正文绕过删除",
  );

  // 独立文档仅通过HTTP取得引用，未由Pi读取；保存输入里的正文也必须采用其正式来源。
  const document = ok(
    await h.request("/knowledge", {
      operation_id: randomUUID(),
      kind: "document",
      name: "合成退款归属说明",
      body: "已确认的合成约定：退款归原付款时间范围；不表示退款实际发生日期。",
      related_ids: [],
    }),
  );
  const knowledgeCid = await h.create();
  await begin(knowledgeCid, "仅保存这份合成资料的解释依据，暂不取数。");
  const knowledgeTask = await tool("update_analysis_task", {
    action: "create",
    goal: "独立资料依据",
    conditions,
    options: [],
  });
  const knowledgeOnly = {
    task_id: knowledgeTask.task_id,
    condition_version: knowledgeTask.condition_version,
    data_range: "仅解释已确认文档，不包含查询数据。",
    findings: [
      {
        text: "旧资料依据正文标记：退款归原付款时间范围。",
        calculation: "采用资料约定，未计算数字。",
        limitations: [],
        query_refs: [],
        figures: [],
        knowledge_refs: [
          { object_id: document.id, version: document.version, path: "body" },
        ],
      },
    ],
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const sdkCall = randomUUID();
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: sdkCall,
        name: "save_analysis_evidence",
        arguments: knowledgeOnly,
      },
    ],
    api: "openai-completions",
    provider: "controlled_deepseek",
    model: "deepseek-flash",
    stopReason: "toolUse",
    usage,
    timestamp: Date.now(),
  });
  const knowledgeSaved = await rawTool(
    "save_analysis_evidence",
    knowledgeOnly,
    sdkCall,
  );
  const knowledgeReceipt = ok(knowledgeSaved.response).data;
  manager.appendMessage({
    role: "toolResult",
    toolCallId: sdkCall,
    toolName: "save_analysis_evidence",
    content: [{ type: "text", text: JSON.stringify(knowledgeReceipt) }],
    isError: false,
    timestamp: Date.now(),
  });
  await tool("read_analysis_task", { task_id: knowledgeTask.task_id });
  const authority = h.sql(
    `SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`,
  )[0];
  assert.ok(
    authority.knowledge.some(
      (value) => value[0] === document.id && value[1] === document.version,
    ),
  );
  const knowledgeAttempt = modelBinding();
  ok(await reserve(knowledgeAttempt));
  ok(
    await h.request(`/knowledge/${document.id}/disable`, {
      operation_id: randomUUID(),
      expected_version: document.version,
    }),
  );
  assert.equal(
    (await h.internal("/internal/model/send", knowledgeAttempt)).value.code,
    "stale_context",
  );
  assert.equal((await reserve(modelBinding())).value.code, "stale_context");
  const knowledgeOriginalRun = run;
  const knowledgeOriginalJob = h.sql(
    `SELECT JSON_OBJECT('id',id) FROM background_jobs WHERE message_id='${knowledgeOriginalRun.message_id}'`,
  )[0].id;
  h.releaseRun(run.run_id);
  h.sql(
    `UPDATE agent_runs SET state='interrupted' WHERE id='${run.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${knowledgeCid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${run.message_id}';`,
  );
  await h.restartApi();
  const knowledgeCapturedCount = h.captured.length;
  await h.resumeWorker();
  await until(
    () =>
      h
        .sql(
          `SELECT JSON_OBJECT('state',state) FROM background_jobs WHERE message_id='${knowledgeOriginalRun.message_id}'`,
        )
        .some((value) => value.state === "failed"),
    "仅资料依据停用后原输入恢复拒绝",
    40000,
  );
  await h.pauseWorker();
  assert.ok(
    h.logs.some((log) =>
      log.output
        .split("\n")
        .some(
          (line) =>
            line.includes("delivery_rejected job=" + knowledgeOriginalJob) &&
            line.includes("code=stale_context"),
        ),
    ),
    "仅资料依据恢复失败须匹配该输入的stale_context拒绝日志",
  );
  assert.ok(
    !h.captured
      .slice(knowledgeCapturedCount)
      .some((value) => value.message_id === knowledgeOriginalRun.message_id),
  );
  assert.equal(
    h.sql(
      `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_evidence WHERE id='${knowledgeReceipt.evidence_id}'`,
    )[0].n,
    1,
  );
  ok(
    await h.request(
      `/conversations/${knowledgeCid}/tasks/${knowledgeTask.task_id}/cancel`,
      {
        operation_id: randomUUID(),
        expected_version: knowledgeTask.condition_version,
      },
    ),
  );
  await begin(knowledgeCid, "重新调查当前有效资料，不采用停用文档的解释。");
  await assertRebuiltContext();
  assert.ok(
    !run.workspace_context.authority_snapshot.knowledge.some(
      (value) => value[0] === document.id,
    ),
  );
  assert.ok(
    !JSON.stringify(run.workspace_context).includes("旧资料依据正文标记"),
  );
  h.releaseRun(run.run_id);
  ok(
    await h.request(
      `/conversations/${knowledgeCid}`,
      { operation_id: randomUUID() },
      "alice",
      "DELETE",
    ),
  );
  checks.push(
    "未经过Pi读取的文档引用在保存知识-only依据时也采用正式版本；停用后reserve/send及原输入恢复拒绝，同对话新输入不接回旧正文或旧来源",
  );
  passed = true;
  console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
} finally {
  if (run) h.releaseRun(run.run_id);
  await writeFile(
    ".local/checks/analysis-evidence.json",
    JSON.stringify(
      {
        passed,
        checks,
        officialRequests: 0,
        scope: "实际Rust/MySQL/合成SQLite与受控工具；不证明真实模型分析准确率",
      },
      null,
      2,
    ) + "\n",
  );
  await h.close();
}
