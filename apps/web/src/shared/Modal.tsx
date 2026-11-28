import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export function Modal({
  title,
  children,
  onClose,
  closeLabel,
  closeTitle,
  className,
  docked = false,
  active = true,
  restoreFocusOnClose = true,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  closeTitle?: string;
  className?: string;
  footer?: ReactNode;
  docked?: boolean;
  active?: boolean;
  restoreFocusOnClose?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const savedScrollRef = useRef(0);
  const priorRef = useRef<Element | null>(null);
  const capturedPriorRef = useRef(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (docked) {
      if (active && savedScrollRef.current > 0 && body) {
        body.scrollTop = savedScrollRef.current;
      }
      return;
    }
    const dialog = ref.current;
    if (!dialog) return;
    if (!active) {
      if (dialog.open) {
        if (body && body.scrollTop > 0) savedScrollRef.current = body.scrollTop;
        dialog.close();
      }
      return;
    }
    if (!capturedPriorRef.current) {
      priorRef.current = document.activeElement;
      capturedPriorRef.current = true;
    }
    if (!dialog.open) {
      const targetScroll = savedScrollRef.current;
      dialog.showModal();
      if (targetScroll > 0 && body) {
        body.scrollTop = targetScroll;
      }
    }
  }, [docked, active]);

  useEffect(() => {
    if (docked) return;
    return () => {
      const dialog = ref.current;
      if (dialog?.open) dialog.close();
      const prior = priorRef.current;
      if (restoreFocusOnClose && prior instanceof HTMLElement && prior.getClientRects().length > 0) {
        prior.focus({ preventScroll: true });
      }
    };
  }, [docked, restoreFocusOnClose]);

  const content = <>
    <div className="modal-head">
      <h2>{title}</h2>
      <button
        type="button"
        className={closeLabel ? "modal-back-button" : "modal-close-button"}
        aria-label={closeLabel ?? "关闭"}
        title={closeTitle}
        onClick={onClose}
      >
        {closeLabel ? `← ${closeLabel}` : "×"}
      </button>
    </div>
    <div
      ref={bodyRef}
      className="modal-body"
      onScroll={event => {
        if (active) savedScrollRef.current = event.currentTarget.scrollTop;
      }}
      onClickCapture={event => {
        if (active) savedScrollRef.current = event.currentTarget.scrollTop;
      }}
    >
      {children}
    </div>
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
