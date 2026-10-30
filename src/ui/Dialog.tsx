import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab and Shift+Tab going round inside `root`. */
const keepTabIn = (e: KeyboardEvent, root: HTMLElement) => {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
  const first = all[0];
  const last = all.at(-1);
  const at = document.activeElement;
  if (!first || !last) e.preventDefault();
  else if (e.shiftKey && (at === first || at === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
};

/** What makes `ref` modal from the keyboard: focus moves in (to its
 *  `[data-autofocus]`, else itself) and comes back after, Tab stays in it,
 *  and Escape closes it (only it, when modals are stacked). Returns the
 *  key handler for its outermost element. */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void): (e: KeyboardEvent) => void {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current)?.focus();
    return () => before?.focus();
  }, [ref]);
  return (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab" && ref.current) {
      e.stopPropagation();
      keepTabIn(e, ref.current);
    }
  };
}

/** A modal over everything: Escape or a click outside closes it (only it,
 *  when dialogs are stacked), focus moves in, stays in, and comes back
 *  after. */
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
  const onKeyDown = useModal(ref, onClose);
  return (
    <div className="sheet-backdrop sheet-backdrop-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKeyDown}>
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

export function CloseButton({ onClose, autoFocus = false }: { onClose: () => void; autoFocus?: boolean }) {
  return (
    <button type="button" className="btn btn-ghost icon-btn" aria-label="Close" data-autofocus={autoFocus || undefined} onClick={onClose}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
      </svg>
    </button>
  );
}
