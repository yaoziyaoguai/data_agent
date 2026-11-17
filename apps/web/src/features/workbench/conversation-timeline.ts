import type { AnalysisReportRef, ChatMessage, Event, LoadedOutputRange, OutputProjection, QueryView, Snapshot, SnapshotRefresh } from "../../../../../packages/contracts/generated/boundary.ts";
import { decodeContract } from "../../../../../packages/contracts/validate.ts";

type ConversationItem =
  | { kind: "message"; key: string; sequence: bigint; message: ChatMessage }
  | { kind: "query"; key: string; sequence: bigint; query: QueryView }
  | { kind: "report"; key: string; sequence: bigint; reference: AnalysisReportRef; conditionChanged: boolean }
  | { kind: "query_notice"; key: string; sequence: bigint; query: QueryView; text: string };

// 确认后查询留在原位；完成事件单独通知，避免结果晚到时重排正在阅读的对话。
export function conversationItems(snapshot: Snapshot, queries: QueryView[]): ConversationItem[] {
  const items: ConversationItem[] = snapshot.messages.map((message, index) => ({ kind: "message", key: "message:" + (message.message_id ?? message.attempt_id ?? index), sequence: BigInt(message.event_seq ?? "0"), message }));
  for (const query of queries) {
    // §6.3：持久首次query_changed锚点优先；旧记录无锚点时退回已加载页的最早事件，补页只可能前移一次，不为后续事件页覆盖。
    const anchored = query.timeline_event_seq
      ?? snapshot.events.find(event => event.type === "query_changed" && event.payload.query_id === query.id)?.event_seq
      ?? "0";
    items.push({ kind: "query", key: "query:" + query.id, sequence: BigInt(anchored), query });
    const completed = snapshot.events.find(event => event.type === "query_result" && event.payload.query_id === query.id);
    const text = completed && ({ succeeded: "查询完成", failed: "查询失败", cancelled: "查询已停止" } as Record<string, string>)[String(completed.payload.state)];
    if (completed && text) items.push({ kind: "query_notice", key: "query-notice:" + query.id, sequence: BigInt(completed.event_seq), query, text });
  }
  const reports = new Map<string, AnalysisReportRef>();
  for (const event of snapshot.events) {
    if (event.type !== "analysis_report_saved") continue;
    try {
      const reference = decodeContract<AnalysisReportRef>("AnalysisReportRef", event.payload);
      if (reference.conversation_id === snapshot.conversation_id) reports.set(reference.report_id, reference);
    } catch { /* 无效通知不能生成可用报告入口，正式报告仍以读取接口为准。 */ }
  }
  for (const task of snapshot.tasks) if (task.report_ref) reports.set(task.report_ref.report_id, task.report_ref);
  for (const reference of reports.values()) {
    const event = snapshot.events.find(event => event.type === "analysis_report_saved" && event.payload.report_id === reference.report_id);
    const task = snapshot.tasks.find(task => task.id === reference.task_id);
    // §5：持久首次保存锚点只在任务report_ref与当前卡片一致时生效，不能仅凭task_id套用；
    // 旧记录缺锚点时回退已加载页事件，再回退0，补页只可能前移一次。
    const anchorTask = snapshot.tasks.find(task => task.report_ref?.report_id === reference.report_id);
    const anchored = anchorTask?.report_timeline_event_seq
      ?? event?.event_seq
      ?? "0";
    items.push({ kind: "report", key: "report:" + reference.report_id, sequence: BigInt(anchored), reference,
      conditionChanged: task !== undefined && task.condition_version !== reference.condition_version });
  }
  return items.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
}

