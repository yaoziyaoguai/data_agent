import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api.ts";
import { WorkspaceRole, WorkspaceRoleProvider, useProvidedWorkspaceRole } from "./WorkspaceRole.tsx";
import { Modal } from "./Modal.tsx";
import { Icon } from "./Icon.tsx";
export type View = "workbench" | "assets" | "knowledge" | "models";
export function WorkspaceShell({ user, view, onView, onLogout, sidebar, children, title, onNewConversation, onReturn, spaceName }: {
  user: string;
  modelLabel: string;
  view: View;
  onView: (view: View) => void;
  onLogout: () => void;
  sidebar?: ReactNode;
  children: ReactNode;
  title?: string;
  onNewConversation?: () => void;
  onReturn?: () => void;
  spaceName?: string;
}) {
  const [access, setAccess] = useState<{ user: string; allowed: boolean } | null>(null);
  const roleState = useProvidedWorkspaceRole(user);
  const knowledgeLabel = roleState.role === "maintainer" || roleState.role === "super_maintainer" ? "语义管理" : "数据字典";
  useEffect(() => {
    let active = true;
    void api("ModelConfigurationAccess", "/model-configuration/access")
      .then(value => { if (active) setAccess({ user, allowed: value.can_manage_models }); })
      .catch(() => { if (active) setAccess(null); });
    return () => { active = false; };
  }, [user, view]);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = (destination: View) => { setMenuOpen(false); onView(destination); };
  const sectionLabel = view === "workbench" ? "工作台" : view === "assets" ? "我的积累" : view === "models" ? "模型配置" : knowledgeLabel;
  const navigation = <WorkspaceRoleProvider value={roleState}>
    <div className="sidebar-brand-block">
      <a className="brand" href="#workbench" onClick={event => { event.preventDefault(); navigate("workbench"); }}>
        <span className="brand-mark"><Icon name="logo"/></span>
        <strong>Data Agent</strong>
      </a>
      {spaceName && <p className="space-name" title={spaceName}>{spaceName}</p>}
    </div>
    {onNewConversation && <button className="new-conversation" onClick={() => { setMenuOpen(false); onNewConversation(); }}><Icon name="plus"/><span>新对话</span></button>}
    <nav className="primary-nav" aria-label="主导航">
      {([["workbench", "工作台", "chat"], ["knowledge", knowledgeLabel, "book"], ["assets", "我的积累", "bookmark"]] as const).map(([value, label, icon]) => <button key={value} aria-current={view === value ? "page" : undefined} onClick={() => navigate(value)}><Icon name={icon}/><span>{label}</span></button>)}
      {access?.user === user && access.allowed && <button aria-current={view === "models" ? "page" : undefined} onClick={() => navigate("models")}><Icon name="sliders"/><span>模型配置</span></button>}
    </nav>
    {sidebar}
    <div className="identity"><span className="avatar">{user.slice(0, 1).toUpperCase()}</span><div className="identity-details"><strong>{user}</strong><WorkspaceRole user={user}/></div><button onClick={onLogout}>退出</button></div>
  </WorkspaceRoleProvider>;
  return <div className={"workspace" + (view === "workbench" ? " workspace-workbench" : "")}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳到主要内容</a>
    <aside className="sidebar">{navigation}</aside>
    <main id="main-content" tabIndex={-1}>
      <header className="workspace-header">
        <div className="workspace-breadcrumb">
          <button className="mobile-menu" aria-label="展开导航" onClick={() => setMenuOpen(true)}><Icon name="menu"/></button>
          <span className="breadcrumb-section">{sectionLabel}</span>
          {(title || spaceName) && <span className="breadcrumb-detail">/ {title || spaceName}</span>}
        </div>
        {onReturn && <button className="return-button" onClick={onReturn}>← 返回刚才的分析</button>}
      </header>
      <div className="workspace-sheet">
        {children}
      </div>
    </main>
    {menuOpen && <Modal title="空间导航" className="navigation-dialog" onClose={() => setMenuOpen(false)}>
      <div onClick={event => { if ((event.target as HTMLElement).closest("button, a")) setMenuOpen(false); }}>{navigation}</div>
    </Modal>}
  </div>;
}
