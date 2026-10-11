import { MarkdownContent } from "../../shared/MarkdownContent.tsx";

export function AssistantMessage({ text, savedSql = [] }: { text: string; savedSql?: string[] }) {
  return <MarkdownContent text={text} className="assistant-markdown" savedSql={savedSql} compactResults />;
}
