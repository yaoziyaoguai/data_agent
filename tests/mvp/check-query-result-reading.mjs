import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";
import { ok } from "./skill-fixtures.mjs";

// 仅配置隔离账本的预留参数；capture模式不发送模型请求。
const profile = {
  provider_id: "deepseek",
  model_id: "deepseek-flash",
  trial_id: "result_reading_" + randomUUID(),
  price_version: "2026-10-04-peak-usd",
  input_limit: 65536,
  output_limit: 2048,
  trial_call_limit: 2,
  trial_cost_micros: "1000000",
  request_call_limit: 2,
  toolset: "data",
  payload_bytes_limit: 65536,
};
const h = await harness({
  capture: true,
  profile,
  env: { DATA_AGENT_LEASE_MS: "120000", DATA_AGENT_QUERY_DELAY_SECONDS: "0.1" },
});
const manager = SessionManager.inMemory("/synthetic/data-agent");
const checks = [];
const observations = {
  maxResultBytes: 0,
  maxToolReceiptBytes: 0,
  contentPages: 0,
};
let passed = false;
let run;
const checkpoint = () =>
  exportCheckpoint(
    manager,
    run.workspace_context.authority_revision,
    run.workspace_context.authority_snapshot,
  );
const rawInvoke = async (name, args) => {
  const input = {
    run_id: run.run_id,
    lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(),
    tool_name: name,
    arguments: args,
    checkpoint: checkpoint(),
  };
  const registered = await h.internal("/internal/data/tool-calls", input);
  if (registered.status !== 200) return registered;
  return h.internal("/internal/data/tools", input);
};
const invoke = async (name, args) => ok(await rawInvoke(name, args)).data;
const readPage = async (query, args = {}) => {
  const receipt = ok(
    await rawInvoke("get_query", { query_id: query.id, ...args }),
  );
  observations.maxToolReceiptBytes = Math.max(
    observations.maxToolReceiptBytes,
    Buffer.byteLength(JSON.stringify(receipt)),
  );
  const page = receipt.data.results;
  assert.ok(page && !page.error, JSON.stringify(page));
  assert.equal(receipt.data.query.result_ref, query.result_ref);
  assert.equal(page.query_id, query.id);
  assert.equal(page.result_ref, query.result_ref);
  const bytes = Buffer.byteLength(JSON.stringify(page));
  observations.maxResultBytes = Math.max(observations.maxResultBytes, bytes);
  assert.ok(bytes <= 23 * 1024, `${bytes} byte result page`);
  return page;
};
const readContent = async (query, args = {}) => {
  const parts = [];
  let offset = 0;
  let total;
  for (let index = 0; index < 100; index++) {
    const page = await readPage(query, { ...args, content_offset: offset });
    if (page.content_format === undefined) {
      assert.equal(index, 0, "续读不能突然换成不同的完整对象");
      return { value: page, pages: 1, chunked: false };
    }
    assert.equal(page.content_format, "json");
    assert.equal(page.rows, undefined, "分块JSON不能伪装成完整行");
    assert.equal(page.content_page.offset, offset);
    total ??= page.content_page.total_chars;
    assert.equal(page.content_page.total_chars, total);
    const length = Array.from(page.content_text).length;
    assert.ok(length > 0);
    parts.push(page.content_text);
    observations.contentPages++;
    if (page.content_page.complete) {
      assert.equal(page.content_page.next_offset, null);
      assert.equal(offset + length, total);
      return {
        value: JSON.parse(parts.join("")),
        pages: index + 1,
        chunked: true,
      };
    }
    assert.equal(page.content_page.next_offset, offset + length);
    offset = page.content_page.next_offset;
  }
  assert.fail("bounded synthetic content did not finish within 100 pages");
};
const expectReadError = async (query, args) => {
  const response = await rawInvoke("get_query", {
    query_id: query.id,
    ...args,
  });
  const error =
    response.status === 200
      ? (response.value.data?.results?.error ?? response.value.data?.error)
      : response.value.code;
  assert.equal(error, "invalid_input", JSON.stringify(response));
};
const assertResultDependencies = (queries) => {
  const expected = queries.map((query) => [query.id, query.result_ref]);
  const authority = h.sql(
    `SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`,
  )[0];
  assert.deepEqual(authority.query_results, expected);
  const storedCheckpoint = h.sql(
    `SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`,
  )[0];
  if (expected.length === 0 && storedCheckpoint === undefined) return;
  assert.ok(storedCheckpoint, "首个工具交付后应保存Pi检查点");
  assert.deepEqual(storedCheckpoint.authority_snapshot.query_results, expected);
};
const submissionState = (cid) =>
  h.sql(
    `SELECT JSON_OBJECT('id',id,'attempts',submission_attempts,'result_ref',result_ref,'sql',sql_text,'parameters',parameters) FROM query_requests WHERE conversation_id='${cid}' ORDER BY id`,
  );
