// The Board view's header parts that only Desk's main window has: the
// board's menu and its dialogs, and minting a sync token (see `BoardChrome`
// in BoardView.tsx). Imported by the main window's shell alone, so a grid's
// own window never reaches `board_sync_mint`.

import { BoardActionDialog, boardEntries } from "./boardActions";
import type { BoardChrome } from "./BoardView";
import { NewTokenDialog } from "./LinkBoard";

export const BOARD_CHROME: BoardChrome = { entries: boardEntries, Action: BoardActionDialog, NewToken: NewTokenDialog };
