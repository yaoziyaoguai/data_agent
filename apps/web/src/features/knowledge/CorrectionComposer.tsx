import { useEffect, useState } from "react";
import { api } from "../../shared/api.ts";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
import { KnowledgePicker } from "../../shared/KnowledgePicker.tsx";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import { Modal } from "../../shared/Modal.tsx";
import {
  semanticError as message,
  useStableOperation,
} from "./semantic-commands.ts";
import type {
  KnowledgeObject,
  KnowledgeEntry,
  Proposal,
  EvidenceRef,
} from "../../../../../packages/contracts/generated/boundary.ts";
export type CorrectionContent = Pick<
  Proposal,
  "object_id" | "base_version" | "entry_id" | "value" | "reason" | "evidence"
>;
export function CorrectionComposer({
  content,
  revision,
  onClose,
  onSaved,
}: {
  content: CorrectionContent;
  revision?: { id: string; value: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const operationId = useStableOperation();
  const [value, setValue] = useState(content.value),
    [reason, setReason] = useState(content.reason),
    [shared, setShared] = useState(false);
  const [baseVersion, setBaseVersion] = useState(content.base_version),
    [evidence, setEvidence] = useState<EvidenceRef[]>(content.evidence);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [refObject, setRefObject] = useState<KnowledgeObject | null>(null),
    [refPath, setRefPath] = useState("");
  const confirmClose = useUnsavedChanges((value !== content.value || reason !== content.reason || JSON.stringify(evidence) !== JSON.stringify(content.evidence) || Boolean(refObject)), onClose);
  const refreshBasis = async () => {
    try {
      const object = await api(
        "KnowledgeObject",
        "/knowledge/" + content.object_id,
      );
      setBaseVersion(object.version);
      setEvidence([
        {
          object_id: object.id,
          version: object.version,
          path: content.entry_id,
        },
      ]);
      setShared(false);
    } catch (e) {
      setError(message(e));
    }
  };
  const addEvidence = async () => {
    try {
      if (!refObject) return;
      const object = await api("KnowledgeObject", "/knowledge/" + refObject.id);
      if (
        !object.entries.some(
          (e) => e.entry_id === refPath.trim() || e.path === refPath.trim(),
        )
      )
        throw new Error("请选择资料中的说明条目。");
      setEvidence((old) => [
        ...old,
        { object_id: object.id, version: object.version, path: refPath.trim() },
      ]);
      setRefObject(null);
      setRefPath("");
      setShared(false);
    } catch (e) {
      setError(message(e));
    }
  };
  const save = async (draft: boolean) => {
    setBusy(true);
    setError("");
    try {
      const body = {
        object_id: content.object_id,
        entry_id: content.entry_id,
        base_version: baseVersion,
        value,
        reason,
        evidence,
        operation_id: operationId({
          action: draft ? "draft" : revision ? "revise" : "submit",
          object_id: content.object_id,
          entry_id: content.entry_id,
          baseVersion,
          value,
          reason,
          evidence,
          revision,
        }),
      };
      if (draft) await api("Proposal", "/knowledge-proposals", "POST", body);
      else
        await api(
          "SemanticCorrection",
          revision
            ? "/semantic-corrections/" + revision.id
            : "/semantic-corrections",
          revision ? "PATCH" : "POST",
          {
            ...body,
            share_confirmed: true,
            ...(revision ? { expected_revision: revision.value } : {}),
          },
        );
      confirmClose.markSaved();
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={revision ? "修订并重新提交建议" : "整理语义纠错建议"}
      onClose={() => { if (!busy) confirmClose(onClose); }}
    >
      <p>
        <KnowledgeReference id={content.object_id} path={content.entry_id}/>
      </p>
      <p className="quiet">
        提交后，提出者、对象负责人和超级维护者可见以下内容。当前对话可继续修改
        SQL 和查询。
      </p>
      <label className="form-label">
        建议修改为
        <textarea
          rows={5}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setShared(false);
          }}
        />
      </label>
      <label className="form-label">
        修改理由
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setShared(false);
          }}
        />
      </label>
      <h3>共享依据</h3>
      <ul>
        {evidence.map((r, i) => (
          <li key={i}>
            <KnowledgeReference id={r.object_id} path={r.path}/>{" "}
            <button
              onClick={() => {
                setEvidence((old) => old.filter((_, n) => n !== i));
                setShared(false);
              }}
              aria-label={"移除依据 " + (i + 1)}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      <details>
        <summary>补充正式知识依据</summary>
        <KnowledgePicker selected={refObject ? [refObject.id] : []} onAdd={object => { setRefObject(object); setRefPath(object.entries[0]?.entry_id ?? ""); }} onRemove={() => { setRefObject(null); setRefPath(""); }}/>
        {refObject && <label className="form-label">引用内容<select value={refPath} onChange={e => setRefPath(e.target.value)}>{refObject.entries.map(entry => <option key={entry.entry_id} value={entry.entry_id}>{entry.label}</option>)}</select></label>}
        <button
          onClick={() => void addEvidence()}
          disabled={!refObject || !refPath.trim()}
        >
          添加依据
        </button>
      </details>
      <button onClick={() => void refreshBasis()}>
        重新核对最新内容与依据
      </button>
      <label className="form-label">
        <span>
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />{" "}
          已核对以上内容可共享；不附带聊天、查询结果或个人记忆
        </span>
      </label>
      <div className="actions">
        {!revision && (
          <button
            disabled={
              busy || !value.trim() || !reason.trim() || !evidence.length
            }
            onClick={() => void save(true)}
          >
            仅保存私人草稿
          </button>
        )}
        <button
          className="primary"
          disabled={
            busy ||
            !shared ||
            !value.trim() ||
            !reason.trim() ||
            !evidence.length
          }
          onClick={() => void save(false)}
        >
          {busy ? "正在保存…" : revision ? "重新提交审核" : "确认提交给负责人"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}
export function ProposeCorrection({
  object,
  entry,
  onSaved,
}: {
  object: KnowledgeObject;
  entry: KnowledgeEntry;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        disabled={object.state !== "enabled"}
        onClick={() => setOpen(true)}
      >
        提出纠错
      </button>
      {open && (
        <CorrectionComposer
          content={{
            object_id: object.id,
            base_version: object.version,
            entry_id: entry.entry_id,
            value: entry.effective_value || "",
            reason: "",
            evidence: [
              {
                object_id: object.id,
                version: object.version,
                path: entry.entry_id,
              },
            ],
          }}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}
