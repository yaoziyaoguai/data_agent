import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KnowledgeObject,
  KnowledgeEntry,
  SourceDocument,
  Proposal,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { ProposeCorrection } from "./CorrectionComposer.tsx";
import { SemanticCorrections } from "./SemanticCorrections.tsx";
import { KnowledgeCreator } from "./KnowledgeCreator.tsx";
import { KnowledgeDocument, documentRepresentatives } from "./KnowledgeDocument.tsx";
import { KnowledgePicker } from "../../shared/KnowledgePicker.tsx";
import { useStableOperation } from "./semantic-commands.ts";
import { KnowledgeDirectory } from "./KnowledgeDirectory.tsx";
import { SemanticMaintainer } from "./SemanticMaintainer.tsx";
import { KnowledgeOrigin } from "./KnowledgeOrigin.tsx";
import { ApiError, api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import { useUnsavedChanges, useNavigationGuard } from "../../shared/UnsavedChanges.tsx";
import { Tabs } from "../../shared/Tabs.tsx";
import type { WorkspaceLocation } from "../../shared/workspace-location.ts";
import { knowledgeKindLabels } from "../../shared/knowledge-labels.ts";
function currentObject(previous: KnowledgeObject | undefined, incoming: KnowledgeObject): KnowledgeObject {
  if (!previous) return incoming;
  const oldPreference=previous.analysis_preference;
  const newPreference=incoming.analysis_preference;
  const preference=oldPreference && (!newPreference || BigInt(oldPreference.version)>BigInt(newPreference.version))?oldPreference:newPreference;
  const oldMaintenance = previous.maintenance;
  const newMaintenance = incoming.maintenance;
  const maintenance = oldMaintenance && (!newMaintenance || (oldMaintenance.authority_id === newMaintenance.authority_id && BigInt(oldMaintenance.version) > BigInt(newMaintenance.version))) ? oldMaintenance : newMaintenance;
  // 内容、负责人和分析偏好分别更新，旧目录不能覆盖已收到的新权限。
  const current = {
    ...(BigInt(previous.version) > BigInt(incoming.version) ? previous : incoming),
    ...(preference ? { analysis_preference: preference } : {}),
    ...(maintenance ? { maintenance } : {}),
  };
  const oldStatus = previous.prefill_status;
  const newStatus = incoming.prefill_status;
  const rank = (state: string) => state === "queued" ? 0 : state === "issued" ? 1 : 2;
  if (previous.version === incoming.version && oldStatus && newStatus && oldStatus.attempt_id === newStatus.attempt_id && rank(oldStatus.state) > rank(newStatus.state)) {
    return { ...current, prefill_status: oldStatus };
  }
  return current;
}
function EntryEditor({
  object,
  entry,
  canEdit,
  onSaved,
  onSource,
  onCorrection,
}: {
  object: KnowledgeObject;
  entry: KnowledgeEntry;
  canEdit: boolean;
  onSaved: (object: KnowledgeObject) => void;
  onSource: (id: string) => void;
  onCorrection: () => void;
}) {
  const operation = useStableOperation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.effective_value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editVersion, setEditVersion] = useState(object.version);
  const isDocument = object.kind === "document" && entry.entry_id === "body";
  let displayValue = entry.effective_value;
  if (entry.path === "lineage") {
    try {
      const upstream: unknown = JSON.parse(displayValue);
      if (Array.isArray(upstream) && upstream.every(value => typeof value === "string")) displayValue = upstream.join("、") || "暂无上游表";
    } catch { /* 人工填写的自然语言按原文展示。 */ }
  }
  const [editUrl, setEditUrl] = useState(String(entry.human_override?.source_url ?? ""));
  const [editRelated, setEditRelated] = useState(object.related_ids);
  const initialEdit = useRef("");
  const confirmClose = useUnsavedChanges(editing && initialEdit.current !== JSON.stringify([value, editUrl, editRelated]), () => { setEditing(false); setValue(entry.effective_value); });
  useEffect(() => {
    if (!editing) setValue(entry.effective_value);
  }, [object.version, entry.entry_id, editing]);
  const save = async (clear = false) => {
    setBusy(true);
    setError("");
    try {
      const v = await api(
        "KnowledgeObject",
        "/knowledge/" + object.id,
        "PATCH",
        {
          operation_id: operation({ object: object.id, entry: entry.entry_id, editVersion, value, clear, editUrl, editRelated }),
          expected_version: editVersion,
          entry_id: entry.entry_id,
          value,
          clear_override: clear,
          ...(isDocument && !clear ? { source_url: editUrl.trim() || null, related_ids: editRelated } : {}),
        },
      );
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
        {entry.review_state === "needs_review" && (
          <span className="review-mark">依据有变化，请核对</span>
        )}
        {canEdit && !editing && (
          <button onClick={() => {initialEdit.current = JSON.stringify([entry.effective_value, String(entry.human_override?.source_url ?? ""), object.related_ids]);setEditVersion(object.version);setEditUrl(String(entry.human_override?.source_url ?? ""));setEditRelated(object.related_ids);setEditing(true);}}>编辑</button>
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
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              保存修改
            </button>
            <button
              disabled={busy}
              onClick={() => confirmClose(() => { setEditing(false); setValue(entry.effective_value); })}
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
export function KnowledgePage({
  user,
  initialObject, initialTab = "概览", initialScope = "tables", onLocation,
}: {
  user: string;
  initialObject?: string | null;
  initialTab?: string;
  initialScope?: "tables" | "all" | "maintained";
  onLocation?: (patch: Partial<WorkspaceLocation>, replace?: boolean) => boolean;
}) {
  const [objects, setObjects] = useState<KnowledgeObject[]>([]);
  const [current, setCurrent] = useState(
    initialObject ?? "table-demo_order_detail",
  );
  const [tab, setTab] = useState(initialTab);
  const directoryElement = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const alignSelection = () => {
      const list = directoryElement.current;
      const selected = list?.querySelector<HTMLElement>('[aria-current="true"]');
      if (!list || !selected || window.innerWidth > 700) return;
      const offset = selected.getBoundingClientRect().left - list.getBoundingClientRect().left;
      if (offset < 0 || offset + selected.offsetWidth > list.clientWidth) list.scrollLeft += offset - 10;
    };
    alignSelection(); window.addEventListener("resize", alignSelection);
    return () => window.removeEventListener("resize", alignSelection);
  }, [current, objects.length]);
  const guard = useNavigationGuard();
  const move = (id: string, nextTab = "概览", scope = directoryScope) => {
    if (onLocation) { if (onLocation({object: id, tab: nextTab, scope})) { setCurrent(id); setTab(nextTab); setDirectoryScope(scope); } }
    else guard(() => { setCurrent(id); setTab(nextTab); setDirectoryScope(scope); });
  };
  const [query, setQuery] = useState("");
  const [directoryScope, setDirectoryScope] = useState<"tables" | "all" | "maintained">(initialScope);
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const [createdObjectId, setCreatedObjectId] = useState("");
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [relatedPage, setRelatedPage] = useState<{parent: string; ids: string[]; next: string | null; loading: boolean; failed: boolean}>({parent: "", ids: [], next: null, loading: false, failed: false});
  const relatedGeneration = useRef(0);
  const [matches, setMatches] = useState<KnowledgeObject[]>([]);
  const [searchLimited, setSearchLimited] = useState(false);
  const [vectorUnavailable,setVectorUnavailable]=useState(false);
  const [syncing,setSyncing]=useState(false);
  const [rebuilding,setRebuilding]=useState(false);
  const [maintenanceNotice,setMaintenanceNotice]=useState("");
  const [savingPreference,setSavingPreference]=useState(false);
  const searchGeneration = useRef(0);
  const [error, setError] = useState("");
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const refreshGeneration = useRef(0);
  const directoryInitialized = useRef(false);
  const visibleObjectIds = useRef<string[]>([]);
  const expandedFields = useRef(new Set<string>());
  const [canAdmin,setCanAdmin]=useState(false);
  const [canCreate,setCanCreate]=useState(false);
  const refresh = async () => {
    const generation = ++refreshGeneration.current;
    const [knowledge, proposals, visible, access] = await Promise.all([
      api("KnowledgeList", "/knowledge"),
      api("ProposalList", "/knowledge-proposals"),
      Promise.all(visibleObjectIds.current.map(id => api("KnowledgeObject", "/knowledge/" + id))),
      api("SemanticAccess","/semantic-access"),
    ]);
    if (generation !== refreshGeneration.current) return;
    if (!directoryInitialized.current) {
      directoryInitialized.current = true;
      setNextAfter(knowledge.next_after_id);
    }
    setObjects((old) => { const byId = new Map(old.map(o => [o.id,o])); for (const v of [...knowledge.objects, ...visible]) byId.set(v.id, currentObject(byId.get(v.id),v)); return [...byId.values()]; });
    setProposals(proposals.proposals);
    setCanAdmin(access.can_admin);
    setCanCreate(access.can_create);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    return () => { ++refreshGeneration.current; };
  }, [user]);
  useEffect(() => {
    if (initialObject !== undefined) setCurrent(initialObject ?? (initialScope === "tables" ? "table-demo_order_detail" : ""));
    setTab(["概览", "字段语义", "关联与血缘", "指标 SQL", "业务文档", "变更记录"].includes(initialTab) ? initialTab : "概览");
    setDirectoryScope(initialScope);
  }, [initialObject, initialTab, initialScope]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 2000);
    return () => { window.clearInterval(timer); ++refreshGeneration.current; };
  }, [user, current, tab]);
  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (directoryScope !== "tables") return;
    if (!query.trim()) { setMatches([]); setSearchLimited(false); setVectorUnavailable(false); return; }
    const timer = window.setTimeout(() => {
      void api("KnowledgeList", "/knowledge?q=" + encodeURIComponent(query)).then(page => {
        if (generation !== searchGeneration.current) return;
        setMatches(page.objects);
        setCurrent(previous => page.objects.some(object => object.id === previous) ? previous : page.objects[0]?.id ?? "");
        setSearchLimited(page.search_coverage?.state !== "complete");
        setVectorUnavailable(page.search_coverage?.vector_state === "unavailable");
        setObjects(old => { const byId = new Map(old.map(o => [o.id,o])); for (const v of page.objects) byId.set(v.id,currentObject(byId.get(v.id),v)); return [...byId.values()]; });
      }).catch(e => { if(generation === searchGeneration.current) setError(e.message); });
    }, 150);
    return () => { window.clearTimeout(timer); ++searchGeneration.current; };
  }, [query, directoryScope]);
  useEffect(() => {
    if (!current) return;
    let live=true;
    void api("KnowledgeObject","/knowledge/"+current).then(v => { if(live) setObjects(old => [...old.filter(o => o.id!==v.id),currentObject(old.find(o => o.id===v.id),v)]); }).catch(e => { if(live) setError(e.message); });
    return () => {live=false;};
  }, [current]);
  const loadRelated = async (parent: string, after: string | null = null) => {
    const generation = ++relatedGeneration.current;
    setRelatedPage(old => ({parent, ids: after && old.parent === parent ? old.ids : [], next: after, loading: true, failed: false}));
    try {
      const page = await api("KnowledgeList", "/knowledge?related_id=" + encodeURIComponent(parent) + (after ? "&after_id=" + encodeURIComponent(after) : ""));
      if (generation !== relatedGeneration.current) return;
      setObjects(old => { const byId = new Map(old.map(o => [o.id,o])); for (const v of page.objects) byId.set(v.id,currentObject(byId.get(v.id),v)); return [...byId.values()]; });
      setRelatedPage(old => ({parent, ids: [...new Set([...old.ids, ...page.objects.map(o => o.id)])], next: page.next_after_id, loading: false, failed: false}));
    } catch(e) {
      if (generation !== relatedGeneration.current) return;
      setRelatedPage(old => ({...old, loading: false, failed: true}));
      setError(e instanceof Error ? e.message : "关联内容读取失败");
    }
  };
  useEffect(() => {
    if (!current) { setRelatedPage({parent: "", ids: [], next: null, loading: false, failed: false}); return; }
    void loadRelated(current);
    return () => { ++relatedGeneration.current; };
  }, [current]);
  const loadMore = async () => {
    if(!nextAfter || loadingMore) return;
    setLoadingMore(true);
    try { const page=await api("KnowledgeList","/knowledge?after_id="+encodeURIComponent(nextAfter)); setNextAfter(page.next_after_id); setObjects(old => { const byId = new Map(old.map(o => [o.id,o])); for (const v of page.objects) byId.set(v.id,currentObject(byId.get(v.id),v)); return [...byId.values()]; }); }
    catch(e){setError(String(e));} finally{setLoadingMore(false);}
  };
  const selected = objects.find((o) => o.id === current);
  const canEdit=selected?.maintenance?.can_edit??false;
  const changePreference=async()=>{
    const preference=selected?.analysis_preference;
    if(!selected || !preference || savingPreference)return;
    setSavingPreference(true);setError("");
    try{
      const value=await api("TableAnalysisPreference","/knowledge/"+selected.id+"/analysis-preference","POST",{operation_id:crypto.randomUUID(),expected_version:preference.version,preferred:!preference.preferred});
      ++refreshGeneration.current;
      setObjects(old=>old.map(o=>o.analysis_preference?.table_id===value.table_id?currentObject(o,{...o,analysis_preference:value}):o));
      setMaintenanceNotice(value.preferred?"已设为常用表，当前表及字段优先分析。其他表仍可按需预填。":"已取消常用设置，已有语义保留。来源改版仍会自动重分析。");
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"常用范围保存失败");}finally{setSavingPreference(false);}
  };
  const synchronize=async()=>{
    if(syncing)return;
    setSyncing(true);setError("");setMaintenanceNotice("");
    try{await api("MutationReceipt","/source-syncs","POST",{operation_id:crypto.randomUUID()});await refresh();setMaintenanceNotice("来源同步完成；语义分析按维护配置继续处理，人工修改保留。");}
    catch(e){
      const message = e instanceof ApiError && e.code === "version_conflict" ? "来源同步发生版本冲突。请刷新查看当前状态，核对平台来源版本后重试。"
        : e instanceof ApiError && e.code === "forbidden" ? "当前账号无权同步来源，请联系本系统超级维护者。"
        : "来源同步未完成，请查看当前状态后重试。";
      setError(message + (e instanceof ApiError ? ` 错误码：${e.code}；诊断编号：${e.requestId}` : ''));
    }finally{setSyncing(false);}
  };
  const rebuild=async()=>{
    if(rebuilding)return;
    setRebuilding(true);setError("");setMaintenanceNotice("");
    try{await api("MutationReceipt","/knowledge-index/rebuilds","POST",{operation_id:crypto.randomUUID()});setMaintenanceNotice("索引重建已排队。检索期间仍会核对当前正式知识，覆盖情况会随进度更新。");}
    catch(e){setError(e instanceof Error && e.message === "vector_unconfigured" ? "尚未配置语义检索服务，暂时无法重建索引。" : e instanceof Error ? e.message : "索引重建失败");}finally{setRebuilding(false);}
  };
  const tables = objects.filter((o) => o.kind === "table");
  const save = (v: KnowledgeObject) => {
    ++refreshGeneration.current;
    if (objects.find(object => object.id === v.id)?.state !== v.state) setDirectoryRevision(value => value + 1);
    setObjects((old) => old.map((o) => (o.id === v.id ? currentObject(o, v) : o)));
  };
  const selectObject = (v: KnowledgeObject | null) => {
    if (!v) { setCurrent(""); return; }
    setObjects(old => [...old.filter(o => o.id !== v.id), currentObject(old.find(o => o.id === v.id), v)]);
    move(v.id);
  };
  const showDirectoryPage = (values: KnowledgeObject[], append: boolean) => {
    setObjects(old => { const byId = new Map(old.map(o => [o.id, o])); for (const value of values) byId.set(value.id, currentObject(byId.get(value.id), value)); return [...byId.values()]; });
    if (!append && !values.some(value => value.id === current)) {
      const next = values[0]?.id ?? "";
      if (onLocation) { if (onLocation({object: next, tab: "概览"}, true)) { setCurrent(next); setTab("概览"); } }
      else guard(() => { setCurrent(next); setTab("概览"); });
    }
  };
  const showSource = async (id: string) => {
    try {
      setSource(await api("SourceDocument", "/sources/" + id));
    } catch (e) {
      setError(String(e));
    }
  };
  const state = async (action: string) => {
    if (!selected) return;
    try {
      save(
        await api(
          "KnowledgeObject",
          "/knowledge/" + selected.id + "/" + action,
          "POST",
          {
            operation_id: crypto.randomUUID(),
            expected_version: selected.version,
          },
        ),
      );
    } catch (e) {
      setError(String(e));
    }
  };
  const relatedObjects = relatedPage.parent === current ? objects.filter(o => relatedPage.ids.includes(o.id)) : [];
  const groups =
    tab === "字段语义"
      ? relatedObjects.filter(
          (o) => o.kind === "field" && o.related_ids.includes(current),
        )
      : tab === "指标 SQL"
        ? relatedObjects.filter(
            (o) => o.kind === "metric" && o.related_ids.includes(current),
          )
        : tab === "业务文档"
          ? relatedObjects.filter(
              (o) => o.kind === "document" && o.related_ids.includes(current),
            )
          : tab === "关联与血缘"
            ? relatedObjects.filter(
                (o) =>
                  o.kind === "relationship" && o.related_ids.includes(current),
              )
            : selected
              ? [selected]
              : [];
  visibleObjectIds.current = [...new Set([current, ...groups
    .filter(o => o.kind !== "field" || expandedFields.current.has(o.id))
    .map(o => o.id)].filter(Boolean))];
  return (
    <section className="management">
      <div className="page-heading">
        <div>
          <h1>语义管理</h1>
        </div>
        <div className="actions">
          <details className="maintenance-menu"><summary>维护操作</summary><div className="actions">
          <button
            onClick={()=>void synchronize()}
            disabled={!canAdmin || syncing}
          >
            {syncing?"同步中…":"同步来源"}
          </button>
          {canAdmin && <button onClick={()=>void rebuild()} disabled={rebuilding}>{rebuilding?"正在排队…":"重建检索索引"}</button>}</div></details>
          <KnowledgeCreator user={user} canCreate={canCreate} relatedId={current} onCreated={v => {
            ++refreshGeneration.current;
            // 新建成功后清除旧筛选，并取消旧目录请求，避免刚保存的对象被切走。
            setCreatedObjectId(v.id);
            setQuery("");
            setObjects(old => [...old.filter(o => o.id !== v.id), v]);
            move(v.id, "概览", directoryScope === "tables" ? "maintained" : directoryScope);
          }}/>
        </div>
      </div>
      <div className="knowledge-toolbar"><label className="form-label directory-scope">语义目录范围
        <select aria-label="语义目录范围" value={directoryScope} onChange={e => move(e.target.value === "tables" ? tables[0]?.id ?? "" : "", "概览", e.target.value as "tables" | "all" | "maintained")}>
          <option value="tables">按表浏览</option><option value="all">全部对象</option><option value="maintained">我负责的对象</option>
        </select>
      </label>
      {directoryScope === "tables" && <label className="search-box">
        <span>⌕</span>
        <input
          aria-label="搜索语义对象"
          placeholder="搜索表、字段、指标或业务文档"
          value={query}
          onChange={(e) => { const value = e.target.value; guard(() => { setQuery(value); setCurrent(previous => value.trim() ? "" : tables.some(table => table.id === previous) ? previous : tables[0]?.id ?? ""); setTab("概览"); }); }}
        />
      </label>}</div>
      {directoryScope === "tables" && searchLimited && <p className="quiet" role="status">候选较多，本次只核对了部分匹配对象。请补充具体名称或业务范围；当前结果不能说明其他对象不存在。</p>}
      {directoryScope === "tables" && vectorUnavailable && <p className="quiet" role="status">语义检索暂不可用，当前使用名称和关键词查找。可稍后重试；检索结果仍按当前知识版本核对。</p>}
      {maintenanceNotice && <p className="quiet" role="status">{maintenanceNotice}</p>}
      <div className="knowledge-layout">
        <nav ref={directoryElement} aria-label="语义对象" className={"object-list" + (directoryScope !== "tables" ? " management-directory" : "")}>
          {directoryScope !== "tables" ? <KnowledgeDirectory key={createdObjectId} user={user} scope={directoryScope} current={current} revision={directoryRevision} onSelect={selectObject} onPage={showDirectoryPage}/> : <>{(query ? matches.map(o=>objects.find(current=>current.id===o.id)??o) : tables
          ).map((o) => (
            <button
              key={o.id}
              aria-current={o.id === current ? "true" : undefined}
              onClick={() => move(o.id)}
            >
              <span>{o.name}</span>
              {tables.some(other => other.id !== o.id && other.name === o.name) && <KnowledgeOrigin object={o}/>}
              <small>
                {knowledgeKindLabels[o.kind]}{o.analysis_preference?.preferred?" · 常用":""}
              </small>
            </button>
          ))}
          {nextAfter && !query && <button disabled={loadingMore} onClick={() => void loadMore()}>加载更多语义对象</button>}
          </>}
        </nav>
        <div className="knowledge-content">
          {selected && (
            <>
              <div className="object-heading">
                <div>
                  <span className="eyebrow">
                    {knowledgeKindLabels[selected.kind]}
                  </span>
                  {selected.kind !== "document" && <h2>{selected.name}</h2>}
                  <details className="object-source"><summary>来源信息</summary><KnowledgeOrigin object={selected} detail/></details>
                </div>
                <div className="actions">
                  <span className="status-pill">
                    {selected.state === "enabled" ? "当前启用" : "已停用"}
                  </span>
                  {selected.kind==="table" && selected.analysis_preference && <button role="switch" aria-label="常用表优先分析" aria-checked={selected.analysis_preference.preferred} disabled={!canEdit || savingPreference} onClick={()=>void changePreference()}>{savingPreference?"保存中…":selected.analysis_preference.preferred?"常用表 · 优先分析":"设为常用表"}</button>}
                  {canEdit && (selected.kind !== "document" || !selected.source_id) && (
                    <button
                      onClick={() =>
                        void state(
                          selected.state === "enabled" ? "disable" : "enable",
                        )
                      }
                    >
                      {selected.state === "enabled" ? "停用" : "启用"}
                    </button>
                  )}
                  {canEdit && selected.kind !== "document" && selected.source_id && (
                    <button onClick={() => void state("reanalyze")}>
                      重新预填
                    </button>
                  )}
                </div>
              </div>
              <SemanticMaintainer object={selected} onSaved={()=>{setDirectoryRevision(value => value + 1);void refresh();}}/>
              {selected.prefill_status && selected.prefill_status.state !== "succeeded" && <p className="quiet" role="status">{({queued:"正在等待补充语义说明",issued:"正在分析资料，补充说明",budget_unavailable:"自动补充暂不可用，仍可人工维护",superseded:"资料已变化，本次分析未采用",unknown:"分析暂未完成，请稍后查看状态",invalid_prefill:"本次分析未通过检查，已有内容保留"} as Record<string,string>)[selected.prefill_status.state] ?? "分析状态待核对"}</p>}
              {selected.kind === "table" && (
                <Tabs label="表的语义内容" value={tab} items={["概览", "字段语义", "关联与血缘", "指标 SQL", "业务文档", "变更记录"].map(label => ({value: label, label}))} onChange={next => move(current, next)}/>
              )}
              {tab === "变更记录" ? (
                <VersionHistory object={selected} />
              ) : (
                <div className="semantic-groups">
                  {!["概览", "变更记录"].includes(tab) && <>
                    {relatedPage.loading && <p role="status">正在读取关联内容…</p>}
                    {!relatedPage.loading && !relatedPage.failed && groups.length === 0 && <p className="quiet">当前已读取的内容中没有此类关联。</p>}
                    {(relatedPage.next || relatedPage.failed) && <button disabled={relatedPage.loading} onClick={() => void loadRelated(current, relatedPage.next)}>{relatedPage.failed ? "重试关联内容" : "加载更多关联内容"}</button>}
                  </>}
                  {documentRepresentatives(groups).map((o) => o.kind === "document" ? <KnowledgeDocument key={o.source_id ?? o.id} object={o} onOpen={o.id !== current ? () => selectObject(o) : undefined} onSaved={parts => { ++refreshGeneration.current; setDirectoryRevision(value => value + 1); setObjects(old => { const byId = new Map(old.map(o => [o.id, o])); for (const part of parts) byId.set(part.id, currentObject(byId.get(part.id), part)); return [...byId.values()]; }); }} onCorrection={() => void refresh()}/> : (
                    <article key={o.id} className={"semantic-object" + (o.kind === "field" ? " field-object" : "")}>
                      {o.id !== current && o.kind !== "field" && (
                        <h3>
                          {o.name}
                          <button onClick={() => selectObject(o)}>打开详情</button>
                        </h3>
                      )}

                      {o.kind === "field" ? (
                        <details onToggle={event => {
                          if (event.currentTarget.open) expandedFields.current.add(o.id);
                          else expandedFields.current.delete(o.id);
                          visibleObjectIds.current = [...new Set([current, ...groups
                            .filter(v => v.kind !== "field" || expandedFields.current.has(v.id))
                            .map(v => v.id)])];
                        }}>
                          <summary>
                            <strong>{o.name.split(".").at(-1)}</strong><span>{o.entries.find(e => e.path === "meaning")?.effective_value || "尚缺说明"}</span><span className="field-detail-label">查看</span>
                          </summary>
                          {o.entries.map((e) => (
                            <EntryEditor
                              key={e.entry_id}
                              object={o}
                              entry={e}
                              canEdit={o.maintenance?.can_edit??false}
                              onCorrection={()=>void refresh()}
                              onSaved={save}
                              onSource={(id) => void showSource(id)}
                            />
                          ))}
                        </details>
                      ) : (
                        o.entries.map((e) => ["ddl", "etl"].includes(e.path) ? <details key={e.entry_id} className="technical-source"><summary>{e.label}</summary><EntryEditor object={o} entry={e} canEdit={o.maintenance?.can_edit ?? false} onCorrection={() => void refresh()} onSaved={save} onSource={id => void showSource(id)}/></details> : (
                          <EntryEditor
                            key={e.entry_id}
                            object={o}
                            entry={e}
                            canEdit={o.maintenance?.can_edit??false}
                              onCorrection={()=>void refresh()}
                            onSaved={save}
                            onSource={(id) => void showSource(id)}
                          />
                        ))
                      )}
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
          {!selected && <div className="knowledge-empty"><h2>选择要查看的内容</h2><p>左侧只列出符合当前范围的内容。没有匹配时，可调整范围或搜索条件。</p></div>}
        </div>
      </div>
      <SemanticCorrections key={user} user={user} proposals={proposals} onSaved={()=>void refresh()}/>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {source && (
        <Modal
          title="来源资料"
          onClose={() => setSource(null)}
        >
          <p className="quiet">
            {source.complete ? "正文完整" : "来源内容不完整"}
          </p>
          <pre className="source-body">{source.body}</pre>
        </Modal>
      )}

    </section>
  );
}
function VersionHistory({ object }: { object: KnowledgeObject }) {
  const [version, setVersion] = useState(object.version);
  const [old, setOld] = useState<KnowledgeObject | null>(null);
  const [error, setError] = useState("");
  return (
    <section>
      <p>
        当前版本 {object.version} · 最新修改者 {object.updated_by}
        。每次保存保留不可变的版本记录。
      </p>
      <label className="form-label">
        查看历史版本
        <input
          type="number"
          min="1"
          max={object.version}
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        />
      </label>
      <button
        onClick={() =>
          void api(
            "KnowledgeObject",
            "/knowledge/" + object.id + "?version=" + version,
          )
            .then(setOld)
            .catch((e) => setError(e.message))
        }
      >
        读取版本
      </button>
      {old && <div>{old.entries.map(entry => <section key={entry.entry_id}><h3>{entry.label}</h3><MarkdownContent text={entry.effective_value}/></section>)}</div>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
