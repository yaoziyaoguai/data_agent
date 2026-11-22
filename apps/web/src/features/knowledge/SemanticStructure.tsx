import { useId } from "react";
import type { KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { TablePicker, useColumnSuggestions } from "./StructureTablePicker.tsx";
import { QueryExampleFields } from "./QueryExampleFields.tsx";
import { reference, type Draft } from "./semantic-structure-draft.ts";
import "./semantic-structure.css";

export { structureEntryId, structureDraft, structureFromDraft, queryExampleDraft } from "./semantic-structure-draft.ts";
export { SemanticStructureView } from "./SemanticStructureView.tsx";
export { QueryExampleFields } from "./QueryExampleFields.tsx";

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
