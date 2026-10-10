import { MarkdownContent } from "../../shared/MarkdownContent.tsx";

export function AssistantMessage({ text }: { text: string }) {
  return <MarkdownContent text={text} className="assistant-markdown" />;
}
