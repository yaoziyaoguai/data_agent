import { useState } from "react";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import {
  semanticError as message,
  useStableOperation,
} from "./semantic-commands.ts";
import type { KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
export function SemanticMaintainer({
  object,
  onSaved,
}: {
  object: KnowledgeObject;
  onSaved: () => void;
}) {
  const operationId = useStableOperation();
  const [editing, setEditing] = useState(false),
    [owner, setOwner] = useState(""),
    [version, setVersion] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const maintenance = object.maintenance;
  if (!maintenance) return null;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api(
        "SemanticMaintenance",
        "/knowledge/" + object.id + "/maintainer",
        "POST",
        {
          operation_id: operationId({
            id: object.id,
            version,
            owner: owner.trim() || null,
          }),
          expected_version: version,
          maintainer_id: owner.trim() || null,
        },
      );
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="semantic-maintainer">
      <p className="quiet">
        语义负责人：{maintenance.maintainer_id ?? "暂未指定"} ·{" "}
        {maintenance.source === "datasight"
          ? "来自 Datasight 最近一次同步"
          : maintenance.source === "creator" ? "首次录入后自动负责" : "本系统管理归属"}
        {maintenance.authority_id !== object.id ? " · 沿用所属表" : ""} ·{" "}
        {maintenance.can_edit ? "你可以维护" : "你可以提出纠错"}
      </p>
      <p className="quiet">
        录入：{object.created_by ?? "历史记录未提供"} · 最后修改：
        {object.updated_by}
      </p>
      {maintenance.can_assign && (
        <button
          onClick={() => {
            setEditing(true);
            setOwner(maintenance.maintainer_id ?? "");
            setVersion(maintenance.version);
          }}
        >
          指定负责人
        </button>
      )}
      {editing && (
        <Modal title="指定独立语义负责人" onClose={() => setEditing(false)}>
          <p>此授权仅用于本对象的语义维护，不改变资料读取或 SQL 执行权限。</p>
          <label className="form-label">
            负责人用户 ID（留空则撤销）
            <input value={owner} onChange={(e) => setOwner(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            保存负责人
          </button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
