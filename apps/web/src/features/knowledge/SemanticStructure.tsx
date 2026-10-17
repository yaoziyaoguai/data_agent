import { useEffect, useId, useRef, useState } from "react";
import type {
  KnowledgeEntry,
  KnowledgeObject,
  EvidenceRef,
  QueryExampleParameter,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { knowledgeSourceLabel } from "../../shared/knowledge-labels.ts";
import { KnowledgePicker } from "../../shared/KnowledgePicker.tsx";
import "./semantic-structure.css";

type Structure = NonNullable<KnowledgeEntry["effective_structure"]>;
type TableReference = { object_id: string; version: string };
type Draft = {
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
const reference = (object: KnowledgeObject): TableReference => ({
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

function TableName({ value }: { value: TableReference | undefined }) {
  const [name, setName] = useState("正在读取表名…");
  useEffect(() => {
    let live = true;
    if (!value) {
      setName("尚未指定");
      return;
    }
    void api(
      "KnowledgeObject",
      "/knowledge/" + encodeURIComponent(value.object_id),
    )
      .then((object) => {
        if (live)
          setName(
            object.name +
              (object.version !== value.version
                ? "（资料已改版，待重新核对）"
                : ""),
          );
      })
      .catch(() => {
        if (live) setName("关联表暂时不可读，请核对资料权限");
      });
    return () => {
      live = false;
    };
  }, [value?.object_id, value?.version]);
  return <>{name}</>;
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

function EvidenceReferences({ references }: { references: EvidenceRef[] }) {
  return (
    <ul>
      {references.map((item, index) => (
        <li key={index}>
          <TableName value={item} /> · 版本 {item.version} ·{" "}
          {item.path || "整份资料"}
        </li>
      ))}
    </ul>
  );
}

function EvidenceDependency({
  value,
  disabled,
  onChange,
  onRemove,
}: {
  value: EvidenceRef;
  disabled: boolean;
  onChange: (value: EvidenceRef) => void;
  onRemove: () => void;
}) {
  const [object, setObject] = useState<KnowledgeObject | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setObject(null);
    setError("");
    void api(
      "KnowledgeObject",
      "/knowledge/" + encodeURIComponent(value.object_id),
    )
      .then((item) => {
        if (live) setObject(item);
      })
      .catch(() => {
        if (live) setError("依赖资料暂不可读，请核对权限或移除。");
      });
    return () => {
      live = false;
    };
  }, [value.object_id]);
  return (
    <div className="semantic-rule-row">
      <span>
        {object?.name ?? "正在读取依赖…"} · 版本 {value.version}
      </span>
      <label className="form-label">
        依赖位置
        <select
          aria-label={`依赖位置 ${object?.name ?? value.object_id}`}
          value={value.path}
          disabled={disabled || !object || object.version !== value.version}
          onChange={(event) => onChange({ ...value, path: event.target.value })}
        >
          {object &&
            object.entries.map((entry) => (
              <option key={entry.entry_id} value={entry.path}>
                {entry.label}
              </option>
            ))}
        </select>
      </label>
      {object && object.version !== value.version && (
        <>
          <p className="quiet" role="status">
            资料已改版，请核对案例后采用当前版本。
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                version: object.version,
                path: object.entries.some((entry) => entry.path === value.path)
                  ? value.path
                  : (object.entries[0]?.path ?? ""),
              })
            }
          >
            采用当前版本
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="button" disabled={disabled} onClick={onRemove}>
        移除依赖
      </button>
    </div>
  );
}

function DependencyPicker({
  label,
  values,
  disabled,
  onChange,
}: {
  label: string;
  values: EvidenceRef[];
  disabled: boolean;
  onChange: (values: EvidenceRef[]) => void;
}) {
  return (
    <fieldset className="semantic-structure-wide" disabled={disabled}>
      <legend>{label}</legend>
      {values.map((value, index) => (
        <EvidenceDependency
          key={`${value.object_id}-${index}`}
          value={value}
          disabled={disabled}
          onChange={(value) =>
            onChange(values.map((old, i) => (i === index ? value : old)))
          }
          onRemove={() => onChange(values.filter((_, i) => i !== index))}
        />
      ))}
      <KnowledgePicker
        selected={[]}
        disabled={disabled || values.length >= 50}
        onAdd={(object) => {
          const path =
            object.entries.find((entry) => entry.path === "ddl")?.path ??
            object.entries[0]?.path;
          if (path !== undefined)
            onChange([
              ...values,
              { object_id: object.id, version: object.version, path },
            ]);
        }}
        onRemove={() => {}}
      />
      <p className="quiet">
        选择实际使用的表、指标或文档条目。版本与位置随案例保存；资料变化后须重新核对。
      </p>
    </fieldset>
  );
}

export function QueryExampleFields({
  draft,
  disabled,
  onChange,
}: {
  draft: Draft;
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) {
  const patch = (value: Partial<Draft>) => onChange({ ...draft, ...value });
  return (
    <div className="semantic-structure-form">
      <label className="form-label semantic-structure-wide">
        适用问题
        <textarea
          aria-label="适用问题"
          rows={3}
          value={draft.applicableQuestion}
          disabled={disabled}
          onChange={(event) =>
            patch({ applicableQuestion: event.target.value })
          }
        />
      </label>
      <label className="form-label">
        结果粒度
        <input
          aria-label="结果粒度"
          value={draft.grain}
          disabled={disabled}
          onChange={(event) => patch({ grain: event.target.value })}
        />
      </label>
      <fieldset className="semantic-structure-wide" disabled={disabled}>
        <legend>参数定义</legend>
        {draft.parameters.map((parameter, index) => (
          <div className="semantic-rule-row" key={index}>
            <label className="form-label">
              参数名称 {index + 1}
              <input
                value={parameter.name}
                onChange={(event) =>
                  patch({
                    parameters: draft.parameters.map((old, i) =>
                      i === index ? { ...old, name: event.target.value } : old,
                    ),
                  })
                }
              />
            </label>
            <label className="form-label">
              参数类型 {index + 1}
              <select
                value={parameter.type}
                onChange={(event) =>
                  patch({
                    parameters: draft.parameters.map((old, i) =>
                      i === index
                        ? {
                            ...old,
                            type: event.target
                              .value as QueryExampleParameter["type"],
                          }
                        : old,
                    ),
                  })
                }
              >
                <option value="string">文本</option>
                <option value="number">数字</option>
                <option value="integer">整数</option>
                <option value="boolean">是/否</option>
              </select>
            </label>
            <label className="form-label">
              参数含义 {index + 1}
              <input
                value={parameter.description}
                onChange={(event) =>
                  patch({
                    parameters: draft.parameters.map((old, i) =>
                      i === index
                        ? { ...old, description: event.target.value }
                        : old,
                    ),
                  })
                }
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={parameter.required}
                onChange={(event) =>
                  patch({
                    parameters: draft.parameters.map((old, i) =>
                      i === index
                        ? { ...old, required: event.target.checked }
                        : old,
                    ),
                  })
                }
              />
              必填
            </label>
            <button
              type="button"
              onClick={() =>
                patch({
                  parameters: draft.parameters.filter((_, i) => i !== index),
                })
              }
            >
              移除参数
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={disabled || draft.parameters.length >= 30}
          onClick={() =>
            patch({
              parameters: [
                ...draft.parameters,
                { name: "", type: "string", description: "", required: true },
              ],
            })
          }
        >
          添加参数
        </button>
      </fieldset>
      <label className="form-label semantic-structure-wide">
        案例 SQL
        <textarea
          aria-label="案例 SQL"
          rows={8}
          value={draft.sql}
          disabled={disabled}
          onChange={(event) => patch({ sql: event.target.value })}
        />
      </label>
      <DependencyPicker
        label="案例依赖"
        values={draft.dependencies}
        disabled={disabled}
        onChange={(dependencies) => patch({ dependencies })}
      />
      <label className="checkbox-label semantic-structure-wide">
        <input
          type="checkbox"
          checked={draft.verificationEnabled}
          disabled={disabled}
          onChange={(event) =>
            patch({ verificationEnabled: event.target.checked })
          }
        />
        我已结合依据核对口径，记录本次核对
      </label>
      {draft.verificationEnabled && (
        <>
          <label className="form-label semantic-structure-wide">
            核对说明
            <textarea
              aria-label="核对说明"
              rows={3}
              value={draft.verificationNote}
              disabled={disabled}
              onChange={(event) =>
                patch({ verificationNote: event.target.value })
              }
            />
          </label>
          <DependencyPicker
            label="核对依据"
            values={draft.verificationEvidence}
            disabled={disabled}
            onChange={(verificationEvidence) => patch({ verificationEvidence })}
          />
        </>
      )}
      <p className="quiet semantic-structure-wide">
        核对记录代表维护者的明确记录。一次运行成功只证明当时可执行；采用案例或改写
        SQL 后，仍需核对当前条件并取得本次执行授权。
      </p>
    </div>
  );
}

export function SemanticStructureView({
  value,
}: {
  value: Structure | null | undefined;
}) {
  return (
    <details className="semantic-structure">
      <summary>
        {value?.kind === "query_example"
          ? "查询案例 · 已录入"
          : value
            ? "计算规则 · 已补充"
            : "计算规则 · 尚未补充"}
      </summary>
      {!value ? (
        <p className="quiet">
          尚未补充可用于计算的规则。Agent
          使用这份说明时仍需核对粒度、口径或关联条件。
        </p>
      ) : (
        <dl className="semantic-structure-facts">
          {value.kind === "query_example" && (
            <>
              <dt>适用问题</dt>
              <dd>{value.applicable_question}</dd>
              <dt>参数</dt>
              <dd>
                {value.parameters.length
                  ? value.parameters.map((parameter) => (
                      <p key={parameter.name}>
                        <code>{parameter.name}</code> · {parameter.type} ·{" "}
                        {parameter.required ? "必填" : "可选"}：
                        {parameter.description}
                      </p>
                    ))
                  : "无参数"}
              </dd>
              <dt>结果粒度</dt>
              <dd>{value.grain}</dd>
              <dt>案例 SQL</dt>
              <dd>
                <pre>{value.sql}</pre>
              </dd>
              <dt>依赖资料</dt>
              <dd>
                <EvidenceReferences references={value.dependencies} />
              </dd>
              <dt>维护者核对记录</dt>
              <dd>
                {value.verification ? (
                  <>
                    {value.verification.note}
                    <EvidenceReferences
                      references={value.verification.evidence_refs}
                    />
                  </>
                ) : (
                  "尚未记录口径核对"
                )}
              </dd>
              <dt>采用方式</dt>
              <dd>
                Agent
                应说明沿用案例原逻辑或参考后改写的差异；执行仍需本次聊天授权。单次运行成功不代表口径已核对。
              </dd>
            </>
          )}
          {value.kind === "table" && (
            <>
              <dt>每行代表</dt>
              <dd>{value.grain ?? "尚未确认"}</dd>
              <dt>唯一键</dt>
              <dd>
                {(value.unique_keys ?? [])
                  .map((key) => key.join(" + "))
                  .join("；") || "尚未确认"}
              </dd>
              <dt>时间字段</dt>
              <dd>
                {(value.time_columns ?? [])
                  .map((item) => `${item.column}：${item.role}`)
                  .join("；") || "尚未指定"}
              </dd>
              <dt>必要过滤</dt>
              <dd>{(value.default_filters ?? []).join("；") || "未指定"}</dd>
              <dt>已知约束</dt>
              <dd>{(value.constraints ?? []).join("；") || "未指定"}</dd>
            </>
          )}
          {value.kind === "field" && (
            <>
              <dt>所属表</dt>
              <dd>
                <TableName value={value.table} />
              </dd>
              <dt>字段</dt>
              <dd>{value.column}</dd>
              <dt>单位</dt>
              <dd>{value.unit ?? "尚未确认"}</dd>
            </>
          )}
          {value.kind === "relationship" && (
            <>
              <dt>两端数据表</dt>
              <dd>
                <TableName value={value.left_table} /> →{" "}
                <TableName value={value.right_table} />
              </dd>
              <dt>关联字段</dt>
              <dd>
                {(value.join_keys ?? [])
                  .map((item) => `${item.left_column} = ${item.right_column}`)
                  .join("；")}
              </dd>
              <dt>对应关系</dt>
              <dd>
                {value.cardinality
                  ? {
                      one_to_one: "一对一",
                      one_to_many: "一对多",
                      many_to_one: "多对一",
                      many_to_many: "多对多",
                    }[value.cardinality]
                  : "尚未确认"}
              </dd>
              <dt>适用范围</dt>
              <dd>{value.scope}</dd>
            </>
          )}
          {value.kind === "metric" && (
            <>
              <dt>使用的表</dt>
              <dd>
                <TableName value={value.table} />
              </dd>
              <dt>计算表达式</dt>
              <dd>
                <code>{value.expression}</code>
              </dd>
              <dt>输入粒度</dt>
              <dd>{value.input_grain}</dd>
              <dt>时间字段</dt>
              <dd>{value.time_column ?? "尚未确认"}</dd>
              <dt>输出单位</dt>
              <dd>{value.unit ?? "尚未确认"}</dd>
              <dt>必要过滤</dt>
              <dd>{(value.required_filters ?? []).join("；") || "未指定"}</dd>
              <dt>可用维度</dt>
              <dd>{(value.dimensions ?? []).join("、") || "未指定"}</dd>
            </>
          )}
        </dl>
      )}
    </details>
  );
}

function TablePicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: TableReference | null;
  disabled: boolean;
  onChange: (value: TableReference | null) => void;
}) {
  const [selected, setSelected] = useState<KnowledgeObject | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<KnowledgeObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setSelected(null);
    setError("");
    if (value)
      void api(
        "KnowledgeObject",
        "/knowledge/" + encodeURIComponent(value.object_id),
      )
        .then((object) => {
          if (live) setSelected(object);
        })
        .catch(() => {
          if (live) setError("暂时无法读取已选表，请重新选择。");
        });
    return () => {
      live = false;
    };
  }, [value?.object_id]);
  useEffect(() => {
    const generation = ++searchGeneration.current;
    let live = true;
    setItems([]);
    setNextAfter(null);
    setLoadingMore(false);
    setLoading(Boolean(query.trim()));
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      void api(
        "KnowledgeList",
        "/knowledge?directory=all&directory_view=grouped&state=enabled&q=" +
          encodeURIComponent(query.trim()),
      )
        .then((result) => {
          if (live && generation === searchGeneration.current) {
            setItems(
              result.objects.filter((object) => object.kind === "table"),
            );
            setNextAfter(result.next_after_id);
          }
        })
        .catch(() => {
          if (live) setError("查找表失败，请重试。");
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
      ++searchGeneration.current;
    };
  }, [query]);
  const loadMore = async () => {
    if (!nextAfter || loadingMore || disabled) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    setError("");
    try {
      const result = await api(
        "KnowledgeList",
        "/knowledge?directory=all&directory_view=grouped&state=enabled&q=" +
          encodeURIComponent(query.trim()) +
          "&after_id=" +
          encodeURIComponent(nextAfter),
      );
      if (generation !== searchGeneration.current) return;
      setItems((old) => {
        const current = new Map(old.map((object) => [object.id, object]));
        for (const object of result.objects.filter(
          (object) => object.kind === "table",
        ))
          current.set(object.id, object);
        return [...current.values()];
      });
      setNextAfter(result.next_after_id);
    } catch {
      if (generation === searchGeneration.current)
        setError("后续结果暂时无法读取，请继续查找重试。");
    } finally {
      if (generation === searchGeneration.current) setLoadingMore(false);
    }
  };
  return (
    <div className="semantic-table-picker">
      <label className="form-label">
        {label}
        <input
          value={query}
          disabled={disabled}
          placeholder={selected ? selected.name : "输入表名查找"}
          onChange={(event) => {
            setError("");
            setQuery(event.target.value);
          }}
        />
      </label>
      {value && (
        <p className="quiet">
          已选择：
          {selected
            ? `${selected.name} · ${knowledgeSourceLabel(selected)}`
            : "正在读取表名…"}{" "}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            重新选择
          </button>
        </p>
      )}
      {value && selected && selected.version !== value.version && (
        <p className="quiet">
          这张表的定义已变化。
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(reference(selected))}
          >
            采用当前表定义
          </button>
        </p>
      )}
      {loading && <p role="status">正在查找表…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loading && query.trim() && !items.length && !error && (
        <p className="quiet">
          {nextAfter
            ? "当前已读取的结果中没有匹配的表，可继续查找。"
            : "没有匹配的表，请换个名称。"}
        </p>
      )}
      {items.map((object) => (
        <button
          type="button"
          key={object.id}
          aria-label={`${object.name} · ${knowledgeSourceLabel(object)}`}
          disabled={disabled}
          onClick={() => {
            setSelected(object);
            onChange(reference(object));
            setQuery("");
          }}
        >
          {object.name}
          <small>{knowledgeSourceLabel(object)}</small>
        </button>
      ))}
      {nextAfter && (
        <button
          type="button"
          disabled={disabled || loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "正在继续查找…" : "继续查找表"}
        </button>
      )}
    </div>
  );
}

function useColumnSuggestions(value: TableReference | null) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setNames([]);
    if (!value) return;
    // 这里只提供当前可读字段的输入建议；完整列校验仍在服务端执行。
    void api(
      "KnowledgeList",
      "/knowledge?related_id=" + encodeURIComponent(value.object_id),
    )
      .then((result) => {
        if (live)
          setNames([
            ...new Set(
              result.objects
                .filter((object) => object.kind === "field")
                .map((object) => object.name.split(".").at(-1) ?? object.name),
            ),
          ]);
      })
      .catch(() => {
        if (live) setNames([]);
      });
    return () => {
      live = false;
    };
  }, [value?.object_id, value?.version]);
  return names;
}

