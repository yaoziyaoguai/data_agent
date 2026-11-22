import type { KnowledgeEntry, KnowledgeObject, EvidenceRef, QueryExampleParameter } from "../../../../../packages/contracts/generated/boundary.ts";

export type Structure = NonNullable<KnowledgeEntry["effective_structure"]>;
export type TableReference = { object_id: string; version: string };
export type Draft = {
  kind: Structure["kind"];
  grain: string;
  keys: string;
  timeColumns: { column: string; role: string }[];
  filters: string;
  constraints: string;
  table: TableReference | null;
  column: string;
  unit: string;
  leftTable: TableReference | null;
  rightTable: TableReference | null;
  joinKeys: { left_column: string; right_column: string }[];
  cardinality:
    "" | "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
  scope: string;
  expression: string;
  inputGrain: string;
  timeColumn: string;
  dimensions: string;
  applicableQuestion: string;
  parameters: QueryExampleParameter[];
  sql: string;
  dependencies: EvidenceRef[];
  verificationEnabled: boolean;
  verificationNote: string;
  verificationEvidence: EvidenceRef[];
};

const columns = (value: string) =>
  value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
const lines = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
export const reference = (object: KnowledgeObject): TableReference => ({
  object_id: object.id,
  version: object.version,
});

export function structureEntryId(object: KnowledgeObject) {
  const existing = object.entries.find(
    (entry) =>
      entry.effective_structure ||
      entry.human_override?.structured_value ||
      entry.suggestion.structured_value ||
      entry.source_facts.structured_value,
  );
  if (existing) return existing.entry_id;
  const choices = (
    {
      table: ["description", "grain"],
      field: ["unit", "meaning"],
      relationship: ["join"],
      metric: ["sql", "body", "definition"],
      query_example: ["body"],
    } as Record<string, string[]>
  )[object.kind];
  return choices?.find((path) =>
    object.entries.some((entry) => entry.path === path),
  );
}

export function structureDraft(
  object: KnowledgeObject,
  entry: KnowledgeEntry,
  objects: KnowledgeObject[],
): Draft {
  const value = entry.effective_structure;
  const kind =
    value?.kind ??
    (["table", "field", "relationship", "metric", "query_example"].includes(
      object.kind,
    )
      ? object.kind
      : null);
  if (
    kind !== "table" &&
    kind !== "field" &&
    kind !== "relationship" &&
    kind !== "metric" &&
    kind !== "query_example"
  )
    throw new Error("这类内容不支持计算规则。");
  const parent = objects.find(
    (item) => item.kind === "table" && object.related_ids.includes(item.id),
  );
  const draft: Draft = {
    kind,
    grain: "",
    keys: "",
    timeColumns: [],
    filters: "",
    constraints: "",
    table: parent ? reference(parent) : null,
    column: object.name.split(".").at(-1) ?? "",
    unit: "",
    leftTable: null,
    rightTable: null,
    joinKeys: [],
    cardinality: "",
    scope: "",
    expression: "",
    inputGrain: "",
    timeColumn: "",
    dimensions: "",
    applicableQuestion: "",
    parameters: [],
    sql: "",
    dependencies: [],
    verificationEnabled: false,
    verificationNote: "",
    verificationEvidence: [],
  };
  if (!value) return draft;
  if (value.kind === "query_example")
    return {
      ...draft,
      applicableQuestion: value.applicable_question,
      parameters: value.parameters,
      sql: value.sql,
      grain: value.grain,
      dependencies: value.dependencies,
      verificationEnabled: value.verification !== null,
      verificationNote: value.verification?.note ?? "",
      verificationEvidence: value.verification?.evidence_refs ?? [],
    };
  if (value.kind === "table")
    return {
      ...draft,
      grain: value.grain ?? "",
      keys: (value.unique_keys ?? []).map((key) => key.join(", ")).join("\n"),
      timeColumns: value.time_columns ?? [],
      filters: (value.default_filters ?? []).join("\n"),
      constraints: (value.constraints ?? []).join("\n"),
    };
  if (value.kind === "field")
    return {
      ...draft,
      table: value.table ?? null,
      column: value.column ?? "",
      unit: value.unit ?? "",
    };
  if (value.kind === "relationship")
    return {
      ...draft,
      leftTable: value.left_table ?? null,
      rightTable: value.right_table ?? null,
      joinKeys: value.join_keys ?? [],
      cardinality: value.cardinality ?? "",
      scope: value.scope ?? "",
    };
  return {
    ...draft,
    table: value.table ?? null,
    expression: value.expression ?? "",
    inputGrain: value.input_grain ?? "",
    timeColumn: value.time_column ?? "",
    unit: value.unit ?? "",
    filters: (value.required_filters ?? []).join("\n"),
    dimensions: (value.dimensions ?? []).join(", "),
  };
}

