import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { harness, until } from "./harness.mjs";

export const ok = (response) => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};

// 两份报告验证共用真实API/SQL/依据夹具，数字预期独立于产品返回值。
export async function createReportFixture(options = {}) {
  const h = await harness({
    capture: true,
    web: options.web ?? false,
    sourceDirectory: resolve("docs/sources/analysis"),
    env: {
      DATA_AGENT_QUERY_DELAY_SECONDS: "0.1",
      DATA_AGENT_LEASE_MS: "120000",
    },
  });
  try {
    let run, manager;
    const handled = new Set();
    const attach = (value) => {
      run = value;
      manager = SessionManager.inMemory("/synthetic/data-agent");
    };
    const binding = () => ({
      run_id: run.run_id,
      lease_epoch: run.lease_epoch,
    });
    const checkpoint = () =>
      exportCheckpoint(
        manager,
        run.workspace_context.authority_revision,
        run.workspace_context.authority_snapshot,
      );
    const invokeRaw = async (name, args, sdk = randomUUID()) => {
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
    const invoke = async (name, args) =>
      ok((await invokeRaw(name, args)).response).data;
    const route = (task) =>
      invoke("update_analysis_task", {
        action: "route",
        task_id: task.task_id,
        expected_version: task.condition_version,
        goal: "",
        options: [],
      });
    const finish = async (
      text = "已保存本次分析依据，可打开报告或继续补充条件。",
    ) => {
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
      handled.add(run.run_id);
      h.releaseRun(run.run_id);
    };
    const begin = async (cid, text) => {
      await h.resumeWorker();
      const message = await h.send(cid, text);
      attach(
        await until(
          () =>
            h.captured.find(
              (value) =>
                value.conversation_id === cid &&
                value.message_id === message.message_id,
            ),
          "报告用户输入",
          40000,
        ),
      );
      await h.pauseWorker();
    };
    const conditions = {
      time_start: "2026-01-01T00:00:00Z",
      time_end: "2026-04-01T00:00:00Z",
      timezone: "UTC",
      metric: "net_revenue",
      channel: null,
      group_by: ["month"],
      filters: ["is_test=0", "paid_amount_cents>0"],
      knowledge_refs: [],
      notes: "付款归属截至4月4日退款，金额单位为分；不得推断因果。",
    };
    const cid = await h.create();
    await begin(cid, "先准备一季度分析报告的SQL，等待执行后核对依据。");
    let task = await invoke("update_analysis_task", {
      action: "create",
      goal: "一季度分析报告",
      conditions,
      options: [],
    });
    const otherTask = await invoke("update_analysis_task", {
      action: "create",
      goal: "另一独立分析",
      conditions,
      options: [],
    });
    const draft = (target, sql) =>
      invoke("request_query", {
        task_id: target.task_id,
        condition_version: target.condition_version,
        sql,
        parameters: {},
        target_id: "synthetic-sqlite",
        summary: "报告验证的已展示SQL。",
        knowledge_refs: [],
        replaces_query_id: null,
      });
    const sqls = [
      await readFile(
        "docs/sources/analysis/evaluation/queries/monthly-net.sql",
        "utf8",
      ),
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<205) SELECT x AS point,x*2 AS amount FROM n ORDER BY point",
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1005) SELECT x AS point,x*2 AS amount FROM n ORDER BY point",
      "SELECT 1 AS point,2 AS amount WHERE 0 ORDER BY point",
      "SELECT '精确金额' AS category,'9007199254740993.01' AS amount",
    ];
    const queries = [];
    for (const sql of sqls) queries.push(await draft(task, sql));
    const foreignQuery = await draft(
      otherTask,
      "SELECT '另一任务' AS category,99 AS amount",
    );
    const canceledQuery = await draft(
      task,
      "SELECT '已取消' AS category,88 AS amount",
    );
    await finish("已展示报告所用SQL。");
    ok(
      await h.request(`/queries/${canceledQuery.id}/cancel`, {
        operation_id: randomUUID(),
      }),
    );
    const readQuery = async (query) =>
      ok(await h.request(`/queries/${query.id}`));
    const confirm = async (query) =>
      ok(
        await h.request(`/queries/${query.id}/confirm`, {
          operation_id: randomUUID(),
          draft_version: query.draft_version,
          condition_version: query.condition_version,
        }),
      );
    for (const query of [...queries, foreignQuery]) await confirm(query);
    const evidence = [],
      results = [];
    let foreignEvidence;
    const saveResultEvidence = async (target, query, result, index = -1) => {
      const text =
        index === 0
          ? "三月净收入134000分；一月至三月依次为102000、113000、134000分。"
          : "合成观察：依据实际保存的行列展示；不对业务原因作推断。";
      return invoke("save_analysis_evidence", {
        task_id: target.task_id,
        condition_version: target.condition_version,
        data_range: "UTC，一季度付款；退款截至4月4日；金额单位分。",
        findings: [
          {
            text,
            calculation: "采用SQL返回的原值，未进行浮点换算。",
            limitations: [
              "只覆盖本次查询；空结果不表示业务总额为零。",
              "部分结果不能代表全部明细。",
              "贡献和关联不能证明因果。",
            ],
            query_refs: [
              {
                query_id: query.id,
                result_ref: result.result_ref,
                columns: result.columns.map((value) => value.name),
              },
            ],
            knowledge_refs: [],
            figures:
              index === 0
                ? [
                    {
                      label: "三月净收入（分）",
                      query_id: query.id,
                      column: "net_cents",
                      row_index: 2,
                      value: "134000",
                    },
                  ]
                : [],
          },
        ],
      });
    };
    // 实际处理每条结果通知，结束捕获替身，后续用户消息不会被旧通知占住。
    await h.resumeWorker();
    for (const query of [...queries, foreignQuery])
      await until(
        async () => (await readQuery(query)).execution_state === "succeeded",
        "报告查询完成",
        40000,
      );
    for (let count = 0; count < queries.length + 1; count++) {
      attach(
        await until(
          () =>
            h.captured.find(
              (value) =>
                value.conversation_id === cid &&
                !handled.has(value.run_id) &&
                value.text.includes("query_id="),
            ),
          "报告查询结果通知",
          40000,
        ),
      );
      await h.pauseWorker();
      const query = [...queries, foreignQuery].find((value) =>
        run.text.includes("query_id=" + value.id),
      );
      assert.ok(query);
      const target = query.id === foreignQuery.id ? otherTask : task;
      await route(target);
      const firstPage = (await invoke("get_query", { query_id: query.id }))
        .results;
      assert.ok(firstPage);
      const rows = [...firstPage.rows];
      let page = firstPage,
        pages = 1;
      while (page.next_cursor) {
        assert.ok(pages++ < 10, "只读取既有1000行保存范围，不扩展查询上限");
        page = (
          await invoke("get_query", {
            query_id: query.id,
            cursor: page.next_cursor,
          })
        ).results;
        assert.equal(page.result_ref, firstPage.result_ref);
        assert.equal(Number(page.fetched_offset), rows.length);
        assert.deepEqual(page.columns, firstPage.columns);
        rows.push(...page.rows);
      }
      const result = {
        ...firstPage,
        rows,
        next_cursor: null,
        result_complete: firstPage.saved_result_complete === true,
      };
      const index = queries.findIndex((value) => value.id === query.id);
      if (index === 0)
        assert.deepEqual(
          result.rows.map((row) => row[3]),
          ["102000", "113000", "134000"],
        );
      if (index === 1) {
        assert.equal(result.rows.length, 205);
        assert.equal(result.rows[204][1], "410");
      }
      if (index === 2) {
        assert.equal(result.rows.length, 1000);
        assert.equal(result.saved_result_complete, false);
      }
      if (index === 3) assert.equal(result.rows.length, 0);
      if (index === 4) assert.equal(result.rows[0][1], "9007199254740993.01");
      const saved = await saveResultEvidence(target, query, result, index);
      if (index >= 0) {
        results[index] = result;
        evidence[index] = saved;
      } else foreignEvidence = saved;
      await finish();
      await h.resumeWorker();
    }
    await h.pauseWorker();
    const chart = (index, overrides = {}) => ({
      kind: "line",
      title: index === 0 ? "一季度月度净收入" : "合成分类比较",
      query_id: queries[index].id,
      result_ref: results[index].result_ref,
      dimension_column:
        index === 0 ? "month" : index === 4 ? "category" : "point",
      measure_column: index === 0 ? "net_cents" : "amount",
      ...overrides,
    });
    const reportPath = (target = task) =>
      `/conversations/${cid}/tasks/${target.task_id}/report`;
    const saveInput = (overrides = {}) => ({
      operation_id: randomUUID(),
      task_id: task.task_id,
      condition_version: task.condition_version,
      expected_version: null,
      title: "一季度净收入分析",
      evidence_ids: [evidence[0].evidence_id, evidence[1].evidence_id],
      charts: [chart(0), chart(1)],
      ...overrides,
    });
    const alterExpiry = (query, timestamp) =>
      execFileSync("python3", [
        "-c",
        "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('UPDATE submissions SET expires_at=? WHERE id=?',(float(sys.argv[3]),sys.argv[2])); d.commit()",
        h.directory + "/platform/submissions.sqlite",
        query.id,
        String(timestamp),
      ]);
    return {
      h,
      cid,
      get task() {
        return task;
      },
      set task(value) {
        task = value;
      },
      otherTask,
      queries,
      results,
      evidence,
      foreignQuery,
      foreignEvidence,
      canceledQuery,
      conditions,
      invoke,
      invokeRaw,
      begin,
      route,
      draft,
      finish,
      confirm,
      readQuery,
      saveResultEvidence,
      chart,
      reportPath,
      saveInput,
      alterExpiry,
      get run() {
        return run;
      },
      get checkpoint() {
        return checkpoint();
      },
      async collectNew(query, target) {
        await h.resumeWorker();
        await until(
          async () => (await readQuery(query)).execution_state === "succeeded",
          "新条件报告查询完成",
          40000,
        );
        attach(
          await until(
            () =>
              h.captured.find(
                (value) =>
                  value.conversation_id === cid &&
                  !handled.has(value.run_id) &&
                  value.text.includes("query_id=" + query.id),
              ),
            "新条件报告结果通知",
            40000,
          ),
        );
        await h.pauseWorker();
        await route(target);
        const result = (await invoke("get_query", { query_id: query.id }))
          .results;
        const saved = await saveResultEvidence(target, query, result);
        await finish();
        return { result, evidence: saved };
      },
      async close() {
        if (run) h.releaseRun(run.run_id);
        await h.close();
      },
    };
  } catch (error) {
    for (const captured of h.captured) h.releaseRun(captured.run_id);
    await h.close();
    throw error;
  }
}

