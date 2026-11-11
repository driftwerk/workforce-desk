// What a board's ⋯ offers (rename, delete, link to Jira or Linear or
// unlink), the same from its sidebar row and from the board's header.

import type { Board } from "../hub/types";
import type { MenuEntry } from "../ui/Menu";
import { BoardDialog, DeleteBoard } from "./BoardDialogs";
import { LinkBoardDialog } from "./LinkBoard";
import { useBoard } from "./store";
import { UnlinkBoard } from "./SyncBar";

import type { BoardAction } from "./board";

export type { BoardAction };

export const boardEntries = (board: Board, act: (a: BoardAction) => void): MenuEntry[] => [
  { kind: "item", label: "Rename board…", onSelect: () => act("rename") },
  { kind: "item", label: "Delete board…", onSelect: () => act("delete") },
  { kind: "separator" },
  board.sync
    ? { kind: "item", label: `Unlink from ${board.sync.system === "jira" ? "Jira" : "Linear"}…`, onSelect: () => act("unlink") }
    : { kind: "item", label: "Link to Jira or Linear…", onSelect: () => act("link") },
];

/** The dialog an action opens. */
export function BoardActionDialog({ board, action, onClose }: { board: Board; action: BoardAction; onClose: () => void }) {
  const count = useBoard((s) => Object.values(s.tickets).filter((t) => t.board === board.id).length);
  switch (action) {
    case "rename":
      return <BoardDialog board={board} onClose={onClose} />;
    case "delete":
      return <DeleteBoard board={board} count={count} onClose={onClose} />;
    case "link":
      return <LinkBoardDialog board={board} tickets={count} onClose={onClose} />;
    case "unlink":
      return <UnlinkBoard board={board} onClose={onClose} />;
  }
}
