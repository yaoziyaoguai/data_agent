import { useEffect, useRef, useState } from "react";
import type { Asset, AssetKind, EvidenceRef, SkillFile } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { SkillFilesEditor } from "./SkillFilesEditor.tsx";
import { PublishSkill } from "./PublishSkill.tsx";
import { SkillSuggestions } from "./SkillSuggestions.tsx";
import { AssetDependenciesEditor } from "./AssetDependenciesEditor.tsx";
import { Modal } from "../../shared/Modal.tsx";
export function AssetsPage({
  user,
  onUseSkill,
}: {
  user: string;
  onUseSkill: (asset: Asset) => Promise<void>;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tab, setTab] = useState<"memory" | "skill" | "shared">("memory");
  const [editing, setEditing] = useState<Asset | null | undefined>();
  const [editingKind, setEditingKind] = useState<AssetKind>("memory");
  const [dependencies, setDependencies] = useState<EvidenceRef[]>([]);
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [publishing, setPublishing] = useState<{asset: Asset; session: number; page: number} | null>(null);
  const [suggesting, setSuggesting] = useState<Asset | null>(null);
  const [saving, setSaving] = useState(false);
  const editorSession = useRef(0);
  const publicationSession = useRef(0);
  const pageSession = useRef(0);
  const saveOperation = useRef({key: "", id: ""});
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState("");
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [backgroundOutcome, setBackgroundOutcome] = useState("");
  const [listError, setListError] = useState("");
  const listRequest = useRef(0);
  const refresh = async () => {
    const request = ++listRequest.current;
    const page = pageSession.current;
    try {
      const result = await api("AssetList", "/assets");
      if (page === pageSession.current && request === listRequest.current) {
        setAssets(result.assets);
        setListError("");
      }
    } catch {
      if (page === pageSession.current && request === listRequest.current) {
        setListError("列表暂时未能更新，已收到的保存或发布成功回执仍然有效。请重新加载列表。");
      }
    }
  };
  useEffect(() => {
    pageSession.current++;
    void refresh();
    return () => { pageSession.current++; listRequest.current++; editorSession.current++; publicationSession.current++; };
  }, [user]);
  useEffect(() => {
    if (!assets.some(a => a.memory_index_state === "queued" || a.memory_index_state === "issued")) return;
    const timer = setTimeout(() => { void refresh(); }, 1500);
    return () => clearTimeout(timer);
  }, [assets]);
  const edit = (asset: Asset | null) => {
    editorSession.current++;
    setSaving(false);
    saveOperation.current = {key: "", id: ""};
    setError("");
    setNotice("");
    setBackgroundOutcome("");
    setFiles(asset?.files ?? []);
    setDependencies(asset?.dependencies ?? []);
    setEditingKind(asset?.kind ?? (tab === "memory" ? "memory" : "skill"));
    setEditing(asset);
    setName(asset?.name ?? "");
    setBody(
      asset?.body ??
        (tab !== "memory"
          ? "# 分析方法\n\n## 适用范围\n\n## 步骤\n1. 核对资料与口径\n2. 展示 SQL，等待用户确认\n3. 解释查询结果\n\n## 输出要求\n列出依据、范围与限制"
          : ""),
    );
    setScope(asset?.scope ?? "");
    setVerified(asset?.verified ?? false);
  };
  const closeEditor = () => {
    editorSession.current++;
    setEditing(undefined);
    setSaving(false);
  };
  const save = async () => {
    if (saving) return;
    const session = editorSession.current;
    const page = pageSession.current;
    setSaving(true); setError("");
    try {
      const input = {
        id: editing?.id ?? null,
        expected_version: editing?.version ?? null,
        kind: editingKind,
        files,
        name,
        body,
        scope,
        verified,
        source_text: editing?.source_text ?? "用户在个人积累页明确保存",
        dependencies,
      };
      const key = JSON.stringify(input);
      if (saveOperation.current.key !== key) saveOperation.current = {key, id: crypto.randomUUID()};
      const saved = await api("Asset", "/assets", "POST", { ...input, operation_id: saveOperation.current.id });
      if (page !== pageSession.current) return;
      // 窗口状态只归原编辑所有；已提交的数据仍须同步到当前页面的列表。
      if (session === editorSession.current) {
        setEditing(undefined);
        setTab(saved.kind === "memory" ? "memory" : saved.visibility === "space" ? "shared" : "skill");
        setNotice(saved.visibility === "space" ? "公共方法已保存新版本；会话仍需明确重选。" : "已保存到你的个人积累，其他用户无法读取。");
      }
      await refresh();
    } catch (e) {
      if (session === editorSession.current) setError(e instanceof Error && e.message === "skill_line_too_long" ? "方法或附件中有单行内容过长，请分行后保存（每行不超过 50 KiB）。" : e instanceof Error ? e.message : "保存失败");
      else if (page === pageSession.current) setBackgroundOutcome(`《${name}》的保存未收到成功回执，请重新加载列表核对。`);
    } finally { if (session === editorSession.current) setSaving(false); }
  };
  const publish = (asset: Asset) => {
    setNotice("");
    setBackgroundOutcome("");
    setPublishing({asset, session: ++publicationSession.current, page: pageSession.current});
  };
  const closePublisher = () => {
    publicationSession.current++;
    setPublishing(null);
  };
  const state = async (asset: Asset, action: string) => {
    const page = pageSession.current;
    const editor = editorSession.current;
    const publication = publicationSession.current;
    const feedbackIsCurrent = () => page === pageSession.current && editor === editorSession.current && publication === publicationSession.current;
    try {
      await api("Asset", "/assets/" + asset.id + "/" + action, "POST", {
        operation_id: crypto.randomUUID(),
        expected_version: asset.version,
      });
      if (page !== pageSession.current) return;
      if (feedbackIsCurrent()) setNotice(
        action === "delete"
          ? "已删除，后续不再采用。"
          : "状态已更新，后续运行按最新状态核对。",
      );
      await refresh();
    } catch (e) {
      if (feedbackIsCurrent()) setError(String(e));
      else if (page === pageSession.current) setBackgroundOutcome(`《${asset.name}》的状态修改未收到成功回执，请重新加载列表核对。`);
    }
  };
  const matches = (asset: Asset) => tab === "memory" ? asset.kind === "memory" : asset.kind === "skill" && (tab === "shared" ? asset.visibility === "space" : asset.visibility !== "space");
  return (
    <section className="management assets-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">积累能继续使用的经验</div>
          <h1>我的积累</h1>
          <p>纠错记住适用范围，方法由你决定何时采用。</p>
        </div>
        <button className="primary" onClick={() => edit(null)}>
          新增{tab === "memory" ? "记忆" : "个人 Skill"}
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
          <small>{assets.filter((a) => a.kind === "skill" && a.visibility !== "space").length}</small>
        </button>
        <button role="tab" aria-selected={tab === "shared"} onClick={() => setTab("shared")}>空间公共 Skill <small>{assets.filter(a => a.visibility === "space").length}</small></button>
      </div>
      {tab === "shared" && <p className="quiet skill-sharing-note">本空间成员共享的分析方法。负责人维护正文，其他成员可以提出建议；使用时仍需明确选用。</p>}
      <div className="asset-grid">
        {assets
          .filter(matches)
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
              {asset.kind === "skill" && <p className="quiet skill-owner">{asset.visibility === "space" ? "空间公共" : "个人"} · 负责人 {asset.owner_id ?? user}</p>}
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
              {(asset.files ?? []).map(file => <details key={file.path}><summary>{file.path}</summary><pre className="skill-preview">{file.content}</pre></details>)}
              <div className="actions">
                {asset.can_edit && <>
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
                </button></>}
                {asset.kind === "skill" && asset.visibility !== "space" && asset.state === "enabled" && <button onClick={() => publish(asset)}>发布到空间</button>}
                {asset.visibility === "space" && <button onClick={() => setSuggesting(asset)}>修改建议</button>}
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
      {!assets.some(matches) && (
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
      {listError && <div className="asset-list-error" role="alert"><p>{listError}</p><button onClick={() => void refresh()}>重新加载列表</button></div>}
      {backgroundOutcome && <div className="asset-operation-note" role="status"><p>{backgroundOutcome}</p><button onClick={() => void refresh()}>核对已提交记录</button></div>}
      {editing !== undefined && (
        <Modal
          title={
            (editing ? "编辑" : "新增") +
            (editingKind === "memory" ? "个人记忆" : "Skill")
          }
          onClose={closeEditor}
        >
          <label className="form-label">
            名称
            <input disabled={saving} aria-label="名称" value={name} onChange={(e) => { setName(e.target.value); setVerified(false); }} />
          </label>
          <label className="form-label">
            内容
            <textarea
              aria-label="内容"
              disabled={saving}
              rows={12}
              value={body}
              onChange={(e) => { setBody(e.target.value); setVerified(false); }}
            />
          </label>
          <label className="form-label">
            适用范围与例外
            <input
              disabled={saving}
              value={scope}
              onChange={(e) => { setScope(e.target.value); setVerified(false); }}
              placeholder="哪些问题可采用，哪些情况除外"
            />
          </label>
          {editingKind === "skill" && <SkillFilesEditor files={files} onChange={value => { setFiles(value); setVerified(false); }} disabled={saving}/>}
          <AssetDependenciesEditor key={editorSession.current} dependencies={dependencies} onChange={value => { setDependencies(value); setVerified(false); }} disabled={saving}/>
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={saving}
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
            />
            我已核对这条{editing?.visibility === "space" ? "公共" : "个人"}定义
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <button
            className="primary"
            disabled={saving || !name.trim() || !body.trim() || !scope.trim()}
            onClick={() => void save()}
          >
            保存
          </button>
        </Modal>
      )}
      {publishing && <PublishSkill key={publishing.session} asset={publishing.asset} onClose={closePublisher} onFailed={() => {
        if (publishing.page === pageSession.current && publishing.session !== publicationSession.current) {
          setBackgroundOutcome(`《${publishing.asset.name}》的发布未收到成功回执，请重新加载列表核对。`);
        }
      }} onPublished={async () => {
        if (publishing.page !== pageSession.current) return;
        if (publishing.session === publicationSession.current) {
          setPublishing(null);
          setTab("shared");
          setNotice("已发布独立公共副本。私人方法后续修改不会自动公开。");
        }
        await refresh();
      }}/>}
      {suggesting && <SkillSuggestions asset={suggesting} onClose={() => setSuggesting(null)}/>}
    </section>
  );
}
