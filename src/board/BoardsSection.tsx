import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMinute } from "../floor/RightNow";
import { SortList, SortRow } from "../groups/rows";
import { useDesk } from "../hub/store";
import type { Ticket } from "../hub/types";
import { setSectionOpen, SideSection } from "../shell/SideSection";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { badgeOfGroup, NO_BADGE, type Badge } from "../unread/badges";
import { Marks } from "../unread/Marks";
import { Menu } from "../ui/Menu";
import { snoozed, waitingOnYou } from "./board";
import { BoardActionDialog, boardEntries, type BoardAction } from "./boardActions";
import { BoardDialog } from "./BoardDialogs";
import { useWaiting } from "./BoardView";
import { arrangedBoards, moveBoard, nudgeBoard, useBoardOrder } from "./order";
import { shownBoard, useBoard } from "./store";
import { boardContent } from "../grids/engine";
import { InGridRow, openFromRow, putInGrid } from "../grids/putIn";
import { boardItem } from "../grids/where";
import { JumpKey } from "../shell/JumpKey";

/** Each board's tickets waiting on you, as its Waiting filter counts them. */
const useWaitingByBoard = (): ReadonlyMap<string, number> => {
  const tickets = useBoard((s) => s.tickets);
  const waiting = useWaiting();
  const now = useMinute();
  return useMemo(() => {
    const out = new Map<string, number>();
    for (const t of Object.values(tickets) as Ticket[])
      if (!snoozed(t, now) && waitingOnYou(t, waiting)) out.set(t.board, (out.get(t.board) ?? 0) + 1);
    return out;
  }, [tickets, waiting, now]);
};

const badgeOf = (n: number | undefined): Badge => (n ? { count: n, dot: false } : NO_BADGE);

/** Opens board `id`, as its sidebar row does: where a grid shows it, else
 *  in the main area. */
export const openBoard = (id: string): void =>
  openFromRow(boardContent(id), () => {
    useBoard.getState().show(id);
    useDesk.getState().setView("board");
  });

/** The sidebar's Boards: a "+" to make one, each board under it, opening
 *  it on click; dragged (or Alt+↑/↓) to reorder, its ⋯ for the rest. */
export function BoardsSection() {
  const supported = useBoard((s) => s.supported);
  const boards = useBoard((s) => s.boards);
  const order = useBoardOrder((s) => s.order);
  const shown = useBoard((s) => shownBoard(s)?.id ?? null);
  const onBoard = useDesk((s) => s.view === "board");
  const inGrids = useDesk((s) => s.view === "grids");
  const waiting = useWaitingByBoard();
  const [making, setMaking] = useState(false);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [acting, setActing] = useState<{ id: string; action: BoardAction } | null>(null);
  const [said, setSaid] = useState("");
  const rows = useRef(new Map<string, HTMLElement>());
  const dragged = useRef(false);
  const hint = useId();
  const keys = useSettings((s) => s.keys);
  // Going to a board opens Boards, so its row shows; once each time, so it
  // can be closed again.
  const shownBefore = useRef(onBoard ? shown : null);
  useEffect(() => {
    const now = onBoard ? shown : null;
    if (now === shownBefore.current) return;
    shownBefore.current = now;
    if (now) setSectionOpen("boards", true);
  }, [onBoard, shown]);
  const list = arrangedBoards(boards, order);
  // An older hub keeps no boards: nothing to list or make.
  if (supported === false) return null;
  const open = (id: string) => {
    if (dragged.current) return;
    openBoard(id);
  };
  const sayWhere = (id: string) => {
    const ids = arrangedBoards(useBoard.getState().boards, useBoardOrder.getState().order).map((b) => b.id);
    setSaid(`${useBoard.getState().boards[id]?.name}: board ${ids.indexOf(id) + 1} of ${ids.length}`);
  };
  const nudge = (id: string, by: -1 | 1) => {
    if (!nudgeBoard(id, by)) return setSaid(by < 0 ? "Already the first board" : "Already the last board");
    sayWhere(id);
    requestAnimationFrame(() => rows.current.get(id)?.focus());
  };
  const menuBoard = menu ? boards[menu.id] : undefined;
  const actingBoard = acting ? boards[acting.id] : undefined;
  return (
    <>
      <SideSection id="boards" label="Boards" title={`Boards (${shortcutLabel(keys.board)})`} newLabel="New board" onNew={() => setMaking(true)} badge={badgeOfGroup(list.map((b) => badgeOf(waiting.get(b.id))))}>
        <span id={hint} className="sr-only">
          Alt+Up and Alt+Down move it. Shift+F10 opens its menu.
        </span>
        <SortList
          label="Boards"
          type="board"
          ids={list.map((b) => b.id)}
          chip={(id) => boards[id]?.name}
          toGrid={(id) => (boards[id] ? { content: boardContent(id), name: boards[id]!.name } : null)}
          onDragStart={() => setMenu(null)}
          justDragged={dragged}
          onMove={(id, before) => {
            moveBoard(id, before);
            sayWhere(id);
          }}
          row={(id, lineBefore) => {
            const b = boards[id]!;
            return (
              <InGridRow
                key={id}
                item={boardItem(id)}
                row={(mark, markId) => (
                  <SortRow
                    id={id}
                    type="board"
                    lineBefore={lineBefore}
                    on={onBoard && shown === id}
                    name={b.name}
                    title={inGrids ? "Drag onto a pane, or to reorder" : "Drag to reorder"}
                    describedBy={markId ? `${hint} ${markId}` : hint}
                    more={`${b.name} options`}
                    register={(el) => (el ? rows.current.set(id, el) : rows.current.delete(id))}
                    onOpen={() => open(id)}
                    onNudge={(by) => nudge(id, by)}
                    onMenu={(at, from) => setMenu({ id, at, from })}
                  >
                    {mark}
                    <Marks badge={badgeOf(waiting.get(id))} />
                    {onBoard && shown === id && <JumpKey kind="board" id={id} />}
                  </SortRow>
                )}
              />
            );
          }}
        />
        <span className="sr-only" aria-live="polite">
          {said}
        </span>
        {menu && menuBoard && (
          <Menu
            label={`${menuBoard.name} options`}
            at={menu.at}
            entries={[
              { kind: "item", label: "Open", onSelect: () => open(menuBoard.id) },
              putInGrid(boardContent(menuBoard.id)),
              { kind: "separator" },
              ...boardEntries(menuBoard, (action) => setActing({ id: menuBoard.id, action })),
            ]}
            onClose={(refocus) => {
              if (refocus) menu.from?.focus();
              setMenu(null);
            }}
          />
        )}
      </SideSection>
      {acting && actingBoard && <BoardActionDialog board={actingBoard} action={acting.action} onClose={() => setActing(null)} />}
      {making && <BoardDialog onMade={() => useDesk.getState().setView("board")} onClose={() => setMaking(false)} />}
    </>
  );
}