export function structureFromDraft(draft: Draft): Structure {
  if (draft.kind === "query_example") {
    if (
      !draft.applicableQuestion.trim() ||
      !draft.sql.trim() ||
      !draft.grain.trim() ||
      !draft.dependencies.length
    )
      throw new Error("请补充适用问题、SQL、结果粒度和依赖资料。");
    if (
      draft.parameters.some(
        (parameter) => !parameter.name.trim() || !parameter.description.trim(),
      )
    )
      throw new Error("请补充每个参数的名称和含义，或移除未完成的参数。");
    if (
      draft.verificationEnabled &&
      (!draft.verificationNote.trim() || !draft.verificationEvidence.length)
    )
      throw new Error("记录核对时，请填写核对说明并选择依据。");
    const [firstDependency, ...otherDependencies] = draft.dependencies;
    const [firstEvidence, ...otherEvidence] = draft.verificationEvidence;
    return {
      kind: "query_example",
      applicable_question: draft.applicableQuestion.trim(),
      parameters: draft.parameters.map((parameter) => ({
        ...parameter,
        name: parameter.name.trim(),
        description: parameter.description.trim(),
      })),
      sql: draft.sql.trim(),
      grain: draft.grain.trim(),
      dependencies: [firstDependency, ...otherDependencies],
      verification: draft.verificationEnabled
        ? {
            note: draft.verificationNote.trim(),
            evidence_refs: [firstEvidence, ...otherEvidence],
          }
        : null,
    };
  }
  if (draft.kind === "table") {
    if (!draft.grain.trim()) throw new Error("请补充每行代表什么。");
    if (
      draft.timeColumns.some((item) => !item.column.trim() || !item.role.trim())
    )
      throw new Error("请为每个时间字段补充字段名和用途，或移除未完成的行。");
    const uniqueKeys = lines(draft.keys).map(
      (line): Extract<Structure, { kind: "table" }>["unique_keys"][number] => {
        const [first, ...rest] = columns(line);
        if (!first) throw new Error("唯一键中需要实际字段名。");
        return [first, ...rest];
      },
    );
    return {
      kind: "table",
      grain: draft.grain.trim(),
      unique_keys: uniqueKeys,
      time_columns: draft.timeColumns.map((item) => ({
        column: item.column.trim(),
        role: item.role.trim(),
      })),
      default_filters: lines(draft.filters),
      constraints: lines(draft.constraints),
    };
  }
  if (draft.kind === "field") {
    if (!draft.table || !draft.column.trim())
      throw new Error("请选择所属表并填写字段名。");
    return {
      kind: "field",
      table: draft.table,
      column: draft.column.trim(),
      unit: draft.unit.trim() || null,
    };
  }
  if (draft.kind === "relationship") {
    if (
      !draft.leftTable ||
      !draft.rightTable ||
      !draft.cardinality ||
      !draft.joinKeys.length ||
      draft.joinKeys.some(
        (item) => !item.left_column.trim() || !item.right_column.trim(),
      ) ||
      !draft.scope.trim()
    )
      throw new Error("请补齐两张表、关联字段、对应关系和适用范围。");
    const [first, ...rest] = draft.joinKeys.map((item) => ({
      left_column: item.left_column.trim(),
      right_column: item.right_column.trim(),
    }));
    return {
      kind: "relationship",
      left_table: draft.leftTable,
      right_table: draft.rightTable,
      join_keys: [first, ...rest],
      cardinality: draft.cardinality,
      scope: draft.scope.trim(),
    };
  }
  if (!draft.table || !draft.expression.trim() || !draft.inputGrain.trim())
    throw new Error("请选择指标使用的表，并补充计算表达式和输入粒度。");
  return {
    kind: "metric",
    table: draft.table,
    expression: draft.expression.trim(),
    input_grain: draft.inputGrain.trim(),
    time_column: draft.timeColumn.trim() || null,
    unit: draft.unit.trim() || null,
    required_filters: lines(draft.filters),
    dimensions: columns(draft.dimensions),
  };
}

export function queryExampleDraft(): Draft {
  return {
    kind: "query_example",
    grain: "",
    keys: "",
    timeColumns: [],
    filters: "",
    constraints: "",
    table: null,
    column: "",
    unit: "",
    leftTable: null,
    rightTable: null,
    joinKeys: [],
    cardinality: "",
    scope: "",
    expression: "",
    inputGrain: "",
    timeColumn: "",
    dimensions: "",
    applicableQuestion: "",
    parameters: [],
    sql: "",
    dependencies: [],
    verificationEnabled: false,
    verificationNote: "",
    verificationEvidence: [],
  };
}
