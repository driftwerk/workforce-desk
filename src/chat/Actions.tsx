import { useId, useState, type ReactNode } from "react";

/** A turn's actions (its tool calls, its steps). While it runs only the
 *  newest shows, the earlier ones folded behind "+ 7 earlier steps"; once it
 *  is over they all fold behind "8 steps". Each turn keeps its own open or
 *  closed state, closed to start. */
export function Actions<T>({ items, live, children }: { items: readonly T[]; live: boolean; children: (shown: T[], first: number) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const n = items.length;
  if (!n) return null;
  const earlier = live ? n - 1 : n;
  const shown = open ? [...items] : live ? [items[n - 1]!] : [];
  const first = open ? 0 : live ? n - 1 : n;
  const noun = `${earlier} ${live ? "earlier " : ""}step${earlier === 1 ? "" : "s"}`;
  return (
    <span className="actions">
      {earlier > 0 && (
        <button type="button" className="link small actions-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? `Hide ${noun}` : live ? `+ ${noun}` : noun}
        </button>
      )}
      <span id={id} className="actions-list">
        {shown.length > 0 && children(shown, first)}
      </span>
    </span>
  );
}
