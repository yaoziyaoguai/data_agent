import { useEffect, useRef, useState } from "react";
import type { KnowledgeObject } from "../../../../packages/contracts/generated/boundary.ts";
import { api } from "./api.ts";
import { KnowledgeReference } from "./KnowledgeReference.tsx";
import { knowledgeKindLabels } from "./knowledge-labels.ts";

export function KnowledgePicker({ selected, onAdd, onRemove, disabled = false }: {
  selected: string[]; onAdd: (object: KnowledgeObject) => void; onRemove: (id: string) => void; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<KnowledgeObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef<number | null>(null);
  const load = async (search: string, after: string | null, current: number) => {
    if (current !== generation.current || pending.current === current) return;
    pending.current = current;
    setLoading(true); setError("");
    const params = new URLSearchParams({directory: "all", state: "enabled", q: search});
    if (after) params.set("after_id", after);
    try {
      const value = await api("KnowledgeList", `/knowledge?${params}`);
      if (current !== generation.current) return;
      setItems(previous => [...new Map((after ? [...previous, ...value.objects] : value.objects).map(item => [item.id, item])).values()]);
      setNext(value.next_after_id);
    } catch {
      if (current === generation.current) setError("查找失败，已读取的资料仍保留，请重试。");
    } finally {
      if (pending.current === current) pending.current = null;
      if (current === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    const current = ++generation.current;
    setItems([]); setNext(null); setError(""); setLoading(Boolean(query.trim()));
    const timer = setTimeout(() => {
      if (query.trim()) void load(query.trim(), null, current);
    }, 150);
    return () => { if (generation.current === current) ++generation.current; clearTimeout(timer); };
  }, [query]);
  return <div className="knowledge-picker">
    {selected.length > 0 && <ul>{selected.map(id => <li key={id}><KnowledgeReference id={id}/><button type="button" disabled={disabled} aria-label="移除关联资料" onClick={() => onRemove(id)}>移除</button></li>)}</ul>}
    <label className="form-label">查找表、字段或业务资料<input value={query} disabled={disabled} placeholder="输入名称，例如：语音任务达成率" onChange={e => { ++generation.current; setQuery(e.target.value); }}/></label>
    {loading && <p role="status">正在查找…</p>}{error && <p role="alert">{error}</p>}
    {!loading && query.trim() && !items.length && !error && <p className="quiet">没有匹配的资料，请换一个名称。</p>}
    <div className="knowledge-picker-results">{items.filter(item => !selected.includes(item.id)).map(item => <button type="button" key={item.id} disabled={disabled} onClick={() => onAdd(item)}>{item.name}<small>{knowledgeKindLabels[item.kind]}</small></button>)}</div>
    {(next || error) && <button type="button" disabled={disabled || loading} onClick={() => void load(query.trim(), next, generation.current)}>{error ? "重试查找资料" : "加载更多资料"}</button>}
  </div>;
}
