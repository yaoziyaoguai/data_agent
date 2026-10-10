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
  const [members, setMembers] = useState<string[] | null>(null);
  const maintenance = object.maintenance;
  if (!maintenance) return null;
  const loadMembers = async () => {
    setMembers(null);
    setError("");
    try { setMembers((await api("SemanticMemberList", "/semantic-members")).user_ids); }
    catch (e) { setError(message(e)); }
  };
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
      setError(e instanceof Error && e.message === "invalid_input" ? "负责人已不在当前有效成员中，请重新选择。" : message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="semantic-maintainer">
      <p className="quiet">
        负责人：{maintenance.maintainer_id ?? "暂未指定"} · {maintenance.can_edit ? "你可以编辑" : "你可以提出纠错"}
      </p>
      <details><summary>维护信息</summary><p className="quiet">{maintenance.source === "datasight" ? "负责人来自 Datasight" : maintenance.source === "creator" ? "由首次录入者负责" : "本系统指定负责人"} · 录入：{object.created_by ?? "历史记录未提供"} · 最近修改：{object.updated_by}</p></details>
      {maintenance.can_assign && (
        <button
          onClick={() => {
            setEditing(true);
            setOwner(maintenance.maintainer_id ?? "");
            setVersion(maintenance.version);
            void loadMembers();
          }}
        >
          指定负责人
        </button>
      )}
      {editing && (
        <Modal title="指定独立语义负责人" onClose={() => setEditing(false)}>
          <p>此授权仅用于本对象的语义维护，不改变资料读取或 SQL 执行权限。</p>
          <label className="form-label">
            负责人
            <select aria-label="负责人" value={owner} disabled={members === null || busy} onChange={(e) => setOwner(e.target.value)}>
              <option value="">暂不指定（撤销负责人）</option>
              {owner && !members?.includes(owner) && <option value={owner} disabled>{members === null ? "正在读取成员…" : "原负责人已不在当前成员中"}</option>}
              {members?.map(user => <option key={user} value={user}>{user}</option>)}
            </select>
          </label>
          {members === null && (error ? <button onClick={() => void loadMembers()}>重试读取成员</button> : <p role="status">正在读取当前空间成员…</p>)}
          <button
            className="primary"
            disabled={busy || members === null || (owner !== "" && !members.includes(owner))}
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
