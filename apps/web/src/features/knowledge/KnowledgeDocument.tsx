import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import type { KnowledgeDocument as Document, KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import { Modal } from "../../shared/Modal.tsx";
import { KnowledgePicker } from "../../shared/KnowledgePicker.tsx";
import { ProposeCorrection } from "./CorrectionComposer.tsx";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import { Tabs } from "../../shared/Tabs.tsx";
import { semanticError, useStableOperation } from "./semantic-commands.ts";

// 只有明确共享文档来源的章节合在一起；同名资料仍是不同文档。
export function documentRepresentatives(objects: KnowledgeObject[]) {
  const seen = new Set<string>();
  return objects.filter(object => {
    if (object.kind !== "document" || !object.source_id) return true;
    if (seen.has(object.source_id)) return false;
    seen.add(object.source_id);
    return true;
  });
}

export function DocumentName({ object }: { object: KnowledgeObject }) {
  const [title, setTitle] = useState("");
  useEffect(() => {
    let live = true;
    setTitle("");
    if (object.kind === "document" && object.source_id) {
      void api("KnowledgeDocument", `/knowledge/${object.id}/document`)
        .then(document => { if (live) setTitle(document.title); }).catch(() => {});
    }
    return () => { live = false; };
  }, [object.id, object.source_id, object.version]);
  return <>{object.kind === "document" && object.source_id ? title || "业务文档" : object.name}</>;
}

export function KnowledgeDocument({ object, onSaved, onCorrection, onOpen }: {
  object: KnowledgeObject;
  onSaved: (parts: KnowledgeObject[]) => void;
  onCorrection: () => void;
  onOpen?: () => void;
}) {
  const readGeneration = useRef(0);
  const editGeneration = useRef(0);
  const [document, setDocument] = useState<Document | null>(null);
  const [editing, setEditing] = useState<{document: Document; generation: number} | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const generation = ++readGeneration.current;
      try { const value = await api("KnowledgeDocument", `/knowledge/${object.id}/document`); if (live && generation === readGeneration.current) { setDocument(value); setError(""); } }
      catch (e) { if (live && generation === readGeneration.current) setError(semanticError(e)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [object.id, object.version, object.maintenance?.version, revision]);
  if (!document) return <section className="document-reader">{error ? <p role="alert">{error} <button onClick={() => setRevision(v => v + 1)}>重新读取文档</button></p> : <p role="status">正在读取整篇文档…</p>}</section>;
  const grouped = document.parts.length > 1;
  const sourceLinks = [...new Set(document.parts.flatMap(part => part.entries.map(entry => entry.human_override?.source_url).filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url))))];
  return <article className="document-reader" aria-label={document.title}>
    <header className="document-heading"><h2>{document.title}</h2><div className="actions">{onOpen && <button onClick={onOpen}>打开文档详情</button>}{document.can_edit && <button onClick={() => setEditing({document, generation: ++editGeneration.current})}>编辑文档</button>}</div></header>
    {error && <p role="alert" className="error">暂时无法刷新文档，以下为已读取的内容。{error}<button onClick={() => setRevision(v => v + 1)}>重新读取文档</button></p>}
    <DocumentReading text={(document.body.startsWith(`# ${document.title}\n`) ? document.body.slice(document.body.indexOf("\n") + 1) : document.body) || "尚未录入正文"}/>
    {sourceLinks.map((url, index) => <p className="quiet" key={url}><a href={url} target="_blank" rel="noopener noreferrer">打开来源链接{sourceLinks.length > 1 ? ` ${index + 1}` : ""} ↗</a>{!document.body.trim() && " · 正文尚未录入，Agent无法据此解释业务。"}</p>)}
    <details className="document-maintenance"><summary>维护与纠错</summary>
      <p className="quiet">{document.can_edit ? "你可以编辑本文。保存会同时核对全文的修改状态。" : "本文由各章节的负责人维护；你可以提出纠错建议。"}</p>
      {document.parts.map(part => <div key={part.id} className="document-section-tools"><strong>{grouped ? part.name : "文档正文"}</strong><span>负责人：{part.maintenance?.maintainer_id ?? "暂未指定"}</span>{part.entries.filter(e => e.entry_id === "body").map(entry => <ProposeCorrection key={entry.entry_id} object={part} entry={entry} onSaved={onCorrection}/>)}</div>)}
    </details>
    {editing && <DocumentEditor key={editing.generation} document={editing.document} objectId={object.id} onClose={() => { ++editGeneration.current; setEditing(null); }} onSaved={value => {
      // 已放弃的保存由轮询读取结果，旧回执不能关闭后来打开的草稿。
      if (editing.generation !== editGeneration.current) return;
      ++readGeneration.current; setDocument(value); onSaved(value.parts); setEditing(null);
    }}/>}
  </article>;
}