export function SemanticStructureEditor({
  object,
  draft,
  confirmed,
  disabled,
  hadStructure,
  onChange,
  onConfirm,
}: {
  object: KnowledgeObject;
  draft: Draft;
  confirmed: boolean;
  disabled: boolean;
  hadStructure: boolean;
  onChange: (draft: Draft) => void;
  onConfirm: (confirmed: boolean) => void;
}) {
  const columnList = useId(),
    leftColumns = useId(),
    rightColumns = useId();
  const names = useColumnSuggestions(
    draft.kind === "table"
      ? reference(object)
      : draft.kind === "query_example"
        ? null
        : draft.table,
  );
  const leftNames = useColumnSuggestions(draft.leftTable),
    rightNames = useColumnSuggestions(draft.rightTable);
  const patch = (value: Partial<Draft>) => onChange({ ...draft, ...value });
  if (draft.kind === "query_example")
    return (
      <>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={disabled}
            onChange={(event) => onConfirm(event.target.checked)}
          />
          同时保存查询案例结构
        </label>
        {!confirmed && (
          <p className="quiet">
            保存说明时，原案例结构将停用。请一同核对适用问题、参数、SQL
            和依赖后保存。
          </p>
        )}
        {confirmed && (
          <QueryExampleFields
            draft={draft}
            disabled={disabled}
            onChange={onChange}
          />
        )}
      </>
    );
  const text = (
    label: string,
    key:
      | "grain"
      | "keys"
      | "filters"
      | "constraints"
      | "column"
      | "unit"
      | "scope"
      | "expression"
      | "inputGrain"
      | "timeColumn"
      | "dimensions",
    multiline = false,
    hint?: string,
  ) => (
    <label className="form-label">
      {label}
      {multiline ? (
        <textarea
          aria-label={label}
          aria-describedby={hint ? `${columnList}-${key}-hint` : undefined}
          rows={3}
          value={draft[key]}
          disabled={disabled}
          onChange={(event) => patch({ [key]: event.target.value })}
        />
      ) : (
        <input
          aria-label={label}
          aria-describedby={hint ? `${columnList}-${key}-hint` : undefined}
          list={
            key === "column" || key === "timeColumn" ? columnList : undefined
          }
          value={draft[key]}
          disabled={disabled}
          onChange={(event) => patch({ [key]: event.target.value })}
        />
      )}{" "}
      {hint && <small id={`${columnList}-${key}-hint`}>{hint}</small>}
    </label>
  );
  return (
    <>
      {hadStructure && !confirmed && (
        <p className="quiet" role="status">
          已有计算规则。请一同核对后保存；只保存说明时，原规则将暂时停用。
        </p>
      )}
      <details className="semantic-structure">
        <summary>补充或核对计算规则</summary>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={disabled}
            onChange={(event) => onConfirm(event.target.checked)}
          />
          同时保存计算规则
        </label>
        <p className="quiet">
          {hadStructure
            ? "只改说明时，原计算规则会暂时停用。确认说明和规则一致后，可以一同保存。"
            : "这些信息用于核对计算。暂时没有依据时，可以先只保存说明。"}
        </p>
        {confirmed && (
          <div className="semantic-structure-form">
            <datalist id={columnList}>
              {names.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <datalist id={leftColumns}>
              {leftNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <datalist id={rightColumns}>
              {rightNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {draft.kind === "table" && (
              <>
                {text(
                  "每行代表什么",
                  "grain",
                  false,
                  "例如：一张订单中的一个商品行。",
                )}
                {text(
                  "唯一键（每行一组）",
                  "keys",
                  true,
                  "同一组内用逗号分隔字段，例如：order_id, line_id。尚未确认时留空。",
                )}
                <fieldset className="semantic-structure-wide">
                  <legend>时间字段与用途</legend>
                  {draft.timeColumns.map((item, index) => (
                    <div className="semantic-rule-row" key={index}>
                      <label className="form-label">
                        时间字段 {index + 1}
                        <input
                          list={columnList}
                          value={item.column}
                          disabled={disabled}
                          onChange={(event) =>
                            patch({
                              timeColumns: draft.timeColumns.map((row, i) =>
                                i === index
                                  ? { ...row, column: event.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="form-label">
                        时间用途 {index + 1}
                        <input
                          value={item.role}
                          disabled={disabled}
                          placeholder="例如：首笔成功付款时间"
                          onChange={(event) =>
                            patch({
                              timeColumns: draft.timeColumns.map((row, i) =>
                                i === index
                                  ? { ...row, role: event.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={`移除时间字段 ${index + 1}`}
                        onClick={() =>
                          patch({
                            timeColumns: draft.timeColumns.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      patch({
                        timeColumns: [
                          ...draft.timeColumns,
                          { column: "", role: "" },
                        ],
                      })
                    }
                  >
                    添加时间字段
                  </button>
                </fieldset>
                {text("必要过滤（每行一条）", "filters", true)}
                {text("已知约束（每行一条）", "constraints", true)}
              </>
            )}
            {draft.kind === "field" && (
              <>
                <TablePicker
                  label="所属表"
                  value={draft.table}
                  disabled={disabled}
                  onChange={(table) => patch({ table })}
                />
                {text("字段名", "column")}
                {text(
                  "单位",
                  "unit",
                  false,
                  "例如：分、元、秒。尚未确认时留空。",
                )}
              </>
            )}
            {draft.kind === "relationship" && (
              <>
                <TablePicker
                  label="左侧表"
                  value={draft.leftTable}
                  disabled={disabled}
                  onChange={(leftTable) => patch({ leftTable })}
                />
                <TablePicker
                  label="右侧表"
                  value={draft.rightTable}
                  disabled={disabled}
                  onChange={(rightTable) => patch({ rightTable })}
                />
                <fieldset className="semantic-structure-wide">
                  <legend>关联字段</legend>
                  {draft.joinKeys.map((item, index) => (
                    <div className="semantic-rule-row" key={index}>
                      <label className="form-label">
                        左侧字段 {index + 1}
                        <input
                          list={leftColumns}
                          value={item.left_column}
                          disabled={disabled}
                          onChange={(event) =>
                            patch({
                              joinKeys: draft.joinKeys.map((row, i) =>
                                i === index
                                  ? { ...row, left_column: event.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="form-label">
                        右侧字段 {index + 1}
                        <input
                          list={rightColumns}
                          value={item.right_column}
                          disabled={disabled}
                          onChange={(event) =>
                            patch({
                              joinKeys: draft.joinKeys.map((row, i) =>
                                i === index
                                  ? { ...row, right_column: event.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={`移除关联字段 ${index + 1}`}
                        onClick={() =>
                          patch({
                            joinKeys: draft.joinKeys.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      patch({
                        joinKeys: [
                          ...draft.joinKeys,
                          { left_column: "", right_column: "" },
                        ],
                      })
                    }
                  >
                    添加关联字段
                  </button>
                </fieldset>
                <label className="form-label">
                  对应关系
                  <select
                    value={draft.cardinality}
                    disabled={disabled}
                    onChange={(event) =>
                      patch({
                        cardinality: event.target.value as Draft["cardinality"],
                      })
                    }
                  >
                    <option value="">请根据业务选择</option>
                    <option value="one_to_one">一对一</option>
                    <option value="one_to_many">一对多</option>
                    <option value="many_to_one">多对一</option>
                    <option value="many_to_many">多对多</option>
                  </select>
                </label>
                {text("适用范围", "scope", true)}
              </>
            )}
            {draft.kind === "metric" && (
              <>
                <TablePicker
                  label="指标使用的表"
                  value={draft.table}
                  disabled={disabled}
                  onChange={(table) => patch({ table })}
                />
                {text("输入粒度", "inputGrain")}
                {text(
                  "计算表达式",
                  "expression",
                  true,
                  "例如：SUM(paid_amount_cents - refunded_amount_cents)。",
                )}
                {text(
                  "时间字段",
                  "timeColumn",
                  false,
                  "没有确认的时间依据时留空。",
                )}
                {text("输出单位", "unit")}
                {text("必要过滤（每行一条）", "filters", true)}
                {text(
                  "可用维度",
                  "dimensions",
                  false,
                  "用逗号分隔字段，例如：channel, region。",
                )}
              </>
            )}
          </div>
        )}
      </details>
    </>
  );
}