async function checkReports() {
  const checks = [];
  let passed = false,
    fixture;
  try {
    fixture = await createReportFixture();
    const { h, cid, queries, evidence, chart, reportPath, saveInput } = fixture;
    const read = async () => ok(await h.request(reportPath()));
    const unavailable = (view, status) => {
      assert.equal(view.status, status);
      assert.deepEqual(Object.keys(view).sort(), ["reference", "status"]);
      assert.ok(!JSON.stringify(view).includes("134000"));
      assert.ok(!JSON.stringify(view).includes("9007199254740993"));
    };
    const initial = saveInput();
    let reference = ok(await h.request(reportPath(), initial));
    assert.equal(reference.task_id, fixture.task.task_id);
    assert.equal(reference.condition_version, fixture.task.condition_version);
    assert.equal(reference.version, "1");
    const available = await read();
    assert.equal(available.status, "available");
    assert.deepEqual(available.reference, reference);
    assert.equal(available.report.title, initial.title);
    assert.deepEqual(available.report.charts, initial.charts);
    assert.equal(available.report.evidence.length, 2);
    const points = available.chart_results.find(
      (value) => value.query_id === queries[1].id,
    );
    assert.equal(points.rows.length, 205);
    assert.equal(points.rows[204][1], "410");
    assert.equal(points.saved_result_complete, true);
    const originalRevision = h.sql(
      `SELECT body FROM analysis_report_revisions WHERE report_id='${reference.report_id}' AND version=1`,
    )[0];
    const forbiddenBodyKeys = (value) => {
      if (!value || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, item]) => [
        ...(["rows", "sql", "parameters", "chart_results"].includes(key)
          ? [key]
          : []),
        ...forbiddenBodyKeys(item),
      ]);
    };
    assert.deepEqual(forbiddenBodyKeys(originalRevision), []);
    checks.push(
      "本人报告从当前任务/条件的已保存依据组装；图表回读205点完整保存结果，不能只取前10行预览",
    );

    assert.deepEqual(ok(await h.request(reportPath(), initial)), reference);
    const changedReplay = await h.request(reportPath(), {
      ...initial,
      title: "异参重放",
    });
    assert.equal(changedReplay.value.code, "idempotency_conflict");
    const stale = await h.request(
      reportPath(),
      saveInput({ expected_version: "9999" }),
    );
    assert.equal(stale.value.code, "version_conflict");
    reference = ok(
      await h.request(
        reportPath(),
        saveInput({
          expected_version: reference.version,
          title: "已修订净收入报告",
        }),
      ),
    );
    assert.equal(reference.version, "2");
    assert.equal((await h.request(reportPath(), undefined, "bob")).status, 404);
    assert.equal(
      (
        await h.request(
          reportPath(),
          saveInput({ expected_version: "2" }),
          "bob",
        )
      ).status,
      404,
    );
    assert.equal((await read()).reference.version, "2");
    checks.push(
      "稳定命令同参返回原引用、异参拒绝；expected_version防并发覆盖；报告修订与条件版本独立，另一用户不能读写",
    );

    for (const overrides of [
      { charts: [chart(0, { measure_column: "missing_amount" })] },
      { charts: [chart(0, { result_ref: "fabricated-result" })] },
      { charts: [chart(0, { measure_column: "month" })] },
      { evidence_ids: [fixture.foreignEvidence.evidence_id], charts: [] },
      {
        charts: [
          chart(0, {
            query_id: fixture.canceledQuery.id,
            result_ref: "canceled-result",
          }),
        ],
      },
      { charts: [chart(4, { kind: "bar" })] },
    ]) {
      const rejected = await h.request(
        reportPath(),
        saveInput({ expected_version: reference.version, ...overrides }),
      );
      assert.ok(rejected.status >= 400, JSON.stringify(rejected.value));
      assert.equal((await read()).reference.version, reference.version);
    }
    assert.equal(
      (await fixture.readQuery(fixture.canceledQuery)).execution_state,
      "cancelled",
    );
    checks.push(
      "不存在或文本度量列、伪造结果、未选来源、另一任务及取消查询均不能成为图表/报告依据；拒绝不会生成修订",
    );

    reference = ok(
      await h.request(
        reportPath(),
        saveInput({
          expected_version: reference.version,
          title: "空结果、覆盖范围与精确金额",
          evidence_ids: evidence.slice(2).map((value) => value.evidence_id),
          charts: [chart(2), chart(3), chart(4, { kind: "bar" })],
        }),
      ),
    );
    const coverage = await read();
    assert.equal(coverage.status, "available");
    const partial = coverage.chart_results.find(
      (value) => value.query_id === queries[2].id,
    );
    assert.equal(partial.rows.length, 1000);
    assert.equal(partial.saved_result_complete, false);
    assert.equal(
      coverage.chart_results.find((value) => value.query_id === queries[3].id)
        .rows.length,
      0,
    );
    assert.equal(
      coverage.chart_results.find((value) => value.query_id === queries[4].id)
        .rows[0][1],
      "9007199254740993.01",
    );
    assert.ok(
      coverage.report.evidence.every((value) =>
        value.findings.every((finding) => finding.limitations.length),
      ),
    );
    checks.push(
      "报告保留1000行截断、空结果与限制；精确金额保持字符串，不用浮点转换或把空结果伪装成零",
    );

    await fixture.begin(cid, "保存刚才的报告修订，不重新执行SQL。");
    await fixture.route(fixture.task);
    // 新的空原生检查点没有旧报告正文；再增加依据，原报告选中项均不在任务最近5项中。
    for (let index = 0; index < 6; index++)
      await fixture.saveResultEvidence(
        fixture.task,
        queries[0],
        fixture.results[0],
      );
    const recentTask = await fixture.invoke("read_analysis_task", {
      task_id: fixture.task.task_id,
    });
    const selectedIds = evidence.slice(2).map((value) => value.evidence_id);
    assert.ok(
      recentTask.evidence_refs.every(
        (value) => !selectedIds.includes(value.evidence_id),
      ),
    );
    assert.ok(
      fixture.checkpoint.entries.every((entry) => entry.type === "session"),
    );
    assert.equal(fixture.checkpoint.leaf_id, null);
    const restored = await fixture.invoke("read_analysis_report", {
      task_id: fixture.task.task_id,
    });
    assert.equal(restored.status, "available");
    assert.equal(restored.reference.version, reference.version);
    assert.deepEqual(restored.evidence_ids, selectedIds);
    assert.deepEqual(restored.charts, coverage.report.charts);
    assert.ok(Array.from(restored.content_text).length <= 8192);
    assert.ok(Buffer.byteLength(JSON.stringify(restored)) <= 23 * 1024);
    const excerpt = await fixture.invoke("read_analysis_report", {
      task_id: fixture.task.task_id,
      offset: 0,
      limit: 128,
    });
    assert.equal(excerpt.content_page.offset, 0);
    assert.equal(excerpt.content_page.complete, false);
    assert.ok(Array.from(excerpt.content_text).length <= 128);
    const continuation = await fixture.invoke("read_analysis_report", {
      task_id: fixture.task.task_id,
      version: excerpt.reference.version,
      offset: excerpt.content_page.next_offset,
      limit: 128,
    });
    assert.equal(
      continuation.content_page.offset,
      excerpt.content_page.next_offset,
    );
    assert.equal(
      restored.content_text.startsWith(
        excerpt.content_text + continuation.content_text,
      ),
      true,
    );
    const staleRead = (
      await fixture.invokeRaw("read_analysis_report", {
        task_id: fixture.task.task_id,
        version: "9999",
      })
    ).response;
    assert.equal(staleRead.value.code, "version_conflict");
    const toolInput = {
      task_id: fixture.task.task_id,
      condition_version: fixture.task.condition_version,
      expected_version: restored.reference.version,
      title: "通过聊天仅改标题的报告修订",
      evidence_ids: restored.evidence_ids,
      charts: restored.charts,
    };
    const savedTool = await fixture.invokeRaw(
      "save_analysis_report",
      toolInput,
    );
    reference = ok(savedTool.response).data;
    assert.equal(reference.version, "4");
    assert.deepEqual(
      ok(await h.internal("/internal/data/tools", savedTool.input)).data,
      reference,
    );
    await fixture.finish("报告已保存，可继续修改条件。");
    assert.equal((await read()).reference.version, "4");
    assert.deepEqual((await read()).report.charts, coverage.report.charts);
    assert.deepEqual(
      (await read()).report.evidence.map(
        (value) => value.reference.evidence_id,
      ),
      selectedIds,
    );
    assert.deepEqual(
      h.sql(
        `SELECT body FROM analysis_report_revisions WHERE report_id='${reference.report_id}' AND version=1`,
      )[0],
      originalRevision,
    );
    assert.equal(
      h.sql(
        `SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE conversation_id='${cid}'`,
      )[0].n,
      7,
    );
    checks.push(
      "空原生检查点通过有界、同版分页读取实际HTTP修订，保全不在任务最近5项的选中依据与图表；Pi仅改标题并稳定重放，不新增SQL查询",
    );

    await fixture.begin(cid, "把报告范围改为新的合成比较，先给SQL。");
    fixture.task = await fixture.invoke("update_analysis_task", {
      action: "revise",
      task_id: fixture.task.task_id,
      expected_version: fixture.task.condition_version,
      goal: "新条件报告",
      condition_patch: { set: { channel: "app", group_by: [] }, unset: [] },
      options: [],
    });
    unavailable(await read(), "condition_changed");
    const changedPage = await fixture.invoke("read_analysis_report", {
      task_id: fixture.task.task_id,
    });
    unavailable(changedPage, "condition_changed");
    assert.ok(
      (
        await h.request(
          reportPath(),
          saveInput({ expected_version: reference.version }),
        )
      ).status >= 400,
    );
    const newQuery = await fixture.draft(
      fixture.task,
      "SELECT '新条件' AS category,42 AS amount",
    );
    await fixture.finish("新条件SQL已准备好。");
    await fixture.confirm(newQuery);
    const replacement = await fixture.collectNew(newQuery, fixture.task);
    assert.deepEqual(replacement.result.rows, [["新条件", "42"]]);
    reference = ok(
      await h.request(
        reportPath(),
        saveInput({
          expected_version: reference.version,
          title: "新条件完成后的报告",
          evidence_ids: [replacement.evidence.evidence_id],
          charts: [
            {
              kind: "bar",
              title: "新条件合成比较",
              query_id: newQuery.id,
              result_ref: replacement.result.result_ref,
              dimension_column: "category",
              measure_column: "amount",
            },
          ],
        }),
      ),
    );
    assert.equal(reference.version, "5");
    assert.equal(
      (await read()).reference.condition_version,
      fixture.task.condition_version,
    );
    checks.push(
      "修改条件立即使旧报告只显示condition_changed；旧依据不能改标签复用，获得新条件结果和依据后再建立新修订",
    );

    fixture.alterExpiry(newQuery, Date.now() / 1000 - 1);
    unavailable(await read(), "sources_unavailable");
    await fixture.begin(cid, "核对这份当前报告的依据是否仍然有效。");
    await fixture.route(fixture.task);
    unavailable(
      await fixture.invoke("read_analysis_report", {
        task_id: fixture.task.task_id,
      }),
      "sources_unavailable",
    );
    await fixture.finish("报告依据已不可用，需重新核对后再继续分析。");
    assert.ok(
      (
        await h.request(
          reportPath(),
          saveInput({
            expected_version: reference.version,
            evidence_ids: [replacement.evidence.evidence_id],
            charts: [],
          }),
        )
      ).status >= 400,
    );
    fixture.alterExpiry(newQuery, Date.now() / 1000 + 86400);
    await writeFile(
      h.directory + "/platform/permissions.json",
      JSON.stringify({ denied_query_users: ["alice"] }),
    );
    unavailable(await read(), "sources_unavailable");
    await writeFile(
      h.directory + "/platform/permissions.json",
      JSON.stringify({}),
    );
    assert.equal((await read()).status, "available");
    checks.push(
      "结果过期或平台撤权后报告只返回状态与引用，不能读取保存数字、正文或图表；恢复仅限本次隔离测试夹具",
    );

    await h.pausePlatform();
    const unavailableNetwork = await h.request(reportPath());
    assert.ok(
      unavailableNetwork.status >= 400,
      JSON.stringify(unavailableNetwork.value),
    );
    assert.notEqual(unavailableNetwork.value.status, "sources_unavailable");
    await h.resumePlatform();
    assert.equal((await read()).status, "available");
    checks.push(
      "平台网络不可用报告明确接口失败，不能冒称来源已失效或返回空正文作为成功",
    );

    const document = ok(
      await h.request("/knowledge", {
        operation_id: randomUUID(),
        kind: "document",
        name: "合成报告引用说明",
        body: "旧文档依据正文：退款归付款范围。",
        related_ids: [],
      }),
    );
    await fixture.begin(cid, "另存一份只解释合成资料的报告。");
    const documentTask = await fixture.invoke("update_analysis_task", {
      action: "create",
      goal: "资料说明报告",
      conditions: fixture.conditions,
      options: [],
    });
    const documentEvidence = await fixture.invoke("save_analysis_evidence", {
      task_id: documentTask.task_id,
      condition_version: documentTask.condition_version,
      data_range: "只解释资料，不包含查询结果。",
      findings: [
        {
          text: "旧文档依据正文：退款归付款范围。",
          calculation: "采用已确认资料定义。",
          limitations: [],
          query_refs: [],
          knowledge_refs: [
            { object_id: document.id, version: document.version, path: "body" },
          ],
          figures: [],
        },
      ],
    });
    await fixture.finish();
    const documentPath = `/conversations/${cid}/tasks/${documentTask.task_id}/report`;
    const documentReport = ok(
      await h.request(documentPath, {
        operation_id: randomUUID(),
        task_id: documentTask.task_id,
        condition_version: documentTask.condition_version,
        expected_version: null,
        title: "合成资料说明",
        evidence_ids: [documentEvidence.evidence_id],
        charts: [],
      }),
    );
    const documentView = ok(await h.request(documentPath));
    assert.equal(documentView.status, "available");
    assert.deepEqual(documentView.chart_results, []);
    assert.ok(JSON.stringify(documentView.report).includes("旧文档依据正文"));
    const conditionDocument = ok(
      await h.request("/knowledge", {
        operation_id: randomUUID(),
        kind: "document",
        name: "合成报告条件定义",
        body: "本次条件依赖此文档：排除测试记录。",
        related_ids: [],
      }),
    );
    const conditionRef = {
      object_id: conditionDocument.id,
      version: conditionDocument.version,
      path: "body",
    };
    await fixture.begin(cid, "再保存一份采用合成条件文档的说明报告。");
    const conditionTask = await fixture.invoke("update_analysis_task", {
      action: "create",
      goal: "带条件依据的报告",
      conditions: { ...fixture.conditions, knowledge_refs: [conditionRef] },
      options: [],
    });
    const conditionEvidence = await fixture.invoke("save_analysis_evidence", {
      task_id: conditionTask.task_id,
      condition_version: conditionTask.condition_version,
      data_range: "依据本次条件定义解释文档，不查询数据。",
      findings: [
        {
          text: "采用本次已确认条件说明退款归属。",
          calculation: "读资料，不计算数字。",
          limitations: [],
          query_refs: [],
          figures: [],
          knowledge_refs: [
            { object_id: document.id, version: document.version, path: "body" },
          ],
        },
      ],
    });
    await fixture.finish();
    const conditionPath = `/conversations/${cid}/tasks/${conditionTask.task_id}/report`;
    const conditionInput = {
      operation_id: randomUUID(),
      task_id: conditionTask.task_id,
      condition_version: conditionTask.condition_version,
      expected_version: null,
      title: "条件定义说明",
      evidence_ids: [conditionEvidence.evidence_id],
      charts: [],
    };
    let conditionReport = ok(await h.request(conditionPath, conditionInput));
    const conditionView = ok(await h.request(conditionPath));
    assert.equal(conditionView.status, "available");
    assert.deepEqual(
      conditionView.report.evidence[0].conditions.knowledge_refs,
      [conditionRef],
    );
    assert.ok(
      !conditionView.report.evidence[0].findings[0].knowledge_refs.some(
        (value) => value.object_id === conditionDocument.id,
      ),
    );
    const originalConditionRevision = h.sql(
      `SELECT body FROM analysis_report_revisions WHERE report_id='${conditionReport.report_id}' AND version=1`,
    )[0];
    const concurrent = await Promise.all(
      ["并发修订甲", "并发修订乙"].map((title) =>
        h.request(conditionPath, {
          ...conditionInput,
          operation_id: randomUUID(),
          title,
          expected_version: conditionReport.version,
        }),
      ),
    );
    assert.equal(
      concurrent.filter((response) => response.status === 200).length,
      1,
    );
    const rejectedConcurrent = concurrent.find(
      (response) => response.status !== 200,
    );
    assert.equal(rejectedConcurrent.value.code, "version_conflict");
    conditionReport = concurrent.find(
      (response) => response.status === 200,
    ).value;
    assert.equal(conditionReport.version, "2");
    assert.equal(ok(await h.request(conditionPath)).reference.version, "2");
    assert.equal(
      h.sql(
        `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_report_revisions WHERE report_id='${conditionReport.report_id}'`,
      )[0].n,
      2,
    );
    assert.deepEqual(
      h.sql(
        `SELECT body FROM analysis_report_revisions WHERE report_id='${conditionReport.report_id}' AND version=1`,
      )[0],
      originalConditionRevision,
    );
    checks.push(
      "两条真实并发保存使用相同expected_version时恰好一成功一version_conflict；head只增一版，原不可变正文保留",
    );
    ok(
      await h.request(`/knowledge/${conditionDocument.id}/disable`, {
        operation_id: randomUUID(),
        expected_version: conditionDocument.version,
      }),
    );
    unavailable(ok(await h.request(conditionPath)), "sources_unavailable");
    const staleConditionSave = await h.request(conditionPath, {
      ...conditionInput,
      operation_id: randomUUID(),
      expected_version: conditionReport.version,
    });
    assert.ok(
      staleConditionSave.status >= 400,
      JSON.stringify(staleConditionSave.value),
    );
    checks.push(
      "仅存在于不可变依据conditions.knowledge_refs的正式文档也属于报告来源；停用后读取只返回状态，新保存拒绝，不靠篡改正文制造反例",
    );
    ok(
      await h.request(`/knowledge/${document.id}/disable`, {
        operation_id: randomUUID(),
        expected_version: document.version,
      }),
    );
    const disabledDocumentView = ok(await h.request(documentPath));
    unavailable(disabledDocumentView, "sources_unavailable");
    assert.deepEqual(disabledDocumentView.reference, documentReport);
    assert.ok(!JSON.stringify(disabledDocumentView).includes("旧文档依据正文"));
    checks.push(
      "仅资料依据的报告也核对正式文档版本；停用后不通过已保存报告正文绕过原资料读取范围",
    );

    ok(
      await h.request(
        `/conversations/${cid}`,
        { operation_id: randomUUID() },
        "alice",
        "DELETE",
      ),
    );
    assert.equal((await h.request(reportPath())).status, 404);
    for (const table of [
      "analysis_reports",
      "analysis_report_operations",
      "analysis_evidence",
    ])
      assert.equal(
        h.sql(
          `SELECT JSON_OBJECT('n',COUNT(*)) FROM ${table} WHERE conversation_id='${cid}'`,
        )[0].n,
        0,
      );
    assert.equal(
      h.sql(
        `SELECT JSON_OBJECT('n',COUNT(*)) FROM analysis_report_revisions WHERE report_id IN ('${reference.report_id}','${documentReport.report_id}','${conditionReport.report_id}')`,
      )[0].n,
      0,
    );
    checks.push(
      "删除会话清理报告当前记录、所有不可变修订、命令回执及依据，报告接口不再暴露私人派生正文",
    );
    passed = true;
    console.log(JSON.stringify({ passed, checks, officialRequests: 0 }));
  } finally {
    await writeFile(
      ".local/checks/analysis-reports.json",
      JSON.stringify(
        {
          passed,
          checks,
          officialRequests: 0,
          scope:
            "真实Rust/MySQL/可执行合成SQLite与受控Pi工具；不证明真实模型自主分析准确率",
        },
        null,
        2,
      ) + "\n",
    );
    if (fixture) await fixture.close();
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  await checkReports();
