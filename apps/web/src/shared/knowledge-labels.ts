import type { KnowledgeObject } from "../../../../packages/contracts/generated/boundary.ts";

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
