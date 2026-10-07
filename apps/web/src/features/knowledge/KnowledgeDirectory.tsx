import { useEffect, useRef, useState } from "react";
import type { KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";

export function KnowledgeDirectory({ scope, current, revision, onSelect }: {
  scope: "all" | "maintained";
  current: string;
  revision: number;
  onSelect: (object: KnowledgeObject) => void;
}) {
  const [name, setName] = useState("");
  const [state, setState] = useState("");
  const [objects, setObjects] = useState<KnowledgeObject[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const fetchPage = async (cursor: string | null, request: number) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ directory: scope });
    if (name.trim()) params.set("q", name.trim());
    if (state) params.set("state", state);
    if (cursor) params.set("after_id", cursor);
    try {
      const page = await api("KnowledgeList", "/knowledge?" + params);
      if (request !== generation.current) return;
      setObjects(old => cursor ? [...old, ...page.objects.filter(o => !old.some(previous => previous.id === o.id))] : page.objects);
      setAfter(page.next_after_id);
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
      <label className="form-label">按名称查找<input aria-label="管理目录名称" value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="form-label">对象状态<select aria-label="管理目录状态" value={state} onChange={e => setState(e.target.value)}>
        <option value="">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option>
      </select></label>
      <button disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新目录</button>
    </div>
    {objects.map(o => <button key={o.id} aria-current={o.id === current ? "true" : undefined} onClick={() => onSelect(o)}>
      <span>{o.name}</span><small>{o.kind} · v{o.version} · {o.state === "disabled" ? "已停用" : "启用"}</small>
    </button>)}
    {loading && <p role="status">正在读取目录…</p>}
    {!loading && !error && objects.length === 0 && <p role="status">没有符合当前条件的对象。</p>}
    {error && <p role="alert" className="error">{error}<button onClick={() => setRefresh(value => value + 1)}>重试目录</button></p>}
    {after && <button disabled={loading} onClick={() => void fetchPage(after, generation.current)}>加载更多目录对象</button>}
  </>;
}
