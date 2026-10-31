import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { useDesk } from "../hub/store";
import { inApp, listen, subscribe } from "../platform";

// Whether Desk has focus, across its windows: each says when it gains or
// loses focus, and one opening asks the others. A detached grid's window
// on screen is seen while any of Desk's windows has focus, so a grid on a
// second monitor reads while you work in the main window, and nothing reads
// once you've left Desk.

/** The other windows of Desk that have focus, by window label. */
export const useDeskFocus = create<Record<string, true>>(() => ({}));

/** Window `from` said whether it has focus. */
export const heardFocus = (from: string, focused: boolean): void =>
  useDeskFocus.setState((s) => {
    if (!!s[from] === focused) return s;
    const { [from]: _gone, ...rest } = s;
    return focused ? { ...rest, [from]: true } : rest;
  }, true);

const anotherFocused = (): boolean => Object.keys(useDeskFocus.getState()).length > 0;

/** Whether what this window shows is being looked at: it's visible, and it
 *  has focus, or it's a detached grid's and another Desk window has. */
export const attending = (): boolean =>
  document.visibilityState === "visible" && (document.hasFocus() || (useDesk.getState().detached && anotherFocused()));

const FOCUS = "desk-focus";
const ASK = "desk-focus-ask";

const label = (): string => {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
};

/** Tells the other windows when this one gains or loses focus, and hears
 *  them; nothing polls. */
export function shareFocus(): () => void {
  if (!inApp) return () => {};
  const me = label();
  const say = (focused: boolean) => void Promise.resolve()
    .then(() => emit(FOCUS, { from: me, focused }))
    .catch(() => undefined);
  const gained = () => say(true);
  const lost = () => say(false);
  const quiet = () => Promise.resolve(() => {});
  const stops = [
    subscribe(
      listen<{ from: string; focused: boolean }>(FOCUS, (e) => {
        if (e.payload.from !== me) heardFocus(e.payload.from, e.payload.focused);
      }).catch(quiet),
    ),
    // A window opening asks where focus is: the one that has it says.
    subscribe(
      listen<{ from: string }>(ASK, (e) => {
        if (e.payload.from !== me && document.hasFocus()) gained();
      }).catch(quiet),
    ),
  ];
  window.addEventListener("focus", gained);
  window.addEventListener("blur", lost);
  window.addEventListener("pagehide", lost);
  void Promise.resolve()
    .then(() => emit(ASK, { from: me }))
    .catch(() => undefined);
  if (document.hasFocus()) gained();
  return () => {
    stops.forEach((s) => s());
    window.removeEventListener("focus", gained);
    window.removeEventListener("blur", lost);
    window.removeEventListener("pagehide", lost);
  };
}
