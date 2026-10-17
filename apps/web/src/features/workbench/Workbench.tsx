import { useEffect, useLayoutEffect, useState, useRef } from "react";
import type {
  Snapshot,
  QueryList,
  HistoryItem,
  AnalysisReportRef,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api, ApiError } from "../../shared/api.ts";
import { decodeContract } from "../../../../../packages/contracts/validate.ts";
import { WorkspaceShell, type View } from "../../shared/WorkspaceShell.tsx";
import { Icon } from "../../shared/Icon.tsx";
import { Modal } from "../../shared/Modal.tsx";
import { conversationItems, displayUserMessage, mergeSnapshot } from "./conversation-timeline.ts";
import { SkillSelections } from "./SkillSelections.tsx";
import { conversationTitle } from "./conversation-title.ts";
import { QueryCard } from "./QueryCard.tsx";
import { AnalysisReport } from "./AnalysisReport.tsx";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { useModelSelection } from "./useModelSelection.ts";
import { clearPendingSubmission, conversationStorageKey, draftStorageKey, pendingSubmissionKey, readPendingSubmission, settleSubmission, storePendingSubmission, writeDraft, type PendingSubmission } from "./conversation-storage.ts";
const creationTime = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
export function Workbench({
  user,
  space,
  modelLabel,
  onLogout,
  onView,
  onManageSkills,
  onEvidence,
}: {
  user: string;
  space: string;
  modelLabel: string;
  onLogout: () => void;
  onView: (v: View) => void;
  onManageSkills: () => void;
  onEvidence: (id: string, summary?: string, version?: string) => void;
}) {
  const [cid, setCid] = useState<string | null>(() =>
    localStorage.getItem(conversationStorageKey(space, user)),
  );
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const model = useModelSelection(space, user, cid);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [queries, setQueries] = useState<QueryList>({
    queries: [],
    confirmation_blocked: false,
  });
  const [text, setText] = useState(() =>
    localStorage.getItem(draftStorageKey(space, user, cid)) ?? "",
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [syncUnavailable, setSyncUnavailable] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedReport, setSelectedReport] = useState<AnalysisReportRef | null>(null);
  useEffect(() => { setSelectedReport(null); }, [cid, space, user]);
  const [historySearch, setHistorySearch] = useState("");
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  const [pendingError, setPendingError] = useState("");
  const [unavailableSubmissionDraft, setUnavailableSubmissionDraft] = useState<string | null>(null);
  const requestRefresh = useRef<() => void>(() => {});
  const sendingRef = useRef(false);
  const mounted = useRef(true);
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
  if (activeConversation.current !== cid) {
    activeConversation.current = cid;
    viewGeneration.current += 1;
  }
  const [loadingOlder, setLoadingOlder] = useState(false);
  const draftKey = (id: string | null) =>
    draftStorageKey(space, user, id);
  const changeText = (value: string) => {
    setText(value);
    writeDraft(space, user, cid, value);
  };
  useEffect(() => {
    mounted.current = true;
    const restore = () => {
      try { setPending(readPendingSubmission(space, user)); setPendingError(""); }
      catch { setPendingError("待确认消息的本地记录无法读取。请保留当前草稿后重新打开页面。"); }
    };
    restore();
    const changed = (event: StorageEvent) => { if (event.key === pendingSubmissionKey(space, user)) restore(); };
    window.addEventListener("storage", changed);
    return () => { mounted.current = false; window.removeEventListener("storage", changed); };
  }, [space, user]);
  useEffect(() => {
    if (localStorage.getItem(conversationStorageKey(space, user))) return;
    const legacy = localStorage.getItem("data-agent.conversation." + user);
    if (!legacy) return;
    let current = true;
    const generation = viewGeneration.current;
    // 旧键没有空间信息，只有服务端确认可读的会话和关联草稿才迁移。
    void api("Snapshot", "/conversations/" + legacy + "/snapshot").then(() => {
      if (!current) return;
      const oldDraft = "data-agent.draft." + user + "." + legacy;
      const destination = draftKey(legacy);
      if (localStorage.getItem(destination) === null && localStorage.getItem(oldDraft) !== null) {
        writeDraft(space, user, legacy, localStorage.getItem(oldDraft) ?? "");
      }
      if (viewGeneration.current === generation && !activeConversation.current && !localStorage.getItem(draftKey(null))) setCid(legacy);
      localStorage.removeItem(oldDraft);
      if (localStorage.getItem("data-agent.conversation." + user) === legacy) localStorage.removeItem("data-agent.conversation." + user);
    }).catch(() => {});
    return () => { current = false; };
  }, [space, user]);
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
  }, [space, user, historySearch]);
  useEffect(() => {
    let current = true;
    snapshotRef.current = null;
    setLoadingOlder(false);
    setSnapshot(null);
    setQueries({ queries: [], confirmation_blocked: false });
    setError("");
    setSyncUnavailable(false);
    setText(localStorage.getItem(draftKey(cid)) ?? "");
    if (cid) localStorage.setItem(conversationStorageKey(space, user), cid);
    else localStorage.removeItem(conversationStorageKey(space, user));
    let refreshing = false;
    let refreshAgain = false;
    let quietCycles = 0;
    let timer: number | undefined;
    let activeUntil = 0;
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      if (current && cid && !document.hidden) timer = window.setTimeout(() => void refresh(), delay);
    };
    const refresh = async () => {
      if (!cid || !current || document.hidden) return;
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      let active = false;
      try {
        const [s, q] = await Promise.all([
          api("Snapshot", "/conversations/" + cid + "/snapshot" + (snapshotRef.current?.last_event_seq ? "?after_seq=" + snapshotRef.current.last_event_seq : "")),
          api("QueryList", "/conversations/" + cid + "/queries"),
        ]);
        if (current) {
          const previous = snapshotRef.current;
          snapshotRef.current = mergeSnapshot(previous, s);
          setSnapshot(snapshotRef.current);
          setQueries(old => JSON.stringify(old) === JSON.stringify(q) ? old : q);
          setSyncUnavailable(false);
          active = s.runs.some(run => run.state === "running") || q.queries.some(query => ["queued", "submitting", "submission_unknown", "running"].includes(query.execution_state));
          quietCycles = active ? 0 : quietCycles + 1;
        }
      } catch {
        if (current) setSyncUnavailable(true);
        quietCycles++;
      } finally {
        refreshing = false;
        if (refreshAgain) { refreshAgain = false; schedule(0); }
        else schedule(active || Date.now() < activeUntil ? 700 : quietCycles < 2 ? 1500 : quietCycles < 3 ? 5000 : 15000);
      }
    };
    const wake = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      quietCycles = 0;
      activeUntil = Date.now() + 3000;
      void refresh();
    };
    requestRefresh.current = wake;
    void refresh();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      current = false;
      window.clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [cid, space, user]);
  const sendPending = async (submission: PendingSubmission) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    const generation = viewGeneration.current;
    let messageAttempted = false;
    try {
      const identity = await api("Identity", "/session");
      if (identity.user_id !== submission.user || identity.space_id !== submission.space) {
        throw new Error("登录身份已变化，请重新进入原账号和空间后重试；原消息与草稿仍保留。");
      }
      let conversation = submission.conversation_id;
      if (!conversation) {
        conversation = (
          await api("ConversationReceipt", "/conversations", "POST", {
            operation_id: submission.creation_operation_id,
          })
        ).conversation_id;
        submission = { ...submission, conversation_id: conversation };
        if (readPendingSubmission(space, user)?.input.client_message_id !== submission.input.client_message_id) return;
        storePendingSubmission(submission);
        if (mounted.current) setPending(submission);
      }
      if (!mounted.current) return;
      messageAttempted = true;
      await api(
        "MessageReceipt",
        "/conversations/" + conversation + "/messages",
        "POST",
        submission.input,
      );
      const nextDraft = settleSubmission(submission, conversation);
      if (!mounted.current) return;
      setPending(readPendingSubmission(space, user));
      if (viewGeneration.current === generation && cid === submission.origin_conversation_id) {
        if (cid === conversation) model.afterMessageSaved();
        if (!submission.origin_conversation_id) setCid(conversation);
        setText(nextDraft);
      }
      requestRefresh.current();
      void refreshHistory().catch(() => { if (mounted.current) setError("消息已保存，暂时无法更新会话列表。"); });
    } catch (e) {
      // 参数明确被拒绝时事务未保存消息；网络错误和未知回执必须继续使用原操作身份。
      const rejected = messageAttempted && e instanceof ApiError && e.code === "invalid_input";
      const unavailable = messageAttempted && e instanceof ApiError && e.code === "not_available";
      if (rejected || unavailable) clearPendingSubmission(submission);
      if (mounted.current) {
        setPending(readPendingSubmission(space, user));
        if (unavailable) {
          // 不可读不等于未保存；原草稿只供查看，不转入新对话或自动重发执行意图。
          setUnavailableSubmissionDraft(localStorage.getItem(draftKey(submission.origin_conversation_id)) ?? "");
        }
        if (viewGeneration.current === generation) setError(unavailable ? "" : rejected
          ? "消息内容或当前模型设置未被接受，尚未保存。草稿已保留，请修改内容或重新选择模型后发送。"
          : e instanceof Error && e.message.startsWith("登录身份已变化") ? e.message
          : "消息的保存回执尚未确认。请重试原消息，正在编辑的草稿会保留。");
      }
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };
  const submit = async () => {
    if (!text.trim() || sendingRef.current || !model.ready || pendingError) return;
    try {
      const existing = readPendingSubmission(space, user);
      if (existing) { setPending(existing); return; }
      const submission: PendingSubmission = {
        schema_version: 1, space, user, origin_conversation_id: cid, conversation_id: cid,
        creation_operation_id: crypto.randomUUID(),
        input: { client_message_id: crypto.randomUUID(), text: text.trim(), ...(model.selection ? { model_selection: model.selection } : {}) },
        draft_text: text, draft_revision: localStorage.getItem(draftKey(cid) + ".revision") ?? "",
      };
      try { decodeContract("MessageInput", submission.input); }
      catch {
        setError("消息内容或模型设置不符合要求，请缩短内容或重新选择模型后发送。草稿已保留。");
        return;
      }
      storePendingSubmission(submission);
      setPending(submission);
      await sendPending(submission);
    } catch (e) { setError(e instanceof Error ? e.message : "无法保存待发送消息，请保留当前草稿。"); }
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
      requestRefresh.current();
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
      requestRefresh.current();
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
            <span title={item.title}>{conversationTitle(item.title) || "会话 " + (history.length - index)}</span>
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
      title={conversationTitle(history.find(item => item.id === cid)?.title ?? "") || "新对话"}
      onNewConversation={() => { setCid(null); setText(localStorage.getItem(draftKey(null)) ?? ""); textarea.current?.focus(); }}
    >
      <section
        className={
          "conversation " + (!snapshot?.messages.length ? "empty" : "")
        }
      >
        <ConversationFeed key={"feed:" + user + ":" + (cid ?? "new")} firstEventSeq={snapshot?.first_event_seq}>
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
                <QueryCard query={item.query} onRefresh={() => requestRefresh.current()} onEvidence={onEvidence}/>
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
            ) : item.kind === "report" ? (
              <div key={item.key} className="report-notice" role="status"><span>{item.conditionChanged ? "分析条件已更新，报告需重新整理" : "分析报告已保存"}</span><button className="text-link" onClick={() => setSelectedReport(item.reference)}>查看分析报告</button></div>
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
                  <AssistantMessage text={m.text} savedSql={queries.queries.map(query => query.sql)} />
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
        {cid && <SkillSelections key={"skills:" + space + ":" + user + ":" + cid} cid={cid} onManage={onManageSkills} refreshRevision={snapshot?.runs.map(run => run.run_id + ":" + run.state).join(",")}/> }
        {pending && !sending && <p className="pending-message" role="status">上一条消息的保存回执尚未确认。重试会发送原内容，保留你正在编辑的草稿。<button onClick={() => void sendPending(pending)}>重试原消息</button></p>}
        {unavailableSubmissionDraft !== null && <div className="pending-message" role="status">
          <p>原对话已删除或不可访问，无法继续核对原消息是否已保存。已结束这次重试；请新建对话继续。</p>
          {unavailableSubmissionDraft && <details><summary>查看原对话保留的草稿</summary><textarea aria-label="原对话保留的草稿" readOnly rows={4} style={{width: "100%"}} value={unavailableSubmissionDraft}/></details>}
          <button onClick={() => setUnavailableSubmissionDraft(null)}>收起此提示</button>
        </div>}
        {pendingError && <p className="error" role="alert">{pendingError}</p>}
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
              disabled={sending || !!pending || !!pendingError || !model.ready || !text.trim()}
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
        {selectedReport && selectedReport.conversation_id === cid && <AnalysisReport
          reference={snapshot?.tasks.find(task => task.id === selectedReport.task_id)?.report_ref ?? selectedReport}
          currentConditionVersion={snapshot?.tasks.find(task => task.id === selectedReport.task_id)?.condition_version}
          onClose={() => setSelectedReport(null)}
          onQuery={queryId => {
            setSelectedReport(null);
            window.requestAnimationFrame(() => {
              const target = document.getElementById("query-" + queryId);
              const previous = target?.closest<HTMLDetailsElement>("details.previous-query");
              if (previous) previous.open = true;
              target?.scrollIntoView({ block: "start" });
              target?.focus({ preventScroll: true });
            });
          }}
          onEvidence={(id, summary, version) => { setSelectedReport(null); window.requestAnimationFrame(() => onEvidence(id, summary, version)); }}
        />}
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
              {historyItems.map(item => <div className="history-row" key={item.id}><button onClick={() => { setCid(item.id); setShowHistory(false); }}><span title={item.title}>{conversationTitle(item.title) || "未命名会话"}</span>{item.created_at && <small><time dateTime={item.created_at}>创建于 {creationTime(item.created_at)}</time></small>}</button><button className="history-delete" aria-label={"删除会话 " + (item.title || "未命名会话")} onClick={() => setDeleteId(item.id)}>删除</button></div>)}
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
