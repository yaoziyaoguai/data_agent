import { useEffect, useLayoutEffect, useState, useRef, useMemo, useSyncExternalStore } from "react";
import type {
  Asset,
  QueryHistoryItem,
  HistoryItem,
  AnalysisReportRef,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api, ApiError } from "../../shared/api.ts";
import { decodeContract } from "../../../../../packages/contracts/validate.ts";
import { WorkspaceShell, type View } from "../../shared/WorkspaceShell.tsx";
import { Icon } from "../../shared/Icon.tsx";
import { Tabs } from "../../shared/Tabs.tsx";
import { Modal } from "../../shared/Modal.tsx";
import { conversationItems, displayUserMessage } from "./conversation-timeline.ts";
import { SkillSelections } from "./SkillSelections.tsx";
import { ConversationSkillPicker } from "./ConversationSkillPicker.tsx";
import { ConversationHistoryModal, formatConversationCreationTime as creationTime } from "./ConversationHistoryModal.tsx";
import { conversationTitle } from "./conversation-title.ts";
import { QueryCard } from "./QueryCard.tsx";
import { AnalysisReport } from "./AnalysisReport.tsx";
import { KnowledgeEvidence } from "../knowledge/KnowledgeEvidence.tsx";
import { QueryResultPanel } from "./QueryResultPanel.tsx";
import "./workbench-dock.css";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { objectReferenceLabels } from "./object-reference-labels.ts";
import { ConversationFeed, type FeedScrollMemory } from "./ConversationFeed.tsx";
import { CompletedRunSteps, RunActivity } from "./RunActivity.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { useLiveConversation } from "./useLiveConversation.ts";
import { useModelSelection } from "./useModelSelection.ts";
import { clearPendingSubmission, conversationStorageKey, draftStorageKey, pendingSubmissionKey, readPendingSubmission, settleSubmission, storePendingSubmission, writeDraft, type PendingSubmission } from "./conversation-storage.ts";
const runFailureReason = (code: unknown): string => ({
  model_auth_failed: "模型凭据无效或无权限，请检查模型配置中的 API Key。",
  model_quota_exhausted: "模型供应商账户额度不足。",
  model_budget_exhausted: "本次会话或试验预算已用尽。",
  budget_exhausted: "本次会话或试验预算已用尽。",
  provider_model_unavailable: "所选模型在供应商侧不可用，请检查 Model ID。",
  model_unavailable: "所选模型或关联服务已停用，请重新选择模型。",
  provider_configuration_invalid: "模型或思考档位配置与供应商协议不匹配。",
  model_input_limit: "请求内容超过模型的输入或请求体字节上限（可在模型配置中调大请求体 MiB）。",
  request_too_large: "请求内容超过模型的输入或请求体字节上限（可在模型配置中调大请求体 MiB）。",
  model_output_limit: "模型输出超过配置的最大输出上限。",
  model_limits_exceeded: "模型调用超出配置的输入或输出上限。",
  model_timeout: "模型响应超时。",
  model_rate_limited: "模型请求触发限流，请稍后重试。",
  retry_exhausted: "模型服务连续临时失败，请稍后重试。",
  model_retry_exhausted: "模型服务连续临时失败，请稍后重试。",
  stale_context: "对话引用的表权限、知识或资产状态已变化。",
  source_unavailable: "平台权限或来源服务暂时不可达，请稍后重试。",
} as Record<string, string>)[String(code ?? "")] ?? "";
type WorkbenchDetail =
  | { kind: "report"; reference: AnalysisReportRef }
  | { kind: "results"; queryId: string }
  | { kind: "evidence"; id: string; summary?: string; version?: string };

const panelLabel = {report: "分析报告", results: "查询结果", evidence: "口径依据"};
const wideQuery = "(min-width: 1280px)";
const dockMinimum = 36;
const dockMaximum = 60;
const clampDockWidth = (width: number) => Math.min(dockMaximum, Math.max(dockMinimum, width));
const dockedViewport = () => window.matchMedia(wideQuery).matches;
const subscribeViewport = (listener: () => void) => {
  const viewport = window.matchMedia(wideQuery);
  viewport.addEventListener("change", listener);
  return () => viewport.removeEventListener("change", listener);
};


