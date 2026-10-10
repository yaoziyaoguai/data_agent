import { useEffect, useRef, useState } from "react";
import type { KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { DocumentName, documentRepresentatives } from "./KnowledgeDocument.tsx";
import { KnowledgeOrigin } from "./KnowledgeOrigin.tsx";
import { useNavigationGuard } from "../../shared/UnsavedChanges.tsx";
import { api } from "../../shared/api.ts";
import { knowledgeKindLabels } from "../../shared/knowledge-labels.ts";

export function KnowledgeDirectory({ user, scope, current, revision, onSelect, onPage }: {
  user: string;
  scope: "all" | "maintained";
  current: string;
  revision: number;
  onSelect: (object: KnowledgeObject | null) => void;
  onPage: (objects: KnowledgeObject[], append: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [state, setState] = useState("");
  const [objects, setObjects] = useState<KnowledgeObject[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const guard = useNavigationGuard();
  const fetchPage = async (cursor: string | null, request: number) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ directory: scope });
    if (name.trim()) params.set("q", name.trim());
    if (state) params.set("state", state);
    if (cursor) params.set("after_id", cursor);
    try {
      const page = await api("KnowledgeList", "/knowledge?" + params);
      let values = page.objects;
      if (!cursor && current && page.next_after_id && !values.some(object => object.id === current)) {
        // 地址可能指向后页；只保留符合当前目录条件、且仍可读的对象。
        try {
          const selected = await api("KnowledgeObject", "/knowledge/" + encodeURIComponent(current));
          if ((!state || selected.state === state) && (!name.trim() || selected.name.toLowerCase().includes(name.trim().toLowerCase())) && (scope !== "maintained" || selected.maintenance?.maintainer_id === user)) values = [selected, ...values];
        } catch { /* 已不可读的旧地址由目录中的有效对象接替。 */ }
      }
      if (request !== generation.current) return;
      setObjects(old => cursor ? [...old, ...values.filter(o => !old.some(previous => previous.id === o.id))] : values);
      setAfter(page.next_after_id);
      onPage(values, cursor !== null);
    } catch (e) {
      if (request === generation.current) setError(e instanceof Error ? e.message : "目录读取失败");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    const request = ++generation.current;
    setObjects([]); setAfter(null); setLoading(true);
    const timer = window.setTimeout(() => void fetchPage(null, request), 150);
    return () => { window.clearTimeout(timer); ++generation.current; };
  }, [scope, name, state, revision, refresh]);
  return <>
    <div className="directory-filters">
      <label className="form-label">按名称查找<input aria-label="管理目录名称" value={name} onChange={e => { const value = e.target.value; guard(() => { onSelect(null); setName(value); }); }} /></label>
      <label className="form-label">对象状态<select aria-label="管理目录状态" value={state} onChange={e => { const value = e.target.value; guard(() => { onSelect(null); setState(value); }); }}>
        <option value="">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option>
      </select></label>
      <button disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新目录</button>
    </div>
    {documentRepresentatives(objects).map(o => <button key={o.id} aria-current={o.id === current ? "true" : undefined} onClick={() => onSelect(o)}>
      <span><DocumentName object={o}/></span><KnowledgeOrigin object={o}/><small>{knowledgeKindLabels[o.kind]}{o.state === "disabled" ? " · 已停用" : ""}</small>
    </button>)}
    {loading && <p role="status">正在读取目录…</p>}
    {!loading && !error && objects.length === 0 && <p role="status">{scope === "maintained" && !name && !state ? "你目前没有负责的内容。可切换到全部对象查看并提出建议。" : "没有符合当前条件的内容。"}</p>}
    {error && <p role="alert" className="error">{error}<button onClick={() => setRefresh(value => value + 1)}>重试目录</button></p>}
    {after && <button disabled={loading} onClick={() => void fetchPage(after, generation.current)}>加载更多目录对象</button>}
  </>;
}
