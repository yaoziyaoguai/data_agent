import {useEffect, useState} from "react";
import type {EvidenceRef, KnowledgeObject} from "../../../../../packages/contracts/generated/boundary.ts";
import {api, ApiError} from "../../shared/api.ts";

export function AssetDependenciesEditor({dependencies, onChange, disabled}: {
  dependencies: EvidenceRef[];
  onChange: (value: EvidenceRef[]) => void;
  disabled: boolean;
}) {
  return <fieldset className="asset-dependencies" disabled={disabled}>
    <legend>引用的资料</legend>
    <p>逐条核对引用的当前内容。更新或移除后，请检查正文与附件，再保存；已选用的会话仍需重新选用。</p>
    {dependencies.length > 0 && <p>移除后，该引用不再参与失效检查。请确认正文、范围和附件已不再依赖它。</p>}
    {dependencies.length === 0 && <p>当前没有知识依赖。</p>}
    {dependencies.map((reference, index) => <DependencyReview
      key={`${reference.object_id}:${reference.path}:${index}`}
      reference={reference}
      onUpdate={value => onChange(dependencies.map((item, i) => i === index ? value : item))}
      onRemove={() => onChange(dependencies.filter((_, i) => i !== index))}
    />)}
  </fieldset>;
}

function DependencyReview({reference, onUpdate, onRemove}: {
  reference: EvidenceRef;
  onUpdate: (value: EvidenceRef) => void;
  onRemove: () => void;
}) {
  const [current, setCurrent] = useState<KnowledgeObject | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [readAttempt, setReadAttempt] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setCurrent(null); setError(""); setConfirmed(false);
    void api("KnowledgeObject", "/knowledge/" + encodeURIComponent(reference.object_id))
      .then(value => { if (active) setCurrent(value); })
      .catch(e => {
        if (active) setError(e instanceof ApiError && ["not_available", "forbidden"].includes(e.code)
          ? "无法读取该知识，可能已删除或读取权限已变化。可重试读取，或核对方法后明确移除此依赖。"
          : "读取当前知识失败，尚不能判断引用是否有效。请重试读取。");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reference.object_id, readAttempt]);
  const entry = current?.entries.find(item => item.entry_id === reference.path || item.path === reference.path);
  const changed = current !== null && current.version !== reference.version;
  const canUpdate = current?.state === "enabled" && entry !== undefined && changed;
  return <article className="asset-dependency">
    <h3>{current?.name ?? "正在读取引用资料"}</h3>
    {loading && <p role="status">正在读取当前知识…</p>}
    {error && <p className="error">{error}</p>}
    {current && <>
      {current.state !== "enabled" ? <p className="error">该知识已停用，不能用于当前引用。</p>
        : !entry ? <p className="error">原引用位置已不存在，请核对方法后移除该依赖。</p>
        : <p>{changed ? "知识已改版，请核对当前内容后决定是否更新。" : "引用版本与当前知识一致。"}</p>}
      {entry && <details open><summary>当前引用内容 · {entry.label}</summary><pre className="skill-preview">{entry.effective_value}</pre></details>}
    </>}
    {canUpdate && <div className="dependency-update">
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>我已核对新版内容及方法适用范围</label>
      <button disabled={!confirmed} onClick={() => { onUpdate({...reference, version: current.version}); setConfirmed(false); }}>采用核对后的最新内容</button>
    </div>}
    <div className="actions">
      <button disabled={loading} onClick={() => setReadAttempt(value => value + 1)}>重新读取当前知识</button>
      <button onClick={onRemove}>核对后移除此依赖</button>
    </div>
  </article>;
}
