import { useState } from "react";
import type { KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import { KnowledgeStatus } from "./KnowledgeStatus.tsx";
import { ProposeCorrection } from "./CorrectionComposer.tsx";
import { semanticError, useStableOperation } from "./semantic-commands.ts";

export function KnowledgeBusinessDomain({ object, onSaved, onSource, onCorrection }: {
  object: KnowledgeObject;
  onSaved: (object: KnowledgeObject) => void;
  onSource?: (id: string) => void;
  onCorrection: () => void;
}) {
  const entry = object.entries.find(value => value.path === "business_domain");
  const canEdit = object.maintenance?.can_edit ?? false;
  const [draft, setDraft] = useState<{ value: string; original: string; version: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useStableOperation();
  const close = useUnsavedChanges(draft !== null && draft.value !== draft.original, () => setDraft(null));
  const sourceId = typeof entry?.source_facts.source_id === "string" ? entry.source_facts.source_id : object.source_id;
  const save = async (clearOverride = false) => {
    if (!draft || busy || !canEdit) return;
    setBusy(true); setError("");
    const input = {
      expected_version: draft.version,
      entry_id: entry?.entry_id ?? "business_domain",
      value: draft.value.trim(),
      clear_override: clearOverride,
    };
    try {
      const saved = await api("KnowledgeObject", `/knowledge/${object.id}`, "PATCH", {
        ...input, operation_id: operation({ object: object.id, ...input }),
      });
      close.markSaved(); setDraft(null); onSaved(saved);
    } catch (e) { setError(semanticError(e)); }
    finally { setBusy(false); }
  };
  return <section className="knowledge-business-domain" aria-label={`${object.name}的业务域`}>
    <div className="entry-head"><strong>业务域</strong>{entry && <KnowledgeStatus entries={[entry]}/>}
      {canEdit && !draft && <button type="button" onClick={() => {
        const value = entry?.effective_value ?? "";
        setDraft({value, original: value, version: object.version}); setError("");
      }}>编辑业务域</button>}
    </div>
    {draft ? <>
      <label className="form-label">业务域<input value={draft.value} maxLength={240} disabled={busy || !canEdit} onChange={event => setDraft({...draft, value: event.target.value})}/></label>
      <p className="quiet">填写已确认的业务域；清空后保存表示未分类。关联资料不会自动带入归属。</p>
      <div className="actions">
        <button type="button" className="primary" disabled={busy || !canEdit} onClick={() => void save()}>保存业务域</button>
        <button type="button" disabled={busy} onClick={() => close(() => setDraft(null))}>取消业务域编辑</button>
        {entry?.human_override && <button type="button" disabled={busy || !canEdit} onClick={() => void save(true)}>清除业务域人工覆盖</button>}
      </div>
    </> : <p>{entry?.effective_value || "未分类"}</p>}
    {entry && <details className="provenance-detail"><summary>查看业务域依据与修改记录</summary>
      <div className="provenance-columns">
        <section><h4>来源资料</h4><p>{String(entry.source_facts.value || entry.source_facts.gap || "未提供来源业务域")}</p>
          {typeof entry.source_facts.quote === "string" && <p>{entry.source_facts.quote}</p>}
          {sourceId && onSource && <button type="button" onClick={() => onSource(sourceId)}>查看来源正文 ↗</button>}
        </section>
        <section><h4>分析建议</h4><p>{String(entry.suggestion.value ?? "暂无分析建议")}</p></section>
        <section><h4>人工修改</h4><p>{entry.human_override ? `由 ${String(entry.human_override.edited_by ?? object.updated_by)} 修改` : "尚未人工修改"}</p></section>
      </div>
    </details>}
    {!canEdit && entry && <ProposeCorrection object={object} entry={entry} onSaved={onCorrection}/>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
