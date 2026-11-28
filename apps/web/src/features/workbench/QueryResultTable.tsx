import type { QueryResults } from "../../../../../packages/contracts/generated/boundary.ts";
import "./query-results.css";

const identifier = /(^id$|_id$|编号|标识)/i;
export const isResultIdentifier = (name: string) => identifier.test(name);

export function QueryResultTable({ columns, rows }: Pick<QueryResults, "columns" | "rows">) {
  return <div className="table-scroll" tabIndex={0} role="region" aria-label="查询结果表格">
    <table>
      <thead><tr>{columns.map((column, index) => {
        const meaning = [column.display_label, column.unit].filter(Boolean).join(" · ");
        const numeric = ["integer", "number"].includes(column.type) && !isResultIdentifier(column.name);
        const classes = [meaning && "annotated", numeric && "numeric"].filter(Boolean).join(" ");
        return <th key={index} scope="col" className={classes || undefined}>
          {column.name}{meaning && <small className="column-meaning">{meaning}</small>}
        </th>;
      })}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((value, cell) => {
        const column = columns[cell];
        const numeric = ["integer", "number"].includes(column.type) && !isResultIdentifier(column.name);
        return <td key={cell} className={numeric ? "numeric" : undefined}>{value ?? "NULL"}</td>;
      })}</tr>)}</tbody>
    </table>
    {!rows.length && <p>查询成功，暂无符合条件的记录。</p>}
  </div>;
}

export function QueryColumnStatistics({ columns, statistics }: Pick<QueryResults, "columns" | "statistics">) {
  if (!statistics) return null;
  const scope = statistics.scope === "complete_result" ? "全部结果" : "本页";
  return <details className="query-column-statistics">
    <summary>列统计 · {scope} {statistics.row_count} 行</summary>
    <div className="query-stats-scroll" role="region" aria-label="查询列统计" tabIndex={0}>
      <ul>
        {statistics.columns.map(column => <li key={column.column_index}>
          <strong>{columns[column.column_index].display_label ?? column.column_name}</strong>
          <dl>
            <div><dt>最小</dt><dd>{column.min ?? "—"}</dd></div>
            <div><dt>最大</dt><dd>{column.max ?? "—"}</dd></div>
            <div><dt>空值</dt><dd>{column.null_count}</dd></div>
            <div><dt>不同值</dt><dd>{column.distinct_count}</dd></div>
          </dl>
        </li>)}
      </ul>
    </div>
  </details>;
}

export function QueryCsvDownload({ queryId }: { queryId: string }) {
  return <a className="text-link" download href={"/api/queries/" + encodeURIComponent(queryId) + "/export.csv"}>下载 CSV ↓</a>;
}
