import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export type FeedScrollMemory = {
  scrollTop: number;
  followLatest: boolean;
  focusSelector?: string | null;
  restoreFocus?: boolean;
};

export function ConversationFeed({
  children,
  firstEventSeq,
  hasMessages = false,
  initialMemory,
  onScrollChange,
  onReturnFocusConsumed,
}: {
  children: ReactNode;
  firstEventSeq?: string;
  hasMessages?: boolean;
  initialMemory?: FeedScrollMemory | null;
  onScrollChange?: (state: { scrollTop: number; followLatest: boolean }) => void;
  onReturnFocusConsumed?: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followLatest = useRef(initialMemory ? initialMemory.followLatest : true);
  const measuredHeight = useRef(0);
  const measuredTop = useRef(0);
  const previousFirst = useRef(firstEventSeq);
  const initializedMessages = useRef(false);
  const restoredMemory = useRef(false);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !hasMessages) return;
    if (!restoredMemory.current && initialMemory) {
      restoredMemory.current = true;
      initializedMessages.current = true;
      followLatest.current = initialMemory.followLatest;
      element.scrollTop = initialMemory.scrollTop;
      measuredHeight.current = element.scrollHeight;
      measuredTop.current = element.scrollTop;
      onScrollChange?.({ scrollTop: element.scrollTop, followLatest: followLatest.current });
      if (initialMemory.restoreFocus) {
        const container = element.closest(".conversation") ?? document;
        const explicitTarget = initialMemory.focusSelector
          ? container.querySelector<HTMLElement>(initialMemory.focusSelector)
          : null;
        const fallbackComposer = document.getElementById("question");
        const target = explicitTarget && explicitTarget.getClientRects().length > 0 ? explicitTarget : fallbackComposer;
        target?.focus({ preventScroll: true });
        onReturnFocusConsumed?.();
      }
      return;
    }
    if (!initializedMessages.current) {
      initializedMessages.current = true;
      // 首次进入多轮历史时：若最后一轮无查询卡且单条长回答超过一屏，优先锚定最后一轮提问起始处，让用户先读本轮问题与开头结论。
      const userMessages = element.querySelectorAll<HTMLElement>(".messages > article.message.user");
      const lastUser = userMessages.item(userMessages.length - 1);
      let hasQueryAfterLastUser = false;
      if (lastUser) {
        let cursor = lastUser.nextElementSibling;
        while (cursor) {
          if (cursor.classList.contains("query-message") || cursor.querySelector(".query-card")) {
            hasQueryAfterLastUser = true;
            break;
          }
          cursor = cursor.nextElementSibling;
        }
      }
      const scrollRect = element.getBoundingClientRect();
      const userRect = lastUser?.getBoundingClientRect();
      const userTopInScroller = lastUser && userRect ? element.scrollTop + (userRect.top - scrollRect.top) : 0;
      const turnHeight = lastUser ? element.scrollHeight - userTopInScroller : 0;
      if (lastUser && !hasQueryAfterLastUser && turnHeight > element.clientHeight * 0.92) {
        followLatest.current = false;
        element.scrollTop = Math.max(0, Math.round(userTopInScroller - 12));
      } else {
        followLatest.current = true;
        element.scrollTop = element.scrollHeight;
      }
      measuredHeight.current = element.scrollHeight;
      measuredTop.current = element.scrollTop;
      onScrollChange?.({ scrollTop: element.scrollTop, followLatest: followLatest.current });
    }
  }, [hasMessages, initialMemory]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element && firstEventSeq && previousFirst.current && BigInt(firstEventSeq) < BigInt(previousFirst.current)) {
      // 补入更早一页时保留原可见消息的位置，包括原本位于滚动区顶部的情况。
      followLatest.current = false;
      element.scrollTop = measuredTop.current + element.scrollHeight - measuredHeight.current;
    }
    previousFirst.current = firstEventSeq;
  }, [firstEventSeq]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const element = viewport.current;
      // 只在用户原本就在最新消息处时跟随；查阅历史时不抢走阅读位置。
      if (element) {
        if (followLatest.current) element.scrollTop = element.scrollHeight;
        measuredHeight.current = element.scrollHeight;
        measuredTop.current = element.scrollTop;
        onScrollChange?.({ scrollTop: element.scrollTop, followLatest: followLatest.current });
      }
    });
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [onScrollChange]);

  return <div className="conversation-scroll" ref={viewport} onScroll={() => {
    const element = viewport.current;
    // 内容伸缩也可能触发scroll；先等尺寸观察器处理，不能误判为用户离开底部。
    if (element && element.scrollHeight === measuredHeight.current) {
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      measuredTop.current = element.scrollTop;
      onScrollChange?.({ scrollTop: element.scrollTop, followLatest: followLatest.current });
    }
  }}><div ref={content}>{children}</div></div>;
}
