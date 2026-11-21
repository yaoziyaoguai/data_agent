import { useEffect, useRef, useState } from "react";
import type { KnowledgeEntry, KnowledgeEntryEdit, KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { ProposeCorrection } from "./CorrectionComposer.tsx";
import { KnowledgePicker } from "../../shared/KnowledgePicker.tsx";
import { KnowledgeStatus } from "./KnowledgeStatus.tsx";
import { api } from "../../shared/api.ts";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import { useStableOperation } from "./semantic-commands.ts";
import { SemanticStructureEditor, SemanticStructureView, structureDraft, structureEntryId, structureFromDraft } from "./SemanticStructure.tsx";

export type StagedEntry = { objectId: string; version: string; edit: KnowledgeEntryEdit };
export function EntryEditor({
  object,
  entry,
  canEdit,
  onSaved,
  onSource,
  onCorrection,
  availableObjects,
  batchMode,
  staged,
  onStage,
}: {
  object: KnowledgeObject;
  entry: KnowledgeEntry;
  canEdit: boolean;
  onSaved: (object: KnowledgeObject) => void;
  onSource: (id: string) => void;
  onCorrection: () => void;
  availableObjects: KnowledgeObject[];
  batchMode?: boolean;
  staged?: StagedEntry;
  onStage?: (value: StagedEntry) => void;
}) {
  const operation = useStableOperation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.effective_value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editVersion, setEditVersion] = useState(object.version);
  const isDocument = object.kind === "document" && entry.entry_id === "body";
  const hasStructureEditor = structureEntryId(object) === entry.entry_id;
  const [structure, setStructure] = useState(() => hasStructureEditor ? structureDraft(object, entry, availableObjects) : null);
  const [saveStructure, setSaveStructure] = useState(false);
  let displayValue = entry.effective_value;
  if (entry.path === "lineage") {
    try {
      const upstream: unknown = JSON.parse(displayValue);
      if (Array.isArray(upstream) && upstream.every(value => typeof value === "string")) displayValue = upstream.join("、") || "暂无上游表";
    } catch { /* 人工填写的自然语言按原文展示。 */ }
  }
  const [editUrl, setEditUrl] = useState(String(entry.human_override?.source_url ?? ""));
  const [editRelated, setEditRelated] = useState(object.related_ids);
  // 批量模式下暂存值优先作为编辑起点，避免重复打开编辑器时丢失已暂存内容。
  const stagedValue = staged?.edit.value;
  const baseValue = stagedValue ?? entry.effective_value;
  const initialEdit = useRef("");
  const confirmClose = useUnsavedChanges(editing && initialEdit.current !== JSON.stringify([value, editUrl, editRelated, structure, saveStructure]), () => { setEditing(false); setValue(baseValue); });
  useEffect(() => {
    if (!editing) setValue(baseValue);
  }, [object.version, entry.entry_id, editing, baseValue]);
  const save = async (clear = false) => {
    try {
      setError("");
      const structuredValue = !clear && saveStructure && structure ? structureFromDraft(structure) : null;
      const edit: KnowledgeEntryEdit = {
        entry_id: entry.entry_id,
        value,
        clear_override: clear,
        ...(hasStructureEditor ? { structured_value: structuredValue } : {}),
        ...(isDocument && !clear ? { source_url: editUrl.trim() || null, related_ids: editRelated } : {}),
      };
      if (batchMode && onStage) {
        onStage({ objectId: object.id, version: editVersion, edit });
        confirmClose.markSaved();
        setEditing(false);
        return;
      }
      setBusy(true);
      const v = await api("KnowledgeObject", "/knowledge/" + object.id, "PATCH", {
        ...edit, operation_id: operation({ object: object.id, version: editVersion, edit }),
        expected_version: editVersion,
      });
      confirmClose.markSaved();
      onSaved(v);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const sourceId =
    typeof entry.source_facts.source_id === "string"
      ? entry.source_facts.source_id
      : object.source_id;
  return (
    <div className="semantic-entry">
      <div className="entry-head">
        <strong>{entry.label}</strong>
        <KnowledgeStatus entries={[entry]}/>
        {stagedValue !== undefined && <span className="status-pill staged">已暂存</span>}
        {canEdit && !editing && (
          <button onClick={() => {
            const stagedStructure = staged?.edit.structured_value;
            const draft = hasStructureEditor
              ? structureDraft(object, staged ? { ...entry, effective_structure: stagedStructure ?? null } : entry, availableObjects)
              : null;
            const confirmed = Boolean(stagedStructure);
            const url = String(staged ? staged.edit.source_url ?? "" : entry.human_override?.source_url ?? "");
            const related = staged?.edit.related_ids ?? object.related_ids;
            initialEdit.current = JSON.stringify([baseValue, url, related, draft, confirmed]);
            setStructure(draft); setSaveStructure(confirmed); setEditVersion(staged?.version ?? object.version);
            setEditUrl(url); setEditRelated(related); setValue(baseValue); setEditing(true);
          }}>编辑</button>
        )}
      </div>
      {editing ? (
        <>
          <label className="sr-only" htmlFor={object.id + "-" + entry.entry_id}>
            {entry.label}
          </label>
          <textarea
            disabled={busy}
            id={object.id + "-" + entry.entry_id}
            className="editor"
            rows={Math.min(14, Math.max(3, value.split("\n").length))}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {isDocument && <>
            <label className="form-label">来源链接<input aria-label="编辑来源链接" value={editUrl} onChange={e => setEditUrl(e.target.value)} /></label>
            <KnowledgePicker selected={editRelated} disabled={busy} onAdd={object => setEditRelated(old => [...old, object.id])} onRemove={id => setEditRelated(old => old.filter(value => value !== id))}/>
          </>}
          {hasStructureEditor && structure && <SemanticStructureEditor object={object} draft={structure} confirmed={saveStructure} disabled={busy} hadStructure={Boolean(entry.effective_structure)} onChange={setStructure} onConfirm={setSaveStructure}/>}
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {batchMode ? "暂存修改" : "保存修改"}
            </button>
            <button
              disabled={busy}
              onClick={() => confirmClose(() => { setEditing(false); setValue(baseValue); })}
            >
              放弃本次编辑
            </button>
            {entry.human_override && (
              <button disabled={busy} onClick={() => void save(true)}>
                清除人工覆盖
              </button>
            )}
          </div>
        </>
      ) : stagedValue !== undefined ? (
        <>
          {!["sql", "ddl", "etl", "lineage"].includes(entry.path)
            ? <MarkdownContent text={stagedValue || "尚缺说明"} className="entry-value staged-value"/>
            : <p className="code-text staged-value">{stagedValue || "尚缺说明"}</p>}
          <p className="quiet">暂存值，随“查看本次修改”批量提交后生效。</p>
        </>
      ) : !["sql", "ddl", "etl", "lineage"].includes(entry.path) ? <MarkdownContent text={entry.effective_value || "尚缺说明"} className="entry-value" /> : (
        <p
          className={
            entry.path === "sql" || entry.path === "ddl" || entry.path === "etl"
              ? "code-text"
              : "entry-value"
          }
        >
          {displayValue || "尚缺说明"}
        </p>
      )}
      {!editing && hasStructureEditor && <SemanticStructureView value={entry.effective_structure}/>}
      {typeof entry.human_override?.source_url === "string" && /^https?:\/\//i.test(entry.human_override.source_url) && (
        <p className="quiet"><a href={entry.human_override.source_url} target="_blank" rel="noopener noreferrer">打开来源链接 ↗</a>{!entry.effective_value.trim() && " · 正文尚未录入，Agent无法据此解释业务"}</p>
      )}
      <details className="provenance-detail">
        <summary>查看依据与修改记录</summary>
        <div className="provenance-columns">
          <section>
            <h4>来源资料</h4>
            <p>{String(entry.source_facts.value ?? entry.source_facts.gap ?? "请查看来源正文")}</p>
            {sourceId && (
              <button onClick={() => onSource(sourceId)}>查看来源正文 ↗</button>
            )}
          </section>
          <section>
            <h4>分析建议</h4>
            <p>{String(entry.suggestion.value ?? "暂无分析建议")}</p>
          </section>
          <section>
            <h4>人工修改</h4>
            <p>{entry.human_override ? `由 ${String(entry.human_override.edited_by ?? object.updated_by)} 修改` : "尚未人工修改"}</p>
          </section>
        </div>
      </details>
      {!canEdit && <ProposeCorrection object={object} entry={entry} onSaved={onCorrection}/>}
      {error && (
        <p className="error" role="alert">
          {error === "version_conflict"
            ? "版本已变化，请刷新后核对再保存。"
            : error}
        </p>
      )}
    </div>
  );
}
// U-03：血缘与加工页签——上游表名与已加载表匹配后可点击直达，未匹配按原文展示；加工步骤按序只读展示并可维护。
