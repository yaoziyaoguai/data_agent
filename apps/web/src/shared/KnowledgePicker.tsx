import { useEffect, useState } from "react";
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
  useEffect(() => {
    let live = true;
    setItems([]); setError(""); setLoading(Boolean(query.trim()));
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      void api("KnowledgeList", `/knowledge?directory=all&state=enabled&q=${encodeURIComponent(query.trim())}`)
        .then(value => { if (live) setItems(value.objects); })
        .catch(() => { if (live) setError("查找失败，请重新输入名称。" ); })
        .finally(() => { if (live) setLoading(false); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  return <div className="knowledge-picker">
    {selected.length > 0 && <ul>{selected.map(id => <li key={id}><KnowledgeReference id={id}/><button type="button" disabled={disabled} aria-label="移除关联资料" onClick={() => onRemove(id)}>移除</button></li>)}</ul>}
    <label className="form-label">查找表、字段或业务资料<input value={query} disabled={disabled} placeholder="输入名称，例如：净收入" onChange={e => setQuery(e.target.value)}/></label>
    {loading && <p role="status">正在查找…</p>}{error && <p role="alert">{error}</p>}
    {!loading && query.trim() && !items.length && !error && <p className="quiet">没有匹配的资料，请换一个名称。</p>}
    <div className="knowledge-picker-results">{items.filter(item => !selected.includes(item.id)).map(item => <button key={item.id} disabled={disabled} onClick={() => { onAdd(item); setQuery(""); }}>{item.name}<small>{knowledgeKindLabels[item.kind]}</small></button>)}</div>
  </div>;
}
