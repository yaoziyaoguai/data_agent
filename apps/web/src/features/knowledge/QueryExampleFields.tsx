import { useEffect, useState } from "react";
import type { KnowledgeObject, EvidenceRef, QueryExampleParameter } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { KnowledgePicker } from "../../shared/KnowledgePicker.tsx";
import type { Draft, TableReference } from "./semantic-structure-draft.ts";

export function TableName({ value }: { value: TableReference | undefined }) {
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

export function EvidenceReferences({ references }: { references: EvidenceRef[] }) {
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
