import type { ChatMessage, Event, QueryView, Snapshot } from "../../../../../packages/contracts/generated/boundary.ts";

type ConversationItem =
  | { kind: "message"; key: string; sequence: bigint; message: ChatMessage }
  | { kind: "query"; key: string; sequence: bigint; query: QueryView }
  | { kind: "query_notice"; key: string; sequence: bigint; query: QueryView; text: string };

// 确认后查询留在原位；完成事件单独通知，避免结果晚到时重排正在阅读的对话。
export function conversationItems(snapshot: Snapshot, queries: QueryView[]): ConversationItem[] {
  const items: ConversationItem[] = snapshot.messages.map((message, index) => ({ kind: "message", key: "message:" + (message.message_id ?? message.attempt_id ?? index), sequence: BigInt(message.event_seq ?? "0"), message }));
  for (const query of queries) {
    const event = snapshot.events.findLast(event => event.type === "query_changed" && event.payload.query_id === query.id);
    items.push({ kind: "query", key: "query:" + query.id, sequence: BigInt(event?.event_seq ?? "0"), query });
    const completed = snapshot.events.find(event => event.type === "query_result" && event.payload.query_id === query.id);
    const text = completed && ({ succeeded: "查询完成", failed: "查询失败", cancelled: "查询已停止" } as Record<string, string>)[String(completed.payload.state)];
    if (completed && text) items.push({ kind: "query_notice", key: "query-notice:" + query.id, sequence: BigInt(completed.event_seq), query, text });
  }
  return items.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
}

export function displayUserMessage(text: string, tasks: Snapshot["tasks"]): { text: string; subject?: string } {
  const prefix = /^\[task:([A-Za-z0-9_-]+)\]\s*/.exec(text);
  const task = prefix && tasks.find(task => task.id === prefix[1]);
  return task && prefix ? { text: text.slice(prefix[0].length), subject: task.goal } : { text };
}

// 展示投影覆盖所有已加载页。完整回答替代同次流式片段，恢复回答隐藏旧尝试。
export function projectMessages(events: Event[]): ChatMessage[] {
  const hidden = new Set(events.filter(e => e.type === "assistant_replaced").map(e => String(e.payload.replaces_attempt_id)));
  const messages = new Map<string, ChatMessage>();
  for (const event of events) {
    const p = event.payload;
    if (event.type === "message") {
      messages.set("user:" + p.message_id, { role: "user", message_id: String(p.message_id), text: String(p.text), committed: true, attempt_id: null, event_seq: event.event_seq });
    } else if ((event.type === "assistant_delta" || event.type === "assistant_committed") && !hidden.has(String(p.attempt_id))) {
      const key = "assistant:" + p.attempt_id;
      const previous = messages.get(key);
      const committed = event.type === "assistant_committed";
      if (previous?.committed || (!committed && p.projection_state === "committed") || p.projection_state === "superseded") continue;
      messages.set(key, { role: "assistant", attempt_id: String(p.attempt_id), output_id: typeof p.output_id === "string" ? p.output_id : null,
        text: committed ? String(p.text) : (previous?.text ?? "") + String(p.text), committed, event_seq: previous?.event_seq ?? event.event_seq });
    }
  }
  return [...messages.values()].sort((a, b) => BigInt(a.event_seq ?? "0") < BigInt(b.event_seq ?? "0") ? -1 : 1);
}

export function mergeSnapshot(previous: Snapshot | null, incoming: Snapshot, older = false): Snapshot {
  if (!previous || previous.conversation_id !== incoming.conversation_id) return { ...incoming, messages: projectMessages(incoming.events) };
  const bySeq = new Map(previous.events.map(e => [e.event_seq, e]));
  for (const event of incoming.events) bySeq.set(event.event_seq, event);
  const events = [...bySeq.values()].sort((a, b) => BigInt(a.event_seq) < BigInt(b.event_seq) ? -1 : 1);
  const first = events[0]?.event_seq ?? "0";
  const last = events.at(-1)?.event_seq ?? previous.last_event_seq ?? "0";
  return { ...(older ? previous : incoming), events, messages: projectMessages(events), first_event_seq: first, last_event_seq: last,
    has_older: BigInt(first) > 1n, has_newer: older ? previous.has_newer : incoming.has_newer };
}
