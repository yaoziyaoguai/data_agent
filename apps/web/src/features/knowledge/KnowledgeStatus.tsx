import type { KnowledgeEntry } from "../../../../../packages/contracts/generated/boundary.ts";
import { knowledgeEntryStatus } from "../../shared/knowledge-labels.ts";

export function KnowledgeStatus({ entries }: { entries: KnowledgeEntry[] }) {
  const states = [...new Map(entries.map(entry => {
    const status = knowledgeEntryStatus(entry);
    return [status.kind, status];
  })).values()];
  return <span className="knowledge-status" aria-label="内容维护状态">{states.map(state =>
    <span key={state.kind} className={state.kind === "review" ? "review-mark" : "quiet"} title={state.description}>{state.label}</span>,
  )}</span>;
}
