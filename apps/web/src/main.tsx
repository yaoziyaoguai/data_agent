import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Workbench } from "./features/workbench/Workbench.tsx";
import { adoptNewConversationDraft, conversationStorageKey, readPendingSubmission } from "./features/workbench/conversation-storage.ts";
import { api } from "./shared/api.ts";
import "./style.css";
import { KnowledgePage } from "./features/knowledge/KnowledgePage.tsx";
import { ModelConfigurationPage } from "./features/models/ModelConfigurationPage.tsx";
import { AssetsPage } from "./features/assets/AssetsPage.tsx";
import { WorkspaceShell, type View } from "./shared/WorkspaceShell.tsx";
import { UnsavedChangesProvider, useNavigationGuard } from "./shared/UnsavedChanges.tsx";
import { useWorkspaceLocation, type WorkspaceLocation } from "./shared/workspace-location.ts";
import type { Asset } from "../../../packages/contracts/generated/boundary.ts";
function App() {
  const { location, navigate: changeLocation } = useWorkspaceLocation();
  const { view, object, assetsTab: assetsEntry } = location;
  const guard = useNavigationGuard();
  const [modelLabel, setModelLabel] = useState("");
  const [user, setUser] = useState<string | null>(null);
  const [space, setSpace] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  // U-04：从工作台跳去语义或积累页时记住来路，壳层提供一键返回刚才的分析。
  const [returnToAnalysis, setReturnToAnalysis] = useState(false);
  const locate = (patch: Partial<WorkspaceLocation>, replace?: boolean) => {
    if (patch.view && patch.view !== "workbench") setReturnToAnalysis(previous => view === "workbench" ? true : previous);
    else if (patch.view === "workbench" || (view === "workbench" && !patch.view)) setReturnToAnalysis(false);
    return changeLocation(patch, replace);
  };
  useEffect(() => {
    void api("Identity", "/session")
      .then((result) => {
        setUser(result.user_id);
        setSpace(result.space_id);
        setSpaceName(result.space_name);
        setModelLabel(result.model_label);
      })
      .catch(() => {});
  }, []);
  const logout = () => {
    void api("LogoutReceipt", "/session", "DELETE")
      .then(() => {
        setUser(null);
        locate({ view: "workbench", object: null });
      })
      .catch((e) => setError(e.message));
  };  const useSkill = async (asset: Asset) => {
    if (!user) return;
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
    locate({ view: "workbench" });
  };
  const navigate = (destination: View) => {
    locate({ view: destination, ...(destination === "assets" ? { assetsTab: "memory" } : {}) });
  };
  if (user) {
    if (view === "workbench")
      return (
        <Workbench
          key={JSON.stringify([space, user])}
          user={user}
          space={space}
          modelLabel={modelLabel}
          onLogout={() => guard(logout)}
          onView={navigate}
          onManageSkills={() => locate({ view: "assets", assetsTab: "skill" })}
          onMaintainEvidence={id => locate({view: "knowledge", object: id, tab: "概览"})}
          spaceName={spaceName}
        />
      );
    return (
      <WorkspaceShell
        user={user}
        modelLabel={modelLabel}
        onLogout={() => guard(logout)}
        view={view}
        onView={navigate}
        spaceName={spaceName}
        onReturn={returnToAnalysis ? () => locate({ view: "workbench" }) : undefined}
      >
        {view === "models" ? <ModelConfigurationPage key={JSON.stringify([space,user])}/> : view === "knowledge" ? (
          <KnowledgePage user={user} initialObject={object} initialTab={location.tab} initialScope={location.scope} onLocation={(patch, replace) => locate(patch, replace)} />
        ) : (
          <AssetsPage user={user} initialTab={assetsEntry} onTab={assetsTab => locate({assetsTab})} onUseSkill={useSkill} />
        )}
      </WorkspaceShell>
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
              setUser(result.user_id);
              setSpace(result.space_id);
              setSpaceName(result.space_name);
              setModelLabel(result.model_label);
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
