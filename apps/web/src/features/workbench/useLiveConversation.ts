import { useEffect, useRef, useState } from "react";
import type { Event, QueryList, WorkbenchUpdate } from "../../../../../packages/contracts/generated/boundary.ts";
import { decodeContract } from "../../../../../packages/contracts/validate.ts";
import { api } from "../../shared/api.ts";
import { appendLiveEvent, loadedOutputRanges, mergeSnapshot } from "./conversation-timeline.ts";

const emptyQueries: QueryList = { queries: [], confirmation_blocked: false };
type ConversationSnapshot = ReturnType<typeof mergeSnapshot>;

export function useLiveConversation(cid: string | null, space: string, user: string) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [queries, setQueries] = useState(emptyQueries);
  const [syncUnavailable, setSyncUnavailable] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [authorityRevision, setAuthorityRevision] = useState(0);
  const requestOlder = useRef<() => void>(() => {});
  const requestReconnect = useRef<() => void>(() => {});

  useEffect(() => {
    setSnapshot(null);
    setQueries(emptyQueries);
    setLoadingOlder(false);
    setSyncUnavailable(false);
    if (!cid) return;
    const controller = new AbortController();
    const { signal } = controller;
    let current: ConversationSnapshot | null = null;
    let source: EventSource | undefined;
    let busy = false;
    let gap = false;
    let published = false;
    const update = (next: ConversationSnapshot) => {
      current = next;
      if (published) setSnapshot(next);
    };
    const reconnect = () => {
      source?.close();
      source = undefined;
      if (busy) gap = true;
      else void readSnapshot();
    };
    const readSnapshot = async (older = false) => {
      if (signal.aborted || busy || (older && !current?.has_older)) return;
      busy = true;
      if (older) setLoadingOlder(true);
      try {
        const next = await api("SnapshotRefresh", "/conversations/" + cid + "/snapshot", "POST", {
          loaded_outputs: current ? loadedOutputRanges(current) : [],
          ...(older ? { before_seq: current?.first_event_seq } : current ? { after_seq: current.last_event_seq } : {}),
        }, undefined, signal);
        if (signal.aborted) return;
        update(mergeSnapshot(current, next, older));
        setSyncUnavailable(false);
        if (!older) connect();
      } catch {
        if (!signal.aborted) setSyncUnavailable(true);
      } finally {
        busy = false;
        if (!signal.aborted) {
          if (older) setLoadingOlder(false);
          if (gap) { gap = false; reconnect(); }
        }
      }
    };
    const connect = () => {
      if (source || !current) return;
      const stream = new EventSource("/api/conversations/" + cid + "/events?view=workbench&after_seq=" + current.last_event_seq);
      source = stream;
      let opened = false;
      stream.onopen = () => {
        if (opened) {
          // 断开期间可能漏掉不带事件序号的权限变化，已展示段落按当前权限补读。
          setAuthorityRevision(value => value + 1);
          reconnect();
          return;
        }
        opened = true;
        setSyncUnavailable(false);
      };
      stream.onmessage = message => {
        if (!current || signal.aborted) return;
        try {
          const event = decodeContract<Event>("Event", JSON.parse(message.data));
          update(appendLiveEvent(current, event));
        } catch {
          reconnect();
        }
      };
      stream.addEventListener("workbench_state", message => {
        if (!current || signal.aborted) return;
        try {
          const next = decodeContract<WorkbenchUpdate>("WorkbenchUpdate", JSON.parse(message.data));
          if (next.query_list) {
            // 首次展示正文时，查询卡与重复 SQL 的折叠依据必须一同到达。
            setQueries(next.query_list);
            published = true;
          }
          update({ ...current, tasks: next.tasks ?? current.tasks, runs: next.runs ?? current.runs });
        } catch {
          reconnect();
        }
      });
      stream.addEventListener("lagged", message => {
        if (message.data === '{"reason":"authority_changed"}') setAuthorityRevision(value => value + 1);
        reconnect();
      });
      stream.addEventListener("stream_closed", () => {
        stream.close();
        source = undefined;
        current = null;
        setSnapshot(null);
        setQueries(emptyQueries);
        setAuthorityRevision(value => value + 1);
        setSyncUnavailable(true);
      });
      stream.onerror = () => {
        setSyncUnavailable(true);
        if (!published && current) {
          published = true;
          setSnapshot(current);
        }
      };
    };
    requestOlder.current = () => void readSnapshot(true);
    requestReconnect.current = reconnect;
    void readSnapshot();
    return () => {
      controller.abort();
      source?.close();
      requestOlder.current = () => {};
      requestReconnect.current = () => {};
    };
  }, [cid, space, user]);

  return { snapshot, queries, loadingOlder, syncUnavailable, authorityRevision, requestOlder, requestReconnect };
}
