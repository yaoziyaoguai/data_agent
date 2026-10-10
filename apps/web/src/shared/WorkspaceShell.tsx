import { useState, type ReactNode } from "react";
import { WorkspaceRole } from "./WorkspaceRole.tsx";
import { Modal } from "./Modal.tsx";
import { Icon } from "./Icon.tsx";
export type View = "workbench" | "assets" | "knowledge";
export function WorkspaceShell({ user, view, onView, onLogout, sidebar, children, title, onNewConversation }: {
  user: string;
  modelLabel: string;
  view: View;
  onView: (view: View) => void;
  onLogout: () => void;
  sidebar?: ReactNode;
  children: ReactNode;
  title?: string;
  onNewConversation?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = (destination: View) => { setMenuOpen(false); onView(destination); };
  const navigation = <>
    <a className="brand" href="#workbench" onClick={event => { event.preventDefault(); navigate("workbench"); }}>◈ <strong>Data Agent</strong></a>
    <p className="space-name">合成零售空间</p>
    {onNewConversation && <button className="new-conversation" onClick={() => { setMenuOpen(false); onNewConversation(); }}><Icon name="plus"/>新对话</button>}
    <nav className="primary-nav" aria-label="主导航">
      {([["workbench", "工作台", "chat"], ["assets", "我的积累", "bookmark"], ["knowledge", "语义管理", "layers"]] as const).map(([value, label, icon]) => <button key={value} aria-current={view === value ? "page" : undefined} onClick={() => navigate(value)}><Icon name={icon}/><span>{label}</span></button>)}
    </nav>
    {sidebar}
    <div className="identity"><span className="avatar">{user.slice(0, 1).toUpperCase()}</span><div className="identity-details"><strong>{user}</strong><WorkspaceRole key={user + ":" + view}/></div><button onClick={onLogout}>退出</button></div>
  </>;
  return <div className={"workspace" + (view === "workbench" ? " workspace-workbench" : "")}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳到主要内容</a>
    <aside className="sidebar">{navigation}</aside>
    <main id="main-content" tabIndex={-1}>
      <header className="workspace-header"><div className="workspace-breadcrumb"><button className="mobile-menu" aria-label="展开导航" onClick={() => setMenuOpen(true)}><Icon name="menu"/></button><span>{view === "workbench" ? "工作台" : view === "assets" ? "我的积累" : "语义管理"}</span><span className="breadcrumb-detail">/ {title || "合成零售空间"}</span></div></header>
      {children}
    </main>
    {menuOpen && <Modal title="空间导航" className="navigation-dialog" onClose={() => setMenuOpen(false)}>{navigation}</Modal>}
  </div>;
}
