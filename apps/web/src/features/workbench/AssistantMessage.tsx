import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AssistantMessage({ text }: { text: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          // 模型文字中的图片只显示描述，避免浏览器自动向外部地址发送请求。
          img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : "[图片]"}</span>,
          table: ({ children }) => (
            <div className="message-table-scroll" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
