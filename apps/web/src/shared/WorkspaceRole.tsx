import { useEffect, useState } from "react";
import type { SemanticAccess } from "../../../../packages/contracts/generated/boundary.ts";
import { api } from "./api.ts";

const roles = {
  user: { label: "普通用户", description: "可提出语义纠错建议。" },
  maintainer: {
    label: "语义维护者",
    description: "可维护自己负责的表、指标或文档等语义。",
  },
  super_maintainer: {
    label: "超级维护者",
    description: "可维护本空间全部共享语义。",
  },
} satisfies Record<
  SemanticAccess["highest_role"],
  { label: string; description: string }
>;

export function WorkspaceRole() {
  const [role, setRole] = useState<SemanticAccess["highest_role"] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async () => {
      if (document.hidden) return;
      const current = ++request;
      try {
        const access = await api("SemanticAccess", "/semantic-access");
        if (active && current === request) {
          setRole(access.highest_role);
          setFailed(false);
        }
      } catch {
        if (active && current === request) {
          setRole(null);
          setFailed(true);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const detail = role ? roles[role] : null;
  return (
    <span
      className="identity-role"
      role="status"
      aria-label="当前空间最高角色"
      title={
        detail
          ? detail.description + " 数据查询与执行权限由 Datasight 单独校验。"
          : undefined
      }
    >
      {detail?.label ?? (failed ? "角色暂不可用" : "角色加载中…")}
    </span>
  );
}
