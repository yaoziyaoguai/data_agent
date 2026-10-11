export function conversationTitle(text: string): string {
  const first = text.trim().split(/[。！？\n]/, 1)[0].replace(/\s+/g, " ");
  const characters = Array.from(first);
  return characters.length > 36 ? characters.slice(0, 36).join("") + "…" : first;
}
