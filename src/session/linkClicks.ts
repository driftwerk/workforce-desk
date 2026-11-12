// A link clicked in a terminal opens once, through Desk.
//
// xterm activates a link on its own mouseup; but while the program in the
// terminal reads the mouse (Claude Code and Codex do, to scroll), xterm also
// sends it the click, and a program that opens links itself then opened the
// page a second time, behind Desk's question. A click on a link is Desk's
// alone then: the program never sees it.

import type { ILinkHandler, IViewportRange } from "@xterm/xterm";

/** What of xterm's terminal this reads: whether its program reads the mouse. */
export interface MouseModes {
  readonly modes: { readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" };
}

/** The link handler for terminal `term` shown in `host`, opening with `open`;
 *  `dispose` lets `host` go. */
export function linkClicks(
  host: HTMLElement,
  term: MouseModes,
  open: (uri: string) => void,
): { handler: ILinkHandler; dispose: () => void } {
  /** The link under the pointer, as xterm says. */
  let hovered: string | null = null;
  /** The link a press on it was kept from the program for. */
  let pressed: string | null = null;
  const readsMouse = () => term.modes.mouseTrackingMode !== "none";

  const down = (e: MouseEvent) => {
    if (e.button !== 0 || !hovered || !readsMouse()) return;
    // Kept from xterm, so neither its mouse report nor its own activation
    // follows: the release below opens it.
    e.stopPropagation();
    e.preventDefault();
    pressed = hovered;
  };
  const up = (e: MouseEvent) => {
    if (pressed === null) return;
    e.stopPropagation();
    e.preventDefault();
    const was = pressed;
    pressed = null;
    // Let go on the link it was pressed on: anywhere else, nothing.
    if (e.button === 0 && hovered === was) open(was);
  };
  host.addEventListener("mousedown", down, true);
  host.addEventListener("mouseup", up, true);

  const handler: ILinkHandler = {
    activate: (_e: MouseEvent, uri: string) => {
      // Only ever reached when the press wasn't kept: the program doesn't
      // read the mouse, so this is the one way the link opens.
      if (pressed === null) open(uri);
    },
    hover: (_e: MouseEvent, uri: string, _range: IViewportRange) => {
      hovered = uri;
    },
    leave: () => {
      hovered = null;
    },
    allowNonHttpProtocols: false,
  };
  return {
    handler,
    dispose: () => {
      host.removeEventListener("mousedown", down, true);
      host.removeEventListener("mouseup", up, true);
    },
  };
}
