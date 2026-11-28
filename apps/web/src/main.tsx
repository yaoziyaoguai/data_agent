import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Workbench } from "./features/workbench/Workbench.tsx";
import type { FeedScrollMemory } from "./features/workbench/ConversationFeed.tsx";
import { adoptNewConversationDraft, conversationStorageKey, readPendingSubmission } from "./features/workbench/conversation-storage.ts";
import { api } from "./shared/api.ts";
import "./style.css";
import { KnowledgePage } from "./features/knowledge/KnowledgePage.tsx";
import { ModelConfigurationPage } from "./features/models/ModelConfigurationPage.tsx";
import { AssetsPage } from "./features/assets/AssetsPage.tsx";
import { WorkspaceShell, type View } from "./shared/WorkspaceShell.tsx";
import { WorkspaceRoleProvider, useWorkspaceRoleState } from "./shared/WorkspaceRole.tsx";
import { UnsavedChangesProvider, useNavigationGuard } from "./shared/UnsavedChanges.tsx";
import { useWorkspaceLocation, type WorkspaceLocation } from "./shared/workspace-location.ts";
import type { Asset } from "../../../packages/contracts/generated/boundary.ts";

type SavedWorkbenchContext = {
  space: string;
  user: string;
  cid: string | null;
  title: string;
  scroll: FeedScrollMemory | null;
};

