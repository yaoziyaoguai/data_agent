import type { ReactNode } from "react";

export function Tabs<T extends string>({ label, value, items, onChange }: {
  label: string;
  value: T;
  items: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return <div className="tabs" role="tablist" aria-label={label} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === "ArrowRight" ? (index + 1) % items.length
      : event.key === "ArrowLeft" ? (index - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus();
    onChange(items[next].value);
  }}>
    {items.map(item => <button key={item.value} role="tab" aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1} onClick={() => onChange(item.value)}>{item.label}</button>)}
  </div>;
}
