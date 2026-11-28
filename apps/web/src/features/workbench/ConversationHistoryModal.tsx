import { useEffect, useRef, useState } from "react";
import type {
  HistoryItem,
  QueryHistory,
  QueryHistoryItem,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { conversationTitle } from "./conversation-title.ts";

export const formatConversationCreationTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

const queryExecutionLabel = (state: string) =>
  (
    {
      succeeded: "已执行",
      failed: "执行失败",
      running: "执行中",
      queued: "排队中",
      submitting: "提交中",
      submission_unknown: "提交确认中",
      canceled: "已取消",
      not_submitted: "未提交",
      awaiting_confirmation: "待确认",
    } as Record<string, string>
  )[state] ?? state;

export function ConversationHistoryModal({
  space,
  user,
  onClose,
  onSelectConversation,
  onSelectQuery,
  onConversationDeleted,
  onError,
}: {
  space: string;
  user: string;
  onClose: () => void;
  onSelectConversation: (id: string, title?: string) => void;
  onSelectQuery: (item: QueryHistoryItem) => void;
  onConversationDeleted: (deletedId: string) => void;
  onError: (message: string) => void;
}) {
  const [historyTab, setHistoryTab] = useState<"conversations" | "queries">("conversations");
  const [historySearch, setHistorySearch] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(true);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryItem[]>([]);
  const [queryHistoryNext, setQueryHistoryNext] = useState<string | null>(null);
  const [queryHistoryBusy, setQueryHistoryBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const historyGeneration = useRef(0);
  const queryHistoryGeneration = useRef(0);

  const refreshHistory = async (query = historySearch, before?: string) => {
    const generation = ++historyGeneration.current;
    setHistoryBusy(true);
    try {
      const params = new URLSearchParams({ q: query });
      if (before) params.set("before_id", before);
      const page = await api("History", "/conversations?" + params);
      if (generation !== historyGeneration.current) return;
      setHistory(old =>
        before ? [...old, ...page.conversations.filter(v => !old.some(o => o.id === v.id))] : page.conversations,
      );
      setHistoryNext(page.next_before_id);
    } finally {
      if (generation === historyGeneration.current) setHistoryBusy(false);
    }
  };

  const refreshQueryHistory = async (query = historySearch, before?: string) => {
    const generation = ++queryHistoryGeneration.current;
    setQueryHistoryBusy(true);
    try {
      const params = new URLSearchParams({ q: query });
      if (before) params.set("before_id", before);
      const page: QueryHistory = await api("QueryHistory", "/queries?" + params);
      if (generation !== queryHistoryGeneration.current) return;
      setQueryHistory(old =>
        before ? [...old, ...page.queries.filter(v => !old.some(o => o.id === v.id))] : page.queries,
      );
      setQueryHistoryNext(page.next_before_id);
    } finally {
      if (generation === queryHistoryGeneration.current) setQueryHistoryBusy(false);
    }
  };

  useEffect(() => {
    setHistoryBusy(true);
    const run = () => {
      void refreshHistory().catch(e => onError(e instanceof Error ? e.message : String(e)));
    };
    if (!historySearch.trim()) {
      run();
      return () => { ++historyGeneration.current; };
    }
    const timer = window.setTimeout(run, 150);
    return () => {
      window.clearTimeout(timer);
      ++historyGeneration.current;
    };
  }, [space, user, historySearch]);

  useEffect(() => {
    if (historyTab !== "queries") return;
    setQueryHistoryBusy(true);
    const run = () => {
      void refreshQueryHistory().catch(e => onError(e instanceof Error ? e.message : String(e)));
    };
    if (!historySearch.trim()) {
      run();
      return () => { ++queryHistoryGeneration.current; };
    }
    const timer = window.setTimeout(run, 150);
    return () => {
      window.clearTimeout(timer);
      ++queryHistoryGeneration.current;
    };
  }, [space, user, historySearch, historyTab]);

  const removeConversation = async () => {
    if (!deleteId) return;
    try {
      await api("MutationReceipt", "/conversations/" + deleteId, "DELETE", {
        operation_id: crypto.randomUUID(),
      });
      const removed = deleteId;
      setDeleteId(null);
      onConversationDeleted(removed);
      await refreshHistory();
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <>
      <Modal title="历史记录" onClose={onClose}>
        <div className="history-tabs" role="group" aria-label="历史类型">
          <button aria-pressed={historyTab === "conversations"} onClick={() => setHistoryTab("conversations")}>
            会话
          </button>
          <button aria-pressed={historyTab === "queries"} onClick={() => setHistoryTab("queries")}>
            查询记录
          </button>
        </div>
        <label className="search-box">
          <input
            aria-label={historyTab === "conversations" ? "搜索会话" : "搜索查询"}
            value={historySearch}
            placeholder={historyTab === "conversations" ? "按标题搜索" : "按查询内容搜索"}
            onChange={e => setHistorySearch(e.target.value)}
          />
        </label>
        {historyTab === "conversations" ? (
          <>
            <nav className="history-dialog" aria-label="全部会话">
              {history.map(item => (
                <div className="history-row" key={item.id}>
                  <button
                    onClick={() => {
                      onSelectConversation(item.id, item.title);
                      onClose();
                    }}
                  >
                    <span title={item.title}>{conversationTitle(item.title) || "未命名会话"}</span>
                    {item.created_at && (
                      <small>
                        <time dateTime={item.created_at}>创建于 {formatConversationCreationTime(item.created_at)}</time>
                      </small>
                    )}
                  </button>
                  <button
                    className="history-delete"
                    aria-label={"删除会话 " + (item.title || "未命名会话")}
                    onClick={() => setDeleteId(item.id)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </nav>
            {!history.length && !historyBusy && <p className="quiet">没有找到符合条件的会话，请调整搜索词。</p>}
            {historyNext && (
              <button
                disabled={historyBusy}
                onClick={() => void refreshHistory(historySearch, historyNext).catch(e => onError(e.message))}
              >
                加载更多会话
              </button>
            )}
            {historyBusy && <p role="status">正在查找会话…</p>}
          </>
        ) : (
          <>
            <nav className="history-dialog" aria-label="全部查询">
              {queryHistory.map(item => (
                <div className="history-row" key={item.id}>
                  <button
                    onClick={() => {
                      onClose();
                      onSelectQuery(item);
                    }}
                  >
                    <span title={item.summary}>
                      {item.text_unavailable ? "正文已失效的查询" : item.summary || "未命名查询"}
                    </span>
                    <small>
                      <time dateTime={item.created_at}>{formatConversationCreationTime(item.created_at)}</time> ·{" "}
                      {queryExecutionLabel(item.execution_state)}
                    </small>
                  </button>
                </div>
              ))}
            </nav>
            {!queryHistory.length && !queryHistoryBusy && (
              <p className="quiet">没有找到符合条件的查询，请调整搜索词。</p>
            )}
            {queryHistoryNext && (
              <button
                disabled={queryHistoryBusy}
                onClick={() => void refreshQueryHistory(historySearch, queryHistoryNext).catch(e => onError(e.message))}
              >
                加载更多查询
              </button>
            )}
            {queryHistoryBusy && <p role="status">正在查找查询…</p>}
          </>
        )}
      </Modal>
      {deleteId && (
        <Modal title="删除这个会话？" onClose={() => setDeleteId(null)}>
          <p>
            删除后不再加载此会话，未执行查询会取消；正在运行的查询会向平台申请取消。你的个人记忆和Skill可在“我的积累”单独管理。
          </p>
          <button className="primary" onClick={() => void removeConversation()}>
            删除此会话
          </button>
        </Modal>
      )}
    </>
  );
}