function App() {
  const { location, navigate: changeLocation } = useWorkspaceLocation();
  const { view, object, assetsTab: assetsEntry } = location;
  const guard = useNavigationGuard();
  const [sessionState, setSessionState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [modelLabel, setModelLabel] = useState("");
  const [user, setUser] = useState<string | null>(null);
  const [space, setSpace] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const roleState = useWorkspaceRoleState(sessionState === "authenticated" && user ? user : "");
  // U-04 & Joint UX：从工作台跳去数据字典或积累页时记住会话标题、滚动位置与焦点锚点，一键返回原回答并恢复键盘焦点。
  const [returnToAnalysis, setReturnToAnalysis] = useState(false);
  const workbenchMemory = useRef<SavedWorkbenchContext | null>(null);
  const latestScroll = useRef<{ scrollTop: number; followLatest: boolean } | null>(null);
  const latestFocusSelector = useRef<string | null>(null);

  const rememberWorkbenchContext = useCallback((cid: string | null, title: string) => {
    if (!user) return;
    const previous = workbenchMemory.current;
    const sameConversation = previous?.space === space && previous.user === user && previous.cid === cid;
    if (!sameConversation) {
      latestScroll.current = null;
      latestFocusSelector.current = null;
    }
    workbenchMemory.current = {
      space,
      user,
      cid,
      title,
      scroll: sameConversation ? previous?.scroll ?? null : null,
    };
  }, [space, user]);

  const recordScroll = useCallback((state: { scrollTop: number; followLatest: boolean }) => {
    latestScroll.current = state;
  }, []);

  const recordFocusSelector = useCallback((selector: string | null) => {
    latestFocusSelector.current = selector;
  }, []);

  const consumeReturnFocus = useCallback(() => {
    if (workbenchMemory.current?.scroll?.restoreFocus) {
      workbenchMemory.current = {
        ...workbenchMemory.current,
        scroll: { ...workbenchMemory.current.scroll, restoreFocus: false },
      };
    }
  }, []);

  const locate = (patch: Partial<WorkspaceLocation>, replace?: boolean, returningFromShortcut = false) => {
    const leavingWorkbench = view === "workbench" && Boolean(patch.view && patch.view !== "workbench");
    const snapshotScroll = leavingWorkbench
      ? {
          scrollTop: latestScroll.current?.scrollTop ?? 0,
          followLatest: latestScroll.current?.followLatest ?? true,
          focusSelector: latestFocusSelector.current,
          restoreFocus: false,
        }
      : null;
    const changed = changeLocation(patch, replace);
    if (changed) {
      if (leavingWorkbench) {
        if (workbenchMemory.current && workbenchMemory.current.space === space && workbenchMemory.current.user === user) {
          workbenchMemory.current = { ...workbenchMemory.current, scroll: snapshotScroll };
        }
        setReturnToAnalysis(true);
      } else if (patch.view === "workbench" || (view === "workbench" && !patch.view)) {
        if (returningFromShortcut && workbenchMemory.current?.scroll) {
          workbenchMemory.current = {
            ...workbenchMemory.current,
            scroll: { ...workbenchMemory.current.scroll, restoreFocus: true },
          };
        }
        setReturnToAnalysis(false);
      }
    }
    return changed;
  };

  useEffect(() => {
    let active = true;
    void api("Identity", "/session")
      .then((result) => {
        if (!active) return;
        setUser(result.user_id);
        setSpace(result.space_id);
        setSpaceName(result.space_name);
        setModelLabel(result.model_label);
        setSessionState("authenticated");
      })
      .catch(() => {
        if (active) setSessionState("unauthenticated");
      });
    return () => { active = false; };
  }, []);

  const logout = () => {
    void api("LogoutReceipt", "/session", "DELETE")
      .then(() => {
        workbenchMemory.current = null;
        latestScroll.current = null;
        setReturnToAnalysis(false);
        setUser(null);
        setSessionState("unauthenticated");
        locate({ view: "workbench", object: null });
      })
      .catch((e) => setError(e.message));
  };

  const selectSkillForCurrentConversation = useCallback(async (asset: Asset, navigateBack = false) => {
    if (!user) return "";
    let cid = localStorage.getItem(conversationStorageKey(space, user));
    if (!cid) {
      if (readPendingSubmission(space, user)?.origin_conversation_id === null) {
        throw new Error("请先返回工作台确认上一条消息的接收状态，再选用分析方法。");
      }
      cid = (
        await api("ConversationReceipt", "/conversations", "POST", {
          operation_id: crypto.randomUUID(),
        })
      ).conversation_id;
      adoptNewConversationDraft(space, user, cid);
      localStorage.setItem(conversationStorageKey(space, user), cid);
    }
    await api("Asset", "/conversations/" + cid + "/skill-selections", "POST", {
      operation_id: crypto.randomUUID(),
      asset_id: asset.id,
      version: asset.version,
    });
    if (navigateBack) locate({ view: "workbench" });
    return cid;
  }, [space, user, view]);

  const navigate = (destination: View) => {
    locate({ view: destination, ...(destination === "assets" ? { assetsTab: "memory" } : {}) });
  };

  if (sessionState === "checking") {
    return (
      <div className="workspace session-checking">
        <aside className="sidebar"><span className="brand">◈ <strong>Data Agent</strong></span></aside>
        <main id="main-content" tabIndex={-1}>
          <header className="workspace-header"><div className="workspace-breadcrumb"><span className="breadcrumb-section">工作台</span></div></header>
          <div className="session-loading" role="status" aria-live="polite">正在恢复工作台会话…</div>
        </main>
      </div>
    );
  }

  if (user && sessionState === "authenticated") {
    const saved = workbenchMemory.current?.space === space && workbenchMemory.current.user === user ? workbenchMemory.current : null;
    if (view === "workbench")
      return (
        <WorkspaceRoleProvider value={roleState}>
          <Workbench
            key={JSON.stringify([space, user])}
            user={user}
            space={space}
            modelLabel={modelLabel}
            onLogout={() => guard(logout)}
            onView={navigate}
            onSelectSkill={asset => selectSkillForCurrentConversation(asset, false)}
            onManageSkills={() => locate({ view: "assets", assetsTab: "skill" })}
            onMaintainEvidence={id => locate({ view: "knowledge", object: id, tab: "概览" })}
            spaceName={spaceName}
            savedContext={saved}
            onContextChange={rememberWorkbenchContext}
            onScrollChange={recordScroll}
            onFocusSelectorChange={recordFocusSelector}
            onReturnFocusConsumed={consumeReturnFocus}
          />
        </WorkspaceRoleProvider>
      );
    return (
      <WorkspaceRoleProvider value={roleState}>
        <WorkspaceShell
          user={user}
          modelLabel={modelLabel}
          onLogout={() => guard(logout)}
          view={view}
          onView={navigate}
          spaceName={spaceName}
          onReturn={returnToAnalysis ? () => locate({ view: "workbench" }, false, true) : undefined}
        >
          {view === "models" ? <ModelConfigurationPage key={JSON.stringify([space, user])}/> : view === "knowledge" ? (
            <KnowledgePage user={user} initialObject={object} initialTab={location.tab} initialScope={location.scope} onLocation={(patch, replace) => locate(patch, replace)} />
          ) : (
            <AssetsPage user={user} initialTab={assetsEntry} onTab={assetsTab => locate({ assetsTab })} onUseSkill={asset => selectSkillForCurrentConversation(asset, true).then(() => {})} />
          )}
        </WorkspaceShell>
      </WorkspaceRoleProvider>
    );
  }
  return (
    <main className="login">
      <div className="login-card">
        <div className="eyebrow">DATA AGENT · LOCAL</div>
        <h1>进入工作台</h1>
        <p>
          使用本机启动器生成的演示登录凭据。
          <br />
          会话与结果按用户隔离保存。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              const result = await api(
                "SessionReceipt",
                "/session",
                "POST",
                undefined,
                token,
              );
              workbenchMemory.current = null;
              latestScroll.current = null;
              setUser(result.user_id);
              setSpace(result.space_id);
              setSpaceName(result.space_name);
              setModelLabel(result.model_label);
              setSessionState("authenticated");
              setToken("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "登录失败");
            }
          }}
        >
          <label htmlFor="token">演示登录凭据</label>
          <input
            id="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
          <button>进入工作台 →</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UnsavedChangesProvider><App /></UnsavedChangesProvider>
  </React.StrictMode>,
);