function describeConversationFocus(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target.id === "question") return "#question";
  const card = target.closest<HTMLElement>(".query-card[id]");
  if (card?.id) return "#" + CSS.escape(card.id);
  if (target.classList.contains("skill-selection-trigger")) return 'button[aria-label="＋ 选用分析方法"]';
  return null;
}

export function Workbench({
  user,
  space,
  modelLabel,
  onLogout,
  onView,
  onSelectSkill,
  onManageSkills,
  onMaintainEvidence,
  spaceName,
  savedContext,
  onContextChange,
  onScrollChange,
  onFocusSelectorChange,
  onReturnFocusConsumed,
}: {
  user: string;
  space: string;
  modelLabel: string;
  onLogout: () => void;
  onView: (v: View) => void;
  onSelectSkill: (asset: Asset) => Promise<string>;
  onManageSkills: () => void;
  onMaintainEvidence: (id: string) => void;
  spaceName: string;
  savedContext?: { cid: string | null; title: string; scroll: FeedScrollMemory | null } | null;
  onContextChange?: (cid: string | null, title: string) => void;
  onScrollChange?: (state: { scrollTop: number; followLatest: boolean }) => void;
  onFocusSelectorChange?: (selector: string | null) => void;
  onReturnFocusConsumed?: () => void;
}) {
  const [cid, setCid] = useState<string | null>(() =>
    localStorage.getItem(conversationStorageKey(space, user)),
  );
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillRefreshRevision, setSkillRefreshRevision] = useState(0);
  const [recentHistory, setRecentHistory] = useState<HistoryItem[]>([]);
  const [selectedHistoryTitle, setSelectedHistoryTitle] = useState<Record<string, string>>({});
  const [appliedMessageIds, setAppliedMessageIds] = useState<string[]>([]);
  const model = useModelSelection(space, user, cid);
  const { snapshot, queries, loadingOlder, syncUnavailable, authorityRevision, requestOlder, requestReconnect } = useLiveConversation(cid, space, user);
  const technicalIdsKey = "data-agent.technical-identifiers." + JSON.stringify([space, user]);
  const [showTechnicalIds, setShowTechnicalIds] = useState(() => localStorage.getItem(technicalIdsKey) === "true");
  useEffect(() => { setShowTechnicalIds(localStorage.getItem(technicalIdsKey) === "true"); }, [technicalIdsKey]);
  const objectReferences = useMemo(() => objectReferenceLabels(snapshot, queries.queries), [snapshot, queries.queries]);
  const savedSql = useMemo(() => queries.queries.flatMap(query => query.sql ? [query.sql] : []), [queries.queries]);
  const [text, setText] = useState(() =>
    localStorage.getItem(draftStorageKey(space, user, cid)) ?? "",
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const pendingQueryJump = useRef<string | null>(null);
  const docked = useSyncExternalStore(subscribeViewport, dockedViewport, () => false);
  const [dockWidth, setDockWidth] = useState(48);
  const dock = useRef<HTMLDivElement>(null);
  const returnPanelFocus = useRef<{opener: HTMLElement | null} | null>(null);
  const focusMovedWithinDock = useRef(false);
  const [panel, setPanel] = useState<{
    conversation: string | null;
    views: (WorkbenchDetail & {opener: HTMLElement | null})[];
    active: WorkbenchDetail["kind"];
  } | null>(null);
  const open = panel?.conversation === cid ? panel : null;
  const closePanel = () => {
    if (open && (!docked || dock.current?.contains(document.activeElement))) {
      returnPanelFocus.current = {opener: open.views.find(view => view.kind === open.active)?.opener ?? null};
    }
    setPanel(previous => {
      if (!previous) return null;
      const views = previous.views.filter(view => view.kind !== previous.active);
      const last = views.at(-1);
      return last ? { ...previous, views, active: last.kind } : null;
    });
  };
  const openPanel = (detail: WorkbenchDetail) => {
    const focused = document.activeElement;
    focusMovedWithinDock.current = Boolean(docked && focused instanceof HTMLElement && dock.current?.contains(focused));
    const view = {...detail, opener: focused instanceof HTMLElement ? focused : null};
    setPanel(previous => {
      const views = previous?.conversation === cid ? previous.views : [];
      const next = views.some(existing => existing.kind === detail.kind)
        ? views.map(existing => existing.kind === detail.kind ? view : existing)
        : [...views, view];
      return { conversation: cid, views: next, active: detail.kind };
    });
  };
  const openEvidence = (id: string, summary?: string, version?: string) => openPanel({kind: "evidence", id, summary, version});
  useEffect(() => { setPanel(null); }, [cid]);
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  const [pendingError, setPendingError] = useState("");
  const [unavailableSubmissionDraft, setUnavailableSubmissionDraft] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const pending = returnPanelFocus.current;
    if (pending) {
      returnPanelFocus.current = null;
      const target = pending.opener?.getClientRects().length && pending.opener !== document.body
        ? pending.opener
        : dock.current?.querySelector<HTMLElement>('.workbench-dock-view:not([hidden]) .modal-head button')
          ?? dock.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
          ?? textarea.current;
      target?.focus({ preventScroll: true });
      return;
    }
    const activeElement = document.activeElement;
    const hiddenDockFocus =
      activeElement instanceof HTMLElement &&
      Boolean(dock.current?.contains(activeElement)) &&
      Boolean(activeElement.closest("[hidden]"));
    if (docked && open && (focusMovedWithinDock.current || !activeElement || activeElement === document.body || hiddenDockFocus)) {
      focusMovedWithinDock.current = false;
      const dockBack = dock.current?.querySelector<HTMLElement>('.workbench-dock-view:not([hidden]) .modal-head button');
      dockBack?.focus({ preventScroll: true });
    }
  }, [open, docked]);
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
  const refreshHistory = async () => {
    const page = await api("History", "/conversations?q=");
    if (mounted.current) setRecentHistory(page.conversations);
  };
  useEffect(() => {
    void refreshHistory().catch(() => {});
  }, [space, user]);
  useEffect(() => {
    setError("");
    setAppliedMessageIds([]);
    setText(localStorage.getItem(draftKey(cid)) ?? "");
    if (cid) localStorage.setItem(conversationStorageKey(space, user), cid);
    else localStorage.removeItem(conversationStorageKey(space, user));
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
      void refreshHistory().catch(() => { if (mounted.current) setError("消息已保存，暂时无法更新会话列表。"); });
    } catch (e) {
      // 参数或模型明确被拒绝时事务未保存消息；网络错误和未知回执仍沿原操作身份。
      const rejected = messageAttempted && e instanceof ApiError
        && (e.code === "invalid_input" || e.code === "model_unavailable");
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
  const loadOlder = () => { if (!loadingOlder) requestOlder.current(); };
  // U-04：定位查询卡片；未加载的事件先请求更早一页再重试，有界次数后放弃并提示。
  const jumpToQuery = (queryId: string) => {
    let attempts = 0;
    const attempt = () => {
      const target = document.getElementById("query-" + queryId);
      if (target) {
        const previous = target.closest<HTMLDetailsElement>("details.previous-query");
        if (previous) previous.open = true;
        target.scrollIntoView({ block: "start" });
        target.focus({ preventScroll: true });
        return;
      }
      if (++attempts > 10) { setError("这条查询未在当前已加载的对话内容中定位到，可在对话内继续加载更早消息后重试。"); return; }
      requestOlder.current();
      window.setTimeout(attempt, 400);
    };
    window.requestAnimationFrame(attempt);
  };
  const openQueryFromHistory = (item: QueryHistoryItem) => {
    if (item.conversation_id === cid) { jumpToQuery(item.id); return; }
    pendingQueryJump.current = item.id;
    setCid(item.conversation_id);
  };
  useEffect(() => {
    const pending = pendingQueryJump.current;
    if (!snapshot || !pending) return;
    pendingQueryJump.current = null;
    jumpToQuery(pending);
  }, [snapshot]);
  // ⌘/Ctrl + K 新建对话；输入法组合与文本编辑快捷键不受影响（仅监听组合键）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCid(null);
        setText(localStorage.getItem(draftKey(null)) ?? "");
        textarea.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const withdraw = async (message: string) => {
    if (!cid) return;
    try {
      await api(
        "MutationReceipt",
        "/conversations/" + cid + "/messages/" + message + "/withdraw",
        "POST",
        { operation_id: crypto.randomUUID() },
      );
    } catch (e) {
      if (e instanceof Error && e.message === "input_already_applied") {
        setAppliedMessageIds(old => old.includes(message) ? old : [...old, message]);
        setError("这条输入已经应用到任务。请补充新消息修订条件，不能撤回已经生效的修改。");
      } else {
        setError(String(e));
      }
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
  // 阶段提示只看最新run与当前attempt；旧轮取消/失败历史沿原消息保留，不再以"本次"名义常驻。
  const latestRun = snapshot?.runs.at(-1);
  const finishedRuns = useMemo(() => new Map(snapshot?.runs
    .filter(run => run.state === "finished")
    .map(run => [run.attempt_id, run.run_id])), [snapshot?.runs]);

  const currentAttemptStarted = currentRun?.attempt_id != null && (snapshot?.events.some(
    (e) => (e.type === "assistant_delta" || e.type === "assistant_committed") && e.payload.attempt_id === currentRun.attempt_id,
  ) ?? false);
  // P-05：服务端把最近登记的工具映射为中文动作提示；本attempt最新事件已是正文
  // 增量而非工具回执时，工具阶段已结束，提示切换为生成回答，不沿用旧工具文案。
  const lastActivityEvent = snapshot?.events.filter(
    (e) => e.type === "tool_result" || (e.type === "assistant_delta" && e.payload.attempt_id === currentRun?.attempt_id),
  ).at(-1);
  const writingAnswer = currentAttemptStarted && lastActivityEvent?.type === "assistant_delta";
  const activityText = currentRun?.purpose === "query_result"
    ? "正在解读查询结果"
    : writingAnswer
      ? "正在生成回答"
      : currentRun?.activity_label ?? (currentAttemptStarted ? "正在生成回答" : "正在处理本次请求");
  const cancel = async () => {
    if (!cid || !currentRun) return;
    try {
      await api(
        "CancelReceipt",
        "/conversations/" + cid + "/cancel-run",
        "POST",
        { run_id: currentRun.run_id, lease_epoch: currentRun.lease_epoch },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "停止失败");
    }
  };
  const draftInput = (value: string) => {
    changeText(value);
    textarea.current?.focus();
  };
  const side = (
    <>
      <div className="history-label">最近对话</div>
      <nav className="history-nav" aria-label="会话历史">
        {recentHistory.slice(0, 12).map((item, index) => (
          <button
            key={item.id}
            aria-current={cid === item.id ? "true" : undefined}
            onClick={() => setCid(item.id)}
          >
            <span title={item.title}>{conversationTitle(item.title) || "会话 " + (recentHistory.length - index)}</span>
            {item.created_at && <small><time dateTime={item.created_at}>创建于 {creationTime(item.created_at)}</time></small>}
          </button>
        ))}
      </nav>
      <button className="history-all" onClick={() => setShowHistory(true)}>
        查看全部会话 ↗
      </button>
      {!recentHistory.length && (
        <p className="quiet">从第一个问题开始，记录会保存在这里。</p>
      )}
    </>
  );
  const resolvedTitle = useMemo(() => {
    if (!cid) return "新对话";
    const matched = recentHistory.find(item => item.id === cid)?.title ?? selectedHistoryTitle[cid];
    if (matched) return conversationTitle(matched) || "对话";
    if (savedContext?.cid === cid && savedContext.title) return savedContext.title;
    const firstUser = snapshot?.messages.find(m => m.role === "user")?.text;
    if (firstUser) return conversationTitle(firstUser) || "对话";
    return "正在载入对话…";
  }, [cid, recentHistory, selectedHistoryTitle, savedContext, snapshot]);
  useEffect(() => {
    onContextChange?.(cid, resolvedTitle);
  }, [cid, resolvedTitle, onContextChange]);
  const loadingConversation = cid !== null && snapshot === null && !syncUnavailable;
  const hasMessages = (snapshot?.messages.length ?? 0) > 0;
  const initialMemory = savedContext?.cid === cid ? savedContext.scroll : null;
  useLayoutEffect(() => {
    if (!cid && initialMemory?.restoreFocus) {
      textarea.current?.focus({ preventScroll: true });
      onReturnFocusConsumed?.();
    }
  }, [cid, initialMemory, onReturnFocusConsumed]);

  return (
    <WorkspaceShell
      user={user}
      modelLabel={model.models.find(item => item.id === model.selection?.model_id)?.label ?? modelLabel}
      onLogout={onLogout}
      view="workbench"
      onView={v => { setShowSkillPicker(false); onView(v); }}
      sidebar={side}
      title={resolvedTitle}
      spaceName={spaceName}
      onNewConversation={() => { setCid(null); setText(localStorage.getItem(draftKey(null)) ?? ""); textarea.current?.focus(); }}
    >
      <div className={"workbench-detail-layout" + (open ? " has-workbench-detail" : "")}
        style={docked && open ? {gridTemplateColumns: `minmax(0, 1fr) 8px ${dockWidth}%`} : undefined}>
      <section
        className={
          "conversation " + (!cid && !hasMessages ? "empty" : "")
        }
        onFocusCapture={event => {
          const selector = describeConversationFocus(event.target);
          if (selector) onFocusSelectorChange?.(selector);
        }}
      >
        <ConversationFeed
          key={"feed:" + user + ":" + (cid ?? "new")}
          firstEventSeq={snapshot?.first_event_seq}
          hasMessages={hasMessages}
          initialMemory={initialMemory}
          onScrollChange={onScrollChange}
          onReturnFocusConsumed={onReturnFocusConsumed}
        >
        {loadingConversation ? (
          <div className="conversation-loading" role="status" aria-live="polite">
            正在载入对话内容…
          </div>
        ) : !snapshot?.messages.length ? (
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
                "查2026年9月语音任务达成率",
                "ASR耗时怎样统计",
                "语音交互链路有哪些表",
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
            {(Object.keys(objectReferences).length > 0 || canLoadOlder) && (
              <div className="messages-toolbar">
                {Object.keys(objectReferences).length > 0 && (
                  <button type="button" className="text-link" aria-pressed={showTechnicalIds} onClick={() => {
                    const next = !showTechnicalIds;
                    setShowTechnicalIds(next);
                    localStorage.setItem(technicalIdsKey, String(next));
                  }}>{showTechnicalIds ? "隐藏技术标识" : "显示技术标识"}</button>
                )}
                {canLoadOlder && (
                  <button className="history-all" onClick={() => void loadOlder()}>
                    加载更早的消息
                  </button>
                )}
              </div>
            )}
            {conversationItems(snapshot, queries.queries).map(item => item.kind === "query" ? (
              <div key={item.key} className="message assistant query-message">
                <div className="message-label">Data Agent · 查询</div>
                <QueryCard query={item.query} authorityRevision={authorityRevision} onEvidence={openEvidence}
                  onOpenResults={() => openPanel({kind: "results", queryId: item.query.id})}/>
              </div>
            ) : item.kind === "query_notice" ? (
              <div key={item.key} className="query-notice" role="status">
                <span>{item.text} · {item.query.text_unavailable ? "来源不可用" : item.query.summary}</span>
                <button className="text-link" onClick={() => {
                  const target = document.getElementById("query-" + item.query.id);
                  const previous = target?.closest<HTMLDetailsElement>("details.previous-query");
                  if (previous) previous.open = true;
                  target?.scrollIntoView({ block: "start" });
                  target?.focus({ preventScroll: true });
                }}>{item.query.text_unavailable ? "查看状态" : item.query.execution_state === "succeeded" ? "查看结果" : "查看查询"}</button>
              </div>
            ) : item.kind === "report" ? (
              <div key={item.key} className="report-notice" role="status"><span>{item.conditionChanged ? "分析条件已更新，报告需重新整理" : "分析报告已保存"}</span><button className="text-link" onClick={() => openPanel({kind: "report", reference: item.reference})}>查看分析报告</button></div>
            ) : (() => { const m = item.message; const display = displayUserMessage(m.text, snapshot.tasks); const finishedRun = m.attempt_id ? finishedRuns.get(m.attempt_id) : undefined; return (
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
                  <><AssistantMessage text={m.text} savedSql={savedSql} objectReferences={showTechnicalIds ? undefined : objectReferences} />
                    {cid && m.committed && finishedRun &&
                      <CompletedRunSteps key={finishedRun} cid={cid} runId={finishedRun}
                        authorityRevision={authorityRevision}/>}</>
                ) : (
                  <>{display.subject && <small className="reply-subject">针对：{display.subject}</small>}<p>{display.text}</p></>
                )}
              </article>
            ); })())}
            {failedInputs.map((e) => {
              const messageId = String(e.payload.message_id);
              const reason = runFailureReason(e.payload.code);
              const alreadyApplied = appliedMessageIds.includes(messageId);
              return (
                <p className="error" key={e.event_id}>
                  这条输入未完成。{reason ? reason + " " : ""}{alreadyApplied ? "条件修改已生效，请直接补充新消息继续。" : "撤回后可核对旧SQL，或重新补充条件。"}
                  {!alreadyApplied && (
                    <button onClick={() => void withdraw(messageId)}>
                      撤回未完成输入
                    </button>
                  )}
                </p>
              );
            })}
            {latestRun?.state === "failed" && (
              <p className="error">
                有一轮处理失败，已保存的记录仍可回看。可补充消息继续。
              </p>
            )}
            {latestRun?.state === "cancelled" && (
              <p className="quiet" role="status">
                本次生成已停止，已保存的消息仍可查看。
              </p>
            )}
          </div>
        )}
        <div className="conversation-feedback">
        {pending && !sending && <p className="pending-message" role="status">上一条消息的保存回执尚未确认。重试会发送原内容，保留你正在编辑的草稿。<button onClick={() => void sendPending(pending)}>重试原消息</button></p>}
        {unavailableSubmissionDraft !== null && <div className="pending-message" role="status">
          <p>原对话已删除或不可访问，无法继续核对原消息是否已保存。已结束这次重试；请新建对话继续。</p>
          {unavailableSubmissionDraft && <details><summary>查看原对话保留的草稿</summary><textarea aria-label="原对话保留的草稿" readOnly rows={4} style={{width: "100%"}} value={unavailableSubmissionDraft}/></details>}
          <button onClick={() => setUnavailableSubmissionDraft(null)}>收起此提示</button>
        </div>}
        {pendingError && <p className="error" role="alert">{pendingError}</p>}
        {model.error && <p role="alert" className="error model-selection-error">{model.error} <button className="text-link" onClick={() => void model.reload()}>重新读取</button></p>}
        {syncUnavailable && <p className="quiet conversation-sync" role="status">暂时无法更新对话。 <button onClick={() => requestReconnect.current()}>重新连接</button></p>}
        {error && <p role="alert" className="error conversation-error">{error}</p>}
        </div>
        </ConversationFeed>
        {currentRun && <RunActivity run={currentRun} label={activityText} onStop={() => void cancel()}/>}
        {cid && <SkillSelections key={"skills:" + space + ":" + user + ":" + cid} cid={cid} onManage={onManageSkills} refreshRevision={skillRefreshRevision + ":" + (snapshot?.runs.map(run => run.run_id + ":" + run.state).join(",") ?? "")}/> }
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
            <div className="composer-tools"><button type="button" className="skill-selection-trigger" aria-label="＋ 选用分析方法" onClick={() => setShowSkillPicker(true)}><Icon name="spark"/><span>分析方法</span></button><ModelSelector models={model.models} selection={model.selection} disabled={sending || model.busy} onChange={selection => void model.change(selection)} /></div>
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
        <p className="footnote">Enter 发送 · Shift + Enter 换行</p>
      </section>
        {docked && open && <div className="workbench-divider" role="separator" tabIndex={0}
          aria-orientation="vertical" aria-label="调整右侧宽度" aria-controls="workbench-details"
          aria-valuemin={dockMinimum} aria-valuemax={dockMaximum} aria-valuenow={dockWidth}
          onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const layout = event.currentTarget.parentElement!.getBoundingClientRect();
            setDockWidth(clampDockWidth(Math.round((layout.right - event.clientX) * 100 / layout.width)));
          }}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setDockWidth(width => clampDockWidth(width + (event.key === "ArrowLeft" ? 2 : -2)));
          }}/>}
        {open && <div id="workbench-details" ref={dock} className={docked ? "workbench-dock-area" : undefined}>
          {docked && open.views.length > 1 && <Tabs label="右侧工作区" value={open.active}
            items={open.views.map(view => ({ value: view.kind, label: panelLabel[view.kind] }))}
            onChange={active => setPanel(previous => previous ? { ...previous, active } : null)}/>}
          {open.views.map(view => {
            const active = view.kind === open.active;
            const nextView = open.views.filter(item => item.kind !== view.kind).at(-1);
            const closeLabel = nextView ? "返回" + panelLabel[nextView.kind] : "返回对话";
            return <div key={view.kind} className={docked ? "workbench-dock-view" : undefined} hidden={docked ? !active : undefined}>
              {view.kind === "report" && <AnalysisReport key={view.reference.report_id}
                reference={snapshot?.tasks.find(task => task.id === view.reference.task_id)?.report_ref ?? view.reference}
                authorityRevision={authorityRevision} docked={docked} active={active} closeLabel={closeLabel} closeTitle={closeLabel}
                currentConditionVersion={snapshot?.tasks.find(task => task.id === view.reference.task_id)?.condition_version}
                onClose={closePanel}
                onQuery={queryId => {
                  if (!docked) setPanel(null);
                  jumpToQuery(queryId);
                }}
                onEvidence={openEvidence}/>}
              {view.kind === "results" && <QueryResultPanel key={view.queryId}
                queryId={view.queryId} authorityRevision={authorityRevision} docked={docked} active={active} closeLabel={closeLabel} closeTitle={closeLabel} onClose={closePanel}/>}
              {view.kind === "evidence" && <Modal docked={docked} active={active} restoreFocusOnClose={false} closeTitle={closeLabel} title="口径依据" closeLabel={closeLabel} className="evidence-dialog" onClose={closePanel}
                footer={<button onClick={() => {
                  const openerSelector = describeConversationFocus(view.opener);
                  if (openerSelector) onFocusSelectorChange?.(openerSelector);
                  setPanel(null);
                  onMaintainEvidence(view.id);
                }}>去维护此内容</button>}>
                <div className="evidence-content">
                  <KnowledgeEvidence key={authorityRevision} id={view.id} version={view.version} querySummary={view.summary}/>
                </div>
              </Modal>}
            </div>;
          })}
        </div>}
      </div>
      {showSkillPicker && (
        <ConversationSkillPicker
          cid={cid}
          onClose={() => setShowSkillPicker(false)}
          onSelectSkill={onSelectSkill}
          onSelectionChanged={nextCid => {
            if (nextCid && nextCid !== cid) setCid(nextCid);
            setSkillRefreshRevision(value => value + 1);
          }}
          onManageSkills={onManageSkills}
        />
      )}
      {showHistory && (
        <ConversationHistoryModal
          space={space}
          user={user}
          onClose={() => setShowHistory(false)}
          onSelectConversation={(id, selectedTitle) => {
            if (selectedTitle) setSelectedHistoryTitle(old => ({ ...old, [id]: selectedTitle }));
            setCid(id);
          }}
          onSelectQuery={openQueryFromHistory}
          onConversationDeleted={deletedId => {
            if (deletedId === cid) setCid(null);
            void refreshHistory().catch(() => {});
          }}
          onError={setError}
        />
      )}
    </WorkspaceShell>
  );
}
