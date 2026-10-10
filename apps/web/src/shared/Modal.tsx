import { useEffect, useRef, type ReactNode } from "react";
export function Modal({
  title,
  onClose,
  children,
  closeLabel,
  className,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const prior = document.activeElement;
    dialog?.showModal();
    return () => {
      // 卸载时 ref 已清空，仍需关闭原节点才能恢复外层焦点。
      dialog?.close();
      if (prior instanceof HTMLElement) prior.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"modal " + (className ?? "")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
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
