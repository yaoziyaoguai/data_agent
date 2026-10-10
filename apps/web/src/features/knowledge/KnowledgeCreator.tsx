import { useState } from "react";
import type { KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { KnowledgePicker } from "../../shared/KnowledgePicker.tsx";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import { Modal } from "../../shared/Modal.tsx";
import { semanticError, useStableOperation } from "./semantic-commands.ts";

export function KnowledgeCreator({
  user,
  canCreate,
  relatedId,
  onCreated,
}: {
  user: string;
  canCreate: boolean;
  relatedId: string;
  onCreated: (object: KnowledgeObject) => void;
}) {
  const [formId, setFormId] = useState("");
  const [kind, setKind] = useState<"metric" | "document" | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [related, setRelated] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmClose = useUnsavedChanges(kind !== null && Boolean(name || body || sourceUrl || JSON.stringify(related) !== JSON.stringify(relatedId ? [relatedId] : [])), () => setKind(null));
  const operation = useStableOperation();
  const label = kind === "metric" ? "指标" : "文档";
  const open = (value: "metric" | "document") => {
    setFormId(crypto.randomUUID());
    setKind(value);
    setName("");
    setBody("");
    setSourceUrl("");
    setRelated(relatedId ? [relatedId] : []);
    setError("");
  };
  const save = async () => {
    if (busy || !kind || !canCreate) return;
    const input = {
      kind,
      name,
      body,
      source_url: sourceUrl.trim() || null,
      related_ids: related,
    };
    setBusy(true);
    setError("");
    try {
      const value = await api("KnowledgeObject", "/knowledge", "POST", {
        ...input,
        operation_id: operation({ formId, ...input }),
      });
      confirmClose.markSaved();
      setKind(null);
      onCreated(value);
    } catch (e) {
      setError(semanticError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button disabled={!canCreate} onClick={() => open("metric")}>
        录入指标
      </button>
      <button
        className="primary"
        disabled={!canCreate}
        onClick={() => open("document")}
      >
        录入业务文档
      </button>
      {kind && (
        <Modal
          title={kind === "metric" ? "录入指标" : "录入业务文档"}
          onClose={() => {
            if (!busy) confirmClose(() => setKind(null));
          }}
        >
          <p className="quiet semantic-creation-notice">
            首次保存后，你（{user}）就是此{label}
            的负责人。其他维护者可以向你提出纠错建议。
          </p>
          <label className="form-label">
            {label}名称
            <input
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="form-label">
            {kind === "metric"
              ? "指标口径与计算 SQL"
              : "正文（支持 Markdown 章节）"}
            <textarea
              rows={12}
              value={body}
              disabled={busy}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <fieldset disabled={busy}><legend>关联资料（可选）</legend><KnowledgePicker selected={related} disabled={busy} onAdd={object => setRelated(old => [...old, object.id])} onRemove={id => setRelated(old => old.filter(value => value !== id))}/></fieldset>
          <label className="form-label">
            来源链接（可选）
            <input
              type="url"
              value={sourceUrl}
              disabled={busy}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://example.invalid/business-guide"
            />
          </label>
          <p className="quiet">
            只有链接时会标明正文未录入，Agent 不会自动假定已经读过。
          </p>
          <button
            className="primary"
            disabled={
              busy ||
              !canCreate ||
              !name.trim() ||
              (!body.trim() && !sourceUrl.trim())
            }
            onClick={() => void save()}
          >
            保存{label}
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
