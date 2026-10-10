import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export function ConversationFeed({ children, firstEventSeq }: { children: ReactNode; firstEventSeq?: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const measuredHeight = useRef(0);
  const measuredTop = useRef(0);
  const previousFirst = useRef(firstEventSeq);
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
      }
    });
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return <div className="conversation-scroll" ref={viewport} onScroll={() => {
    const element = viewport.current;
    // 内容伸缩也可能触发scroll；先等尺寸观察器处理，不能误判为用户离开底部。
    if (element && element.scrollHeight === measuredHeight.current) {
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      measuredTop.current = element.scrollTop;
    }
  }}><div ref={content}>{children}</div></div>;
}
