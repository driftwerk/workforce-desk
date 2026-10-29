import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { deskReady } from "./platform";
import { restoreBeforeRender } from "./restore/boot";
import { mainUi } from "./restore/ui";
import { App } from "./shell/App";
import "./styles/app.css";
import "./styles/crew.css";
import "./styles/overview.css";

/** Shows the window once the restored shell has been committed. (Not on an
 *  animation frame: a hidden window's page never gets one.) */
function Ready() {
  useEffect(() => {
    void deskReady().catch(() => undefined);
  }, []);
  return null;
}

// What was open is put back before the shell first renders, and the window
// (made hidden, where it was) is shown once it has: no default view first.
void restoreBeforeRender([mainUi]).then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
      <Ready />
    </StrictMode>,
  );
});
