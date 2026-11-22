import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KnowledgeObject,
  KnowledgeEntry,
  KnowledgeEntryEdit,
  SourceDocument,
  Proposal,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { SemanticCorrections } from "./SemanticCorrections.tsx";
import { KnowledgeCreator } from "./KnowledgeCreator.tsx";
import { KnowledgeLineageView } from "./KnowledgeLineageView.tsx";
import { KnowledgeDocument, documentRepresentatives } from "./KnowledgeDocument.tsx";
import { useStableOperation } from "./semantic-commands.ts";
import { KnowledgeDirectory } from "./KnowledgeDirectory.tsx";
import { SemanticMaintainer } from "./SemanticMaintainer.tsx";
import { KnowledgeOrigin } from "./KnowledgeOrigin.tsx";
import { KnowledgeBusinessDomain } from "./KnowledgeBusinessDomain.tsx";
import { KnowledgeMaintenanceImpact } from "./KnowledgeMaintenanceImpact.tsx";
import { SourceSynchronizationStatus, useSourceSynchronization } from "./SourceSynchronization.tsx";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import { useUnsavedChanges, useNavigationGuard } from "../../shared/UnsavedChanges.tsx";
import { Tabs } from "../../shared/Tabs.tsx";
import type { WorkspaceLocation } from "../../shared/workspace-location.ts";
import { knowledgeKindLabels } from "../../shared/knowledge-labels.ts";
import { EntryEditor, type StagedEntry } from "./EntryEditor.tsx";
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
function LineageAndEtl({object, onOpen, onSaved, onCorrection, onSource, availableObjects, stagedEdits, onStage}: {
  object: KnowledgeObject;
  onOpen: (id: string) => void;
  onSaved: (object: KnowledgeObject) => void;
  onCorrection: () => void;
  onSource: (id: string) => void;
  availableObjects: KnowledgeObject[];
  stagedEdits: Record<string, StagedEntry>;
  onStage?: (item: StagedEntry) => void;
}) {
  const lineageEntry = object.entries.find(e => e.path === "lineage");
  const etlEntries = object.entries.filter(e => e.path === "etl");
  const editorProps = {canEdit: object.maintenance?.can_edit ?? false, onCorrection, onSaved, onSource, availableObjects, batchMode: !!onStage && object.maintenance?.can_edit === true, onStage};
  return (
    <article className="semantic-object lineage-object">
      <h3>血缘</h3>
      <KnowledgeLineageView key={object.id} objectId={object.id} title={object.name} version={object.version} onOpen={onOpen}/>
      {lineageEntry && (
        <details className="technical-source">
          <summary>维护血缘说明</summary>
          <EntryEditor object={object} entry={lineageEntry} staged={stagedEdits[object.id + ":" + lineageEntry.entry_id]} {...editorProps}/>
        </details>
      )}
      {etlEntries.length > 0 && <>
        <h3>加工过程</h3>
        {etlEntries.map((entry, index) => (
          <section key={entry.entry_id} className="etl-step">
            <h4>步骤 {index + 1}</h4>
            <EntryEditor object={object} entry={entry} staged={stagedEdits[object.id + ":" + entry.entry_id]} {...editorProps}/>
          </section>
        ))}
      </>}
    </article>
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
    initialObject ?? "",
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
    else guard(() => { setCurrent(id); setTab(nextTab); setDirectoryScope(scope); }, undefined, "knowledge");
  };
  const [query, setQuery] = useState("");
  const [directoryScope, setDirectoryScope] = useState<"tables" | "all" | "maintained">(initialScope);
  const directorySelection = useRef({scope: directoryScope, query});
  directorySelection.current = {scope: directoryScope, query};
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const [createdObjectId, setCreatedObjectId] = useState("");
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [relatedPage, setRelatedPage] = useState<{parent: string; ids: string[]; next: string | null; loading: boolean; failed: boolean}>({parent: "", ids: [], next: null, loading: false, failed: false});
  const relatedGeneration = useRef(0);
  const [matches, setMatches] = useState<KnowledgeObject[]>([]);
  const [searchLimited, setSearchLimited] = useState(false);
  const [vectorUnavailable,setVectorUnavailable]=useState(false);
  const [rebuilding,setRebuilding]=useState(false);
  const [maintenanceNotice,setMaintenanceNotice]=useState("");
  const [savingPreference,setSavingPreference]=useState(false);
  const searchGeneration = useRef(0);
  const [error, setError] = useState("");
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const refreshRequest = useRef<() => void>(() => {});
  const activeObject = useRef(current);
  activeObject.current = current;
  const [authorityRevision, setAuthorityRevision] = useState(0);
  const [correctionsRevision, setCorrectionsRevision] = useState(0);
  const [canAdmin,setCanAdmin]=useState(false);
  const [canCreate,setCanCreate]=useState(false);
  // P-04：普通用户把语义页收窄为只读数据字典，隐藏维护面、同步与预填状态。
  const [role,setRole]=useState<"user" | "maintainer" | "super_maintainer" | null>(null);
  // 角色判定只写一次；JSX 里 `a || b && x` 会因优先级把布尔当子节点渲染成空，必须用变量。
  const canMaintain = role === "maintainer" || role === "super_maintainer";
  // U-02：条目快速筛选与批量核对暂存；stagedEdits 以“对象:条目”为键，提交时按对象分组。
  const [entryFilter, setEntryFilter] = useState<"all" | "suggested" | "overridden" | "missing">("all");
  const [batchMode, setBatchMode] = useState(false);
  const [stagedEdits, setStagedEdits] = useState<Record<string, StagedEntry>>({});
  const [diffOpen, setDiffOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const batchOperation = useStableOperation();
  const discardBatch = () => { setStagedEdits({}); setDiffOpen(false); };
  const batchGuard = useUnsavedChanges(Object.keys(stagedEdits).length > 0, discardBatch, "knowledge");
  const refresh = () => refreshRequest.current();
  const sourceSync = useSourceSynchronization(user, canAdmin, () => {
    setDirectoryRevision(value => value + 1);
    refresh();
  });
  useEffect(() => {
    let live = true;
    let inFlight = false;
    let pending = false;
    let initialized = false;
    const controller = new AbortController();
    const { signal } = controller;
    let relatedChanged = false;
    const run = async () => {
      if (!live) return;
      if (inFlight) { pending = true; return; }
      inFlight = true;
      const readRelated = relatedChanged;
      relatedChanged = false;
      try {
        // 子请求失败也须等同批读取结束，避免提前释放在途状态。
        const [knowledge, proposals, access] = await Promise.allSettled([
          api("KnowledgeList", "/knowledge?directory=all&directory_view=grouped", "GET", undefined, undefined, signal),
          api("ProposalList", "/knowledge-proposals", "GET", undefined, undefined, signal),
          api("SemanticAccess", "/semantic-access", "GET", undefined, undefined, signal),
        ]);
        if (!live) return;
        if (knowledge.status === "rejected") throw knowledge.reason;
        if (proposals.status === "rejected") throw proposals.reason;
        if (access.status === "rejected") throw access.reason;
        const page = knowledge.value;
        if (!initialized) {
          initialized = true;
          setNextAfter(page.next_after_id);
          if (directorySelection.current.scope === "tables" && !directorySelection.current.query.trim()) setCurrent(previous => previous || page.objects.find(object => object.kind === "table")?.id || "");
        }
        setObjects(old => { const byId = new Map(old.map(object => [object.id, object])); for (const value of page.objects) byId.set(value.id, currentObject(byId.get(value.id), value)); return [...byId.values()]; });
        setProposals(proposals.value.proposals);
        setCanAdmin(access.value.can_admin);
        setCanCreate(access.value.can_create);
        setRole(access.value.highest_role);
        if (readRelated && activeObject.current) await loadRelated(activeObject.current, null, true);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "目录读取失败");
      } finally {
        inFlight = false;
        if (live && pending) { pending = false; void run(); }
      }
    };
    refreshRequest.current = () => { void run(); };
    const stream = new EventSource("/api/workspace/events");
    const refreshAuthority = () => {
      setObjects([]);
      setMatches([]);
      setSource(null);
      setAuthorityRevision(revision => revision + 1);
      setDirectoryRevision(revision => revision + 1);
      setCorrectionsRevision(revision => revision + 1);
    };
    let connected = false;
    stream.onopen = () => {
      if (connected) refreshAuthority();
      connected = true;
    };
    stream.addEventListener("catalog_changed", () => {
      relatedChanged = true;
      setDirectoryRevision(revision => revision + 1);
      void run();
    });
    stream.addEventListener("corrections_changed", () => setCorrectionsRevision(revision => revision + 1));
    stream.addEventListener("authority_changed", refreshAuthority);
    stream.addEventListener("lagged", refreshAuthority);
    stream.addEventListener("stream_closed", () => stream.close());
    void run();
    return () => {
      live = false;
      controller.abort();
      stream.close();
    };
  }, [user, authorityRevision]);
  useEffect(() => {
    if (initialObject !== undefined) setCurrent(initialObject ?? "");
    // U-03：旧页签名“关联与血缘”归一到“血缘与加工”，历史链接仍可直达。
    const normalizedTab = initialTab === "关联与血缘" ? "血缘与加工" : initialTab;
    setTab(["概览", "字段语义", "血缘与加工", "指标 SQL", "业务文档", "变更记录"].includes(normalizedTab) ? normalizedTab : "概览");
    setDirectoryScope(initialScope);
  }, [initialObject, initialTab, initialScope]);
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
  }, [query, directoryScope, authorityRevision]);
  useEffect(() => {
    if (!current) return;
    let live=true;
    void api("KnowledgeObject","/knowledge/"+current).then(v => { if(live) setObjects(old => [...old.filter(o => o.id!==v.id),currentObject(old.find(o => o.id===v.id),v)]); }).catch(e => { if(live) setError(e.message); });
    return () => {live=false;};
  }, [current, authorityRevision]);
  const loadRelated = async (parent: string, after: string | null = null, keepLoaded = false) => {
    const generation = ++relatedGeneration.current;
    if (!keepLoaded) setRelatedPage(old => ({parent, ids: after && old.parent === parent ? old.ids : [], next: after, loading: true, failed: false}));
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
  }, [current, authorityRevision]);
  const loadMore = async () => {
    if(!nextAfter || loadingMore) return;
    setLoadingMore(true);
    try { const page=await api("KnowledgeList","/knowledge?directory=all&directory_view=grouped&after_id="+encodeURIComponent(nextAfter)); setNextAfter(page.next_after_id); setObjects(old => { const byId = new Map(old.map(o => [o.id,o])); for (const v of page.objects) byId.set(v.id,currentObject(byId.get(v.id),v)); return [...byId.values()]; }); }
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
      setObjects(old=>old.map(o=>o.analysis_preference?.table_id===value.table_id?currentObject(o,{...o,analysis_preference:value}):o));
      setMaintenanceNotice(value.preferred?"已设为常用表，当前表及字段优先分析。其他表仍可按需预填。":"已取消常用设置，已有语义保留。来源改版仍会自动重分析。");
      refresh();
    }catch(e){setError(e instanceof Error?e.message:"常用范围保存失败");}finally{setSavingPreference(false);}
  };
  const rebuild=async()=>{
    if(rebuilding)return;
    setRebuilding(true);setError("");setMaintenanceNotice("");
    try{await api("MutationReceipt","/knowledge-index/rebuilds","POST",{operation_id:crypto.randomUUID()});setMaintenanceNotice("索引重建已排队。检索期间仍会核对当前正式知识，覆盖情况会随进度更新。");}
    catch(e){setError(e instanceof Error && e.message === "vector_unconfigured" ? "尚未配置语义检索服务，暂时无法重建索引。" : e instanceof Error ? e.message : "索引重建失败");}finally{setRebuilding(false);}
  };
  const tables = objects.filter((o) => o.kind === "table");
  const save = (v: KnowledgeObject) => {
    if (objects.find(object => object.id === v.id)?.state !== v.state) setDirectoryRevision(value => value + 1);
    setObjects((old) => old.map((o) => (o.id === v.id ? currentObject(o, v) : o)));
    refresh();
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
      else guard(() => { setCurrent(next); setTab("概览"); }, undefined, "knowledge");
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
          : tab === "血缘与加工"
            ? relatedObjects.filter(
                (o) =>
                  o.kind === "relationship" && o.related_ids.includes(current),
              )
            : selected
              ? [selected]
              : [];
  // U-02：待核对范围限定为当前表与其已加载字段对象；条目按“建议/人工覆盖/尚缺说明”归类。
  const fieldObjects = selected?.kind === "table"
    ? relatedObjects.filter(o => o.kind === "field" && o.related_ids.includes(current))
    : [];
  const entryCategory = (entry: KnowledgeEntry) =>
    entry.human_override ? "overridden"
    : typeof entry.suggestion.value === "string" && entry.suggestion.value.trim() ? "suggested"
    : !entry.effective_value.trim() ? "missing"
    : "other";
  const entryMatchesFilter = (entry: KnowledgeEntry) => entryFilter === "all" || entryCategory(entry) === entryFilter;
  const scopeEntries = (selected ? [selected, ...fieldObjects] : []).flatMap(o => o.entries);
  const filterCounts = {
    suggested: scopeEntries.filter(e => entryCategory(e) === "suggested").length,
    overridden: scopeEntries.filter(e => entryCategory(e) === "overridden").length,
    missing: scopeEntries.filter(e => entryCategory(e) === "missing").length,
  };
  const pendingReviewCount = scopeEntries.filter(e => e.review_state !== "confirmed" || entryCategory(e) === "suggested").length;
  // 字段语义按字段整体匹配筛选；概览在条目级过滤，其他页签不参与筛选。
  const visibleGroups = tab === "字段语义" && entryFilter !== "all"
    ? groups.filter(o => o.entries.some(entryMatchesFilter))
    : groups;
  const stagedKey = (objectId: string, entryId: string) => objectId + ":" + entryId;
  const stagedList = Object.entries(stagedEdits).map(([key, edit]) => ({key, ...edit}));
  const stageEdit = (item: StagedEntry) => {
    setStagedEdits(old => ({...old, [stagedKey(item.objectId, item.edit.entry_id)]: item}));
  };
  const submitBatch = async () => {
    if (batchBusy || stagedList.length === 0) return;
    setBatchBusy(true); setError("");
    const byObject = new Map<string, {object_id: string; expected_version: string; edits: KnowledgeEntryEdit[]}>();
    for (const item of stagedList) {
      const group = byObject.get(item.objectId) ?? { object_id: item.objectId, expected_version: item.version, edits: [] };
      if (BigInt(item.version) < BigInt(group.expected_version)) group.expected_version = item.version;
      group.edits.push(item.edit);
      byObject.set(item.objectId, group);
    }
    const changes = [...byObject.values()];
    try {
      const receipt = await api("KnowledgeBatchReceipt", "/knowledge/batch-entries", "PATCH", {
        operation_id: batchOperation(changes), objects: changes,
      });
      setObjects(old => {
        const updated = new Map(receipt.objects.map(object => [object.id, object]));
        return old.map(object => updated.has(object.id) ? currentObject(object, updated.get(object.id)!) : object);
      });
      batchGuard.markSaved();
      discardBatch();
    } catch (e) {
      setError(e instanceof Error && e.message === "version_conflict"
        ? "有条目的版本已变化，整批尚未保存。请重新核对后暂存。"
        : e instanceof Error ? e.message : "批量提交失败，暂存修改仍保留");
    } finally {
      setBatchBusy(false);
    }
  };
  return (
    <section className="management">
      <div className="page-heading">
        <div>
          <h1>{canMaintain ? "语义管理" : "数据字典"}</h1>
        </div>
        {canMaintain && <div className="actions">
          <details className="maintenance-menu"><summary>维护操作</summary><div className="actions">
          <button
            onClick={()=>{setMaintenanceNotice("");void sourceSync.synchronize();}}
            disabled={!canAdmin || sourceSync.busy}
          >
            {sourceSync.label}
          </button>
          {canAdmin && <button onClick={()=>void rebuild()} disabled={rebuilding}>{rebuilding?"正在排队…":"重建检索索引"}</button>}</div></details>
          <KnowledgeCreator user={user} canCreate={canCreate} relatedId={current} onCreated={v => {
            refresh();
            // 新建成功后清除旧筛选，并取消旧目录请求，避免刚保存的对象被切走。
            setCreatedObjectId(v.id);
            setQuery("");
            setObjects(old => [...old.filter(o => o.id !== v.id), v]);
            move(v.id, "概览", directoryScope === "tables" ? "maintained" : directoryScope);
          }}/>
        </div>}
      </div>
      <div className="knowledge-toolbar"><label className="form-label directory-scope">语义目录范围
        <select aria-label="语义目录范围" value={directoryScope} onChange={e => move(e.target.value === "tables" ? tables[0]?.id ?? "" : "", "概览", e.target.value as "tables" | "all" | "maintained")}>
          <option value="tables">按表浏览</option><option value="all">全部对象</option>{canMaintain && <option value="maintained">我负责的对象</option>}
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
      {canAdmin && <SourceSynchronizationStatus sync={sourceSync}/>}
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
                  {canMaintain && selected.kind==="table" && selected.analysis_preference && <button role="switch" aria-label="常用表优先分析" aria-checked={selected.analysis_preference.preferred} disabled={!canEdit || savingPreference} onClick={()=>void changePreference()}>{savingPreference?"保存中…":selected.analysis_preference.preferred?"常用表 · 优先分析":"设为常用表"}</button>}
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
              {canMaintain && <SemanticMaintainer object={selected} onSaved={()=>{setDirectoryRevision(value => value + 1);void refresh();}}/>}
              {canMaintain && <KnowledgeMaintenanceImpact objectId={selected.id} version={selected.version}/>}
              {canMaintain && selected.prefill_status && selected.prefill_status.state !== "succeeded" && <p className="quiet" role="status">{({queued:"正在等待补充语义说明",issued:"正在分析资料，补充说明",budget_unavailable:"自动补充暂不可用，仍可人工维护",superseded:"资料已变化，本次分析未采用",unknown:"分析暂未完成，请稍后查看状态",invalid_prefill:"本次分析未通过检查，已有内容保留"} as Record<string,string>)[selected.prefill_status.state] ?? "分析状态待核对"}</p>}
              {canMaintain && selected.preparation_status && <p className="quiet" role="status">{({queued:"正在排队整理来源原文",running:"正在分批整理来源原文",analysis:"正在分析来源批次",review:"正在复核来源批次",partial:"来源整理完成但存在未解释内容",failed:"来源整理失败，已有内容保留",superseded:"已被新修订的整理取代",unknown:"来源整理结果不确定，等待复核"} as Record<string,string>)[selected.preparation_status.state] ?? "来源整理状态待核对"}</p>}
              {selected.kind === "table" && (
                <Tabs label="表的语义内容" value={tab} items={["概览", "字段语义", "血缘与加工", "指标 SQL", "业务文档", "变更记录"].map(label => ({value: label, label}))} onChange={next => move(current, next)}/>
              )}
              {selected.kind === "table" && ["概览", "字段语义"].includes(tab) && (
                <div className="entry-filter-bar">
                  <span className="pending-summary">待核对 {pendingReviewCount} 条</span>
                  <div className="filter-buttons" role="group" aria-label="条目筛选">
                    <button aria-pressed={entryFilter === "all"} onClick={() => setEntryFilter("all")}>全部</button>
                    <button aria-pressed={entryFilter === "suggested"} onClick={() => setEntryFilter("suggested")}>待核对建议 {filterCounts.suggested}</button>
                    <button aria-pressed={entryFilter === "overridden"} onClick={() => setEntryFilter("overridden")}>已人工覆盖 {filterCounts.overridden}</button>
                    <button aria-pressed={entryFilter === "missing"} onClick={() => setEntryFilter("missing")}>尚缺说明 {filterCounts.missing}</button>
                  </div>
                  {canMaintain ? canEdit ? <>
                    <label className="batch-toggle"><input type="checkbox" checked={batchMode} onChange={e => setBatchMode(e.target.checked)}/>批量修改</label>
                    <button onClick={() => setDiffOpen(true)} disabled={stagedList.length === 0}>查看本次修改（{stagedList.length}）</button>
                  </> : <span className="quiet">当前对象由他人负责，仅支持逐条修改</span> : null}
                </div>
              )}
              {tab === "变更记录" ? (
                <VersionHistory object={selected} />
              ) : (
                <div className="semantic-groups">
                  {tab === "血缘与加工" && selected.kind === "table" && (
                    <LineageAndEtl object={selected} onOpen={id => move(id)} onSaved={save} onCorrection={() => void refresh()} onSource={id => void showSource(id)} availableObjects={objects} stagedEdits={stagedEdits} onStage={batchMode ? stageEdit : undefined}/>
                  )}
                  {!["概览", "变更记录"].includes(tab) && <>
                    {relatedPage.loading && <p role="status">正在读取关联内容…</p>}
                    {!relatedPage.loading && !relatedPage.failed && visibleGroups.length === 0 && <p className="quiet">{tab === "血缘与加工" ? "暂无其他关联对象。" : entryFilter !== "all" && tab === "字段语义" ? "当前筛选下没有匹配的字段。" : "当前已读取的内容中没有此类关联。"}</p>}
                    {(relatedPage.next || relatedPage.failed) && <button disabled={relatedPage.loading} onClick={() => void loadRelated(current, relatedPage.next)}>{relatedPage.failed ? "重试关联内容" : "加载更多关联内容"}</button>}
                  </>}
                  {documentRepresentatives(visibleGroups).map((o) => o.kind === "document" ? <KnowledgeDocument key={o.source_id ?? o.id} object={o} onOpen={o.id !== current ? () => selectObject(o) : undefined} onSaved={parts => { refresh(); setDirectoryRevision(value => value + 1); setObjects(old => { const byId = new Map(old.map(o => [o.id, o])); for (const part of parts) byId.set(part.id, currentObject(byId.get(part.id), part)); return [...byId.values()]; }); }} onCorrection={() => void refresh()}/> : (
                    <article key={o.id} className={"semantic-object" + (o.kind === "field" ? " field-object" : "")}>
                      {o.id !== current && o.kind !== "field" && (
                        <h3>
                          {o.name}
                          <button onClick={() => selectObject(o)}>打开详情</button>
                        </h3>
                      )}

                      {o.kind === "field" ? (
                        <details>
                          <summary>
                            <strong>{o.name.split(".").at(-1)}</strong><span>{o.entries.find(e => e.path === "meaning")?.effective_value || "尚缺说明"}</span><span className="field-detail-label">查看</span>
                          </summary>
                          <KnowledgeBusinessDomain object={o} onSaved={save} onCorrection={() => void refresh()} onSource={id => void showSource(id)}/>
                          {o.entries.filter(e => e.path !== "business_domain").map((e) => (
                            <EntryEditor
                              key={e.entry_id}
                              object={o}
                              entry={e}
                              canEdit={o.maintenance?.can_edit??false}
                              onCorrection={()=>void refresh()}
                              onSaved={save}
                              onSource={(id) => void showSource(id)}
                              availableObjects={objects}
                              batchMode={batchMode && (o.maintenance?.can_edit ?? false)}
                              staged={stagedEdits[stagedKey(o.id, e.entry_id)]}
                              onStage={stageEdit}
                            />
                          ))}
                        </details>
                      ) : (
                        <><KnowledgeBusinessDomain object={o} onSaved={save} onCorrection={() => void refresh()} onSource={id => void showSource(id)}/>{o.entries.filter(e => e.path !== "business_domain" && e.path !== "lineage" && e.path !== "etl" && (tab !== "概览" || entryMatchesFilter(e))).map((e) => e.path === "ddl" ? <details key={e.entry_id} className="technical-source"><summary>{e.label}</summary><EntryEditor object={o} entry={e} canEdit={o.maintenance?.can_edit ?? false} onCorrection={() => void refresh()} onSaved={save} onSource={id => void showSource(id)} availableObjects={objects} batchMode={batchMode && (o.maintenance?.can_edit ?? false)} staged={stagedEdits[stagedKey(o.id, e.entry_id)]} onStage={stageEdit}/></details> : (
                          <EntryEditor
                            key={e.entry_id}
                            object={o}
                            entry={e}
                            canEdit={o.maintenance?.can_edit??false}
                              onCorrection={()=>void refresh()}
                            onSaved={save}
                            onSource={(id) => void showSource(id)}
                            availableObjects={objects}
                            batchMode={batchMode && (o.maintenance?.can_edit ?? false)}
                            staged={stagedEdits[stagedKey(o.id, e.entry_id)]}
                            onStage={stageEdit}
                          />
                        ))}</>
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
      <SemanticCorrections key={user} user={user} revision={correctionsRevision} proposals={proposals} onSaved={()=>void refresh()}/>
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
      {diffOpen && (
        <Modal title={`本次修改（${stagedList.length} 条）`} onClose={() => setDiffOpen(false)}>
          {stagedList.length === 0 ? <p className="quiet">当前没有暂存的修改。</p> : <>
            <div className="batch-diff">
              {stagedList.map(item => {
                const object = objects.find(o => o.id === item.objectId);
                const entry = object?.entries.find(e => e.entry_id === item.edit.entry_id);
                return (
                  <section key={item.key} className="batch-diff-item">
                    <h4>{object?.name ?? item.objectId} · {entry?.label ?? item.edit.entry_id}</h4>
                    <div className="provenance-columns">
                      <section>
                        <h5>来源事实</h5>
                        <p>{entry ? String(entry.source_facts.value ?? entry.source_facts.gap ?? "请查看来源正文") : "条目已不在当前列表"}</p>
                      </section>
                      <section>
                        <h5>模型建议</h5>
                        <p>{entry ? String(entry.suggestion.value ?? "暂无分析建议") : "—"}</p>
                      </section>
                      <section>
                        <h5>人工值变化</h5>
                        <p className="code-text diff-old">{entry?.effective_value || "（空）"}</p>
                        <p className="code-text diff-new">{item.edit.clear_override ? "清除人工覆盖" : item.edit.value || "（空）"}</p>
                      </section>
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="actions">
              <button className="primary" disabled={batchBusy} onClick={() => void submitBatch()}>{batchBusy ? "正在提交…" : "提交全部修改"}</button>
              <button disabled={batchBusy} onClick={discardBatch}>放弃全部</button>
            </div>
          </>}
          {error && <p className="error" role="alert">{error}</p>}
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
