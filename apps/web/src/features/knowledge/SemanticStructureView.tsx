import { TableName, EvidenceReferences } from "./QueryExampleFields.tsx";
import type { Structure } from "./semantic-structure-draft.ts";
import "./semantic-structure.css";

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
