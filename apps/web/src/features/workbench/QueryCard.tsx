import { useState } from "react";
import type {
  QueryView,
  QueryResults,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
function status(q: QueryView) {
  return (
    (
      {
        not_submitted:
          q.confirmation_state === "superseded"
            ? "已被新版替代"
            : q.check_state === "passed"
              ? "等待确认"
              : "检查未通过",
        queued: "等待提交",
        submitting: "正在提交",
        submission_unknown: "提交结果待查证",
        running: "查询运行中",
        succeeded: "查询完成",
        failed: "查询失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[q.execution_state] ?? q.execution_state
  );
}
export function QueryCard({
  query,
  blocked,
  onRefresh,
  onRevise,
  onEvidence,
}: {
  query: QueryView;
  blocked: boolean;
  onRefresh: () => void;
  onRevise: (text: string) => void;
  onEvidence: (id: string) => void;
}) {
  const [result, setResult] = useState<QueryResults | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"table" | "chart">("table");
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await api("QueryView", "/queries/" + query.id + "/confirm", "POST", {
        operation_id: crypto.randomUUID(),
        draft_version: query.draft_version,
        condition_version: query.condition_version,
      });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "确认失败");
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await api("QueryView", "/queries/" + query.id + "/cancel", "POST", {
        operation_id: crypto.randomUUID(),
      });
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const load = async (cursor?: string) => {
    setBusy(true);
    setError("");
    try {
      const value = await api(
        "QueryResults",
        "/queries/" +
          query.id +
          "/results" +
          (cursor ? "?cursor=" + cursor : ""),
      );
      setResult((old) =>
        cursor && old
          ? {
              ...value,
              rows: [...old.rows, ...value.rows],
              fetched_offset: "0",
              result_complete: !value.next_cursor && !value.truncated,
            }
          : value,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "结果读取失败");
    } finally {
      setBusy(false);
    }
  };
  const numeric =
    result?.columns
      .map((_, i) => i)
      .filter(
        (i) =>
          ["integer", "number"].includes(result.columns[i].type) &&
          result.rows.some(
            (r) => r[i] !== null && Number.isFinite(Number(r[i])),
          ),
      ) ?? [];
  const valueIndex = numeric.at(-1);
  const max =
    valueIndex === undefined
      ? 0
      : Math.max(
          ...(result?.rows.map((r) => Math.abs(Number(r[valueIndex]))) ?? [0]),
        );
  return (
    <section
      className={
        "query-card " +
        (query.confirmation_state === "superseded" ? "superseded" : "")
      }
      aria-label={"SQL草稿版本 " + query.draft_version}
    >
      <div className="card-heading">
        <div>
          <span className="eyebrow">SQL · 版本 {query.draft_version}</span>
          <h3>{status(query)}</h3>
        </div>
        <span className="status-pill">条件 v{query.condition_version}</span>
      </div>
      <p className="query-summary">{query.summary}</p>
      <details
        open={
          query.execution_state === "not_submitted" &&
          query.confirmation_state !== "superseded"
        }
      >
        <summary>完整 SQL 与绑定参数</summary>
        <pre>{query.sql}</pre>
        <dl className="parameters">
          {Object.entries(query.parameters).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="quiet">目标：{query.target_id} · SQLite · 合成数据平台</p>
      </details>
      <div className="evidence-row">
        {query.knowledge_refs.map((ref) => (
          <button key={ref.object_id} onClick={() => onEvidence(ref.object_id)}>
            ↗ {ref.object_id.replace(/^(metric|field|table)-/, "")} v
            {ref.version}
          </button>
        ))}
      </div>
      <div className="actions">
        <button onClick={() => void navigator.clipboard.writeText(query.sql)}>
          复制 SQL
        </button>
        <button onClick={() => onRevise(`[task:${query.task_id}] `)}>
          补充或纠正
        </button>
        {query.confirmation_state === "awaiting_confirmation" &&
          query.execution_state === "not_submitted" && (
            <button
              className="primary"
              disabled={busy || blocked}
              onClick={() => void confirm()}
            >
              {blocked ? "正在处理补充信息…" : "执行查询"}
            </button>
          )}
        {[
          "queued",
          "submitting",
          "running",
          "submission_unknown",
          "not_submitted",
        ].includes(query.execution_state) &&
          query.confirmation_state !== "superseded" && (
            <button disabled={busy} onClick={() => void cancel()}>
              取消查询
            </button>
          )}
        {query.execution_state === "succeeded" && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void load()}
          >
            查看结果
          </button>
        )}
      </div>
      {query.execution_state === "submission_unknown" && (
        <p className="quiet">
          正在按原提交标识查证，不重复执行。可继续在当前对话提问。
        </p>
      )}
      {query.error && <p className="error">{query.error_details?.message ?? query.error}</p>}
      {error && (
        <p role="alert" className="error">
          {error === "result_expired"
            ? "结果已过期。请生成新的查询并确认执行。"
            : error}
        </p>
      )}
      {result && (
        <div className="result-panel">
          <div className="result-toolbar">
            <div className="segmented">
              <button
                aria-pressed={mode === "table"}
                onClick={() => setMode("table")}
              >
                表格
              </button>
              <button
                aria-pressed={mode === "chart"}
                disabled={valueIndex === undefined}
                onClick={() => setMode("chart")}
              >
                图表
              </button>
            </div>
            <a
              className="text-link"
              href={"/api/queries/" + query.id + "/export.csv"}
            >
              导出此查询已保存的全部结果 CSV ↗
            </a>
          </div>
          <p className="quiet">
            CSV
            导出此查询缓存的全部结果（最多1000行），可能多于当前显示。金额按原字段单位保留。
            <br />
            已获取 {result.rows.length} 行 ·{" "}
            {result.result_complete ? "查询结果完整" : "部分结果"}
            {result.truncated ? " · 已截断" : ""} · 来源：可执行合成数据 ·
            上游为固定样例快照
          </p>
          {mode === "table" ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name}>{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j}>{v ?? "NULL"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!result.rows.length && <p>查询成功，暂无符合条件的记录。</p>}
            </div>
          ) : (
            <div className="bar-chart" role="img" aria-label="查询结果柱状图">
              {result.rows.slice(0, 30).map((row, i) => (
                <div className="chart-row" key={i}>
                  <span>
                    {valueIndex === 0
                      ? result.columns[0].name
                      : (row[0] ?? "未知")}
                  </span>
                  <div>
                    <i
                      style={{
                        width:
                          Math.max(
                            1,
                            (100 * Math.abs(Number(row[valueIndex!]))) /
                              (max || 1),
                          ) + "%",
                      }}
                    />
                  </div>
                  <strong>{row[valueIndex!] ?? "NULL"}</strong>
                </div>
              ))}
              <p className="quiet">
                按原始字段单位展示。超过30行时图表只显示前30行，表格保留已获取数据。
              </p>
            </div>
          )}
          {result.next_cursor && (
            <button
              disabled={busy}
              onClick={() => void load(result.next_cursor!)}
            >
              加载下一页
            </button>
          )}
        </div>
      )}
    </section>
  );
}
