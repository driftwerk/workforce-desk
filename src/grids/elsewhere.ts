// What a pane opens that only Desk's main window can show: a room's thread
// (in Rooms) and a ticket (in its panel beside the view). In the main window
// it opens there; from a grid's own window it's sent to the main window,
// which opens it and comes forward (shell/elsewhere.ts, the main window's
// alone).

import { emitTo } from "@tauri-apps/api/event";
import { useBoard } from "../board/store";
import { useDesk } from "../hub/store";
import { inApp } from "../platform";
import { openTarget } from "../shell/navigate";

export type Elsewhere = { kind: "thread"; room: string; thread: string } | { kind: "ticket"; id: string };

export const ELSEWHERE_EVENT = "desk-open";

/** Opens `what` here. */
export const openHere = (what: Elsewhere): void => {
  if (what.kind === "thread") openTarget({ kind: "room", roomId: what.room, threadId: what.thread });
  else useBoard.getState().openTicket(what.id);
};

/** Opens `what` in the main window: here when this is it. */
export const openInMain = (what: Elsewhere): void => {
  if (inApp && useDesk.getState().detached) void emitTo("main", ELSEWHERE_EVENT, what).catch(() => undefined);
  else openHere(what);
};
