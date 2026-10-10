import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// 轮询和流式更新复用同一渲染器，保留表格节点、滚动位置与键盘焦点。
const components: Components = {
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : "[图片]"}</span>,
  table: ({ children }) => <div className="message-table-scroll" tabIndex={0} role="region" aria-label="可横向滚动的表格"><table>{children}</table></div>,
};
const plugins = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({ text, className = "" }: { text: string; className?: string }) {
  return <div className={"markdown-content " + className}><Markdown remarkPlugins={plugins} skipHtml components={components}>{text}</Markdown></div>;
});
