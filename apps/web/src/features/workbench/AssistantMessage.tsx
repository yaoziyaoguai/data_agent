import { MarkdownContent } from "../../shared/MarkdownContent.tsx";
import type { ObjectReferenceLabels } from "../../shared/markdown-object-references.ts";

export function AssistantMessage({ text, savedSql = [], objectReferences }: { text: string; savedSql?: string[]; objectReferences?: ObjectReferenceLabels }) {
  return <MarkdownContent text={text} className="assistant-markdown" savedSql={savedSql} objectReferences={objectReferences} compactResults />;
}