const platformState = () =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import hashlib,json,sqlite3,sys\nwith sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True) as db:\n rows=db.execute('SELECT id,owner,fp,state,payload,result FROM submissions ORDER BY id').fetchall()\n print(json.dumps([{'id':r[0],'owner':r[1],'fingerprint':r[2],'state':r[3],'payload_sha256':hashlib.sha256(r[4].encode()).hexdigest(),'result_sha256':hashlib.sha256(r[5].encode()).hexdigest()} for r in rows]))",
        h.directory + "/platform/submissions.sqlite",
      ],
      { encoding: "utf8" },
    ),
  );

try {
  const cid = await h.create();
  run = await h.capture(cid, "准备合成宽结果、Unicode和空结果SQL，先不执行。");
  await h.pauseWorker();
  const task = await invoke("update_analysis_task", {
    action: "create",
    goal: "验证已保存结果可完整续读",
    conditions: {
      time_start: null,
      time_end: null,
      timezone: "UTC",
      metric: null,
      channel: null,
      group_by: [],
      filters: [],
      knowledge_refs: [],
      notes: "",
    },
    options: [],
  });
  const wideBody = "x".repeat(1500);
  const unicodeUnit = '中文🙂"\\\n';
  const unicodeValue = unicodeUnit.repeat(4096);
  const sqls = [
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) SELECT x AS serial, CAST(x AS TEXT)||'${wideBody}' AS detail FROM n ORDER BY x`,
    `WITH RECURSIVE t(n,body) AS (SELECT 0,'${unicodeUnit}' UNION ALL SELECT n+1,body||body FROM t WHERE n<12) SELECT body AS detail FROM t WHERE n=12 UNION ALL SELECT body FROM t WHERE n=12 UNION ALL SELECT NULL`,
    "SELECT 1 AS value WHERE 0",
    "SELECT NULL AS value",
  ];
  const drafts = [];
  for (const sql of sqls)
    drafts.push(
      await invoke("request_query", {
        task_id: task.task_id,
        condition_version: task.condition_version,
        sql,
        parameters: {},
        target_id: "synthetic-sqlite",
        replaces_query_id: null,
        summary: "从零合成结果读取验证",
        knowledge_refs: [],
      }),
    );
  await invoke("update_analysis_task", {
    action: "route",
    task_id: task.task_id,
    expected_version: task.condition_version,
    goal: "",
    options: [],
  });
  const text = "合成查询已准备。";
  ok(
    await h.internal("/internal/outputs", {
      run_id: run.run_id,
      lease_epoch: run.lease_epoch,
      chunk_seq: "1",
      text,
    }),
  );
  ok(
    await h.internal("/internal/finish", {
      run_id: run.run_id,
      lease_epoch: run.lease_epoch,
      commit_id: run.output_id,
      final_text: text,
      checkpoint: checkpoint(),
    }),
  );
  h.releaseRun(run.run_id);
  const draftRun = run.run_id;
  for (const query of drafts)
    ok(
      await h.request(`/queries/${query.id}/confirm`, {
        operation_id: randomUUID(),
        draft_version: query.draft_version,
        condition_version: query.condition_version,
      }),
    );
  await h.resumeWorker();
  const queries = [];
  for (const draft of drafts)
    queries.push(
      await until(async () => {
        const query = ok(await h.request(`/queries/${draft.id}`));
        assert.notEqual(query.execution_state, "failed", JSON.stringify(query));
        return query.execution_state === "succeeded" && query;
      }, "synthetic query finished"),
    );
  run = await until(
    () =>
      h.captured.find(
        (candidate) =>
          candidate.conversation_id === cid && candidate.run_id !== draftRun,
      ),
    "result delivery",
  );
  await h.pauseWorker();
  const beforeQueries = submissionState(cid);
  const beforePlatform = platformState();
  assert.equal(beforeQueries.length, 4);
  assert.ok(beforeQueries.every((query) => query.attempts === 1));
  assert.equal(beforePlatform.length, 4);

  // 三个不同查询各自首次交付统计、JSON片段、单元格；不能先读rows掩盖依赖漏记。
  assertResultDependencies([]);
  const initialStatistics = await readPage(queries[0], { view: "statistics" });
  assert.equal(initialStatistics.rows, undefined);
  assert.equal(initialStatistics.statistics.row_count, 100);
  assertResultDependencies([queries[0]]);
  const initialContent = await readPage(queries[1]);
  assert.equal(initialContent.content_format, "json");
  assert.equal(initialContent.rows, undefined);
  assertResultDependencies([queries[0], queries[1]]);
  const initialCell = await readPage(queries[3], {
    view: "cell",
    row_index: 0,
    column_index: 0,
  });
  assert.equal(initialCell.value, null);
  assert.equal(initialCell.rows, undefined);
  assertResultDependencies([queries[0], queries[1], queries[3]]);
  checks.push(
    "统计、首个JSON片段和NULL单元格首次交付即分别写入run及Pi检查点结果依赖，不依赖先读rows",
  );

  const rawWide = ok(await h.request(`/queries/${queries[0].id}/results`));
  const expectedRows = Array.from({ length: 100 }, (_, index) => [
    String(index + 1),
    String(index + 1) + wideBody,
  ]);
  assert.deepEqual(rawWide.rows, expectedRows);
  const rawWideBytes = Buffer.byteLength(JSON.stringify(rawWide));
  assert.ok(rawWideBytes > 128 * 1024 && rawWideBytes < 512 * 1024);
  observations.originalWideBytes = rawWideBytes;
  const delivered = [];
  let cursor = null;
  let widePages = 0;
  do {
    const { value: page } = await readContent(
      queries[0],
      cursor ? { cursor } : {},
    );
    assert.equal(page.fetched_offset, String(delivered.length));
    assert.ok(page.rows.length > 0 && page.rows.length < 100);
    assert.deepEqual(
      page.rows,
      expectedRows.slice(delivered.length, delivered.length + page.rows.length),
    );
    assert.equal(page.statistics.row_count, page.rows.length);
    assert.equal(page.statistics.scope, "page");
    assert.equal(page.saved_row_count, 100);
    assert.equal(page.saved_result_complete, true);
    delivered.push(...page.rows);
    cursor = page.next_cursor;
    if (cursor !== null) assert.equal(cursor, String(delivered.length));
    assert.ok(++widePages <= 100);
  } while (cursor !== null);
  assert.deepEqual(delivered, expectedRows);
  observations.widePages = widePages;
  checks.push(
    "超过128KiB的合法100行平台页经get_query字节分页，全部行与精确值按绝对游标恢复，无丢失或重复",
  );

  const wideStatistics = (await readContent(queries[0], { view: "statistics" }))
    .value;
  assert.equal(wideStatistics.rows, undefined);
  assert.equal(wideStatistics.statistics.row_count, 100);
  assert.equal(wideStatistics.statistics.scope, "complete_result");
  assert.deepEqual(wideStatistics.statistics.columns[0].numeric_counts, {
    negative: 0,
    zero: 0,
    positive: 100,
  });
  assert.equal(wideStatistics.statistics.columns[1].distinct_count, 100);
  const tailStatistics = (
    await readContent(queries[0], { view: "statistics", cursor: "90" })
  ).value;
  assert.equal(tailStatistics.fetched_offset, "90");
  assert.equal(tailStatistics.statistics.row_count, 10);
  assert.equal(tailStatistics.statistics.scope, "page");
  const absoluteCell = (
    await readContent(queries[0], {
      view: "cell",
      row_index: 90,
      column_index: 1,
    })
  ).value;
  assert.equal(absoluteCell.row_index, 90);
  assert.equal(absoluteCell.value, "91" + wideBody);
  checks.push(
    "统计独立读取原平台100行范围，尾页保持page标记；单元格坐标使用绝对行号",
  );

  const rawUnicode = ok(await h.request(`/queries/${queries[1].id}/results`));
  assert.deepEqual(rawUnicode.rows, [[unicodeValue], [unicodeValue], [null]]);
  assert.ok(Buffer.byteLength(JSON.stringify(rawUnicode)) < 512 * 1024);
  const longCell = await readContent(queries[1], {
    view: "cell",
    row_index: 1,
    column_index: 0,
  });
  assert.equal(longCell.chunked, true);
  assert.ok(longCell.pages > 1);
  assert.equal(longCell.value.row_index, 1);
  assert.equal(longCell.value.value, unicodeValue);
  const longRow = await readContent(queries[1]);
  assert.equal(longRow.chunked, true);
  assert.deepEqual(longRow.value.rows, [[unicodeValue]]);
  assert.equal(longRow.value.next_cursor, "1");
  const secondRow = await readContent(queries[1], { cursor: "1" });
  assert.deepEqual(secondRow.value.rows, [[unicodeValue]]);
  assert.equal(secondRow.value.fetched_offset, "1");
  assert.equal(secondRow.value.next_cursor, "2");
  const nullRow = (await readContent(queries[1], { cursor: "2" })).value;
  assert.deepEqual(nullRow.rows, [[null]]);
  assert.equal(nullRow.next_cursor, null);
  const repeatedStatistics = await readContent(queries[1], {
    view: "statistics",
  });
  assert.equal(repeatedStatistics.chunked, true);
  assert.equal(repeatedStatistics.value.statistics.scope, "complete_result");
  assert.equal(repeatedStatistics.value.statistics.row_count, 3);
  assert.deepEqual(repeatedStatistics.value.statistics.columns[0], {
    column_index: 0,
    column_name: "detail",
    non_null_count: 2,
    null_count: 1,
    distinct_count: 1,
    repeated_values: [{ value: unicodeValue, count: 2 }],
    numeric_counts: null,
  });
  checks.push(
    "超大Unicode单行、指定单元格和重复长值统计按JSON文本续读，中文/emoji/转义字符逐值精确重组",
  );

  const nullCell = (
    await readContent(queries[1], {
      view: "cell",
      row_index: 2,
      column_index: 0,
    })
  ).value;
  assert.equal(nullCell.value, null);
  const empty = (await readContent(queries[2])).value;
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.statistics.row_count, 0);
  assert.equal(empty.next_cursor, null);
  for (const args of [
    { content_offset: 4194304 },
    { view: "cell", row_index: 999, column_index: 0 },
    { view: "cell", row_index: 0, column_index: 99 },
    { view: "cell", row_index: 0, column_index: 0, cursor: "0" },
    { view: "cell", row_index: 0, column_index: 0, content_offset: -1 },
    { cursor: "1001" },
  ])
    await expectReadError(queries[1], args);
  await expectReadError(queries[1], {
    view: "cell",
    row_index: 2,
    column_index: 0,
    content_offset: 1,
  });
  checks.push(
    "NULL与空结果保持原义，非法行列/游标/内容偏移被拒绝，不返回伪造空值",
  );

  assert.notEqual(
    (await h.request(`/queries/${queries[0].id}/results`, undefined, "bob"))
      .status,
    200,
  );
  const aliceRun = run;
  await h.resumeWorker();
  const bobCid = await h.create("bob");
  const bobMessage = await h.send(bobCid, "读取合成结果", "bob");
  run = await until(
    () =>
      h.captured.find(
        (candidate) => candidate.message_id === bobMessage.message_id,
      ),
    "bob input",
  );
  await h.pauseWorker();
  for (const args of [
    {},
    { view: "statistics" },
    { view: "cell", row_index: 0, column_index: 1 },
  ]) {
    const response = await rawInvoke("get_query", {
      query_id: queries[0].id,
      ...args,
    });
    assert.notEqual(response.status, 200);
    assert.equal(response.value.code, "not_available");
  }
  assert.deepEqual(submissionState(cid), beforeQueries);
  assert.deepEqual(platformState(), beforePlatform);
  assert.equal(
    ok(await h.request(`/conversations/${cid}/queries`)).queries.length,
    4,
  );
  checks.push(
    "其他用户经HTTP及get_query三种读取视图均被拒绝；读取前后查询、SQL、result_ref、提交次数和平台账本不变",
  );

  run = aliceRun;
  const reserve = (attempt) =>
    h.internal("/internal/model/reserve", {
      run_id: run.run_id,
      lease_epoch: run.lease_epoch,
      call_attempt_id: attempt,
      parameters_fingerprint: "a".repeat(64),
      input_tokens_upper: profile.input_limit,
      output_tokens_max: profile.output_limit,
    });
  const validAttempt = randomUUID();
  ok(await reserve(validAttempt));
  execFileSync("python3", [
    "-c",
    "import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute('UPDATE submissions SET expires_at=0 WHERE id=?',(sys.argv[2],))",
    h.directory + "/platform/submissions.sqlite",
    queries[0].id,
  ]);
  const deniedAttempt = randomUUID();
  const denied = await reserve(deniedAttempt);
  assert.notEqual(denied.status, 200);
  assert.equal(denied.value.code, "stale_context");
  assert.deepEqual(
    h.sql(
      `SELECT JSON_OBJECT('id',id,'state',state) FROM model_call_attempts WHERE id IN ('${validAttempt}','${deniedAttempt}') ORDER BY id`,
    ),
    [{ id: validAttempt, state: "reserved" }],
  );
  checks.push(
    "已读结果过期后同run的下一次模型reserve被stale_context拒绝，新尝试未预留，已有未发送预留保持reserved",
  );

  passed = true;
  console.log(
    JSON.stringify({ passed, checks, observations, officialRequests: 0 }),
  );
} finally {
  await mkdir(".local/checks", { recursive: true });
  await writeFile(
    ".local/checks/query-result-reading.json",
    JSON.stringify(
      { passed, checks, observations, officialRequests: 0 },
      null,
      2,
    ),
  );
  await h.close();
}
