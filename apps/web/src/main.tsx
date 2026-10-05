import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Workbench } from "./features/workbench/Workbench.tsx";
import { api } from "./shared/api.ts";
import "./style.css";
import { KnowledgePage } from "./features/knowledge/KnowledgePage.tsx";
import { AssetsPage } from "./features/assets/AssetsPage.tsx";
import { WorkspaceShell, type View } from "./shared/WorkspaceShell.tsx";
import type { Asset } from "../../../packages/contracts/generated/boundary.ts";
function App() {
  const [view, setView] = useState<View>("workbench");
  const [object, setObject] = useState<string | null>(null);
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
        setView("workbench");
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
    setView("workbench");
  };
  if (user) {
    if (view === "workbench")
      return (
        <Workbench
          user={user}
          modelLabel={modelLabel}
          onLogout={logout}
          onView={setView}
          onEvidence={(id) => {
            setObject(id);
            setView("knowledge");
          }}
        />
      );
    return (
      <WorkspaceShell
        user={user}
        modelLabel={modelLabel}
        onLogout={logout}
        view={view}
        onView={setView}
      >
        {view === "knowledge" ? (
          <KnowledgePage user={user} initialObject={object} />
        ) : (
          <AssetsPage user={user} onUseSkill={useSkill} />
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
    <App />
  </React.StrictMode>,
);
