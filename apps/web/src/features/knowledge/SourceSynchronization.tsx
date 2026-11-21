import { useEffect, useRef, useState } from "react";
import type {
  SourceSyncAccepted,
  SourceSyncProgress,
  SourceWorkProgress,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { ApiError, api } from "../../shared/api.ts";

const syncLabels = { queued: "等待处理", running: "处理中", completed: "已完成", failed: "未完成" };
const workLabels = { pending: "等待处理", running: "处理中", completed: "已完成", failed: "处理失败", not_required: "无需处理" };
const terminal = (status: SourceSyncAccepted["status"]) => status === "completed" || status === "failed";
const workPending = (work: SourceWorkProgress) => work.status === "pending" || work.status === "running";

function failureMessage(error: unknown, reading: boolean) {
  const message = error instanceof ApiError && error.code === "forbidden"
    ? "当前账号无权同步或查看来源同步进度，请联系本系统超级维护者。"
    : error instanceof ApiError && error.code === "not_available"
      ? "当前无法访问这次同步，请核对账号和空间。"
      : reading ? "暂时无法读取同步进度，已显示的状态可能不是最新。"
        : "尚未确认同步请求的接收结果。重试会沿用同一次请求。";
  return message + (error instanceof ApiError ? ` 错误码：${error.code}；诊断编号：${error.requestId}` : "");
}

export function useSourceSynchronization(user: string, canAdmin: boolean, onChanged: () => void) {
  const [accepted, setAccepted] = useState<(SourceSyncAccepted & { owner: string }) | null>(null);
  const [progress, setProgress] = useState<SourceSyncProgress | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pollRevision, setPollRevision] = useState(0);
  const command = useRef<string | null>(null);
  const generation = useRef(0);
  const identity = useRef(user);
  const changed = useRef(onChanged);
  identity.current = user;
  changed.current = onChanged;
  useEffect(() => {
    setAccepted(null); setProgress(null); setSubmitting(false); setError(""); command.current = null;
    return () => { ++generation.current; };
  }, [user]);

  useEffect(() => {
    if (!accepted || accepted.owner !== user || !canAdmin) return;
    let live = true;
    let timer: number | undefined;
    const controller = new AbortController();
    let previous: string | undefined;
    let delay = 250;
    let refreshed = false;
    const poll = async () => {
      try {
        const current = await api("SourceSyncProgress", accepted.status_url, "GET", undefined, undefined, controller.signal);
        if (!live) return;
        if (current.sync_id !== accepted.sync_id) throw new Error("sync_identity_mismatch");
        setProgress(current); setError("");
        if (terminal(current.status) && !refreshed) { refreshed = true; changed.current(); }
        if (!terminal(current.status) || [current.preparation, current.raw_index, current.knowledge_index].some(workPending)) {
          const shape = JSON.stringify(current);
          delay = previous === shape ? Math.min(4000, delay * 2) : 250;
          previous = shape;
          timer = window.setTimeout(() => void poll(), delay);
        }
      } catch (cause) {
        if (live) setError(failureMessage(cause, true));
      }
    };
    void poll();
    // 页面离开或切换批次后不再轮询，已发出的读取也不能写回旧状态。
    return () => { live = false; controller.abort(); window.clearTimeout(timer); };
  }, [accepted, canAdmin, user, pollRevision]);

  const current = accepted?.owner === user ? accepted : null;
  const currentProgress = current ? progress : null;
  const busy = submitting || Boolean(current && !terminal(currentProgress?.status ?? current.status));
  const synchronize = async () => {
    if (!canAdmin || busy) return;
    const attempt = ++generation.current;
    command.current ??= crypto.randomUUID();
    setSubmitting(true); setError(""); setAccepted(null); setProgress(null);
    try {
      const receipt = await api("SourceSyncAccepted", "/source-syncs", "POST", { operation_id: command.current });
      if (attempt !== generation.current || identity.current !== user) return;
      command.current = null;
      setProgress(null); setAccepted({ ...receipt, owner: user });
    } catch (cause) {
      if (attempt === generation.current && identity.current === user) setError(failureMessage(cause, false));
    } finally {
      if (attempt === generation.current && identity.current === user) setSubmitting(false);
    }
  };
  return {
    accepted: current, progress: currentProgress, busy, error,
    label: submitting ? "正在提交…" : busy ? "同步中…" : command.current ? "重试提交同步" : current ? "重新同步" : "同步来源",
    synchronize,
    retryProgress: () => { setError(""); setPollRevision(value => value + 1); },
  };
}

export function SourceSynchronizationStatus({ sync }: { sync: ReturnType<typeof useSourceSynchronization> }) {
  if (!sync.accepted && !sync.error) return null;
  const progress = sync.progress;
  const status = progress?.status ?? sync.accepted?.status;
  return <section aria-label="来源同步进度" className="semantic-entry">
    {status && <p role="status">资料同步：{syncLabels[status]}</p>}
    {progress && <>
      <p className="quiet">已处理 {progress.processed_sources} 份来源，已保存 {progress.pages_committed} 批资料。</p>
      {status === "completed" && <p>资料已保存；整理和索引进度分别如下。</p>}
      {status === "failed" && <p role="alert">本次同步未完成，已保存的资料保留。可核对原因后重新同步。{progress.error_message ? ` ${progress.error_message}` : progress.error_code && ` 错误码：${progress.error_code}`}</p>}
      <ul>{([
        ["语义整理", progress.preparation], ["原文索引", progress.raw_index], ["知识索引", progress.knowledge_index],
      ] as const).map(([name, work]) => <li key={name}>
        {name}：{workLabels[work.status]}{work.total > 0 && ` · ${work.completed} / ${work.total}`}{work.failed > 0 && ` · 失败 ${work.failed}`}
      </li>)}</ul>
    </>}
    {sync.error && <p role="alert" className="error">{sync.error}</p>}
    {sync.error && sync.accepted && <button onClick={sync.retryProgress}>重试读取进度</button>}
  </section>;
}
