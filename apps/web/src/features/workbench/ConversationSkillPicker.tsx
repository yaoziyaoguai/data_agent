import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Asset,
  ConversationSkillSelection,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";

export function ConversationSkillPicker({
  cid,
  onClose,
  onSelectSkill,
  onSelectionChanged,
  onManageSkills,
}: {
  cid: string | null;
  onClose: () => void;
  onSelectSkill: (asset: Asset) => Promise<string>;
  onSelectionChanged: (nextCid?: string) => void;
  onManageSkills: () => void;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selections, setSelections] = useState<ConversationSkillSelection[]>([]);
  const [changeBlocked, setChangeBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "personal" | "space">("all");
  const pendingRemovals = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    const load = async () => {
      try {
        const [assetList, selectedList] = await Promise.all([
          api("AssetList", "/assets"),
          cid
            ? api("ConversationSkillSelections", "/conversations/" + cid + "/skill-selections")
            : Promise.resolve(null),
        ]);
        if (!active) return;
        setAssets(assetList.assets);
        setSelections(selectedList?.selections ?? []);
        setChangeBlocked(selectedList?.change_blocked ?? false);
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "分析方法读取失败");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [cid]);

  const enabledSkills = useMemo(
    () => assets.filter(a => a.kind === "skill" && a.state === "enabled" && !a.text_unavailable && !a.draft_status),
    [assets],
  );
  const draftCount = useMemo(
    () => assets.filter(a => a.kind === "skill" && a.state === "draft" && !a.draft_status).length,
    [assets],
  );
  const selectedByAsset = useMemo(
    () => new Map(selections.map(item => [item.asset_id, item])),
    [selections],
  );
  const visibleSkills = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return enabledSkills.filter(skill => {
      if (scopeFilter === "personal" && skill.visibility === "space") return false;
      if (scopeFilter === "space" && skill.visibility !== "space") return false;
      if (!keyword) return true;
      return [skill.name, skill.scope, skill.body].some(text => text.toLowerCase().includes(keyword));
    });
  }, [enabledSkills, scopeFilter, search]);

  const choose = async (asset: Asset) => {
    if (busyId || changeBlocked) return;
    setBusyId(asset.id);
    setActionError("");
    try {
      const nextCid = await onSelectSkill(asset);
      onSelectionChanged(nextCid || undefined);
      onClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (selection: ConversationSkillSelection) => {
    if (!cid || busyId || changeBlocked) return;
    setBusyId(selection.asset_id);
    setActionError("");
    let operationId = pendingRemovals.current.get(selection.selection_id);
    if (!operationId) {
      operationId = crypto.randomUUID();
      pendingRemovals.current.set(selection.selection_id, operationId);
    }
    try {
      await api("SkillRemovalReceipt", "/conversations/" + cid + "/skill-selections", "DELETE", {
        operation_id: operationId,
        asset_id: selection.asset_id,
        selection_id: selection.selection_id,
      });
      pendingRemovals.current.delete(selection.selection_id);
      setSelections(old => old.filter(item => item.selection_id !== selection.selection_id));
      onSelectionChanged(cid);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      if (code === "version_conflict") pendingRemovals.current.delete(selection.selection_id);
      setActionError(
        code === "message_pending"
          ? "当前输入尚未结束，请等待生成完成再调整分析方法。"
          : "暂时无法移除该方法，请稍后重试。",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      title="选用分析方法"
      className="skill-picker-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="quiet">选用后仅对当前对话生效，不会改动未发送草稿</span>
          <button
            type="button"
            className={enabledSkills.length === 0 ? "primary" : undefined}
            onClick={() => {
              onClose();
              onManageSkills();
            }}
          >
            去我的积累管理
          </button>
          {enabledSkills.length > 0 && (
            <button type="button" className="primary" onClick={onClose}>
              完成
            </button>
          )}
        </>
      }
    >
      {draftCount > 0 && (
        <div className="asset-operation-note" role="status" style={{ marginTop: 0, marginBottom: 14 }}>
          你有 {draftCount} 份待核对保存的方法草稿，点击下方“去我的积累管理”核对保存后即可在对话中选用。
        </div>
      )}
      <div className="skill-picker-toolbar">
        <label className="search-box">
          <span>⌕</span>
          <input
            aria-label="搜索分析方法"
            placeholder="搜索个人或空间公共 Skill"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        <div className="history-tabs" role="group" aria-label="方法来源" style={{ marginBottom: 0 }}>
          <button type="button" aria-pressed={scopeFilter === "all"} onClick={() => setScopeFilter("all")}>
            全部 {enabledSkills.length}
          </button>
          <button type="button" aria-pressed={scopeFilter === "personal"} onClick={() => setScopeFilter("personal")}>
            我的 Skill {enabledSkills.filter(a => a.visibility !== "space").length}
          </button>
          <button type="button" aria-pressed={scopeFilter === "space"} onClick={() => setScopeFilter("space")}>
            空间公共 {enabledSkills.filter(a => a.visibility === "space").length}
          </button>
        </div>
      </div>
      {changeBlocked && <p className="quiet" role="status">当前对话输入正在处理中，完成后可调整分析方法。</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {loading && <p role="status" className="quiet">正在读取可用分析方法…</p>}
      {!loading && !loadError && visibleSkills.length === 0 && (
        <div className="asset-empty" style={{ marginTop: 12, padding: "36px 20px" }}>
          <p>{enabledSkills.length === 0 ? "当前还没有已启用的分析方法，可通过下方“去我的积累管理”新建或从模板采用。" : "没有匹配当前筛选条件的分析方法。"}</p>
          {enabledSkills.length > 0 && (search || scopeFilter !== "all") && (
            <button type="button" onClick={() => { setSearch(""); setScopeFilter("all"); }}>
              清除筛选
            </button>
          )}
        </div>
      )}
      {!loading && !loadError && visibleSkills.length > 0 && (
        <div className="skill-picker-list">
          {visibleSkills.map(skill => {
            const selected = selectedByAsset.get(skill.id);
            const active = selected?.availability === "available";
            return (
              <article key={skill.id} className="asset-card">
                <div className="skill-picker-item-main">
                  <div className="skill-picker-meta">
                    <span className="status-pill">{skill.visibility === "space" ? "空间公共" : "个人"}</span>
                    {skill.verified && <span>已核对</span>}
                    {active && <span>· 当前对话已选用</span>}
                  </div>
                  <h3>{skill.name}</h3>
                  <p>{skill.scope}</p>
                </div>
                <div className="skill-picker-actions">
                  {active && selected ? (
                    <button
                      type="button"
                      disabled={busyId !== null || changeBlocked}
                      aria-label={"从本会话移除 " + skill.name}
                      onClick={() => void remove(selected)}
                    >
                      {busyId === skill.id ? "正在移除…" : "从本会话移除"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={busyId !== null || changeBlocked}
                      onClick={() => void choose(skill)}
                    >
                      {busyId === skill.id ? "选用中…" : selected?.availability === "version_changed" ? "更新所选版本" : "在当前对话选用"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
