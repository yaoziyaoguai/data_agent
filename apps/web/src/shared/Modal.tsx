import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  title,
  children,
  onClose,
  closeLabel,
  className,
  docked = false,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  className?: string;
  footer?: ReactNode;
  docked?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const prior = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (prior instanceof HTMLElement) prior.focus({ preventScroll: true });
    };
  }, [docked]);

  const content = <>
    <div className="modal-head">
      <h2>{title}</h2>
      <button aria-label={closeLabel ?? "关闭"} onClick={onClose}>
        {closeLabel ?? "×"}
      </button>
    </div>
    <div className="modal-body">{children}</div>
    {footer && <div className="modal-footer">{footer}</div>}
  </>;
  const classes = ["modal", className, docked && "workbench-dock"].filter(Boolean).join(" ");
  if (docked) {
    return <aside className={classes} role="dialog" aria-label={title} onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    }}>{content}</aside>;
  }
  return <dialog ref={ref} className={classes} aria-label={title}
    onCancel={event => {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}
    onClick={event => { if (event.target === ref.current) onClose(); }}>
    {content}
  </dialog>;
}
