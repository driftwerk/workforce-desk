import { useRef, useState } from "react";
import { below } from "../groups/rows";
import { SYSTEM_TITLE } from "../hub/boardSync";
import type { SourceOrder, SourceOrderKey, SyncSystem } from "../hub/types";
import { Menu, type MenuEntry } from "../ui/Menu";
import { ordersFor, sourceByHand, sourceSortOf, type BoardOrder } from "./board";

/** What a board there orders by, after "·": "by priority", "manual
 *  order". Without an ordering read (an older hub), nothing. */
export const sourceWords = (system: SyncSystem | null, ordering: SourceOrder | null | undefined): string | null => {
  if (!ordering) return null;
  const first: SourceOrderKey | undefined = ordering.by?.[0];
  const field = first?.field ?? (system === "jira" ? "rank" : "manual");
  switch (field) {
    case "manual":
      return "manual order";
    case "rank":
      return first?.desc ? "by rank, reversed" : "by rank";
    case "priority":
      return first?.desc ? "by priority" : "by priority, lowest first";
    case "prioritySort":
      return "by priority";
    case "created":
      return first?.desc ? "newest first" : "oldest first";
    case "updated":
      return first?.desc ? "recently updated first" : "least recently updated first";
    case "due":
      return first?.desc ? "by due date, latest first" : "by due date";
  }
};

/** An order's name in its menu ("As on Jira", "As on Linear · by
 *  priority"), and as the chip says it ("as on Jira"). */
export const orderName = (order: BoardOrder, system: SyncSystem | null, ordering?: SourceOrder | null): string => {
  switch (order) {
    case "source": {
      const words = sourceWords(system, ordering);
      return `As on ${system ? SYSTEM_TITLE[system] : "the board"}${words ? ` · ${words}` : ""}`;
    }
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
export const orderSays = (order: BoardOrder, system: SyncSystem | null, ordering?: SourceOrder | null): string => {
  switch (order) {
    case "source":
      if (ordering?.from) return `The board's own order, from ${ordering.from}`;
      if (system && system !== "github" && ordering?.by?.length && !sourceByHand(sourceSortOf({ ordering }))) return `The board's own order, as ${SYSTEM_TITLE[system]} sorts it`;
      return system === "linear" ? "The board's own order, as Linear has it" : system === "github" ? "The project's own order, as GitHub has it" : "The board's own order, as Jira ranks it";
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
export const orderChipSays = (order: BoardOrder, system: SyncSystem | null, ordering?: SourceOrder | null): string =>
  `Order: ${lower(orderName(order, system, ordering))}`;

/** What the board's status line says when a drag or Alt+arrow up or down
 *  can't change a sorted order: the card keeps its place, and how to move
 *  cards by hand. */
export const sortedSaid = (order: BoardOrder, system: SyncSystem | null, ordering?: SourceOrder | null, upstream: boolean = !!system): string =>
  system && !upstream
    ? `Sorted ${order === "changed" ? "by recent change" : lower(orderName(order, system))}: ${SYSTEM_TITLE[system]} keeps no order for a repository’s issues, so cards only change column.`
    : order === "source" && system
      ? `${SYSTEM_TITLE[system]} sorts this board ${sourceWords(system, ordering) ?? "itself"}, so dragging a card up or down doesn't reorder it. Reorder it in ${SYSTEM_TITLE[system]}.`
      : `Sorted ${order === "changed" ? "by recent change" : lower(orderName(order, system))}: choose ${system ? `As on ${SYSTEM_TITLE[system]}` : "As arranged"} to move cards by hand.`;

/** The board's Order chip, beside its filters: a menu of the orders the
 *  board offers, the one in force ticked. */
export function OrderChip({
  order,
  system,
  ordering,
  upstream = !!system,
  onChange,
}: {
  order: BoardOrder;
  system: SyncSystem | null;
  /** How the board there orders its issues, once read. */
  ordering?: SourceOrder | null;
  /** Whether the board there keeps an order (a repository's issues don't). */
  upstream?: boolean;
  onChange: (o: BoardOrder) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entries: MenuEntry[] = [
    ...ordersFor(!!system, upstream).map(
      (o): MenuEntry => ({
        kind: "item",
        radio: true,
        checked: o === order,
        label: orderName(o, system, ordering),
        detail: orderSays(o, system, ordering),
        onSelect: () => onChange(o),
      }),
    ),
    ...(system && ordering?.note ? [{ kind: "note", text: ordering.note } as MenuEntry] : []),
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
        <span>{orderChipSays(order, system, ordering)}</span>
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
