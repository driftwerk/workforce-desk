// The main window opens what its grids' windows send it (see
// grids/elsewhere.ts), and comes forward through Desk's native side: the
// page may not focus a window itself.

import { ELSEWHERE_EVENT, openHere, type Elsewhere } from "../grids/elsewhere";
import { focusMainWindow, inApp, listen, subscribe } from "../platform";

export const hearElsewhere = (): (() => void) =>
  inApp
    ? subscribe(
        listen<Elsewhere>(ELSEWHERE_EVENT, (e) => {
          openHere(e.payload);
          void focusMainWindow().catch(() => undefined);
        }),
      )
    : () => {};
