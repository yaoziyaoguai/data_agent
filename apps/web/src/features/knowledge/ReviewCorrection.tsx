import { useEffect, useState } from "react";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
import { api } from "../../shared/api.ts";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import { Modal } from "../../shared/Modal.tsx";
import {
  semanticError as message,
  useStableOperation,
} from "./semantic-commands.ts";
import type {
  KnowledgeObject,
  SemanticCorrection,
} from "../../../../../packages/contracts/generated/boundary.ts";
export function ReviewCorrection({
  correction,
  action,
  onClose,
  onSaved,
}: {
  correction: SemanticCorrection;
  action: "accepted" | "rejected" | "apply";
  onClose: () => void;
  onSaved: () => void;
}) {
  const operationId = useStableOperation();
  const [text, setText] = useState(action === "apply" ? correction.value : ""),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const confirmClose = useUnsavedChanges(text !== (action === "apply" ? correction.value : ""), onClose);
  const [current, setCurrent] = useState<KnowledgeObject | null>(null);
  useEffect(() => {
    void api("KnowledgeObject", "/knowledge/" + correction.object_id)
      .then(setCurrent)
      .catch((e) => setError(message(e)));
  }, [correction.object_id]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api(
        "SemanticCorrection",
        "/semantic-corrections/" +
          correction.id +
          (action === "apply" ? "/apply" : "/review"),
        "POST",
        {
          operation_id: operationId({
            id: correction.id,
            revision: correction.revision,
            version: correction.base_version,
            action,
            text,
          }),
          expected_revision: correction.revision,
          ...(action === "apply"
            ? { expected_version: correction.base_version, value: text }
            : { decision: action, reason: text }),
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
      title={
        action === "apply"
          ? "核对并编辑正式语义"
          : action === "accepted"
            ? "接受建议，稍后修改"
            : "驳回建议"
      }
      onClose={() => { if (!busy) confirmClose(onClose); }}
    >
      <p>
        <KnowledgeReference id={correction.object_id} path={correction.entry_id}/>
      </p>
      <h3>当前正式内容</h3>
      <pre className="source-body">
        {
          current?.entries.find((e) => e.entry_id === correction.entry_id)
            ?.effective_value
        }
      </pre>
      {action === "apply" && current?.version !== correction.base_version && (
        <p role="alert" className="error">
          正式语义已变化。请提出者核对新版本、修订建议并重新提交。
        </p>
      )}
      <label className="form-label">
        {action === "apply" ? "核对后保存的正式内容" : "处理理由"}
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {action === "apply" ? (
        <label className="form-label">
          <span>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />{" "}
            已核对当前版本与共享依据
          </span>
        </label>
      ) : (
        <p className="quiet">
          本操作只记录处理意见。接受后仍需编辑并明确保存，正式语义才会更新。
        </p>
      )}
      <button
        className="primary"
        onClick={() => void save()}
        disabled={
          busy ||
          !text.trim() ||
          !current ||
          (action === "apply" &&
            (!checked || current.version !== correction.base_version))
        }
      >
        {busy
          ? "正在保存…"
          : action === "apply"
            ? "保存正式内容"
            : action === "accepted"
              ? "确认接受"
              : "确认驳回"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}
