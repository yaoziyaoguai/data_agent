import { useEffect, useId, useRef, useState } from "react";
import type { AnalysisReportRef, AnalysisReportView, AnalysisReportChart, Conditions, QueryResults } from "../../../../../packages/contracts/generated/boundary.ts";
import { api, ApiError } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
import { decimalChartScale } from "./analysis-report-chart.ts";
import "./analysis-report.css";

export function AnalysisReport({ reference, currentConditionVersion, onClose, onQuery, onEvidence }: {
  reference: AnalysisReportRef;
  currentConditionVersion?: string;
  onClose: () => void;
  onQuery: (queryId: string) => void;
  onEvidence: (id: string, summary?: string, version?: string) => void;
}) {
  const [view, setView] = useState<AnalysisReportView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const changed = currentConditionVersion !== undefined && currentConditionVersion !== reference.condition_version;
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const request = ++generation.current;
      setView(null); setError(""); setLoading(true);
      try {
        const next = await api("AnalysisReportView", "/conversations/" + reference.conversation_id + "/tasks/" + reference.task_id + "/report");
        if (!mounted || request !== generation.current) return;
        if (next.status === "available" && (next.reference.report_id !== reference.report_id || next.reference.task_id !== reference.task_id
          || next.reference.conversation_id !== reference.conversation_id || next.reference.condition_version !== reference.condition_version
          || BigInt(next.reference.version) < BigInt(reference.version))) throw new Error("报告引用已变化，请返回对话重新打开。");
        setView(next);
      } catch (failure) {
        if (mounted && request === generation.current) setError(failure instanceof ApiError && ["forbidden", "not_available"].includes(failure.code)
          ? "这份报告目前不可访问，请返回对话核对。" : "暂时无法核对报告与数据依据，请重试。");
      } finally { if (mounted && request === generation.current) setLoading(false); }
    };
    const wake = () => { if (!document.hidden) void load(); };
    void load();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => { mounted = false; ++generation.current; window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
  }, [reference.report_id, reference.version, reference.conversation_id, reference.task_id, reference.condition_version, currentConditionVersion, retry]);
  const available = !changed && view?.status === "available" && view.reference.report_id === reference.report_id
    && view.reference.condition_version === reference.condition_version && BigInt(view.reference.version) >= BigInt(reference.version) ? view : null;
  return <Modal title="分析报告" className="analysis-report-dialog" closeLabel="返回对话" onClose={onClose}
    footer={<button className="primary" onClick={onClose}>返回对话</button>}>
    {changed || view?.status === "condition_changed" ? <div className="report-state" role="status"><h3>分析条件已更新</h3><p>这份报告采用的是此前条件。请返回对话，核对新的分析结果后再整理报告。</p></div>
      : view?.status === "sources_unavailable" ? <div className="report-state" role="status"><h3>报告依据暂不可用</h3><p>报告依赖的结果或资料已过期或不可读取。请返回对话重新核对；需要重新查询时，通过聊天提出执行要求。</p></div>
        : loading ? <p className="report-state" role="status">正在核对报告与数据依据…</p>
          : error ? <div className="report-state" role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>重新读取报告</button></div>
            : available ? <article className="analysis-report-body">
              <header className="report-heading"><h3>{available.report.title}</h3><p>整理于 <time dateTime={available.report.created_at}>{new Date(available.report.created_at).toLocaleString("zh-CN", { hour12: false })}</time></p></header>
              <section className="report-scope" aria-label="分析范围"><h4>分析范围与来源条件</h4>{available.report.evidence.map((evidence, index) =>
                <section key={evidence.reference.evidence_id} id={"report-source-" + evidence.reference.evidence_id} className="report-source" aria-label={"来源 " + (index + 1)}>
                  <h5>来源 {index + 1}</h5><p>{evidence.data_range}</p><ReportConditions conditions={evidence.conditions} />
                  <details className="report-evidence"><summary>核对来源归属</summary><dl className="report-conditions"><div><dt>分析任务</dt><dd>{evidence.reference.task_id}</dd></div><div><dt>条件版本</dt><dd>{evidence.reference.condition_version}</dd></div></dl></details>
                </section>)}</section>
              <section aria-label="分析结论" className="report-findings"><h4>主要结论</h4>{available.report.evidence.flatMap((evidence, sourceIndex) => evidence.findings.map((finding, index) =>
                <section key={evidence.reference.evidence_id + ":" + index} className="report-finding">
                  <p className="report-source-label">采用来源 {sourceIndex + 1} 的条件</p><MarkdownContent text={finding.text} />
                  {!!finding.figures.length && <dl className="report-figures">{finding.figures.map((figure, figureIndex) => <div key={figureIndex}><dt>{figure.label}</dt><dd>{figure.value === null ? "暂无数值" : String(figure.value)}</dd></div>)}</dl>}
                  {!!finding.limitations.length && <div className="report-limits"><strong>解读范围</strong><ul>{finding.limitations.map((limit, limitIndex) => <li key={limitIndex}>{limit}</li>)}</ul></div>}
                  {(finding.calculation || finding.query_refs.length || finding.knowledge_refs.length) && <details className="report-evidence"><summary>核对计算与口径依据</summary>
                    {finding.calculation && <p>{finding.calculation}</p>}
                    {!!finding.query_refs.length && <div className="report-query-links">{finding.query_refs.map((query, queryIndex) => <button className="text-link" key={query.query_id} onClick={() => onQuery(query.query_id)}>查看计算查询 {queryIndex + 1}</button>)}</div>}
                    {!!finding.knowledge_refs.length && <div className="evidence-row">{finding.knowledge_refs.map(ref => <KnowledgeReference key={ref.object_id + ":" + ref.path} id={ref.object_id} path={ref.path} onOpen={id => onEvidence(id, available.report.title, ref.version)} />)}</div>}
                  </details>}
                </section>))}</section>
              {!!available.report.charts.length && <section className="report-charts" aria-label="分析图表"><h4>图表与数据</h4>{available.report.charts.map((chart, index) => {
                const result = available.chart_results.find(result => result.query_id === chart.query_id && result.result_ref === chart.result_ref);
                const sourceLabels = available.report.evidence.flatMap((evidence, sourceIndex) => evidence.findings.some(finding => finding.query_refs.some(query => query.query_id === chart.query_id && query.result_ref === chart.result_ref)) ? ["来源 " + (sourceIndex + 1)] : []);
                return result ? <ReportChart key={index} chart={chart} result={result} sourceLabels={sourceLabels} /> : <p key={index} className="report-state" role="status">该图表的数据暂不可用，请返回对话核对。</p>;
              })}</section>}
            </article> : null}
  </Modal>;
}