export function DocumentReading({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const [headings, setHeadings] = useState<{id: string; text: string}[]>([]);
  useLayoutEffect(() => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("h2, h3") ?? [])];
    setHeadings(items.map((heading, index) => {
      heading.id = prefix + "-section-" + index;
      return {id: heading.id, text: heading.textContent || "章节"};
    }));
  }, [text, prefix]);
  return <div className="document-reading">{headings.length >= 3 && <nav className="document-outline" aria-label="文档章节"><strong>本文目录</strong>{headings.map(heading => <button key={heading.id} onClick={() => document.getElementById(heading.id)?.scrollIntoView({block: "start"})}>{heading.text}</button>)}</nav>}<div ref={ref}><MarkdownContent text={text}/></div></div>;
}

function DocumentEditor({ document, objectId, onClose, onSaved }: {
  document: Document; objectId: string; onClose: () => void; onSaved: (document: Document) => void;
}) {
  const bodyId = useId();
  const [body, setBody] = useState(document.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const single = document.parts.length === 1;
  const tooLong = [...body].length > 100000;
  const [related, setRelated] = useState(document.parts[0].related_ids);
  const [sourceUrl, setSourceUrl] = useState(String(document.parts[0].entries.find(e => e.entry_id === "body")?.human_override?.source_url ?? ""));
  const operation = useStableOperation();
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const originalUrl = String(document.parts[0].entries.find(e => e.entry_id === "body")?.human_override?.source_url ?? "");
  const confirmClose = useUnsavedChanges((body !== document.body || sourceUrl !== originalUrl || JSON.stringify(related) !== JSON.stringify(document.parts[0].related_ids)), onClose);
  const close = () => { if (!busy) confirmClose(onClose); };
  const save = async () => {
    if (busy || tooLong) return;
    setBusy(true); setError("");
    const input = { body, parts: document.parts.map(part => ({ id: part.id, expected_version: part.version })), ...(single ? { related_ids: related, source_url: sourceUrl.trim() || null } : {}) };
    try { const saved = await api("KnowledgeDocument", `/knowledge/${objectId}/document`, "PATCH", { operation_id: operation(input), ...input }); confirmClose.markSaved(); onSaved(saved); }
    catch (e) { setError(semanticError(e)); }
    finally { setBusy(false); }
  };
  return <Modal title={`编辑文档 · ${document.title}`} className="document-edit-dialog" onClose={close} footer={<><button disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || tooLong} onClick={() => void save()}>{busy ? "保存中…" : "保存文档"}</button></>}>
    <Tabs label="文档编辑方式" value={mode} items={[{value: "edit", label: "编辑"}, {value: "preview", label: "阅读预览"}]} onChange={setMode}/>
    <div className="document-editor" hidden={mode !== "edit"}>
      <label className="form-label" htmlFor={bodyId}>文档正文</label>
      <textarea id={bodyId} value={body} rows={22} disabled={busy} onChange={event => setBody(event.target.value)}/>
      {tooLong && <p role="alert" className="error">正文超过单次保存的 10 万字符限制。请精简后再保存；原文和当前草稿均保留。</p>}
    </div>
    {mode === "preview" && <MarkdownContent text={body || "尚未填写正文"}/>}
    {single && <details><summary>关联资料与来源链接</summary><KnowledgePicker selected={related} disabled={busy} onAdd={object => setRelated(old => [...old, object.id])} onRemove={id => setRelated(old => old.filter(value => value !== id))}/><label className="form-label">来源链接（可选）<input type="url" value={sourceUrl} disabled={busy} onChange={e => setSourceUrl(e.target.value)}/></label></details>}
    {error && <p role="alert" className="error">{error} 当前草稿仍保留。</p>}
  </Modal>;
}
