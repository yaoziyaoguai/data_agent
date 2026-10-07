import { useEffect, useRef, useState } from "react";
import type {
  KnowledgeObject,
  KnowledgeEntry,
  SourceDocument,
  Proposal,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { ProposeCorrection } from "./CorrectionComposer.tsx";
import { SemanticCorrections } from "./SemanticCorrections.tsx";
import { KnowledgeCreator } from "./KnowledgeCreator.tsx";
import { SemanticMaintainer } from "./SemanticMaintainer.tsx";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
function currentObject(previous: KnowledgeObject | undefined, incoming: KnowledgeObject): KnowledgeObject {
  if (!previous) return incoming;
  const oldPreference=previous.analysis_preference;
  const newPreference=incoming.analysis_preference;
  const preference=oldPreference && (!newPreference || BigInt(oldPreference.version)>BigInt(newPreference.version))?oldPreference:newPreference;
  if (BigInt(previous.version) > BigInt(incoming.version)) return preference?{...previous,analysis_preference:preference}:previous;
  if(preference)incoming={...incoming,analysis_preference:preference};
  const oldStatus = previous.prefill_status;
  const newStatus = incoming.prefill_status;
  const rank = (state: string) => state === "queued" ? 0 : state === "issued" ? 1 : 2;
  if (previous.version === incoming.version && oldStatus && newStatus && oldStatus.attempt_id === newStatus.attempt_id && rank(oldStatus.state) > rank(newStatus.state)) {
    return { ...incoming, prefill_status: oldStatus };
  }
  return incoming;
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
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.effective_value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editVersion, setEditVersion] = useState(object.version);
  const isDocument = object.kind === "document" && entry.entry_id === "body";
  const [editUrl, setEditUrl] = useState(String(entry.human_override?.source_url ?? ""));
  const [editRelated, setEditRelated] = useState(object.related_ids.join(", "));
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
          operation_id: crypto.randomUUID(),
          expected_version: editVersion,
          entry_id: entry.entry_id,
          value,
          clear_override: clear,
          ...(isDocument && !clear ? { source_url: editUrl.trim() || null, related_ids: editRelated.split(",").map(v => v.trim()).filter(Boolean) } : {}),
        },
      );
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
        <span className={"provenance " + (entry.human_override ? "human" : "")}>
          {entry.human_override ? "人工修改" : entry.suggestion.analysis_state === "validated" ? "模型建议" : "来源预填"}
        </span>
        {entry.review_state === "needs_review" && (
          <span className="review-mark">来源重分析后待复核</span>
        )}
        {canEdit && !editing && (
          <button onClick={() => {setEditVersion(object.version);setEditUrl(String(entry.human_override?.source_url ?? ""));setEditRelated(object.related_ids.join(", "));setEditing(true);}}>编辑</button>
        )}
      </div>
      {editing ? (
        <>
          <label className="sr-only" htmlFor={object.id + "-" + entry.entry_id}>
            {entry.label}
          </label>
          <textarea
            id={object.id + "-" + entry.entry_id}
            className="editor"
            rows={Math.min(14, Math.max(3, value.split("\n").length))}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {isDocument && <>
            <label className="form-label">来源链接<input aria-label="编辑来源链接" value={editUrl} onChange={e => setEditUrl(e.target.value)} /></label>
            <label className="form-label">关联对象（逗号分隔）<input aria-label="编辑关联对象" value={editRelated} onChange={e => setEditRelated(e.target.value)} /></label>
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
              onClick={() => {
                setEditing(false);
                setValue(entry.effective_value);
              }}
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
      ) : (
        <p
          className={
            entry.path === "sql" || entry.path === "ddl" || entry.path === "etl"
              ? "code-text"
              : "entry-value"
          }
        >
          {entry.effective_value || "尚缺说明"}
        </p>
      )}
      {typeof entry.human_override?.source_url === "string" && /^https?:\/\//i.test(entry.human_override.source_url) && (
        <p className="quiet"><a href={entry.human_override.source_url} target="_blank" rel="noopener noreferrer">打开来源链接 ↗</a>{!entry.effective_value.trim() && " · 正文尚未录入，Agent无法据此解释业务"}</p>
      )}
      <details className="provenance-detail">
        <summary>查看来源事实、分析建议与人工记录</summary>
        <div className="provenance-columns">
          <section>
            <h4>来源事实</h4>
            <pre>{JSON.stringify(entry.source_facts, null, 2)}</pre>
            {sourceId && (
              <button onClick={() => onSource(sourceId)}>查看来源正文 ↗</button>
            )}
          </section>
          <section>
            <h4>分析建议</h4>
            <pre>{JSON.stringify(entry.suggestion, null, 2)}</pre>
            <p className="quiet">
              建议保留引用、缺口和分析状态。模型补全须配置维护预算；人工保存不等于业务验收通过。
            </p>
          </section>
          <section>
            <h4>人工覆盖</h4>
            <pre>{JSON.stringify(entry.human_override, null, 2)}</pre>
          </section>
        </div>
      </details>
      <ProposeCorrection object={object} entry={entry} onSaved={onCorrection}/>
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
  initialObject,
}: {
  user: string;
  initialObject?: string | null;
}) {
  const [objects, setObjects] = useState<KnowledgeObject[]>([]);
  const [current, setCurrent] = useState(
    initialObject ?? "table-demo_order_detail",
  );
  const [tab, setTab] = useState("概览");
  const [query, setQuery] = useState("");
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
    if (initialObject) {
      setCurrent(initialObject);
      setTab("概览");
    }
  }, [initialObject]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 2000);
    return () => { window.clearInterval(timer); ++refreshGeneration.current; };
  }, [user, current, tab]);
  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!query.trim()) { setMatches([]); setSearchLimited(false); setVectorUnavailable(false); return; }
    const timer = window.setTimeout(() => {
      void api("KnowledgeList", "/knowledge?q=" + encodeURIComponent(query)).then(page => {
        if (generation !== searchGeneration.current) return;
        setMatches(page.objects);
        setSearchLimited(page.search_coverage?.state !== "complete");
        setVectorUnavailable(page.search_coverage?.vector_state === "unavailable");
        setObjects(old => { const byId = new Map(old.map(o => [o.id,o])); for (const v of page.objects) byId.set(v.id,currentObject(byId.get(v.id),v)); return [...byId.values()]; });
      }).catch(e => { if(generation === searchGeneration.current) setError(e.message); });
    }, 150);
    return () => { window.clearTimeout(timer); ++searchGeneration.current; };
  }, [query]);
  useEffect(() => {
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
    catch(e){setError(e instanceof Error?e.message:"同步失败");}finally{setSyncing(false);}
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
    setObjects((old) => old.map((o) => (o.id === v.id ? currentObject(o, v) : o)));
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
    .map(o => o.id)])];
  return (
    <section className="management">
      <div className="page-heading">
        <div>
          <div className="eyebrow">从来源到可复用的业务知识</div>
          <h1>语义管理</h1>
          <p>事实有出处，建议可核对，人工修改始终保留。</p>
        </div>
        <div className="actions">
          <button
            onClick={()=>void synchronize()}
            disabled={!canAdmin || syncing}
          >
            {syncing?"同步中…":"同步来源"}
          </button>
          {canAdmin && <button onClick={()=>void rebuild()} disabled={rebuilding}>{rebuilding?"正在排队…":"重建检索索引"}</button>}
          <KnowledgeCreator user={user} canCreate={canCreate} relatedId={current} onCreated={v => {
            ++refreshGeneration.current;
            setObjects(old => [...old.filter(o => o.id !== v.id), v]);
            setCurrent(v.id);
            setTab("概览");
          }}/>
        </div>
      </div>
      <label className="search-box">
        <span>⌕</span>
        <input
          aria-label="搜索语义对象"
          placeholder="搜索表、字段、指标或业务文档"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {searchLimited && <p className="quiet" role="status">候选较多，本次只核对了部分匹配对象。请补充具体名称或业务范围；当前结果不能说明其他对象不存在。</p>}
      {vectorUnavailable && <p className="quiet" role="status">语义检索暂不可用，当前使用名称和关键词查找。可稍后重试；检索结果仍按当前知识版本核对。</p>}
      {maintenanceNotice && <p className="quiet" role="status">{maintenanceNotice}</p>}
      <div className="knowledge-layout">
        <nav aria-label="语义对象" className="object-list">
          {(query ? matches.map(o=>objects.find(current=>current.id===o.id)??o) : tables
          ).map((o) => (
            <button
              key={o.id}
              aria-current={o.id === current ? "true" : undefined}
              onClick={() => {
                setCurrent(o.id);
                setTab("概览");
              }}
            >
              <span>{o.name}</span>
              <small>
                {o.kind} · v{o.version}{o.analysis_preference?.preferred?" · 常用":""}
              </small>
            </button>
          ))}
          {nextAfter && !query && <button disabled={loadingMore} onClick={() => void loadMore()}>加载更多语义对象</button>}
        </nav>
        <div className="knowledge-content">
          {selected && (
            <>
              <div className="object-heading">
                <div>
                  <span className="eyebrow">
                    {selected.kind.toUpperCase()} · VERSION {selected.version}
                  </span>
                  <h2>{selected.name}</h2>
                </div>
                <div className="actions">
                  <span className="status-pill">
                    {selected.state === "enabled" ? "当前启用" : "已停用"}
                  </span>
                  {selected.kind==="table" && selected.analysis_preference && <button role="switch" aria-label="常用表优先分析" aria-checked={selected.analysis_preference.preferred} disabled={!canEdit || savingPreference} onClick={()=>void changePreference()}>{savingPreference?"保存中…":selected.analysis_preference.preferred?"常用表 · 优先分析":"设为常用表"}</button>}
                  {canEdit && (
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
                  {canEdit && selected.source_id && (
                    <button onClick={() => void state("reanalyze")}>
                      重新预填
                    </button>
                  )}
                </div>
              </div>
              <SemanticMaintainer object={selected} onSaved={()=>void refresh()}/>
              {selected.kind==="table" && selected.analysis_preference && <p className="quiet">{selected.analysis_preference.preferred?"此表和所属字段优先深入分析，状态见各对象。":"基础资料已入目录；可设为常用表优先分析，或按需重新预填。"}</p>}
              {selected.prefill_status && <p className="quiet" role="status">{({queued:"来源已更新，等待语义分析",issued:"语义分析中；中断后会保留未知状态",budget_unavailable:"来源事实已更新；未配置可用维护预算，模型建议待补充",succeeded:"本次模型建议已保存，引用和格式已核对，业务含义仍需复核",superseded:"分析期间来源或人工版本已变化，旧建议未应用",unknown:"模型调用回执未知，保留预算且未自动重试",invalid_prefill:"模型结果未通过引用或格式校验，未应用"} as Record<string,string>)[selected.prefill_status.state] ?? selected.prefill_status.state}</p>}
              {selected.kind === "table" && (
                <div className="tabs" role="tablist">
                  {[
                    "概览",
                    "字段语义",
                    "关联与血缘",
                    "指标 SQL",
                    "业务文档",
                    "变更记录",
                  ].map((label) => (
                    <button
                      key={label}
                      role="tab"
                      aria-selected={tab === label}
                      onClick={() => setTab(label)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
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
                  {groups.map((o) => (
                    <article key={o.id} className="semantic-object">
                      {o.id !== current && (
                        <h3>
                          {o.name} <small>v{o.version}</small>
                        </h3>
                      )}
                      {o.id!==current && <SemanticMaintainer object={o} onSaved={()=>void refresh()}/>}
                      {o.kind === "field" ? (
                        <details onToggle={event => {
                          if (event.currentTarget.open) expandedFields.current.add(o.id);
                          else expandedFields.current.delete(o.id);
                          visibleObjectIds.current = [...new Set([current, ...groups
                            .filter(v => v.kind !== "field" || expandedFields.current.has(v.id))
                            .map(v => v.id)])];
                        }}>
                          <summary>
                            {o.name} ·{" "}
                            {
                              o.entries.find((e) => e.path === "meaning")
                                ?.effective_value
                            }
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
                        o.entries.map((e) => (
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
          {!selected && <p className="quiet">请选择一个语义对象。</p>}
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
          title={"来源 · " + source.source_id + " v" + source.version}
          onClose={() => setSource(null)}
        >
          <p className="quiet">
            {source.complete ? "正文完整" : "来源内容不完整"} · 当前版本{" "}
            {source.current_version}
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
      {old && <pre className="source-body">{JSON.stringify(old, null, 2)}</pre>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
