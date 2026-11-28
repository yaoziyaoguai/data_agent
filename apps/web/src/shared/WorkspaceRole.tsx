import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { SemanticAccess } from "../../../../packages/contracts/generated/boundary.ts";
import { api } from "./api.ts";

const roles = {
  user: { label: "普通用户", description: "可查阅数据字典并提出语义纠错建议。" },
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

type RoleState = {
  role: SemanticAccess["highest_role"] | null;
  failed: boolean;
};

const RoleContext = createContext<RoleState | null>(null);

export function useWorkspaceRoleState(user: string): RoleState {
  const [state, setState] = useState<{ user: string; role: SemanticAccess["highest_role"] | null; failed: boolean }>({
    user,
    role: null,
    failed: false,
  });
  useEffect(() => {
    let active = true;
    let request = 0;
    setState({ user, role: null, failed: false });
    const refresh = async () => {
      if (document.hidden) return;
      const current = ++request;
      try {
        const access = await api("SemanticAccess", "/semantic-access");
        if (active && current === request) {
          setState({ user, role: access.highest_role, failed: false });
        }
      } catch {
        if (active && current === request) {
          setState({ user, role: null, failed: true });
        }
      }
    };
    // 角色随登录态与权限信号变化：进入、回到页面或收到语义权限变更事件时读取，不做定时轮询。
    void refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("workspace-role-refresh", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("workspace-role-refresh", refresh);
    };
  }, [user]);
  return state.user === user ? { role: state.role, failed: state.failed } : { role: null, failed: false };
}

export function useProvidedWorkspaceRole(user: string): RoleState {
  const provided = useContext(RoleContext);
  const fallback = useWorkspaceRoleState(provided ? "" : user);
  return provided ?? fallback;
}

export function WorkspaceRoleProvider({ value, children }: { value: RoleState; children: ReactNode }) {
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function WorkspaceRole({ user = "" }: { user?: string }) {
  const provided = useContext(RoleContext);
  const fallback = useWorkspaceRoleState(provided ? "" : user);
  const { role, failed } = provided ?? fallback;
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
