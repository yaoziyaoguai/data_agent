import type { ChatMessage, Event, Snapshot } from "../../../../../packages/contracts/generated/boundary.ts";

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
