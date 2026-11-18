import { useRef, useState } from "react";
import { below } from "../groups/rows";
import { SYSTEM_TITLE } from "../hub/boardSync";
import type { SyncSystem } from "../hub/types";
import { Menu, type MenuEntry } from "../ui/Menu";
import { ordersFor, type BoardOrder } from "./board";

/** An order's name in its menu ("As on Jira"), and as the chip says it
 *  ("as on Jira"). */
export const orderName = (order: BoardOrder, system: SyncSystem | null): string => {
  switch (order) {
    case "source":
      return `As on ${system ? SYSTEM_TITLE[system] : "the board"}`;
    case "newest":
      return "Newest first";
    case "oldest":
      return "Oldest first";
    case "changed":
      return "Recently changed";
    case "arranged":
      return "As arranged";
  }
};

/** What an order does, under its name in the menu. */
export const orderSays = (order: BoardOrder, system: SyncSystem | null): string => {
  switch (order) {
    case "source":
      return system === "linear" ? "The board's own order, as Linear has it" : "The board's own order, as Jira ranks it";
    case "newest":
      return "Most recently created at the top";
    case "oldest":
      return system ? "Order of creation, what boards do today" : "The first created at the top";
    case "changed":
      return "The last one touched at the top";
    case "arranged":
      return "Your own order: drag cards to arrange them";
  }
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The chip's words: "Order: as on Jira", "Order: newest first". */
export const orderChipSays = (order: BoardOrder, system: SyncSystem | null): string =>
  `Order: ${order === "source" ? `as on ${system ? SYSTEM_TITLE[system] : "the board"}` : lower(orderName(order, system))}`;

/** What the board's status line says when a drag or Alt+arrow up or down
 *  can't change a sorted order: the card keeps its place, and how to move
 *  cards by hand. */
export const sortedSaid = (order: BoardOrder, system: SyncSystem | null): string =>
  `Sorted ${order === "changed" ? "by recent change" : lower(orderName(order, system))}: choose ${system ? `As on ${SYSTEM_TITLE[system]}` : "As arranged"} to move cards by hand.`;

/** The board's Order chip, beside its filters: a menu of the orders the
 *  board offers, the one in force ticked. */
export function OrderChip({ order, system, onChange }: { order: BoardOrder; system: SyncSystem | null; onChange: (o: BoardOrder) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entries: MenuEntry[] = [
    ...ordersFor(!!system).map(
      (o): MenuEntry => ({ kind: "item", radio: true, checked: o === order, label: orderName(o, system), detail: orderSays(o, system), onSelect: () => onChange(o) }),
    ),
    { kind: "note", text: "Kept for this board, with its filters." },
  ];
  return (
    <>
      <button
        ref={button}
        type="button"
        className="chip-btn board-facet board-order"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title="How each column's cards are sorted"
        onClick={(e) => setMenu(menu ? null : below(e.currentTarget))}
      >
        <span>{orderChipSays(order, system)}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className="board-facet-caret">
          <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu && (
        <Menu
          label="Order"
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            if (refocus) button.current?.focus();
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
