import { useEffect, useRef, useState } from "react";
import type { Event, QueryList, WorkbenchUpdate } from "../../../../../packages/contracts/generated/boundary.ts";
import { decodeContract } from "../../../../../packages/contracts/validate.ts";
import { api, ApiError } from "../../shared/api.ts";
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
    let disposed = false;
    let requestController = new AbortController();
    let current: ConversationSnapshot | null = null;
    let source: EventSource | undefined;
    let reading: "latest" | "older" | null = null;
    let olderPending = false;
    let gap = false;
    let published = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    let recheckAuthority = false;
    const update = (next: ConversationSnapshot) => {
      current = next;
      if (published) setSnapshot(next);
    };
    const closeStream = () => {
      requestController.abort();
      requestController = new AbortController();
      clearTimeout(retry);
      source?.close();
      source = undefined;
      reading = null;
      olderPending = false;
      gap = false;
      current = null;
      setSnapshot(null);
      setQueries(emptyQueries);
      setLoadingOlder(false);
      setAuthorityRevision(value => value + 1);
      setSyncUnavailable(true);
    };
    const reconnect = () => {
      if (disposed) return;
      clearTimeout(retry);
      source?.close();
      source = undefined;
      if (reading) gap = true;
      else void readSnapshot();
    };
    const scheduleReconnect = () => {
      source?.close();
      source = undefined;
      clearTimeout(retry);
      retry = setTimeout(reconnect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    };
    const readSnapshot = async (older = false) => {
      if (disposed || (older && !current?.has_older)) return;
      if (reading) {
        if (older && reading === "latest") olderPending = true;
        return;
      }
      const { signal } = requestController;
      reading = older ? "older" : "latest";
      let merged = false;
      if (older) setLoadingOlder(true);
      try {
        const next = await api("SnapshotRefresh", "/conversations/" + cid + "/snapshot", "POST", {
          loaded_outputs: current ? loadedOutputRanges(current) : [],
          ...(older ? { before_seq: current?.first_event_seq } : current ? { after_seq: current.last_event_seq } : {}),
        }, undefined, signal);
        if (disposed || signal.aborted) return;
        update(mergeSnapshot(current, next, older));
        merged = true;
        setSyncUnavailable(false);
        if (!older) {
          if (recheckAuthority) {
            recheckAuthority = false;
            setAuthorityRevision(value => value + 1);
          }
          connect();
        }
      } catch (error) {
        if (disposed || signal.aborted) return;
        if (error instanceof ApiError && ["unauthenticated", "forbidden", "not_available"].includes(error.code)) {
          closeStream();
        } else {
          setSyncUnavailable(true);
          if (!older && !source) scheduleReconnect();
        }
      } finally {
        if (!signal.aborted) reading = null;
        if (!disposed && !signal.aborted) {
          if (older) setLoadingOlder(false);
          if (gap) {
            gap = false;
            reconnect();
          } else if (olderPending && merged) {
            olderPending = false;
            void readSnapshot(true);
          }
        }
      }
    };
    const connect = () => {
      if (disposed || source || !current) return;
      const stream = new EventSource("/api/conversations/" + cid + "/events?view=workbench&after_seq=" + current.last_event_seq);
      source = stream;
      let opened = false;
      let interrupted = false;
      const unavailable = () => {
        setSyncUnavailable(true);
        if (!published && current) {
          published = true;
          setSnapshot(current);
        }
        recheckAuthority = true;
      };
      const invalidFrame = () => {
        unavailable();
        scheduleReconnect();
      };
      stream.onopen = () => {
        if (opened || interrupted) {
          // 断开期间可能漏掉不带事件序号的权限变化，已展示段落按当前权限补读。
          recheckAuthority = true;
          reconnect();
          return;
        }
        opened = true;
      };
      stream.onmessage = message => {
        if (!current || disposed) return;
        try {
          const event = decodeContract<Event>("Event", JSON.parse(message.data));
          update(appendLiveEvent(current, event));
        } catch {
          invalidFrame();
        }
      };
      stream.addEventListener("workbench_state", message => {
        if (!current || disposed) return;
        try {
          const next = decodeContract<WorkbenchUpdate>("WorkbenchUpdate", JSON.parse(message.data));
          if (next.query_list) {
            // 首次展示正文时，查询卡与重复 SQL 的折叠依据必须一同到达。
            setQueries(next.query_list);
            published = true;
            retryDelay = 1000;
            setSyncUnavailable(false);
          }
          update({ ...current, tasks: next.tasks ?? current.tasks, runs: next.runs ?? current.runs });
        } catch {
          invalidFrame();
        }
      });
      stream.addEventListener("lagged", message => {
        if (message.data === '{"reason":"authority_changed"}') setAuthorityRevision(value => value + 1);
        reconnect();
      });
      stream.addEventListener("stream_closed", closeStream);
      stream.onerror = () => {
        interrupted = true;
        unavailable();
        if (stream.readyState === EventSource.CLOSED) {
          scheduleReconnect();
        }
      };
    };
    requestOlder.current = () => void readSnapshot(true);
    requestReconnect.current = reconnect;
    void readSnapshot();
    return () => {
      disposed = true;
      requestController.abort();
      clearTimeout(retry);
      source?.close();
      requestOlder.current = () => {};
      requestReconnect.current = () => {};
    };
  }, [cid, space, user]);

  return { snapshot, queries, loadingOlder, syncUnavailable, authorityRevision, requestOlder, requestReconnect };
}
