import { useEffect, useLayoutEffect, useState, useRef } from "react";
import type {
  Snapshot,
  QueryList,
  HistoryItem,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { WorkspaceShell, type View } from "../../shared/WorkspaceShell.tsx";
import { Icon } from "../../shared/Icon.tsx";
import { Modal } from "../../shared/Modal.tsx";
import { conversationItems, displayUserMessage, mergeSnapshot } from "./conversation-timeline.ts";
import { SkillSelections } from "./SkillSelections.tsx";
import { QueryCard } from "./QueryCard.tsx";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { useModelSelection } from "./useModelSelection.ts";
const creationTime = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
export function Workbench({
  user,
  modelLabel,
  onLogout,
  onView,
  onManageSkills,
  onEvidence,
}: {
  user: string;
  modelLabel: string;
  onLogout: () => void;
  onView: (v: View) => void;
  onManageSkills: () => void;
  onEvidence: (id: string, summary?: string, version?: string) => void;
}) {
  const [cid, setCid] = useState<string | null>(() =>
    localStorage.getItem("data-agent.conversation." + user),
  );
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const model = useModelSelection(user, cid);
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
  const [syncUnavailable, setSyncUnavailable] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [, setRevision] = useState(0);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  const historyGeneration = useRef(0);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = Math.min(160, Math.max(52, input.scrollHeight)) + "px";
  }, [text]);
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
    setSyncUnavailable(false);
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
          setSyncUnavailable(false);
        }
      } catch {
        if (current) setSyncUnavailable(true);
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
    if (!text.trim() || sending || !model.ready) return;
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
        { client_message_id: crypto.randomUUID(), text: input, ...(model.selection ? { model_selection: model.selection } : {}) },
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
      <div className="history-label">最近对话</div>
      <nav className="history-nav" aria-label="会话历史">
        {history.slice(0, 12).map((item, index) => (
          <button
            key={item.id}
            aria-current={cid === item.id ? "true" : undefined}
            onClick={() => setCid(item.id)}
          >
            <span>{item.title || "会话 " + (history.length - index)}</span>
            {item.created_at && <small><time dateTime={item.created_at}>创建于 {creationTime(item.created_at)}</time></small>}
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
      modelLabel={model.models.find(item => item.id === model.selection?.model_id)?.label ?? modelLabel}
      onLogout={onLogout}
      view="workbench"
      onView={onView}
      sidebar={side}
      title={history.find(item => item.id === cid)?.title || "新对话"}
      onNewConversation={() => { setCid(null); setText(localStorage.getItem(draftKey(null)) ?? ""); textarea.current?.focus(); }}
    >
      <section
        className={
          "conversation " + (!snapshot?.messages.length ? "empty" : "")
        }
      >
        <ConversationFeed key={user + ":" + (cid ?? "new")} firstEventSeq={snapshot?.first_event_seq}>
        {!snapshot?.messages.length ? (
          <div className="welcome">
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
            {conversationItems(snapshot, queries.queries).map(item => item.kind === "query" ? (
              <div key={item.key} className="message assistant query-message">
                <div className="message-label">Data Agent · 查询</div>
                <QueryCard query={item.query} onRefresh={() => setRevision(v => v + 1)} onEvidence={onEvidence}/>
              </div>
            ) : item.kind === "query_notice" ? (
              <div key={item.key} className="query-notice" role="status">
                <span>{item.text} · {item.query.summary}</span>
                <button className="text-link" onClick={() => {
                  const target = document.getElementById("query-" + item.query.id);
                  const previous = target?.closest<HTMLDetailsElement>("details.previous-query");
                  if (previous) previous.open = true;
                  target?.scrollIntoView({ block: "start" });
                  target?.focus({ preventScroll: true });
                }}>{item.query.execution_state === "succeeded" ? "查看结果" : "查看查询"}</button>
              </div>
            ) : (() => { const m = item.message; const display = displayUserMessage(m.text, snapshot.tasks); return (
              <article
                key={item.key}
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
                  <>{display.subject && <small className="reply-subject">针对：{display.subject}</small>}<p>{display.text}</p></>
                )}
              </article>
            ); })())}
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
                本次生成已停止，已保存的消息仍可查看。
              </p>
            )}
            {currentRun && (
              <div className="activity" role="status">
                <i />
                正在查阅资料并分析{" "}
                <button onClick={() => void cancel()}>停止生成</button>
              </div>
            )}
          </div>
        )}
        </ConversationFeed>
        {cid && <SkillSelections key={user + ":" + cid} cid={cid} onManage={onManageSkills}/> }
        <div className="composer">
          <label className="sr-only" htmlFor="question">
            你的数据问题
          </label>
          <textarea
            ref={textarea}
            id="question"
            maxLength={32000}
            value={text}
            onChange={(e) => changeText(e.target.value)}
            placeholder="继续提问，或补充、纠正刚才的内容…"
            rows={2}
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
            <div className="composer-tools"><button className="skill-selection-trigger" aria-label="＋ 选用分析方法" onClick={onManageSkills}><Icon name="spark"/><span>分析方法</span></button><ModelSelector models={model.models} selection={model.selection} disabled={sending || model.busy} onChange={selection => void model.change(selection)} /></div>
            <button
              aria-label={sending ? "保存中…" : "发送 ↑"}
              className="send-button"
              disabled={sending || !model.ready || !text.trim()}
              onClick={() => void submit()}
            >
              {sending ? "…" : <Icon name="up"/>}
            </button>
          </div>
        </div>
        {model.error && <p role="alert" className="error model-selection-error">{model.error} <button className="text-link" onClick={() => void model.reload()}>重新读取</button></p>}
        {syncUnavailable && <p className="quiet conversation-sync" role="status">暂时无法更新对话，正在重试…</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <p className="footnote">Enter 发送 · Shift + Enter 换行</p>
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
            <nav className="history-dialog" aria-label="全部会话">
              {historyItems.map(item => <div className="history-row" key={item.id}><button onClick={() => { setCid(item.id); setShowHistory(false); }}><span>{item.title || "未命名会话"}</span>{item.created_at && <small><time dateTime={item.created_at}>创建于 {creationTime(item.created_at)}</time></small>}</button><button className="history-delete" aria-label={"删除会话 " + (item.title || "未命名会话")} onClick={() => setDeleteId(item.id)}>删除</button></div>)}
            </nav>
            {!historyItems.length && !historyBusy && <p className="quiet">没有找到符合条件的会话，请调整搜索词。</p>}
            {historyNext && <button disabled={historyBusy} onClick={() => void refreshHistory(historySearch, historyNext).catch(e => setError(e.message))}>加载更多会话</button>}
            {historyBusy && <p role="status">正在查找会话…</p>}

          </Modal>
        )}
      </section>
    </WorkspaceShell>
  );
}
