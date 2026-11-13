// ⌘1 to ⌘9 (the Go to shortcut, with any last digit): the sidebar's items in
// the order it shows them. 1 is the Dashboard; then each grid, room and
// board, of the sections that are open, so the numbers are of the rows you
// see. The lit row shows its number.

import { useEffect } from "react";
import { openBoard } from "../board/BoardsSection";
import { useBoardOrder } from "../board/order";
import { useBoard } from "../board/store";
import { roomContent } from "../grids/engine";
import { showGrid } from "../grids/Grids";
import { openFromRow } from "../grids/putIn";
import { useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import { useRoomOrder } from "../rooms/order";
import { useSettings } from "../settings/store";
import { matches, terminalKeys, withDigit } from "../shortcuts/keys";
import { inTerminal, useShortcuts } from "../shortcuts/manager";
import { boardIds, gridIds, jumps, roomIds, type Jump } from "./JumpKey";
import { useSections } from "./SideSection";
import { useUi } from "./ui";

/** The items as they are now. */
const jumpsNow = (): Jump[] =>
  jumps(
    { grids: gridIds(useGrids.getState()), rooms: roomIds(useDesk.getState().rooms, useRoomOrder.getState().order), boards: boardIds(useBoard.getState(), useBoardOrder.getState().order) },
    useSections.getState().closed,
  );

/** Opens `j`, as its row does. */
export const goTo = (j: Jump): void => {
  useUi.getState().closeSettings();
  switch (j.kind) {
    case "dashboard":
      return useDesk.getState().setView("floor");
    case "grid":
      return void showGrid(j.id);
    case "room":
      return openFromRow(roomContent(j.id), () => void useDesk.getState().openRoom(j.id));
    case "board":
      return openBoard(j.id);
  }
};

/** Takes the Go to keys while Desk's main window is in front (a grid's own
 *  window has no sidebar): from a field or a terminal pane too, and from
 *  Settings, which they close. Reads what the sidebar shows only when
 *  they're pressed. */
export function useSidebarJumps(): void {
  const keys = useSettings((s) => s.keys.goTo);
  const recording = useShortcuts((s) => s.recording);
  useEffect(() => {
    if (recording || !keys) return;
    const onKey = (e: KeyboardEvent) => {
      // Not behind a dialog or an open menu, nor for a key already taken.
      if (e.repeat || e.defaultPrevented || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      for (let d = 1; d <= 9; d++) {
        const k = withDigit(keys, d);
        if (!matches(e, inTerminal(e.target) ? terminalKeys(k) : k)) continue;
        const j = jumpsNow()[d - 1];
        if (!j) return;
        e.preventDefault();
        return goTo(j);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, recording]);
}

