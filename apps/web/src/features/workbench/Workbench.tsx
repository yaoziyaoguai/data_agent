import { useEffect, useState, useRef } from "react";
import type {
  Snapshot,
  QueryList,
  HistoryItem,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { WorkspaceShell, type View } from "../../shared/WorkspaceShell.tsx";
import { Modal } from "../../shared/Modal.tsx";
import { mergeSnapshot } from "./conversation-timeline.ts";
import { QueryCard } from "./QueryCard.tsx";
import { AssistantMessage } from "./AssistantMessage.tsx";
export function Workbench({
  user,
  modelLabel,
  onLogout,
  onView,
  onEvidence,
}: {
  user: string;
  modelLabel: string;
  onLogout: () => void;
  onView: (v: View) => void;
  onEvidence: (id: string) => void;
}) {
  const [cid, setCid] = useState<string | null>(() =>
    localStorage.getItem("data-agent.conversation." + user),
  );
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [queries, setQueries] = useState<QueryList>({
    queries: [],
    confirmation_blocked: false,
  });
  const [text, setText] = useState(() =>
    localStorage.getItem("data-agent.draft." + user + "." + (cid ?? "new")) ?? "",
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [task, setTask] = useState<string | null>(null);
  const [, setRevision] = useState(0);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  const historyGeneration = useRef(0);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const viewGeneration = useRef(0);
  const activeConversation = useRef(cid);
  const draftRevision = useRef(0);
  if (activeConversation.current !== cid) {
    activeConversation.current = cid;
    viewGeneration.current += 1;
  }
  const [loadingOlder, setLoadingOlder] = useState(false);
  const draftKey = (id: string | null) =>
    "data-agent.draft." + user + "." + (id ?? "new");
  const changeText = (value: string) => {
    draftRevision.current += 1;
    setText(value);
    localStorage.setItem(draftKey(cid), value);
  };
  const refreshHistory = async (query = historySearch, before?: string) => {
    const generation = ++historyGeneration.current;
    setHistoryBusy(true);
    try {
      const params = new URLSearchParams({ q: query });
      if (before) params.set("before_id", before);
      const page = await api("History", "/conversations?" + params);
      if (generation !== historyGeneration.current) return;
      setHistory(old => before ? [...old, ...page.conversations.filter(v => !old.some(o => o.id === v.id))] : page.conversations);
      setHistoryNext(page.next_before_id);
    } finally {
      if (generation === historyGeneration.current) setHistoryBusy(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshHistory().catch(e => setError(e.message)); }, 150);
    return () => { window.clearTimeout(timer); ++historyGeneration.current; };
  }, [user, historySearch]);
  useEffect(() => {
    let current = true;
    snapshotRef.current = null;
    setLoadingOlder(false);
    setSnapshot(null);
    setQueries({ queries: [], confirmation_blocked: false });
    setError("");
    setTask(null);
    setText(localStorage.getItem(draftKey(cid)) ?? "");
    if (cid) localStorage.setItem("data-agent.conversation." + user, cid);
    else localStorage.removeItem("data-agent.conversation." + user);
    let refreshing = false;
    const refresh = async () => {
      if (!cid || refreshing) return;
      refreshing = true;
      try {
        const [s, q] = await Promise.all([
          api("Snapshot", "/conversations/" + cid + "/snapshot" + (snapshotRef.current?.last_event_seq ? "?after_seq=" + snapshotRef.current.last_event_seq : "")),
          api("QueryList", "/conversations/" + cid + "/queries"),
        ]);
        if (current) {
          snapshotRef.current = mergeSnapshot(snapshotRef.current, s);
          setSnapshot(snapshotRef.current);
          setQueries(q);
        }
      } catch (e) {
        if (current) setError(e instanceof Error ? e.message : "读取失败");
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 700);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [cid, user]);
  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError("");
    const input = text.trim();
    const origin = cid;
    const generation = viewGeneration.current;
    const submittedDraft = text;
    const submittedRevision = draftRevision.current;
    try {
      let conversation = cid;
      if (!conversation) {
        conversation = (
          await api("ConversationReceipt", "/conversations", "POST", {
            operation_id: crypto.randomUUID(),
          })
        ).conversation_id;
      }
      await api(
        "MessageReceipt",
        "/conversations/" + conversation + "/messages",
        "POST",
        { client_message_id: crypto.randomUUID(), text: input },
      );
      if (viewGeneration.current === generation) {
        const nextDraft = draftRevision.current === submittedRevision
          ? "" : localStorage.getItem(draftKey(origin)) ?? "";
        localStorage.setItem(draftKey(conversation), nextDraft);
        if (!origin) {
          localStorage.removeItem(draftKey(origin));
          setCid(conversation);
        }
        setText(nextDraft);
      } else if (localStorage.getItem(draftKey(origin)) === submittedDraft) {
        localStorage.removeItem(draftKey(origin));
      }
      await refreshHistory();
    } catch (e) {
      if (viewGeneration.current === generation)
        setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSending(false);
    }
  };
  const loadOlder = async () => {
    if (!cid || !snapshot || loadingOlder) return;
    const generation = viewGeneration.current;
    setLoadingOlder(true);
    const before = snapshot.first_event_seq;
    try {
      const page = await api(
        "Snapshot",
        "/conversations/" + cid + "/snapshot?before_seq=" + before,
      );
      if (viewGeneration.current === generation) {
        snapshotRef.current = mergeSnapshot(snapshotRef.current, page, true);
        setSnapshot(snapshotRef.current);
      }
    } catch (e) {
      if (viewGeneration.current === generation) setError(String(e));
    } finally {
      if (viewGeneration.current === generation) setLoadingOlder(false);
    }
  };
  const cancelTask = async (id: string, version: string) => {
    if (!cid) return;
    try {
      await api(
        "MutationReceipt",
        "/conversations/" + cid + "/tasks/" + id + "/cancel",
        "POST",
        { operation_id: crypto.randomUUID(), expected_version: version },
      );
      setRevision((v) => v + 1);
    } catch (e) {
      setError(String(e));
    }
  };
  const withdraw = async (message: string) => {
    if (!cid) return;
    try {
      await api(
        "MutationReceipt",
        "/conversations/" + cid + "/messages/" + message + "/withdraw",
        "POST",
        { operation_id: crypto.randomUUID() },
      );
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error && e.message === "input_already_applied" ? "这条输入已经应用到任务。请补充新消息修订条件，不能撤回已经生效的修改。" : String(e));
    }
  };
  const removeConversation = async () => {
    if (!deleteId) return;
    try {
      await api("MutationReceipt", "/conversations/" + deleteId, "DELETE", {
        operation_id: crypto.randomUUID(),
      });
      if (deleteId === cid) setCid(null);
      setDeleteId(null);
      await refreshHistory();
    } catch (e) {
      setError(String(e));
    }
  };
  const messages = snapshot?.messages ?? [];
  const canLoadOlder = snapshot?.has_older;
  const failedInputs =
    snapshot?.events.filter(
      (e) =>
        e.type === "run_failed" &&
        !snapshot.events.some(
          (x) =>
            x.type === "message_withdrawn" &&
            x.payload.message_id === e.payload.message_id,
        ),
    ) ?? [];
  const currentRun = snapshot?.runs.find((r) => r.state === "running");
  const cancel = async () => {
    if (!cid || !currentRun) return;
    try {
      await api(
        "CancelReceipt",
        "/conversations/" + cid + "/cancel-run",
        "POST",
        { run_id: currentRun.run_id, lease_epoch: currentRun.lease_epoch },
      );
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "停止失败");
    }
  };
  const draftInput = (value: string) => {
    changeText(value);
    textarea.current?.focus();
  };
  const historyItems = history;
  const side = (
    <>
      <div className="history-label">
        最近会话
        <button
          aria-label="新对话"
          onClick={() => {
            setCid(null);
            setText(localStorage.getItem(draftKey(null)) ?? "");
          }}
        >
          ＋
        </button>
      </div>
      <nav className="history-nav" aria-label="会话历史">
        {history.slice(0, 8).map((item, index) => (
          <button
            key={item.id}
            aria-current={cid === item.id ? "true" : undefined}
            onClick={() => setCid(item.id)}
          >
            <span>◌</span>
            <span>{item.title || "会话 " + (history.length - index)}</span>
          </button>
        ))}
      </nav>
      <button className="history-all" onClick={() => setShowHistory(true)}>
        查看全部会话 ↗
      </button>
      {!history.length && (
        <p className="quiet">从第一个问题开始，记录会保存在这里。</p>
      )}
    </>
  );
  return (
    <WorkspaceShell
      user={user}
      modelLabel={modelLabel}
      onLogout={onLogout}
      view="workbench"
      onView={onView}
      sidebar={side}
    >
      <section
        className={
          "conversation " + (!snapshot?.messages.length ? "empty" : "")
        }
      >
        {!snapshot?.messages.length ? (
          <div className="welcome">
            <div className="eyebrow">从问题到有依据的分析</div>
            <h1>
              把数据问题，
              <br />
              说清楚。
            </h1>
            <p>
              查口径、写 SQL、分析结果。
              <br />
              同一个对话，可以一直聊下去。
            </p>
            <div className="example-grid">
              {[
                "查2026年1月净收入",
                "2026年1月退款率是多少",
                "支付客户数如何计算",
              ].map((q) => (
                <button
                  key={q}
                  className="example"
                  onClick={() => draftInput(q)}
                >
                  {q} ↗
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages" aria-live="polite">
            {canLoadOlder && (
              <button className="history-all" onClick={() => void loadOlder()}>
                加载更早的消息
              </button>
            )}
            {messages.map((m, i) => (
              <article
                key={m.message_id ?? m.attempt_id ?? i}
                className={"message " + m.role}
              >
                <div className="message-label">
                  {m.role === "user" ? "你" : "Data Agent"}
                  {!m.committed && (
                    <span> · {currentRun ? "生成中" : "未完成"}</span>
                  )}
                </div>
                {m.role === "assistant" ? (
                  <AssistantMessage text={m.text} />
                ) : (
                  <p>{m.text}</p>
                )}
              </article>
            ))}
            {failedInputs.map((e) => (
              <p className="error" key={e.event_id}>
                这条输入未完成。撤回后可核对旧SQL，或重新补充条件。
                <button
                  onClick={() => void withdraw(String(e.payload.message_id))}
                >
                  撤回未完成输入
                </button>
              </p>
            ))}
            {snapshot.runs.some((r) => r.state === "failed") && (
              <p className="error">
                有一轮处理失败，已保存的记录仍可回看。可补充消息继续。
              </p>
            )}
            {snapshot.runs.some((r) => r.state === "cancelled") && (
              <p className="quiet" role="status">
                本次生成已停止，已保存的任务仍可查看。
              </p>
            )}
            {currentRun && (
              <div className="activity" role="status">
                <i />
                正在调查并保存结果{" "}
                <button onClick={() => void cancel()}>停止生成</button>
              </div>
            )}
          </div>
        )}
        {snapshot?.tasks.length ? (
          <section className="task-results" aria-label="已保存的任务">
            <div className="task-strip">
              <span className="eyebrow">
                分析任务 · {snapshot.tasks.length}
              </span>
              {snapshot.tasks.length > 1 && (
                <select
                  aria-label="筛选分析任务"
                  value={task ?? ""}
                  onChange={(e) => setTask(e.target.value || null)}
                >
                  <option value="">查看所有任务</option>
                  {snapshot.tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.goal.slice(0, 32)}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {snapshot.tasks
              .filter((t) => !task || t.id === task)
              .map((t) => (
                <details key={t.id} className="task">
                  <summary>
                    <strong>{t.goal}</strong>
                    <span>
                      条件版本 {t.condition_version} ·{" "}
                      {t.lifecycle === "cancelled"
                        ? "已取消"
                        : t.phase === "waiting_clarification"
                          ? "等待你的补充"
                          : "已保存"}
                    </span>
                  </summary>
                  <small>任务 {t.id}</small>
                  <button
                    disabled={t.lifecycle === "cancelled"}
                    onClick={() => draftInput(`[task:${t.id}] `)}
                  >
                    继续这个任务
                  </button>
                  {t.lifecycle !== "cancelled" && (
                    <button
                      onClick={() => void cancelTask(t.id, t.condition_version)}
                    >
                      取消这个任务
                    </button>
                  )}
                </details>
              ))}
          </section>
        ) : null}
        <div className="query-stack">
          {queries.queries
            .filter((q) => !task || q.task_id === task)
            .map((q) => (
              <QueryCard
                key={q.id}
                query={q}
                blocked={queries.confirmation_blocked || sending}
                onRefresh={() => setRevision((v) => v + 1)}
                onRevise={draftInput}
                onEvidence={onEvidence}
              />
            ))}
        </div>
        <div className="composer">
          <label className="sr-only" htmlFor="question">
            你的数据问题
          </label>
          <textarea
            ref={textarea}
            id="question"
            value={text}
            onChange={(e) => changeText(e.target.value)}
            placeholder="继续提问，或补充、纠正已有任务…"
            rows={3}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-footer">
            <span>Enter 发送 · Shift + Enter 换行</span>
            <button
              disabled={sending || !text.trim()}
              onClick={() => void submit()}
            >
              {sending ? "保存中…" : "发送 ↑"}
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <p className="footnote">合成资料 · {modelLabel} · 新查询始终由你确认</p>
        {deleteId && (
          <Modal title="删除这个会话？" onClose={() => setDeleteId(null)}>
            <p>
              删除后不再加载此会话，未执行查询会取消；正在运行的查询会向平台申请取消。你的个人记忆和Skill可在“我的积累”单独管理。
            </p>
            <button
              className="primary"
              onClick={() => void removeConversation()}
            >
              删除此会话
            </button>
          </Modal>
        )}
        {showHistory && (
          <Modal title="全部会话" onClose={() => setShowHistory(false)}>
            <label className="search-box">
              <input
                aria-label="搜索会话"
                value={historySearch}
                placeholder="按标题搜索"
                onChange={(e) => setHistorySearch(e.target.value)}
              />
            </label>
            <nav className="history-dialog">
              {historyItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setCid(item.id);
                    setShowHistory(false);
                  }}
                >
                  {item.title ?? "会话 " + item.id.slice(0, 8)}
                  <small>{item.id}</small>
                </button>
              ))}
            </nav>
            {historyNext && <button disabled={historyBusy} onClick={() => void refreshHistory(historySearch, historyNext).catch(e => setError(e.message))}>加载更多会话</button>}
            {historyBusy && <p role="status">正在查找会话…</p>}
            <div className="actions">
              {historyItems.map((item) => (
                <button key={item.id} onClick={() => setDeleteId(item.id)}>
                  删除会话 {item.title ?? item.id.slice(0, 8)}
                </button>
              ))}
            </div>
          </Modal>
        )}
      </section>
    </WorkspaceShell>
  );
}
