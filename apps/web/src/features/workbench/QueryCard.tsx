import { useCallback, useEffect, useRef, useState } from "react";
import type {
  QueryView,
  QueryResults,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { QueryResultsView } from "./QueryResultsView.tsx";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
function status(q: QueryView) {
  return (
    (
      {
        not_submitted:
          q.confirmation_state === "superseded"
            ? "已被新版替代"
            : q.check_state === "passed"
              ? "SQL 已准备好"
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
  onRefresh,
  onEvidence,
}: {
  query: QueryView;
  onRefresh: () => void;
  onEvidence: (id: string, summary?: string, version?: string) => void;
}) {
  const [result, setResult] = useState<QueryResults | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);
  const resultGeneration = useRef(0);
  const copy = async () => {
    const parameters = Object.keys(query.parameters).length
      ? "\n\n-- 绑定参数（执行时需一并提供）\n" + JSON.stringify(query.parameters, null, 2).split("\n").map(line => "-- " + line).join("\n")
      : "";
    try {
      await navigator.clipboard.writeText(query.sql + parameters);
      setCopied(true);
    } catch {
      setError("复制失败，请选中 SQL 和参数后复制。");
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
  const load = useCallback(async () => {
    const generation = ++resultGeneration.current;
    setBusy(true);
    setError("");
    try {
      const value = await api(
        "QueryResults",
        "/queries/" + query.id + "/results",
      );
      if (generation !== resultGeneration.current) return;
      setResult(value);
    } catch (e) {
      if (generation === resultGeneration.current) {
        setResult(null);
        setError(e instanceof Error ? e.message : "结果读取失败");
      }
    } finally {
      if (generation === resultGeneration.current) setBusy(false);
    }
  }, [query.id]);
  useEffect(() => {
    if (query.execution_state === "succeeded") void load();
    return () => { ++resultGeneration.current; };
  }, [load, query.execution_state]);
  const running = ["queued", "submitting", "running", "submission_unknown"].includes(query.execution_state);
  const stopping = running && query.cancel_state === "requested";
  const queryError = query.error === "outcome_unknown"
    ? stopping ? "暂时无法确认是否已停止，系统会继续核对。" : "暂时无法确认查询状态，系统会继续核对。"
    : query.error_details?.message ?? query.error;
  const sql = (
    <div className="query-sql">
      <div className="query-sql-toolbar"><span>{query.execution_state === "succeeded" ? "实际执行的 SQL" : "SQL"}</span><button onClick={() => void copy()} aria-label="复制 SQL" title="复制 SQL 及绑定参数">{copied ? "已复制" : "复制 SQL"}</button></div>
      <pre><code>{query.sql}</code></pre>
      {Object.keys(query.parameters).length > 0 && <dl className="parameters" aria-label="绑定参数">
        {Object.entries(query.parameters).map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>
        ))}
      </dl>}
    </div>
  );
  const content = (
    <section
      id={"query-" + query.id}
      tabIndex={-1}
      className={
        "query-card " +
        (running ? "query-running " : "") +
        (query.confirmation_state === "superseded" ? "superseded" : "")
      }
      aria-label={"查询：" + query.summary}
    >
      <div className="card-heading">
        <h3>{stopping ? "正在停止查询" : status(query)}</h3>
        {running && <button className="text-link" disabled={busy || query.cancel_state === "requested"} onClick={() => void cancel()}>{query.cancel_state === "requested" ? "正在停止…" : "停止"}</button>}
      </div>
      {query.execution_state !== "succeeded" && <p className="query-summary">{query.summary}</p>}
      {result && <QueryResultsView result={result} onShowSql={() => setShowSql(true)}/>}
      {query.execution_state === "succeeded" && <details className="query-conditions"><summary>本次查询条件</summary><p className="query-summary">{query.summary}</p></details>}
      {running ? <>
        <p className="quiet">{stopping ? "已发出停止请求，正在等待查询平台确认。你可以继续聊天。" : "正在后台运行，可以继续聊天或发起其他查询。"}</p>
        <details className="running-sql"><summary>查看 SQL 和参数</summary>{sql}</details>
      </> : sql}
      {!!query.knowledge_refs.length && <details className="query-evidence"><summary>查看口径依据</summary><div className="evidence-row">{query.knowledge_refs.map(ref => <KnowledgeReference key={ref.object_id + ref.path} id={ref.object_id} path={ref.path} onOpen={id => onEvidence(id, query.summary, ref.version)}/>)}</div></details>}
      {query.execution_state === "succeeded" && !result && <p className="quiet">{busy ? "正在读取查询结果…" : <button onClick={() => void load()}>重新读取结果</button>}</p>}
      {query.execution_state === "submission_unknown" && !stopping && (
        <p className="quiet">
          正在向查询平台确认状态，你可以继续聊天。
        </p>
      )}
      {query.error && <p className="error">{queryError}</p>}
      {error && (
        <p role="alert" className="error">
          {error === "result_expired"
            ? "结果已过期。可以在对话中要求重新查询。"
            : error}
        </p>
      )}
      {showSql && <Modal title="最终执行的 SQL" onClose={() => setShowSql(false)} footer={<button className="primary" onClick={() => setShowSql(false)}>返回结果</button>}>{sql}{error && <p role="alert" className="error">{error}</p>}</Modal>}
    </section>
  );
  return query.confirmation_state === "superseded" ? <details className="previous-query"><summary>此前的 SQL · 已被修改</summary>{content}</details> : content;
}
