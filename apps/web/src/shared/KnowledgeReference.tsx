import { useEffect, useState } from "react";
import type { KnowledgeObject } from "../../../../packages/contracts/generated/boundary.ts";
import { api } from "./api.ts";

export function KnowledgeReference({ id, path, onOpen }: { id: string; path?: string; onOpen?: (id: string) => void }) {
  const [object, setObject] = useState<KnowledgeObject | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setObject(null); setFailed(false);
    void api("KnowledgeObject", "/knowledge/" + id).then(value => { if (current) setObject(value); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [id]);
  const entry = object?.entries.find(entry => entry.entry_id === path || entry.path === path);
  const label = object ? object.name + (entry ? " · " + entry.label : "") : failed ? "资料暂不可访问" : "正在读取资料名称…";
  return onOpen ? <button disabled={failed} onClick={() => onOpen(id)}>{label} ↗</button> : <span>{label}</span>;
}