function ReportConditions({ conditions }: { conditions: Conditions }) {
  const time = (value: string) => {
    try { return new Intl.DateTimeFormat("zh-CN", { timeZone: conditions.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
    catch { return value; }
  };
  const channel = conditions.channel && ({ web: "网站", app: "应用", store: "门店" } as const)[conditions.channel];
  return <dl className="report-conditions" aria-label="实际采用条件">
    {conditions.time_start && <div><dt>开始时间（含）</dt><dd><time dateTime={conditions.time_start} title={conditions.time_start}>{time(conditions.time_start)}</time></dd></div>}
    {conditions.time_end && <div><dt>结束时间（不含）</dt><dd><time dateTime={conditions.time_end} title={conditions.time_end}>{time(conditions.time_end)}</time></dd></div>}
    {conditions.timezone && <div><dt>时区</dt><dd>{conditions.timezone}</dd></div>}
    {conditions.metric && <div><dt>指标</dt><dd>{conditions.metric}</dd></div>}
    {channel && <div><dt>渠道</dt><dd>{channel}</dd></div>}
    {!!conditions.group_by.length && <div><dt>分组</dt><dd>{conditions.group_by.join("、")}</dd></div>}
    {!!conditions.filters.length && <div><dt>筛选条件</dt><dd>{conditions.filters.join("\n")}</dd></div>}
    {conditions.notes && <div><dt>补充说明</dt><dd>{conditions.notes}</dd></div>}
  </dl>;
}

function ReportChart({ chart, result, sourceLabels }: { chart: AnalysisReportChart; result: QueryResults; sourceLabels: string[] }) {
  const titleId = useId();
  const dimension = result.columns.findIndex(column => column.name === chart.dimension_column);
  const measure = result.columns.findIndex(column => column.name === chart.measure_column);
  if (dimension < 0 || measure < 0) return <p className="report-state">图表字段已变化，当前无法绘制。</p>;
  const values = result.rows.map(row => row[measure]);
  const scale = decimalChartScale(values, chart.kind === "bar");
  const partial = result.truncated || !result.result_complete || result.saved_result_complete !== true || result.saved_row_count !== result.rows.length || !!result.next_cursor;
  const width = Math.max(640, result.rows.length * 128);
  const segments: string[][] = [[]];
  if (scale) scale.positions.forEach((position, index) => {
    if (position === null) { if (segments.at(-1)?.length) segments.push([]); }
    else segments.at(-1)?.push((index + 0.5) * width / result.rows.length + "," + (160 - position * 140));
  });
  return <figure className="report-chart" aria-labelledby={titleId}>
    <figcaption id={titleId}>{chart.title}<small>{sourceLabels.join("、")}</small><small>{chart.dimension_column} · {chart.measure_column}（字段原值）</small></figcaption>
    {partial && <p className="result-limit">图表仅覆盖平台已保存的 {result.saved_row_count ?? result.rows.length} 条结果，原查询结果不完整，不能据此推算全量。</p>}
    {!result.rows.length ? <p className="report-chart-empty">查询成功，当前条件下暂无记录。</p> : !scale ? <p className="report-chart-empty">当前数值为空或不能安全绘图，原值可在下方表格中核对。</p>
      : chart.kind === "bar" ? <div className="report-chart-scroll" tabIndex={0} role="region" aria-label={chart.title + "，全部分类与精确数值"}><div className="report-bars" role="list">{result.rows.map((row, index) => {
        const position = scale.positions[index]; const zero = scale.zero ?? 0;
        return <div className="report-bar-row" role="listitem" key={index}><span>{row[dimension] ?? "未填写"}</span><div className="report-bar-track"><i className="report-bar-zero" style={{ left: zero * 100 + "%" }}/>{position !== null && <b className={position < zero ? "negative" : ""} style={{ left: Math.min(position, zero) * 100 + "%", width: Math.abs(position - zero) * 100 + "%" }} />}</div><strong>{row[measure] ?? "无数据"}</strong></div>;
      })}</div></div> : <div className="report-chart-scroll report-trend-scroll" tabIndex={0} role="region" aria-label={chart.title + "，全部时间点，可横向滚动"}><div style={{ width }}>
        <svg className="report-trend" viewBox={`0 0 ${width} 180`} role="img" aria-label={chart.title + "，共 " + result.rows.length + " 个点，精确数值见下方"}>
          {scale.zero !== null && <line className="report-trend-zero" x1="0" x2={width} y1={160 - scale.zero * 140} y2={160 - scale.zero * 140} />}
          {segments.filter(segment => segment.length > 1).map((segment, index) => <polyline className="report-trend-line" key={index} points={segment.join(" ")} />)}
          {scale.positions.map((position, index) => position !== null && <circle className="report-trend-point" key={index} cx={(index + 0.5) * width / result.rows.length} cy={160 - position * 140} r="4"><title>{result.rows[index][dimension]}：{result.rows[index][measure]}</title></circle>)}
        </svg>
        <div className="report-point-labels" role="list" style={{ gridTemplateColumns: `repeat(${result.rows.length}, minmax(0, 1fr))` }}>{result.rows.map((row, index) => <div role="listitem" key={index}><span>{row[dimension]}</span><strong>{row[measure] ?? "无数据"}</strong></div>)}</div>
      </div></div>}
    <p className="report-chart-caption">图表展示本次查询已保存的全部 {result.rows.length} 条记录，数值标签保留字段原值。</p>
    <details className="report-chart-data"><summary>查看数据预览（前 {Math.min(10, result.rows.length)} 行）</summary><div className="table-scroll" tabIndex={0} role="region" aria-label={chart.title + "的数据预览"}><table><thead><tr>{result.columns.map((column, index) => <th key={index}>{column.name}</th>)}</tr></thead><tbody>{result.rows.slice(0, 10).map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{value ?? "NULL"}</td>)}</tr>)}</tbody></table>{!result.rows.length && <p>暂无符合条件的记录。</p>}</div><a className="text-link" href={"/api/queries/" + result.query_id + "/export.csv"}>下载当前保存的 CSV ↓</a></details>
  </figure>;
}
