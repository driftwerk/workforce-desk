import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { deskReady } from "./platform";
import { GridWindow } from "./grids/GridWindow";
import { GRID_PREFIX } from "./grids/storage";
import { DRAIN_PREFIX } from "./hubs/drain";
import { detachedGrid } from "./grids/windows";
import { deskState, restoreBeforeRender } from "./restore/boot";
import { keepFileDrafts } from "./restore/drafts";
import { mainUi } from "./restore/ui";
import { followRooms, roomOrder, ROOMS_PREFIX } from "./rooms/order";
import { App } from "./shell/App";
import { loadHost } from "./shell/host";
import { DeskRichHost } from "./shell/richHost";
import "./styles/app.css";
import "./styles/crew.css";
import "./styles/overview.css";
import "./styles/floor.css";
import "./styles/grids.css";
import "./styles/panels.css";
import "./styles/attachments.css";

/** Shows the window once the restored shell has been committed. (Not on an
 *  animation frame: a hidden window's page never gets one.) */
function Ready() {
  useEffect(() => {
    void deskReady().catch(() => undefined);
  }, []);
  return null;
}

// Grids, the rooms' order and how far each conversation has been drained
// are kept with the rest of what Desk restores.
void deskState.register(GRID_PREFIX);
void deskState.register(ROOMS_PREFIX);
void deskState.register(DRAIN_PREFIX);

// A detached grid's window shows that grid alone (see grids/GridWindow).
const grid = detachedGrid();

// What was open is put back before the shell first renders, and the window
// (made hidden, where it was) is shown once it has: no default view first.
// What this computer is (its platform, where the backend runs) is read then
// too, so every screen words itself for it from the start.
void Promise.all([restoreBeforeRender(grid ? [] : [mainUi, roomOrder]), loadHost().catch(() => undefined)]).then(() => {
  // A detached grid has no drafts of its own to keep, nor rooms.
  if (!grid) {
    keepFileDrafts();
    followRooms();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <DeskRichHost>{grid ? <GridWindow gridId={grid} /> : <App />}</DeskRichHost>
      <Ready />
    </StrictMode>,
  );
});
