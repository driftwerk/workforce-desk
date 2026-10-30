import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { trackedIn } from "../grids/terminals";
import { useDesk } from "../hub/store";
import { useFocusRequest } from "../shell/focus";
import { useSettings } from "../settings/store";
import { matches, scopeOf, type ShortcutId } from "../shortcuts/keys";
import { useTheme } from "../theme/store";
import { monoStack } from "../theme/tokens";
import { xtermTheme } from "../theme/xterm";
import { Viewer } from "./viewer";

/** A session's terminal, or a grid's: the hub's pseudo-terminal, attached
 *  over its socket (which replays what it kept, then streams). Where the
 *  same terminal shows in more than one place, the one the person last
 *  turned to types into it and sets its size; the others mirror it. */
export function Terminal({
  sessionId,
  terminalId,
  autoFocus = true,
}: {
  sessionId?: string;
  /** A terminal the hub hosts for a grid pane, instead of a session's. */
  terminalId?: string;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const hub = useDesk((s) => s.hub);
  const session = useDesk((s) => sessionId ?? trackedIn(s.sessions, terminalId ?? null)?.id ?? null);
  useFocusRequest(session && `session:${session}`, term);
  const theme = useTheme();
  /** Shown while another viewer is the one typing into this terminal. */
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    if (!host.current || !hub || !(sessionId || terminalId)) return;
    const x = new XTerm({
      fontFamily: monoStack(theme.spec),
      fontSize: theme.spec.fonts.codeSize,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 10_000,
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    x.loadAddon(fit);
    x.open(host.current);
    term.current = x;
    const ws = terminalId ? hub.terminalSocket(terminalId) : hub.ptySocket(sessionId!);
    const encoder = new TextEncoder();
    const viewer = new Viewer({
      // A pane that isn't laid out (parked) has no size: it keeps the one it had.
      propose: () => {
        if (!host.current || host.current.clientWidth <= 0 || host.current.clientHeight <= 0) return null;
        return fit.proposeDimensions() ?? null;
      },
      resize: ({ cols, rows }) => {
        if (x.cols !== cols || x.rows !== rows) x.resize(cols, rows);
      },
      send: (c) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(c)),
      role: (active) => setViewing(!active),
    });
    viewerRef.current = viewer;
    const inPane = () => !!host.current && host.current.contains(document.activeElement);
    ws.onopen = () => viewer.opened(inPane());
    ws.onmessage = (m) => {
      if (m.data instanceof ArrayBuffer) x.write(new Uint8Array(m.data));
      else if (typeof m.data === "string") {
        try {
          viewer.heard(JSON.parse(m.data));
        } catch {
          // Not a control message this Desk knows.
        }
      }
    };
    ws.onclose = () => {
      setViewing(false);
      x.write(`\r\n\x1b[2m— ${terminalId ? "terminal closed" : "session detached"} —\x1b[0m\r\n`);
    };
    // Keys go to the hub as typed; it keeps only the active viewer's. The
    // claim comes from the person turning here (a click, focus, a key, a
    // paste), never from onData, which also carries xterm's answers to the
    // program's queries. The listeners capture, so the claim goes ahead of
    // what xterm sends for the same event (a focus report, a mouse report).
    const input = x.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(encoder.encode(d)));
    const turnedHere = () => viewer.claim();
    const el = host.current;
    const turns = ["mousedown", "focus", "paste"] as const;
    for (const t of turns) el.addEventListener(t, turnedHere, true);
    // Desk's own shortcuts (⌘T, ⌘N, ⌘,) reach Desk, not the shell.
    x.attachCustomKeyEventHandler((e) => {
      const keys = useSettings.getState().keys;
      const desks = (Object.keys(keys) as ShortcutId[]).some((id) => scopeOf(id) === "app" && matches(e, keys[id]));
      if (!desks && e.type === "keydown") viewer.claim();
      return !desks;
    });
    const observer = new ResizeObserver(() => viewer.boxChanged());
    observer.observe(el);
    if (autoFocus) x.focus();
    return () => {
      observer.disconnect();
      for (const t of turns) el.removeEventListener(t, turnedHere, true);
      input.dispose();
      ws.close();
      x.dispose();
      term.current = null;
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme changes are applied below without reconnecting
  }, [hub, sessionId, terminalId]);

  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(theme);
  }, [theme]);

  // A new size or face changes how many columns and rows fit.
  const fontFamily = monoStack(theme.spec);
  const fontSize = theme.spec.fonts.codeSize;
  useEffect(() => {
    const x = term.current;
    if (!x || (x.options.fontFamily === fontFamily && x.options.fontSize === fontSize)) return;
    x.options.fontFamily = fontFamily;
    x.options.fontSize = fontSize;
    viewerRef.current?.boxChanged();
  }, [fontFamily, fontSize]);

  return (
    <div className="terminal-frame">
      <div className="terminal" ref={host} />
      {viewing && (
        <button type="button" className="terminal-viewing" onClick={() => term.current?.focus()}>
          Viewing · click to type here
        </button>
      )}
    </div>
  );
}
