import { useEffect, useState } from "react";
import type { Asset } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";

export function AssetPreview({ id }: { id: string }) {
  const [result, setResult] = useState<Asset | "unavailable" | null>(null);
  useEffect(() => {
    const request = new AbortController();
    setResult(null);
    void api("Asset", "/assets/" + encodeURIComponent(id), "GET", undefined, undefined, request.signal)
      .then(asset => { if (!request.signal.aborted) setResult(asset); })
      .catch(() => { if (!request.signal.aborted) setResult("unavailable"); });
    return () => request.abort();
  }, [id]);

  if (!result) return <p role="status">正在核对方法与来源…</p>;
  if (result === "unavailable" || result.text_unavailable) return <p role="alert">方法或来源目前不可读取。</p>;
  return <>
    <h3>{result.name}</h3>
    <p className="quiet">{result.scope}</p>
    {result.owner_id && <p className="quiet">负责人 {result.owner_id}</p>}
    <MarkdownContent text={result.body}/>
    {result.dependencies.length > 0 && <ul aria-label="知识依赖">{result.dependencies.map(reference =>
      <li key={reference.object_id + ":" + reference.path}><KnowledgeReference id={reference.object_id} path={reference.path}/></li>)}</ul>}
    {result.files?.map(file => <details key={file.path}>
      <summary>{file.path.replace(/^(references|assets)\//, "")}</summary>
      <pre className="skill-preview">{file.content}</pre>
    </details>)}
  </>;
}
