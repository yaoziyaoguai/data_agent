import { useEffect, useState } from "react";
import type { QueryResults } from "../../../../../packages/contracts/generated/boundary.ts";
import { api, ApiError } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { QueryColumnStatistics, QueryCsvDownload, QueryResultTable } from "./QueryResultTable.tsx";

type Page = { cursor: string | null; authorityRevision: number; retry: number };

export function QueryResultPanel({ queryId, authorityRevision, docked, active = true, closeLabel = "返回对话", closeTitle, onClose }: {
  queryId: string;
  authorityRevision: number;
  docked: boolean;
  active?: boolean;
  closeLabel?: string;
  closeTitle?: string;
  onClose: () => void;
}) {
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const cursor = pages.at(-1) ?? null;
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<(Page & ({ result: QueryResults } | { error: string })) | null>(null);
  useEffect(() => {
    let active: AbortController | null = null;
    const path = "/queries/" + encodeURIComponent(queryId) + "/results";
    const load = () => {
      if (active) return;
      const request = new AbortController();
      active = request;
      void api("QueryResults", path + (cursor === null ? "" : "?cursor=" + encodeURIComponent(cursor)),
        "GET", undefined, undefined, request.signal)
        .then(result => {
          if (!request.signal.aborted) setLoaded({ cursor, authorityRevision, retry, result });
        })
        .catch((error: unknown) => {
          if (request.signal.aborted) return;
          const message = error instanceof ApiError && ["forbidden", "not_available", "result_expired"].includes(error.code)
            ? "查询结果已过期或当前不可读取。" : "查询结果暂时无法读取。";
          setLoaded({ cursor, authorityRevision, retry, error: message });
        })
        .finally(() => { active = null; });
    };
    const wake = () => { if (!document.hidden) load(); };
    load();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      active?.abort();
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [queryId, cursor, authorityRevision, retry]);
  const page = loaded && loaded.cursor === cursor && loaded.authorityRevision === authorityRevision && loaded.retry === retry ? loaded : null;
  const result = page && "result" in page ? page.result : null;

  return <Modal docked={docked} active={active} restoreFocusOnClose={false} closeTitle={closeTitle ?? closeLabel} title="查询结果" closeLabel={closeLabel} className="full-result-dialog" onClose={onClose}>
    {page === null && <p role="status">正在核对查询结果…</p>}
    {page && "error" in page && <p role="alert">{page.error} <button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {result && <>
      <div className="full-result-toolbar">
        <span>第 {pages.length} 页 · {result.rows.length} 行</span>
        <QueryCsvDownload queryId={queryId}/>
      </div>
      {result.truncated && <p className="result-limit">结果已截断，下载仅包含平台当前保存的数据。</p>}
      <QueryResultTable columns={result.columns} rows={result.rows}/>
      <QueryColumnStatistics columns={result.columns} statistics={result.statistics}/>
    </>}
    {(pages.length > 1 || result?.next_cursor) && <div className="full-result-pagination">
      <button disabled={pages.length === 1} onClick={() => setPages(values => values.slice(0, -1))}>上一页</button>
      <button disabled={!result?.next_cursor} onClick={() => {
        const next = result?.next_cursor;
        if (next) setPages(values => [...values, next]);
      }}>下一页</button>
    </div>}
  </Modal>;
}
