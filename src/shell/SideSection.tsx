// A sidebar section (Rooms, Boards, Groups): its name with a chevron that
// opens and closes it, its "+", and what it lists. Closed, its header shows
// what's for you inside, so nothing is hidden silently. Whether each is
// closed is remembered in this browser's storage.

import { useId, type ReactNode } from "react";
import { create } from "zustand";
import type { Badge } from "../unread/badges";
import { Marks } from "../unread/Marks";

export type SectionId = "rooms" | "boards" | "groups";

export const SECTIONS_KEY = "desk.sidebar.closed";

const readClosed = (): Partial<Record<SectionId, boolean>> => {
  try {
    const v = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") as unknown;
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).filter(([, c]) => c === true)) as Partial<Record<SectionId, boolean>>;
  } catch {
    return {};
  }
};

export const useSections = create<{ closed: Partial<Record<SectionId, boolean>> }>(() => ({ closed: readClosed() }));

/** Opens or closes section `id`, and remembers it. */
export const setSectionOpen = (id: SectionId, open: boolean): void => {
  if (!useSections.getState().closed[id] === open) return;
  const closed = { ...useSections.getState().closed };
  if (open) delete closed[id];
  else closed[id] = true;
  useSections.setState({ closed });
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(closed));
  } catch {
    // Not kept (storage off or full): it is still closed until Desk restarts.
  }
};

/** Reads what was remembered again (for tests). */
export const reloadSections = (): void => useSections.setState({ closed: readClosed() });

function Plus() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7 2v10M2 7h10" />
    </svg>
  );
}

export function SideSection({
  id,
  label,
  className = "",
  newLabel,
  onNew,
  badge,
  title,
  children,
}: {
  id: SectionId;
  label: string;
  className?: string;
  /** The "+"'s label, as "New room". */
  newLabel: string;
  onNew: () => void;
  /** What's for you inside, shown on the header while it's closed. */
  badge: Badge;
  /** The header's tooltip, as "Boards (⌘B)". */
  title?: string;
  children: ReactNode;
}) {
  const open = useSections((s) => !s.closed[id]);
  const body = useId();
  return (
    <div className={`side-section ${className}`.trim()} role="region" aria-label={label}>
      <span className="side-label side-label-action side-head">
        <button type="button" className="side-toggle" title={title} aria-expanded={open} aria-controls={open ? body : undefined} onClick={() => setSectionOpen(id, !open)}>
          <span className={`grp-chevron ${open ? "open" : ""}`} aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 2l4 3-4 3" />
            </svg>
          </span>
          <span className="side-toggle-name">{label}</span>
          {!open && <Marks badge={badge} />}
        </button>
        <button
          type="button"
          className="icon-btn-sm"
          aria-label={newLabel}
          title={newLabel}
          onClick={() => {
            // What's made shows in it.
            setSectionOpen(id, true);
            onNew();
          }}
        >
          <Plus />
        </button>
      </span>
      {open && (
        <div id={body} className="side-section-body">
          {children}
        </div>
      )}
    </div>
  );
}
