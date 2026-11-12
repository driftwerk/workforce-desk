// Whether the person has stepped away from Desk, in any of its windows: the
// main one, and each detached grid's. Each window notes the person's input
// and tells the others (at most every few seconds); the main window, which
// restarts into an update, reads the latest of them all. Before a restart,
// every window writes what it hasn't yet (drafts among it).

import { emit } from "@tauri-apps/api/event";
import { inApp, listen, subscribe } from "../platform";
import { deskState } from "../restore/boot";

/** What counts as the person being here. */
const INPUT = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

/** How often a window tells the others it was used, at most. */
export const TELL_EVERY_MS = 10_000;

const INPUT_EVENT = "desk-input";
const FLUSH_EVENT = "desk-flush";

let lastInput = Date.now();
let told = 0;

/** When the person last did something in any of Desk's windows. */
export const lastInputAt = (): number => lastInput;

/** For tests: when the person last did something. */
export const setLastInput = (at: number): void => {
  lastInput = at;
};

const noted = () => {
  const now = Date.now();
  lastInput = now;
  if (inApp && now - told >= TELL_EVERY_MS) {
    told = now;
    void emit(INPUT_EVENT, { at: now }).catch(() => undefined);
  }
};

/** Notes the person's input in this window, hears the other windows', and
 *  writes what's pending when a restart is coming. Every window starts it. */
export function followInput(): () => void {
  for (const e of INPUT) window.addEventListener(e, noted, { capture: true, passive: true });
  window.addEventListener("focus", noted);
  const stops = inApp
    ? [
        subscribe(listen<{ at: number }>(INPUT_EVENT, (e) => void (lastInput = Math.max(lastInput, e.payload.at)))),
        subscribe(listen(FLUSH_EVENT, () => void deskState.flush().catch(() => undefined))),
      ]
    : [];
  return () => {
    for (const e of INPUT) window.removeEventListener(e, noted, { capture: true });
    window.removeEventListener("focus", noted);
    for (const stop of stops) stop();
  };
}

/** How long the other windows are given to write what's pending. */
const FLUSH_WAIT_MS = 300;

/** Writes what's pending in this window, and asks the others to, before
 *  Desk restarts. */
export async function flushEverywhere(): Promise<void> {
  if (inApp) await emit(FLUSH_EVENT, {}).catch(() => undefined);
  await deskState.flush().catch(() => undefined);
  if (inApp) await new Promise((done) => setTimeout(done, FLUSH_WAIT_MS));
}
