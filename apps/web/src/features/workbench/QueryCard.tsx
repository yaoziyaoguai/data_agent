import { useEffect, useRef, useState } from "react";
import type {
  QueryView,
  QueryResults,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api, ApiError } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { QueryResultsView } from "./QueryResultsView.tsx";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
function status(q: QueryView) {
  if (q.text_unavailable && q.execution_state === "not_submitted") return "查询来源不可用";
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
  authorityRevision,
  onEvidence,
}: {
  query: QueryView;
  authorityRevision: number;
  onEvidence: (id: string, summary?: string, version?: string) => void;
}) {
  const [result, setResult] = useState<QueryResults | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastAuthority = useRef(authorityRevision);
  const readResult = useRef<((authorityChanged?: boolean) => void) | null>(null);
  const readable = query.text_unavailable !== true;
  const parameters = query.parameters ?? {};
  const references = query.knowledge_refs ?? [];
  // 用户声明的时间口径快照（与平台data_freshness不同源）：截点/批次是声明值，不是平台观测。
  const roleLabel: Record<string, string> = { event_time: "时间字段", observation_cutoff: "观察截点", data_batch: "数据批次" };
  const timeBasis = readable
    ? (query.time_basis?.time_roles ?? []).map(role => {
        const value = role.value ?? role.field_ref ?? role.description;
        return `${roleLabel[role.role] ?? role.role} ${value}`;
      }).join(" · ")
    : "";
  const copy = async () => {
    if (!readable || !query.sql) return;
    const parameterText = Object.keys(parameters).length
      ? "\n\n-- 绑定参数（执行时需一并提供）\n" + JSON.stringify(parameters, null, 2).split("\n").map(line => "-- " + line).join("\n")
      : "";
    try {
      await navigator.clipboard.writeText(query.sql + parameterText);
      setCopied(true);
    } catch {
      setError("复制失败，请选中 SQL 和参数后复制。");
    }
  };
  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      await api("QueryView", "/queries/" + query.id + "/cancel", "POST", {
        operation_id: crypto.randomUUID(),
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let mounted = true;
    let controller: AbortController | undefined;
    setResult(null);
    setShowSql(false);
    setCopied(false);
    setError("");
    setBusy(false);
    const load = async (authorityChanged = false) => {
      if (!mounted || !readable || query.execution_state !== "succeeded" || (document.hidden && !authorityChanged)) return;
      if (controller && !authorityChanged) return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setBusy(true); setError("");
      try {
        const value = await api("QueryResults", "/queries/" + query.id + "/results", "GET", undefined, undefined, request.signal);
        if (!request.signal.aborted) setResult(value);
      } catch (cause) {
        if (!request.signal.aborted) {
          setResult(null);
          setError(cause instanceof ApiError ? cause.code : "结果读取失败");
        }
      } finally {
        if (!request.signal.aborted) { controller = undefined; setBusy(false); }
      }
    };
    const wake = () => { void load(); };
    readResult.current = (authorityChanged) => void load(authorityChanged);
    void load();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      mounted = false;
      controller?.abort();
      readResult.current = null;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [query.id, readable, query.execution_state, query.result_ref]);
  useEffect(() => {
    if (lastAuthority.current === authorityRevision) return;
    lastAuthority.current = authorityRevision;
    readResult.current?.(true);
  }, [authorityRevision]);
  const running = ["queued", "submitting", "running", "submission_unknown"].includes(query.execution_state);
  const stopping = running && query.cancel_state === "requested";
  const queryError = query.error === "outcome_unknown"
    ? stopping ? "暂时无法确认是否已停止，系统会继续核对。" : "暂时无法确认查询状态，系统会继续核对。"
    : query.error_details?.message ?? query.error;
  const sql = readable ? (
    <div className="query-sql">
      <div className="query-sql-toolbar"><span>{query.execution_state === "succeeded" ? "实际执行的 SQL" : "SQL"}</span><button onClick={() => void copy()} aria-label="复制 SQL" title="复制 SQL 及绑定参数">{copied ? "已复制" : "复制 SQL"}</button></div>
      <pre><code>{query.sql}</code></pre>
      {Object.keys(parameters).length > 0 && <dl className="parameters" aria-label="绑定参数">
        {Object.entries(parameters).map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>
        ))}
      </dl>}
    </div>
  ) : null;
  const content = (
    <section
      id={"query-" + query.id}
      tabIndex={-1}
      className={
        "query-card " +
        (running ? "query-running " : "") +
        (query.confirmation_state === "superseded" ? "superseded" : "")
      }
      aria-label={"查询：" + (readable ? query.summary : "来源不可用")}
    >
      <div className="card-heading">
        <h3>{stopping ? "正在停止查询" : status(query)}</h3>
        {running && <button className="text-link" disabled={busy || query.cancel_state === "requested"} onClick={() => void cancel()}>{query.cancel_state === "requested" ? "正在停止…" : "停止"}</button>}
      </div>
      {!readable && <p className="query-summary" role="status">查询来源已失效或无法核验，SQL、参数和结果已隐藏。查询状态仍会更新，运行中的查询仍可停止。</p>}
      {readable && query.execution_state !== "succeeded" && <p className="query-summary">{query.summary}</p>}
      {timeBasis && <p className="quiet query-time-basis">{timeBasis}</p>}
      {readable && result && <QueryResultsView result={result} onShowSql={() => setShowSql(true)}/>}
      {readable && query.execution_state === "succeeded" && <details className="query-conditions"><summary>本次查询条件</summary><p className="query-summary">{query.summary}</p></details>}
      {running ? <>
        <p className="quiet">{stopping ? "已发出停止请求，正在等待查询平台确认。你可以继续聊天。" : "正在后台运行，可以继续聊天或发起其他查询。"}</p>
        {readable && <details className="running-sql"><summary>查看 SQL 和参数</summary>{sql}</details>}
      </> : sql}
      {readable && !!references.length && <details className="query-evidence"><summary>查看口径依据</summary><div className="evidence-row">{references.map(ref => <KnowledgeReference key={ref.object_id + ref.path} id={ref.object_id} path={ref.path} onOpen={id => onEvidence(id, query.summary, ref.version)}/>)}</div></details>}
      {readable && query.execution_state === "succeeded" && !result && !["result_expired", "forbidden", "not_available", "unauthenticated"].includes(error) && <p className="quiet">{busy ? "正在读取查询结果…" : <button onClick={() => readResult.current?.()}>重新读取结果</button>}</p>}
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
            : ["forbidden", "not_available", "unauthenticated"].includes(error)
              ? "当前无权读取此查询结果。"
              : error}
        </p>
      )}
      {readable && showSql && <Modal title="最终执行的 SQL" onClose={() => setShowSql(false)} footer={<button className="primary" onClick={() => setShowSql(false)}>返回结果</button>}>{sql}{error && <p role="alert" className="error">{error}</p>}</Modal>}
    </section>
  );
  return query.confirmation_state === "superseded" ? <details className="previous-query"><summary>此前的 SQL · 已被修改</summary>{content}</details> : content;
}
