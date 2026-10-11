import type { KnowledgeObject, KnowledgeEntry } from "../../../../packages/contracts/generated/boundary.ts";

export const knowledgeKindLabels: Record<KnowledgeObject["kind"], string> = {
  table: "数据表", field: "字段", metric: "指标", document: "业务文档", relationship: "关联关系", term: "业务术语",
};

export function knowledgeSourceLabel(object: KnowledgeObject): string {
  if (!object.source_id) return "人工录入";
  if (object.kind === "document") return "业务文档";
  if (object.source_id === "etl") return "加工 SQL";
  if (object.source_id === "schema") return "样例表结构";
  return "平台元数据";
}

export function knowledgeEntryStatus(entry: KnowledgeEntry) {
  if (entry.review_state === "needs_review") return {
    kind: "review", label: "来源变化，待复核", description: "当前内容保留，需结合变化后的来源重新核对。",
  };
  if (entry.human_override) return {
    kind: "human", label: "人工维护", description: "由维护者录入或修改；不代表业务正确性已经验证。",
  };
  if (typeof entry.suggestion.value === "string" && entry.suggestion.value.trim()) return {
    kind: "model", label: "模型整理 · 尚未人工维护", description: "根据来源整理的建议，使用时请留意其中的限制和未知内容。",
  };
  return {
    kind: "source", label: "来源资料", description: "沿用来源中的记录，尚未由维护者补充业务说明。",
  };
}
