import { useEffect, useState } from "react";
import type { KnowledgeLineage } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import "./knowledge-lineage.css";

type Edge = KnowledgeLineage["upstream"][number];
const relationshipLabels: Record<Edge["relationship"], string> = {
  table_relation: "表关联",
  metric_query: "指标取数",
  field_reference: "字段引用",
  skill_dependency: "Skill 依赖",
};

function LineageNodes({ edges, empty, onOpen }: { edges: Edge[]; empty: string; onOpen: (id: string) => void }) {
  if (!edges.length) return <p className="lineage-empty">{empty}</p>;
  return <ul className="lineage-nodes">
    {edges.map(edge => <li key={edge.object_id + ":" + edge.relationship}>
      {edge.kind === "skill" ? <strong>{edge.name}</strong>
        : <button onClick={() => onOpen(edge.object_id)}>{edge.name}</button>}
      <small>{relationshipLabels[edge.relationship]}</small>
      {edge.key_summary && <span className="lineage-keys">{edge.key_summary}</span>}
    </li>)}
  </ul>;
}

function LineageConnector() {
  return <svg className="lineage-connector" aria-hidden="true" viewBox="0 0 32 24" fill="none">
    <path d="M1 12H28m-7-6 7 6-7 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

export function KnowledgeLineageView({ objectId, title, version, onOpen }: {
  objectId: string;
  title: string;
  version: string;
  onOpen: (id: string) => void;
}) {
  const [state, setState] = useState<{ graph: KnowledgeLineage } | { failed: true } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setState(null);
    void api("KnowledgeLineage", "/knowledge/" + encodeURIComponent(objectId) + "/lineage",
      "GET", undefined, undefined, request.signal)
      .then(graph => {
        if (!request.signal.aborted) setState({graph});
      })
      .catch(() => {
        if (!request.signal.aborted) setState({failed: true});
      });
    return () => request.abort();
  }, [objectId, version, retry]);
  if (!state) return <p className="quiet" role="status">正在读取血缘…</p>;
  if ("failed" in state) return <p role="alert">血缘暂时不可读取。 <button onClick={() => setRetry(value => value + 1)}>重试</button></p>;

  const { upstream, downstream, more_downstream } = state.graph;
  return <div className="lineage-flow" role="group" aria-label="血缘流向">
    <section className="lineage-upstream" aria-label="上游来源表">
      <h4>上游来源表</h4>
      <LineageNodes edges={upstream} empty="没有可读的上游来源" onOpen={onOpen}/>
    </section>
    {upstream.length > 0 && <span className="lineage-upstream-link"><LineageConnector/></span>}
    <section className="lineage-current" aria-label="当前对象">
      <h4>当前对象</h4>
      <strong>{title}</strong>
    </section>
    {downstream.length > 0 && <span className="lineage-downstream-link"><LineageConnector/></span>}
    <section className="lineage-downstream" aria-label="下游指标与受影响资产">
      <h4>下游指标与受影响资产</h4>
      <LineageNodes edges={downstream} empty="没有可读的下游依赖" onOpen={onOpen}/>
      {more_downstream && <p className="lineage-empty">仅展示首批下游依赖。</p>}
    </section>
  </div>;
}
