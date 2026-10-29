import { useState } from "react";
import { Menu, type MenuEntry } from "../ui/Menu";
import type { PaneContent } from "./engine";
import { useGrids } from "./store";
import { addToGrid } from "./windows";

/** "Put in grid ▾", in a side panel's header: the grids, and a new one.
 *  What the panel shows goes to the grid as a sidebar item's "Add to grid"
 *  sends it, and is shown there; `onShown` then closes the panel. */
export function PutInGrid({ content, label, onShown }: { content: PaneContent; label: string; onShown: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement } | null>(null);
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const put = (gridId: string | null) => {
    if (addToGrid(content, gridId).shown) onShown();
  };
  const entries: MenuEntry[] = [
    ...order.flatMap((id): MenuEntry[] => (grids[id] ? [{ kind: "item", label: grids[id]!.name, onSelect: () => put(id) }] : [])),
    ...(order.some((id) => grids[id]) ? [{ kind: "separator" as const }] : []),
    { kind: "item", label: "New grid", onSelect: () => put(null) },
  ];
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost gbtn rpanel-put"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={label}
        title="Put it in a grid"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4, from: e.currentTarget });
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="1.5" y="1.5" width="11" height="11" rx="2" />
          <path d="M7 1.5v11M1.5 7h11" />
        </svg>
        <span className="rpanel-put-label">Put in grid</span> ▾
      </button>
      {menu && (
        <Menu
          label="Put in grid"
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            if (refocus) menu.from.focus();
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
