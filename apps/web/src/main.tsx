import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Workbench } from "./features/workbench/Workbench.tsx";
import { api } from "./shared/api.ts";
import "./style.css";
import { KnowledgePage } from "./features/knowledge/KnowledgePage.tsx";
import { AssetsPage } from "./features/assets/AssetsPage.tsx";
import { WorkspaceShell, type View } from "./shared/WorkspaceShell.tsx";
import { UnsavedChangesProvider, useNavigationGuard } from "./shared/UnsavedChanges.tsx";
import { useWorkspaceLocation } from "./shared/workspace-location.ts";
import { KnowledgeEvidence } from "./features/knowledge/KnowledgeEvidence.tsx";
import { Modal } from "./shared/Modal.tsx";
import type { Asset } from "../../../packages/contracts/generated/boundary.ts";
function App() {
  const { location, navigate: changeLocation } = useWorkspaceLocation();
  const { view, object, assetsTab: assetsEntry } = location;
  const guard = useNavigationGuard();
  const [evidence, setEvidence] = useState<{id: string; version?: string; summary?: string} | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [modelLabel, setModelLabel] = useState("");
  const [user, setUser] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api("Identity", "/session")
      .then((result) => {
        setUser(result.user_id);
        setModelLabel(result.model_label);
      })
      .catch(() => {});
  }, []);
  const logout = () => {
    void api("LogoutReceipt", "/session", "DELETE")
      .then(() => {
        setUser(null);
        setShowEvidence(false);
        setEvidence(null);
        changeLocation({ view: "workbench", object: null });
      })
      .catch((e) => setError(e.message));
  };
  const useSkill = async (asset: Asset) => {
    if (!user) return;
    let cid = localStorage.getItem("data-agent.conversation." + user);
    if (!cid) {
      cid = (
        await api("ConversationReceipt", "/conversations", "POST", {
          operation_id: crypto.randomUUID(),
        })
      ).conversation_id;
      localStorage.setItem("data-agent.conversation." + user, cid);
    }
    await api("Asset", "/conversations/" + cid + "/skill-selections", "POST", {
      operation_id: crypto.randomUUID(),
      asset_id: asset.id,
      version: asset.version,
    });
    changeLocation({ view: "workbench" });
  };
  const navigate = (destination: View) => {
    setShowEvidence(false);
    changeLocation({ view: destination, ...(destination === "assets" ? { assetsTab: "memory" } : {}) });
  };
  if (user) {
    if (view === "workbench")
      return (
        <>
          <Workbench
            user={user}
            modelLabel={modelLabel}
            onLogout={() => guard(logout)}
            onView={navigate}
            onManageSkills={() => {
              changeLocation({ view: "assets", assetsTab: "skill" });
            }}
            onEvidence={(id, summary, version) => {
              setEvidence({id, summary, version});
              setShowEvidence(true);
            }}
          />
          {showEvidence && evidence && (
            <Modal
              title="口径依据"
              className="evidence-dialog"
              onClose={() => setShowEvidence(false)}
              footer={<><button onClick={() => { setShowEvidence(false); changeLocation({view: "knowledge", object: evidence.id, tab: "概览"}); }}>去维护此内容</button><button className="primary" onClick={() => setShowEvidence(false)}>返回对话</button></>}
            >
              <div className="evidence-content">
                <KnowledgeEvidence id={evidence.id} version={evidence.version} querySummary={evidence.summary}/>
              </div>
            </Modal>
          )}
        </>
      );
    return (
      <WorkspaceShell
        user={user}
        modelLabel={modelLabel}
        onLogout={() => guard(logout)}
        view={view}
        onView={navigate}
      >
        {view === "knowledge" ? (
          <KnowledgePage user={user} initialObject={object} initialTab={location.tab} initialScope={location.scope} onLocation={(patch, replace) => changeLocation(patch, replace)} />
        ) : (
          <AssetsPage user={user} initialTab={assetsEntry} onTab={assetsTab => changeLocation({assetsTab})} onUseSkill={useSkill} />
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
