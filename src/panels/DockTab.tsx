import type { ReactNode, Ref } from "react";

/** The strip on the right that docked panels' tabs stand in. */
export function DockStrip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav className="stage-dock" aria-label={label}>
      {children}
    </nav>
  );
}

/** A docked panel's tab: its name read upwards, and a count beside it. */
export function DockTab({
  label,
  count,
  pressed,
  title,
  ariaLabel,
  buttonRef,
  onClick,
}: {
  label: string;
  count?: number;
  /** For a tab that opens its panel beside the focused one. */
  pressed?: boolean;
  title: string;
  ariaLabel?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
}) {
  return (
    <button ref={buttonRef} type="button" className="dock-tab" aria-pressed={pressed} aria-label={ariaLabel} title={title} onClick={onClick}>
      {label}
      {!!count && <span className="badge dock-badge">{count}</span>}
    </button>
  );
}
