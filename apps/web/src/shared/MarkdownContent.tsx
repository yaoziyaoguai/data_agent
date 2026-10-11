import { createContext, memo, useContext, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const ResultDisplay = createContext<{ savedSql: string[]; compactResults: boolean }>({ savedSql: [], compactResults: false });

// 变化的数据经 Context 传入，新增查询也不更换渲染器，避免历史节点重建。
const components: Components = {
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : "[图片]"}</span>,
  pre: function ResultCode({children, node}) {
    const { savedSql } = useContext(ResultDisplay);
    const code = node?.children[0];
    const value = code?.type === "element" && code.tagName === "code"
      ? code.children.map(child => child.type === "text" ? child.value : "").join("") : "";
    // 仅忽略两端空白，保留字符串、标识符与注释中可能改变含义的空白。
    const matching = value.trim() && savedSql.some(sql => sql.trim() === value.trim());
    return matching ? <details className="message-data-detail"><summary>查看回复中的 SQL（查询卡片已提供）</summary><pre>{children}</pre></details> : <pre>{children}</pre>;
  },
  table: function ResultTable({children, node}) {
    const { compactResults } = useContext(ResultDisplay);
    const body = node?.children.find(child => child.type === "element" && child.tagName === "tbody");
    const rowCount = body?.type === "element" ? body.children.filter(child => child.type === "element" && child.tagName === "tr").length : 0;
    const table = <div className="message-table-scroll" tabIndex={0} role="region" aria-label="可横向滚动的表格"><table>{children}</table></div>;
    return compactResults && rowCount > 10 ? <details className="message-data-detail"><summary>查看回复中的明细表（{rowCount} 行）</summary>{table}</details> : table;
  },
};
const plugins = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({ text, className = "", savedSql = [], compactResults = false }: { text: string; className?: string; savedSql?: string[]; compactResults?: boolean }) {
  const display = useMemo(() => ({ savedSql, compactResults }), [savedSql, compactResults]);
  return <div className={"markdown-content " + className}><ResultDisplay.Provider value={display}><Markdown remarkPlugins={plugins} skipHtml components={components}>{text}</Markdown></ResultDisplay.Provider></div>;
});
