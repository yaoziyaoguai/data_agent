import { useEffect, useRef, useState } from "react";
import type { Asset, AssetKind, EvidenceRef, SkillFile } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { SkillFilesEditor } from "./SkillFilesEditor.tsx";
import { PublishSkill } from "./PublishSkill.tsx";
import { SkillSuggestions } from "./SkillSuggestions.tsx";
import { AssetDependenciesEditor } from "./AssetDependenciesEditor.tsx";
import { Modal } from "../../shared/Modal.tsx";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import { Tabs } from "../../shared/Tabs.tsx";
import { SkillExamples } from "./SkillExamples.tsx";
export function AssetsPage({
  user,
  initialTab = "memory",
  onUseSkill, onTab,
}: {
  user: string;
  initialTab?: "memory" | "skill" | "shared";
  onTab?: (tab: "memory" | "skill" | "shared") => void;
  onUseSkill: (asset: Asset) => Promise<void>;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tab, setTab] = useState<"memory" | "skill" | "shared">(initialTab);
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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const initialEdit = useRef("");
  const confirmClose = useUnsavedChanges(editing !== undefined && initialEdit.current !== JSON.stringify([name, body, scope, verified, files, dependencies]), () => closeEditor());
  useEffect(() => {
    if (initialTab !== tab) {
      editorSession.current++; publicationSession.current++;
      setEditing(undefined); setPublishing(null); setSuggesting(null); setSaving(false);
      setSearch(""); setStatusFilter(""); setTab(initialTab);
    }
  }, [initialTab]);
  const changeTab = (value: "memory" | "skill" | "shared") => { setTab(value); setSearch(""); setStatusFilter(""); onTab?.(value); };
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
    initialEdit.current = JSON.stringify([asset?.name ?? "", asset?.body ?? "", asset?.scope ?? "", asset?.verified ?? false, asset?.files ?? [], asset?.dependencies ?? []]);
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
    setBody(asset?.body ?? "");
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
        confirmClose.markSaved();
        setEditing(undefined);
        changeTab(saved.kind === "memory" ? "memory" : saved.visibility === "space" ? "shared" : "skill");
        setNotice(saved.visibility === "space" ? "公共方法已更新；使用中的会话需要重新选用。" : "已保存到你的个人积累，其他用户无法读取。");
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
          <h1>我的积累</h1>
        </div>
        {tab === "shared" ? <button onClick={() => changeTab("skill")}>从我的 Skill 发布</button> : <button className="primary" onClick={() => edit(null)}>新增{tab === "memory" ? "记忆" : "个人 Skill"}</button>}
      </div>
      <Tabs label="个人与公共资产" value={tab} onChange={changeTab} items={[
        {value:"memory",label:<>个人记忆 <small>{assets.filter(a => a.kind === "memory").length}</small></>},
        {value:"skill",label:<>我的 Skill <small>{assets.filter(a => a.kind === "skill" && a.visibility !== "space").length}</small></>},
        {value:"shared",label:<>空间公共 Skill <small>{assets.filter(a => a.visibility === "space").length}</small></>},
      ]}/>
      <div className="asset-filters"><label className="search-box"><input aria-label="搜索资产" placeholder="搜索名称、内容或适用范围" value={search} onChange={event => setSearch(event.target.value)}/></label><select aria-label="资产状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></div>
      {tab === "skill" && <p className="quiet">Skill 是可重复使用的分析方法，选用后为当前对话提供步骤和注意事项。</p>}
      {tab === "shared" && <p className="quiet skill-sharing-note">本空间成员共享的分析方法。负责人维护正文，其他成员可以提出建议；使用时仍需明确选用。</p>}
      <div className="asset-grid">
        {assets
          .filter(matches).filter(asset => (!statusFilter || asset.state === statusFilter) && [asset.name, asset.body, asset.scope].some(value => value.toLowerCase().includes(search.trim().toLowerCase())))
          .map((asset) => (
            <article
              key={asset.id}
              className={
                "asset-card " + (asset.state === "disabled" ? "disabled" : "")
              }
            >
              <div className="asset-main"><h2 title={asset.name}>{asset.name}</h2><p className="asset-body asset-excerpt">{asset.body.replace(/^#+\s*/gm, "")}</p></div>
              <div className="asset-scope"><p title={asset.scope}>{asset.scope}</p></div>
              <div className="asset-state"><span className="status-pill">{asset.state === "enabled" ? "已启用" : "已停用"}</span><small>{asset.verified ? "已核对" : "待核对"}</small></div>
              <div className="actions asset-primary-actions">{asset.can_edit && <button onClick={() => edit(asset)}>编辑</button>}{asset.kind === "skill" && asset.state === "enabled" && <button className="primary" onClick={() => void onUseSkill(asset).catch(e => setError(e.message))}>在当前对话选用</button>}</div>
              <details className="asset-full-content"><summary>查看完整{asset.kind === "memory" ? "记忆" : "方法"}</summary><MarkdownContent text={asset.body}/><p><strong>适用范围：</strong>{asset.scope}</p>
              {asset.kind === "skill" && <p className="quiet skill-owner">{asset.visibility === "space" ? "空间公共" : "个人"} · 负责人 {asset.owner_id ?? user}</p>}
              {asset.memory_index_state && asset.memory_index_state !== "indexed" && (
                <p className="asset-index-state" role="status">
                  {asset.memory_index_state === "failed" ? "记忆已保存，检索同步失败；仍可从个人目录查找。" : "记忆已保存，正在同步检索。"}
                </p>
              )}
              <details>
                <summary>查看来源与依赖</summary>
                <p>{asset.source_text}</p>
                {asset.dependencies.map(reference => <p key={reference.object_id + reference.path}><KnowledgeReference id={reference.object_id} path={reference.path}/></p>)}
                <details className="technical-details"><summary>维护记录</summary><p>版本 {asset.version} · 记录编号 {asset.id}</p><pre>{JSON.stringify(asset.dependencies, null, 2)}</pre></details>
              </details>
              {(asset.files ?? []).map(file => <details key={file.path}><summary>{file.path.replace(/^(references|assets)\//, "")}</summary><pre className="skill-preview">{file.content}</pre></details>)}
              <div className="actions">
                {asset.can_edit && <>
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

              </div></details>
            </article>
          ))}
      </div>
      {assets.some(matches) && !assets.filter(matches).some(asset => (!statusFilter || asset.state === statusFilter) && [asset.name, asset.body, asset.scope].some(value => value.toLowerCase().includes(search.trim().toLowerCase())) ) && <div className="asset-empty"><p>没有符合当前条件的内容。</p><button onClick={() => { setSearch(""); setStatusFilter(""); }}>清除筛选</button></div>}
      {!assets.some(matches) && (
        <div className="asset-empty">
          <span>◇</span>
          <h2>
            {tab === "memory"
              ? "让有价值的纠错留下来"
              : tab === "shared" ? "空间还没有公共分析方法" : "把分析方法写成自己的 Skill"}
          </h2>
          <p>
            {tab === "memory"
              ? "对话中的明确纠错与偏好可保存到这里，也可以手动录入。"
              : tab === "shared" ? "可以将自己的 Skill 明确发布到空间，生成独立的公共副本。" : "保存适用范围、步骤和输出要求，再在需要的对话中明确选用。"}
          </p>
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
          onClose={() => confirmClose(closeEditor)}
          className="asset-editor-dialog"
          footer={<><span className="quiet">{editing?.visibility === "space" ? "空间公共方法" : "仅自己可用"}</span><button onClick={() => confirmClose(closeEditor)}>取消</button><button className="primary" disabled={saving || !name.trim() || !body.trim() || !scope.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></>}
        >
          {editingKind === "skill" && editing === null && <SkillExamples disabled={saving} hasDraft={Boolean(name || body || scope)} onChoose={example => { setName(example.name); setBody(example.body); setScope(example.scope); setVerified(false); }}/>}
          <label className="form-label">
            名称 <small aria-hidden="true">必填</small>
            <input disabled={saving} aria-label="名称" value={name} onChange={(e) => { setName(e.target.value); setVerified(false); }} />
          </label>
          <label className="form-label">
            内容 <small aria-hidden="true">必填</small>
            <textarea
              aria-label="内容"
              disabled={saving}
              rows={5}
              placeholder={editingKind === "skill" ? "告诉 Agent 应该先确认什么、怎样分析、最后如何汇报。普通文字即可。" : "例如：我的周报金额统一以元展示，临时要求优先。"}
              value={body}
              onChange={(e) => { setBody(e.target.value); setVerified(false); }}
            />
          </label>
          <label className="form-label">
            适用范围与例外 <small aria-hidden="true">必填</small>
            <input
              disabled={saving}
              aria-label="适用范围与例外"
              value={scope}
              onChange={(e) => { setScope(e.target.value); setVerified(false); }}
              placeholder="例如：仅用于收入周报；时间或口径不清时先问我"
            />
          </label>
          {editingKind === "skill" && <details className="asset-attachments" open={files.length > 0}><summary>补充说明与报告模板（可选）{files.length > 0 ? ` · ${files.length} 份` : ""}</summary><SkillFilesEditor files={files} onChange={value => { setFiles(value); setVerified(false); }} disabled={saving}/></details>}
          {dependencies.length > 0 && <AssetDependenciesEditor key={editorSession.current} dependencies={dependencies} onChange={value => { setDependencies(value); setVerified(false); }} disabled={saving}/>}
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={saving}
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
            />
            我已核对这条{editing?.visibility === "space" ? "公共" : "个人"}定义 <small aria-hidden="true">（可选）</small>
          </label>
          {error && <p role="alert" className="error">{error}</p>}

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
          changeTab("shared");
          setNotice("已发布独立公共副本。私人方法后续修改不会自动公开。");
        }
        await refresh();
      }}/>}
      {suggesting && <SkillSuggestions asset={suggesting} onClose={() => setSuggesting(null)}/>}
    </section>
  );
}
