import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { deskReady } from "./platform";
import { paintSavedTheme } from "./theme/boot";
import { useTheme } from "./theme/store";
import { followDrops } from "./drop/native";
import { GridWindow } from "./grids/GridWindow";
import { GRID_PREFIX } from "./grids/storage";
import { DRAIN_PREFIX } from "./hubs/drain";
import { detachedGrid } from "./grids/windows";
import { followMachineSessions, machineSessions, SIDEBAR_PREFIX } from "./groups/machines";
import { deskState, restoreBeforeRender } from "./restore/boot";
import { keepFileDrafts } from "./restore/drafts";
import { mainUi } from "./restore/ui";
import { followRooms, roomOrder, ROOMS_PREFIX } from "./rooms/order";
import { boardOrder } from "./board/order";
import { App } from "./shell/App";
import { SECRET_WINDOW, SecretWindow } from "./machines/SecretWindow";
import { thisWindow } from "./grids/windows";
import { loadHost } from "./shell/host";
import { DeskRichHost } from "./shell/richHost";
import "./styles/app.css";
import "./styles/crew.css";
import "./styles/problem.css";
import "./styles/overview.css";
import "./styles/floor.css";
import "./styles/grids.css";
import "./styles/panels.css";
import "./styles/attachments.css";
import "./styles/board.css";
import "./styles/memory.css";

/** Shows the window once the restored shell has been committed in its
 *  theme, on that theme's background. (Not on an animation frame: a hidden
 *  window's page never gets one.) */
function Ready() {
  const { bg } = useTheme().colors;
  const first = useRef(bg);
  useEffect(() => {
    void deskReady(first.current).catch(() => undefined);
  }, []);
  return null;
}

// Desk's own field for a machine's password is a window of its own: its
// theme, and nothing else of the app.
const secret = thisWindow() === SECRET_WINDOW;

// Grids, the rooms' order (and the boards', under the sidebar's), how far each conversation has been drained and
// the machines' sessions in the sidebar are kept with the rest of what Desk
// restores.
if (!secret) {
  void deskState.register(GRID_PREFIX);
  void deskState.register(ROOMS_PREFIX);
  void deskState.register(DRAIN_PREFIX);
  void deskState.register(SIDEBAR_PREFIX);
}

// A detached grid's window shows that grid alone (see grids/GridWindow).
const grid = detachedGrid();

// What was open is put back before the shell first renders, and the window
// (made hidden, where it was) is shown once it has: no default view first.
// What this computer is (its platform, where the backend runs) is read then
// too, so every screen words itself for it from the start.
// The theme too: the window first shows in the one chosen.
if (secret)
  void paintSavedTheme()
    .catch(() => undefined)
    .then(() =>
      createRoot(document.getElementById("root")!).render(
        <StrictMode>
          <SecretWindow />
        </StrictMode>,
      ),
    );
else void Promise.all([
  restoreBeforeRender(grid ? [] : [mainUi, roomOrder, boardOrder, machineSessions]),
  loadHost().catch(() => undefined),
  paintSavedTheme().catch(() => undefined),
]).then(() => {
  // Unsaved file drafts are kept in every window: a grid's own window can
  // hold a room's or an agent's composer. Rooms' order and the machines'
  // sessions are the main window's to follow.
  keepFileDrafts();
  if (!grid) {
    followRooms();
    followMachineSessions();
  }
  // Files dropped on this window, from the system's own drag and drop.
  followDrops();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <DeskRichHost>{grid ? <GridWindow gridId={grid} /> : <App />}</DeskRichHost>
      <Ready />
    </StrictMode>,
  );
});
