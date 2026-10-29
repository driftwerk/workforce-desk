import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useDesk } from "../hub/store";
import { useSettings } from "../settings/store";
import { matches, scopeOf, type ShortcutId } from "../shortcuts/keys";
import { useTheme } from "../theme/store";
import { xtermTheme } from "../theme/xterm";

/** A session's terminal, or a grid's: the hub's pseudo-terminal, attached
 *  over its socket (which replays what it kept, then streams). */
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
  const hub = useDesk((s) => s.hub);
  const theme = useTheme();

  useEffect(() => {
    if (!host.current || !hub || !(sessionId || terminalId)) return;
    const x = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 10_000,
      theme: xtermTheme(theme),
    });
    // Desk's own shortcuts (⌘T, ⌘N, ⌘,) reach Desk, not the shell.
    x.attachCustomKeyEventHandler((e) => {
      const keys = useSettings.getState().keys;
      return !(Object.keys(keys) as ShortcutId[]).some((id) => scopeOf(id) === "app" && matches(e, keys[id]));
    });
    const fit = new FitAddon();
    x.loadAddon(fit);
    x.open(host.current);
    term.current = x;
    const ws = terminalId ? hub.terminalSocket(terminalId) : hub.ptySocket(sessionId!);
    const encoder = new TextEncoder();
    const sendSize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: x.cols, rows: x.rows }));
    };
    // A pane that isn't laid out (parked) has no size: it keeps the one it had.
    const refit = () => {
      if (host.current && host.current.clientWidth > 0 && host.current.clientHeight > 0) fit.fit();
    };
    ws.onopen = () => {
      refit();
      sendSize();
    };
    ws.onmessage = (m) => {
      if (m.data instanceof ArrayBuffer) x.write(new Uint8Array(m.data));
    };
    ws.onclose = () => x.write(`\r\n\x1b[2m— ${terminalId ? "terminal closed" : "session detached"} —\x1b[0m\r\n`);
    const input = x.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(encoder.encode(d)));
    const resized = x.onResize(sendSize);
    const observer = new ResizeObserver(refit);
    observer.observe(host.current);
    if (autoFocus) x.focus();
    return () => {
      observer.disconnect();
      input.dispose();
      resized.dispose();
      ws.close();
      x.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme changes are applied below without reconnecting
  }, [hub, sessionId, terminalId]);

  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(theme);
  }, [theme]);

  return <div className="terminal" ref={host} />;
}
