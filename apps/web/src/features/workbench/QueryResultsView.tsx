import { useId, useState } from "react";
import type { QueryResults } from "../../../../../packages/contracts/generated/boundary.ts";

// 只以返回的列类型构建候选；编号不作数值指标，单位和业务含义不从数值猜测。
export function chartColumns(result: QueryResults) {
  const rows = result.rows.slice(0, 10);
  const identifier = /(^id$|_id$|编号|标识)/i;
  const dimensions = result.columns.flatMap((column, index) =>
    ["text", "string", "date", "datetime", "timestamp"].includes(column.type) && !identifier.test(column.name) && rows.some(row => row[index] !== null) ? [index] : []);
  const measures = result.columns.flatMap((column, index) => {
    const values = rows.map(row => row[index]).filter(value => value !== null);
    return ["integer", "number"].includes(column.type) && !identifier.test(column.name) && values.length > 0 && values.every(value => value.trim() !== "" && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER) ? [index] : [];
  });
  return { dimensions, measures };
}

export function QueryResultsView({ result, onShowSql }: { result: QueryResults; onShowSql: () => void }) {
  const [mode, setMode] = useState<"table" | "chart">("table");
  const [dimension, setDimension] = useState<number | null>(null);
  const [measure, setMeasure] = useState<number | null>(null);
  const chartId = useId();
  const preview = result.rows.slice(0, 10);
  const { dimensions, measures } = chartColumns(result);
  const dimensionIndex = dimensions.includes(dimension ?? -1) ? dimension! : dimensions[0];
  const measureIndex = measures.includes(measure ?? -1) ? measure! : measures[0];
  const canChart = dimensionIndex !== undefined && measureIndex !== undefined;
  const moreRows = result.rows.length > preview.length || !!result.next_cursor || result.truncated;
  const values = canChart ? preview.map(row => row[measureIndex] === null ? null : Number(row[measureIndex])) : [];
  const low = Math.min(0, ...values.filter((value): value is number => value !== null));
  const high = Math.max(0, ...values.filter((value): value is number => value !== null));
  const range = high - low || 1;
  const zero = -low / range * 100;
  return <div className="result-panel">
    {result.rows.length === 1 && !dimensions.length && <div className="result-values">{measures.map(index => <div key={index}><span>{result.columns[index].name}</span><strong>{result.rows[0][index] ?? "NULL"}</strong></div>)}</div>}
    <div className="result-toolbar">
      <div className="segmented" aria-label="结果展示"><button aria-pressed={mode === "table" || !canChart} onClick={() => setMode("table")}>表格</button><button aria-pressed={mode === "chart" && canChart} disabled={!canChart} title={canChart ? "按分类和指标查看" : "当前结果缺少适合绘图的分类与数值指标"} onClick={() => setMode("chart")}>图表</button></div>
      <div className="result-actions"><button className="text-link" onClick={onShowSql}>最终 SQL</button><a className="text-link" href={"/api/queries/" + result.query_id + "/export.csv"}>下载 CSV ↓</a></div>
    </div>
    {result.truncated && <p className="result-limit">结果已截断：下载也仅包含平台当前保存的结果。</p>}
    {!result.truncated && !result.result_complete && !result.next_cursor && <p className="result-limit">平台返回部分结果，下载仅包含当前可用的数据。</p>}
    {mode === "table" || !canChart ? <div className="table-scroll" tabIndex={0} role="region" aria-label="查询结果表格"><table><thead><tr>{result.columns.map((column, index) => <th key={index}>{column.name}</th>)}</tr></thead><tbody>{preview.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{value ?? "NULL"}</td>)}</tr>)}</tbody></table>{!preview.length && <p>查询成功，暂无符合条件的记录。</p>}</div> : <>
      <div className="chart-options"><label>分类<select aria-label="图表分类" value={dimensionIndex} onChange={event => setDimension(Number(event.target.value))}>{dimensions.map(index => <option key={index} value={index}>{result.columns[index].name}</option>)}</select></label><label>指标<select aria-label="图表指标" value={measureIndex} onChange={event => setMeasure(Number(event.target.value))}>{measures.map(index => <option key={index} value={index}>{result.columns[index].name}</option>)}</select></label></div>
      <div className="bar-chart" role="img" aria-labelledby={chartId}><p id={chartId}>{result.columns[dimensionIndex].name} · {result.columns[measureIndex].name}（字段原值）</p>{preview.map((row, index) => {
        const value = values[index];
        return <div className="chart-row" key={index}><span>{row[dimensionIndex] ?? "未填写"}</span><div className="chart-track"><span className="chart-zero" style={{ left: zero + "%" }}/>{value !== null && <i className={value < 0 ? "negative" : ""} style={{ left: (Math.min(0, value) - low) / range * 100 + "%", width: Math.abs(value) / range * 100 + "%" }}/>}</div><strong>{row[measureIndex] ?? "无数据"}</strong></div>;
      })}</div>
    </>}
    <p className="result-caption">{moreRows ? `预览前 ${preview.length} 行 · 下载可查看更多数据` : `共 ${preview.length} 行`}{mode === "chart" && canChart ? " · 与表格相同范围" : ""}</p>
  </div>;
}
