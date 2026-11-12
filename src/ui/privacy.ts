// The system's privacy settings, through Desk's native side
// (src-tauri/src/privacy.rs): the exact pane where the person lets Desk use
// the microphone or read their files, and whether it may now. The page's
// own opener only opens web links, so it can't open these.

import { useEffect, useRef } from "react";
import { invoke, reportOpenFailure } from "../platform";
import { useHost } from "../shell/host";
import type { Fix, Problem } from "./problem";

export type Pane = "fullDiskAccess" | "microphone" | "accessibility" | "filesAndFolders" | "loginItems";
export type Access = "granted" | "denied" | "notAsked" | "unknown";

/** Each pane as System Settings names it. */
export const PANE_NAMES: Record<Pane, string> = {
  fullDiskAccess: "Full Disk Access",
  microphone: "Microphone",
  accessibility: "Accessibility",
  filesAndFolders: "Files and Folders",
  loginItems: "Login Items",
};

/** Opens `pane` in the system's settings. A failure is said, never only
 *  logged: the person pressed a button and must see why nothing opened. */
export const openPane = (pane: Pane): Promise<void> =>
  invoke<void>("privacy_open", { pane }).catch((e: unknown) => {
    console.warn(`couldn't open the ${PANE_NAMES[pane]} settings:`, e);
    reportOpenFailure(e);
  });

/** Whether Desk has `pane`'s permission now; "unknown" where the system
 *  doesn't say. */
export const checkPane = (pane: Pane): Promise<Access> => invoke<Access>("privacy_check", { pane }).catch(() => "unknown" as const);

/** The button that opens `pane`, in the words of the system it's on. */
export const paneFix = (pane: Pane): Fix => ({
  label: useHost.getState().platform === "windows" ? "Open Windows Settings" : `Open ${PANE_NAMES[pane]} settings`,
  run: () => void openPane(pane),
});

/** What native text says of a permission the system withholds, and which
 *  pane grants it; null when it's about something else. */
export function permissionOf(text: string): { plain: string; pane: Pane | null } | null {
  if (/isn.t allowed to use the microphone/i.test(text)) return { plain: "Allow Desk to use the microphone.", pane: "microphone" };
  const read = /isn.t allowed to read (.+?)\.(?: Allow it in (Files and Folders|Full Disk Access)\.)?(?:$|\s)/i.exec(text);
  if (read) {
    const pane: Pane | null = read[2] === "Files and Folders" ? "filesAndFolders" : read[2] === "Full Disk Access" ? "fullDiskAccess" : null;
    return { plain: `Allow Desk to read ${read[1]}.`, pane };
  }
  return null;
}

/** A permission problem in the one shape Desk uses (#167), with the button
 *  that opens its pane; null when `text` isn't one. */
export function permissionProblem(text: string, what?: string): Problem | null {
  const p = permissionOf(text);
  if (!p) return null;
  return {
    plain: p.plain,
    ...(p.pane ? { fix: paneFix(p.pane) } : {}),
    ...(text !== p.plain ? { details: text } : {}),
    ...(what ? { what } : {}),
  };
}

/** While `pane` is `waiting`, asks again whether Desk has it each time Desk
 *  comes back to the front (the person allowed it in System Settings and
 *  came back), and runs `granted` once it does. `recheck` overrides how it
 *  asks, for what the system doesn't tell (Files and Folders: try again). */
export function useRecheckOnFocus(pane: Pane | null, waiting: boolean, granted: () => void, recheck?: () => Promise<boolean>) {
  const latest = useRef({ granted, recheck });
  latest.current = { granted, recheck };
  useEffect(() => {
    if (!pane || !waiting) return;
    let asking = false;
    const ask = () => {
      if (asking || document.visibilityState === "hidden") return;
      asking = true;
      const { recheck: own } = latest.current;
      (own ? own() : checkPane(pane).then((a) => a === "granted"))
        .then((ok) => {
          if (ok) latest.current.granted();
        })
        .catch(() => undefined)
        .finally(() => {
          asking = false;
        });
    };
    window.addEventListener("focus", ask);
    document.addEventListener("visibilitychange", ask);
    return () => {
      window.removeEventListener("focus", ask);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [pane, waiting]);
}
