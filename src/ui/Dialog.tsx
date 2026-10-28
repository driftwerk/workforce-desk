import { useEffect, useId, useRef, type ReactNode } from "react";

/** A modal over everything: Escape or a click outside closes it (only it,
 *  when dialogs are stacked), focus moves in and comes back after. */
export function Dialog({
  title,
  onClose,
  wide = false,
  children,
}: {
  /** Renders the heading; gets the id the dialog is labelled by. */
  title: (id: string) => ReactNode;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current;
    first?.focus();
    return () => before?.focus();
  }, []);
  return (
    <div
      className="sheet-backdrop sheet-backdrop-center"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div ref={ref} className={`dialog ${wide ? "dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        {title(id)}
        {children}
      </div>
    </div>
  );
}

/** Arrow keys move the choice in a radio group, as they do natively. */
export const radioKeys = <T,>(e: React.KeyboardEvent, items: readonly T[], current: number, pick: (item: T) => void): void => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!step || items.length === 0) return;
  e.preventDefault();
  const next = (Math.max(current, 0) + step + items.length) % items.length;
  pick(items[next]!);
  const group = (e.currentTarget as HTMLElement).closest('[role="radiogroup"]');
  requestAnimationFrame(() => group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus());
};

export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="btn btn-ghost icon-btn" aria-label="Close" onClick={onClose}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
      </svg>
    </button>
  );
}
