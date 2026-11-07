import { useEffect } from "react";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import type { Theme } from "./tokens";
import { terminalLight, terminalPalette } from "./xterm";

/** Keeps every engine Desk talks to told the colours its terminals are drawn
 *  in: when it connects, and whenever the theme changes. */
export function useTerminalColors(theme: Theme): void {
  const palette = JSON.stringify(terminalPalette(theme));
  // Which engines are connected, as one key: a reconnect tells it again.
  const connected = useDesk((s) =>
    Object.entries(s.engines)
      .filter(([, e]) => e.connected)
      .map(([m]) => m)
      .sort()
      .join(","),
  );
  useEffect(() => {
    const engines = useDesk.getState().engines;
    for (const m of connected ? connected.split(",") : []) {
      engines[m]?.hub.setTerminalColors(JSON.parse(palette)).catch((e: unknown) => console.warn(`terminal colours not given to ${m}: ${String(e)}`));
    }
  }, [palette, connected]);
}

/** Whether a running session's CLI shows colours for the other ground than
 *  its terminal's now, until it restarts. */
export const needsRestartForColors = (s: Session, theme: Theme): boolean =>
  s.live && !!s.fixedGround && s.fixedGround !== (terminalLight(theme.colors) ? "light" : "dark");
