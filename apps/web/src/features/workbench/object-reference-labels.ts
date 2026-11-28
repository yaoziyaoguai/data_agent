import type { QueryView, Snapshot } from "../../../../../packages/contracts/generated/boundary.ts";
import type { ObjectReferenceLabels } from "../../shared/markdown-object-references.ts";

type ObjectReference = { id: string; kind: string; name: string };
function shortName(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/「/g, "“")
    .replace(/」/g, "”");
  if (!normalized) return "";
  const firstClause = normalized.split(/[。！？；\n]/)[0]?.trim() || normalized;
  const chars = [...firstClause];
  if (chars.length <= 36 && firstClause.length === normalized.length) return firstClause;
  let slice = chars.slice(0, Math.min(chars.length, 36)).join("");
  const pairs: [string, string][] = [["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"], ["“", "”"]];
  for (const [open, close] of pairs) {
    const lastOpen = slice.lastIndexOf(open);
    if (lastOpen > 6 && slice.indexOf(close, lastOpen) < 0) slice = slice.slice(0, lastOpen);
  }
  const comma = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf("、"), slice.lastIndexOf(", "));
  if (chars.length > 36 && comma >= 12) slice = slice.slice(0, comma);
  slice = slice.replace(/[，、：:；;,.(\[（【“\s]+$/u, "");
  return slice + (slice.length < normalized.length ? "…" : "");
}

// 只使用当前有权快照与事件中的身份，不从助手正文反推对象或请求额外私人资料。
export function objectReferenceLabels(snapshot: Snapshot | null, queries: QueryView[]): ObjectReferenceLabels {
  const references = new Map<string, ObjectReference>();
  const tasks = new Map(snapshot?.tasks.map(task => [task.id, task]));
  const goal = (id: unknown) => {
    const task = typeof id === "string" ? tasks.get(id) : undefined;
    return task && !task.text_unavailable ? shortName(task.goal) : "";
  };
  const add = (id: unknown, kind: string, name = "") => {
    if (typeof id === "string" && id) references.set(id, { id, kind, name });
  };
  for (const task of snapshot?.tasks ?? []) {
    add(task.id, "任务", goal(task.id));
    // P-04：分析依据由后台自动绑定，不在对话里作为独立实体露出；报告仍可见。
    if (task.report_ref) add(task.report_ref.report_id, "分析报告", goal(task.id));
  }
  for (const query of queries) add(query.id, "查询", query.text_unavailable ? "" : shortName(query.summary));
  for (const event of snapshot?.events ?? []) {
    const payload = event.payload;
    if (event.type === "analysis_report_saved") add(payload.report_id, "分析报告", goal(payload.task_id));
    else if (event.type === "skill_draft_prepared") add(payload.draft_id, "方法草稿", goal(payload.task_id));
    else if (event.type === "memory_saved" || event.type === "memory_disabled") add(payload.asset_id, "个人记忆");
  }
  const groups = new Map<string, ObjectReference[]>();
  for (const reference of references.values()) {
    const label = reference.kind + (reference.name ? `「${reference.name}」` : "");
    const group = groups.get(label) ?? [];
    group.push(reference);
    groups.set(label, group);
  }
  const labels: Record<string, string> = {};
  for (const [label, group] of groups) {
    // 同名对象按稳定身份排序区分，快照刷新不会因列表顺序变化换称呼。
    group.sort((left, right) => left.id.localeCompare(right.id));
    group.forEach((reference, index) => { labels[reference.id] = label + (group.length > 1 ? `〔${index + 1}〕` : ""); });
  }
  return labels;
}
