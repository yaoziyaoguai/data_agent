import { useEffect, useRef, type ReactNode } from "react";
export function Modal({
  title,
  onClose,
  children,
  closeLabel,
  className,
  footer,
  dock = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
  footer?: ReactNode;
  dock?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const prior = document.activeElement;
    const wide = dock ? window.matchMedia("(min-width: 1280px)") : null;
    const open = () => {
      if (dialog.open) dialog.close();
      if (wide?.matches) dialog.show();
      else dialog.showModal();
    };
    open();
    wide?.addEventListener("change", open);
    return () => {
      wide?.removeEventListener("change", open);
      // 卸载时 ref 已清空，仍需关闭原节点才能恢复外层焦点。
      dialog.close();
      if (prior instanceof HTMLElement) prior.focus({ preventScroll: true });
    };
  }, [dock]);
  return (
    <dialog
      ref={ref}
      className={["modal", className, dock && "workbench-dock"].filter(Boolean).join(" ")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (dock && event.key === "Escape" && !event.currentTarget.matches(":modal")) {
          event.stopPropagation();
          onClose();
        }
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button aria-label={closeLabel ?? "关闭"} onClick={onClose}>
          {closeLabel ?? "×"}
        </button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </dialog>
  );
}
