import type { ReactNode } from "react";
export type View = "workbench" | "assets" | "knowledge";
export function WorkspaceShell({
  user,
  modelLabel,
  view,
  onView,
  onLogout,
  sidebar,
  children,
}: {
  user: string;
  modelLabel: string;
  view: View;
  onView: (view: View) => void;
  onLogout: () => void;
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onView("workbench");
          }}
        >
          ◈ <strong>Data Agent</strong>
        </a>
        <nav className="primary-nav" aria-label="主导航">
          {(
            [
              ["workbench", "工作台", "01"],
              ["assets", "我的积累", "02"],
              ["knowledge", "语义管理", "03"],
            ] as const
          ).map(([value, label, n]) => (
            <button
              key={value}
              aria-current={view === value ? "page" : undefined}
              onClick={() => onView(value)}
            >
              <span>{label}</span>
              <small>{n}</small>
            </button>
          ))}
        </nav>
        {sidebar}
        <div className="identity">
          <span className="avatar">{user.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{user}</strong>
            <small>
              语义权限按对象校验
            </small>
          </div>
          <button onClick={onLogout}>退出</button>
        </div>
      </aside>
      <main>
        <header>
          <span>
            {view === "workbench"
              ? "工作台"
              : view === "assets"
                ? "我的积累"
                : "语义管理"}{" "}
            <strong>/ 合成零售空间</strong>
          </span>
          <span className="badge">{modelLabel}</span>
        </header>
        {children}
      </main>
    </div>
  );
}
