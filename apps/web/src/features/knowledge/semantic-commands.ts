import { useRef } from "react";
export function semanticError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return (
    (
      {
        version_conflict: "版本或建议已变化，请重新打开并核对后再保存。",
        stale_knowledge: "目标或依据已更新，请核对最新内容后修订建议。",
        forbidden: "当前没有这项维护权限，请刷新负责人信息。",
        not_available: "当前无法访问该对象或建议。",
      } as Record<string, string>
    )[code] ?? code
  );
}
// 同一表单内容的重传沿用操作身份，响应丢失后重试不会重复创建建议。
export function useStableOperation() {
  const previous = useRef<{ fingerprint: string; id: string } | null>(null);
  return (content: unknown) => {
    const fingerprint = JSON.stringify(content);
    if (previous.current?.fingerprint !== fingerprint)
      previous.current = { fingerprint, id: crypto.randomUUID() };
    return previous.current.id;
  };
}