export function displayUserMessage(text: string, tasks: Snapshot["tasks"]): { text: string; subject?: string } {
  const prefix = /^\[task:([A-Za-z0-9_-]+)\]\s*/.exec(text);
  const task = prefix && tasks.find(task => task.id === prefix[1]);
  return task && prefix ? { text: text.slice(prefix[0].length), subject: task.text_unavailable ? "任务目标暂不可用" : task.goal } : { text };
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

type ConversationSnapshot = Snapshot & { output_projections?: LoadedOutputRange[] };
const outputRangeKey = (range: LoadedOutputRange) => JSON.stringify([range.attempt_id, range.first_event_seq, range.last_event_seq]);
const assistantEvent = (event: Event) => ["assistant_delta", "assistant_committed", "assistant_replaced"].includes(event.type);

// 只在实际连续缓存区间内合并同一attempt，不能用全局min/max吞掉尚未读过的页。
export function loadedOutputRanges(snapshot: ConversationSnapshot): LoadedOutputRange[] {
  const ranges: LoadedOutputRange[] = [];
  const current = new Map<string, LoadedOutputRange>();
  let previous: bigint | undefined;
  for (const event of snapshot.events) {
    const sequence = BigInt(event.event_seq);
    if (previous !== undefined && sequence !== previous + 1n) current.clear();
    previous = sequence;
    if (!assistantEvent(event) || typeof event.payload.attempt_id !== "string") continue;
    const attempt = event.payload.attempt_id;
    const range = current.get(attempt);
    if (range) range.last_event_seq = event.event_seq;
    else {
      const next = { attempt_id: attempt, first_event_seq: event.event_seq, last_event_seq: event.event_seq };
      current.set(attempt, next);
      ranges.push(next);
    }
  }
  const fingerprints = new Map((snapshot.output_projections ?? []).map(range => [outputRangeKey(range), range.projection_fingerprint]));
  return ranges.map(range => {
    const fingerprint = fingerprints.get(outputRangeKey(range));
    return fingerprint ? { ...range, projection_fingerprint: fingerprint } : range;
  });
}

export function mergeSnapshot(previous: ConversationSnapshot | null, incoming: Snapshot | SnapshotRefresh, older = false): ConversationSnapshot {
  const sameConversation = previous?.conversation_id === incoming.conversation_id;
  if (!sameConversation) previous = null;
  const projections: OutputProjection[] = "output_projections" in incoming ? incoming.output_projections : [];
  if (previous && !incoming.events.length && !older && projections.every(projection => projection.projection_result === "unchanged") &&
      JSON.stringify(previous.tasks) === JSON.stringify(incoming.tasks) && JSON.stringify(previous.runs) === JSON.stringify(incoming.runs) &&
      previous.has_newer === incoming.has_newer) return previous;
  const bySeq = new Map((previous?.events ?? []).map(event => [event.event_seq, event]));
  for (const event of incoming.events) bySeq.set(event.event_seq, event);
  for (const projection of projections) {
    if (projection.projection_result === "unchanged") continue;
    const first = BigInt(projection.first_event_seq), last = BigInt(projection.last_event_seq);
    for (const [sequence, event] of bySeq) {
      if (assistantEvent(event) && event.payload.attempt_id === projection.attempt_id && BigInt(sequence) >= first && BigInt(sequence) <= last) bySeq.delete(sequence);
    }
    if (projection.projection_result === "replace") for (const event of projection.events!) bySeq.set(event.event_seq, event);
  }
  const events = [...bySeq.values()].sort((a, b) => BigInt(a.event_seq) < BigInt(b.event_seq) ? -1 : 1);
  // 游标描述实际分页读取；投影删除事件后也不能从展示数组反算游标。
  let first = previous?.first_event_seq ?? "0", last = previous?.last_event_seq ?? "0";
  if (incoming.events.length) {
    const pageFirst = incoming.first_event_seq ?? incoming.events[0].event_seq;
    const pageLast = incoming.last_event_seq ?? incoming.events.at(-1)!.event_seq;
    if (first === "0" || BigInt(pageFirst) < BigInt(first)) first = pageFirst;
    if (BigInt(pageLast) > BigInt(last)) last = pageLast;
  }
  const fingerprints = new Map((previous?.output_projections ?? []).map(range => [outputRangeKey(range), range]));
  for (const projection of projections) fingerprints.set(outputRangeKey(projection), {
    attempt_id: projection.attempt_id, first_event_seq: projection.first_event_seq, last_event_seq: projection.last_event_seq,
    projection_fingerprint: projection.projection_fingerprint,
  });
  const next: ConversationSnapshot = { ...(older && previous ? previous : incoming), events, messages: projectMessages(events),
    first_event_seq: first, last_event_seq: last,
    has_older: older || !previous ? incoming.has_older : previous.has_older,
    has_newer: older && previous ? previous.has_newer : incoming.has_newer,
    output_projections: [...fingerprints.values()] };
  next.output_projections = loadedOutputRanges(next);
  return next;
}
