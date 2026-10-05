import { useEffect, useRef, useState } from "react";
import type { Asset } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
export function AssetsPage({
  user,
  onUseSkill,
}: {
  user: string;
  onUseSkill: (asset: Asset) => Promise<void>;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tab, setTab] = useState<"memory" | "skill">("memory");
  const [editing, setEditing] = useState<Asset | null | undefined>();
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState("");
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const listRequest = useRef(0);
  const refresh = async () => {
    const request = ++listRequest.current;
    const result = await api("AssetList", "/assets");
    if (request === listRequest.current) setAssets(result.assets);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    return () => { listRequest.current++; };
  }, [user]);
  useEffect(() => {
    if (!assets.some(a => a.memory_index_state === "queued" || a.memory_index_state === "issued")) return;
    const timer = setTimeout(() => { void refresh().catch(e => setError(e.message)); }, 1500);
    return () => clearTimeout(timer);
  }, [assets]);
  const edit = (asset: Asset | null) => {
    setEditing(asset);
    setName(asset?.name ?? "");
    setBody(
      asset?.body ??
        (tab === "skill"
          ? "# 分析方法\n\n## 适用范围\n\n## 步骤\n1. 核对资料与口径\n2. 展示 SQL，等待用户确认\n3. 解释查询结果\n\n## 输出要求\n列出依据、范围与限制"
          : ""),
    );
    setScope(asset?.scope ?? "");
    setVerified(asset?.verified ?? false);
  };
  const save = async () => {
    listRequest.current++;
    try {
      await api("Asset", "/assets", "POST", {
        operation_id: crypto.randomUUID(),
        id: editing?.id ?? null,
        expected_version: editing?.version ?? null,
        kind: editing?.kind ?? tab,
        name,
        body,
        scope,
        verified,
        source_text: editing?.source_text ?? "用户在个人积累页明确保存",
        dependencies: editing?.dependencies ?? [],
      });
      setEditing(undefined);
      await refresh();
      setNotice("已保存到你的个人积累，其他用户无法读取。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };
  const state = async (asset: Asset, action: string) => {
    listRequest.current++;
    try {
      await api("Asset", "/assets/" + asset.id + "/" + action, "POST", {
        operation_id: crypto.randomUUID(),
        expected_version: asset.version,
      });
      await refresh();
      setNotice(
        action === "delete"
          ? "已删除，后续不再采用。"
          : "状态已更新，后续运行按最新状态核对。",
      );
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section className="management assets-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">积累能继续使用的经验</div>
          <h1>我的积累</h1>
          <p>纠错记住适用范围，方法由你决定何时采用。</p>
        </div>
        <button className="primary" onClick={() => edit(null)}>
          新增{tab === "memory" ? "记忆" : "Skill"}
        </button>
      </div>
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "memory"}
          onClick={() => setTab("memory")}
        >
          记忆与纠错{" "}
          <small>{assets.filter((a) => a.kind === "memory").length}</small>
        </button>
        <button
          role="tab"
          aria-selected={tab === "skill"}
          onClick={() => setTab("skill")}
        >
          我的 Skill{" "}
          <small>{assets.filter((a) => a.kind === "skill").length}</small>
        </button>
      </div>
      <div className="asset-grid">
        {assets
          .filter((a) => a.kind === tab)
          .map((asset) => (
            <article
              key={asset.id}
              className={
                "asset-card " + (asset.state === "disabled" ? "disabled" : "")
              }
            >
              <div className="card-heading">
                <span className="eyebrow">
                  {asset.kind === "memory" ? "PERSONAL MEMORY" : "SKILL"} · v
                  {asset.version}
                </span>
                <span className="status-pill">
                  {asset.state === "enabled" ? "启用" : "停用"}
                </span>
              </div>
              <h2>{asset.name}</h2>
              <p className="asset-body">{asset.body}</p>
              <div className="asset-scope">
                <strong>适用范围</strong>
                <p>{asset.scope}</p>
                <small>
                  {asset.verified ? "用户已确认" : "待核对线索"} ·{" "}
                  {asset.dependencies.length} 个知识依赖
                </small>
              </div>
              {asset.memory_index_state && (
                <p className="asset-index-state" role="status">
                  {asset.memory_index_state === "indexed" ? "记忆检索已同步" : asset.memory_index_state === "failed" ? "记忆已保存，检索同步失败；仍可从个人目录查找。" : "记忆已保存，正在同步检索。"}
                </p>
              )}
              <details>
                <summary>查看来源与依赖</summary>
                <p>{asset.source_text}</p>
                <pre>{JSON.stringify(asset.dependencies, null, 2)}</pre>
              </details>
              <div className="actions">
                <button onClick={() => edit(asset)}>编辑</button>
                <button
                  onClick={() =>
                    void state(
                      asset,
                      asset.state === "enabled" ? "disable" : "enable",
                    )
                  }
                >
                  {asset.state === "enabled" ? "停用" : "启用"}
                </button>
                <button onClick={() => void state(asset, "delete")}>
                  删除
                </button>
                {asset.kind === "skill" && asset.state === "enabled" && (
                  <button
                    className="primary"
                    onClick={() =>
                      void onUseSkill(asset)
                        .then(() =>
                          setNotice("已选择该版本，回到工作台继续提问。"),
                        )
                        .catch((e) => setError(e.message))
                    }
                  >
                    在当前对话选用
                  </button>
                )}
              </div>
            </article>
          ))}
      </div>
      {!assets.some((a) => a.kind === tab) && (
        <div className="asset-empty">
          <span>◇</span>
          <h2>
            {tab === "memory"
              ? "让有价值的纠错留下来"
              : "把分析方法写成自己的 Skill"}
          </h2>
          <p>
            {tab === "memory"
              ? "对话中的明确纠错与偏好可保存到这里，也可以手动录入。每条记忆都属于你。"
              : "保存适用范围、步骤和输出要求，再在需要的对话中明确选用。"}
          </p>
          <button onClick={() => edit(null)}>
            创建第一条{tab === "memory" ? "记忆" : "Skill"}
          </button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editing !== undefined && (
        <Modal
          title={
            (editing ? "编辑" : "新增") +
            (tab === "memory" ? "个人记忆" : "Skill")
          }
          onClose={() => setEditing(undefined)}
        >
          <label className="form-label">
            名称
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="form-label">
            内容
            <textarea
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <label className="form-label">
            适用范围与例外
            <input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="哪些问题可采用，哪些情况除外"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
            />
            我已核对这条个人定义
          </label>
          <button
            className="primary"
            disabled={!name.trim() || !body.trim() || !scope.trim()}
            onClick={() => void save()}
          >
            保存
          </button>
        </Modal>
      )}
    </section>
  );
}
