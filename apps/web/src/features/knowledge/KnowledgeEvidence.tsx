import { useEffect, useState } from "react";
import type { KnowledgeObject, KnowledgeDocument } from "../../../../../packages/contracts/generated/boundary.ts";
import { DocumentReading } from "./KnowledgeDocument.tsx";
import { api } from "../../shared/api.ts";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import { knowledgeKindLabels, knowledgeSourceLabel } from "../../shared/knowledge-labels.ts";

export function KnowledgeEvidence({ id, version, querySummary }: { id: string; version?: string; querySummary?: string }) {
  const [object, setObject] = useState<KnowledgeObject | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setObject(null); setError("");
    void api("KnowledgeObject", "/knowledge/" + encodeURIComponent(id) + (version ? "?version=" + encodeURIComponent(version) : ""))
      .then(value => { if (live) setObject(value); })
      .catch(() => { if (live) setError("暂时无法读取这份依据，请重试或核对资料权限。"); });
    return () => { live = false; };
  }, [id, version, revision]);
  if (error) return <p className="error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重新读取依据</button></p>;
  if (!object) return <p role="status">正在读取依据…</p>;
  return <article className="knowledge-evidence">
    <p className="eyebrow">{knowledgeKindLabels[object.kind]} · {knowledgeSourceLabel(object)}</p><h2>{object.name}</h2>
    <p className="quiet">负责人：{object.maintenance?.maintainer_id ?? "暂未指定"}{object.state !== "enabled" ? " · 已停用" : ""}</p>
    <h3>{version ? "查询采用的共享口径" : "共享口径"}</h3>
    {object.entries.filter(entry => !["ddl", "etl"].includes(entry.path)).map(entry => <section key={entry.entry_id}><h4>{entry.label}</h4><MarkdownContent text={entry.effective_value || "尚缺说明"}/>{entry.review_state === "needs_review" && <p className="review-mark">依据有变化，请核对</p>}</section>)}
    {object.kind === "document" && <FullEvidenceDocument key={object.id} id={object.id}/>}
    {querySummary && <section className="evidence-query-conditions"><h3>本次查询条件</h3><p>{querySummary}</p></section>}
  </article>;
}

function FullEvidenceDocument({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(false);
    void api("KnowledgeDocument", `/knowledge/${id}/document`).then(value => { if (live) setDocument(value); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [id, open, revision]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>阅读当前整篇文档</summary>
    <p className="quiet">以下为当前全文；上方保留本次查询采用的依据。</p>
    {error ? <p role="alert">文档暂时无法读取。<button onClick={() => setRevision(value => value + 1)}>重试全文</button></p> : document ? <DocumentReading text={document.body}/> : <p role="status">正在读取全文…</p>}
  </details>;
}
