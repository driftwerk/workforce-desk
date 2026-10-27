import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useDesk } from "../hub/store";
import { useTheme } from "../theme/store";
import { xtermTheme } from "../theme/xterm";

export function Terminal({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const hub = useDesk((s) => s.hub);
  const theme = useTheme();

  useEffect(() => {
    if (!host.current || !hub) return;
    const x = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12.5,
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
    const ws = hub.ptySocket(sessionId);
    const encoder = new TextEncoder();
    const sendSize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: x.cols, rows: x.rows }));
    };
    ws.onopen = () => {
      fit.fit();
      sendSize();
    };
    ws.onmessage = (m) => {
      if (m.data instanceof ArrayBuffer) x.write(new Uint8Array(m.data));
    };
    ws.onclose = () => x.write("\r\n\x1b[2m— session detached —\x1b[0m\r\n");
    const input = x.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(encoder.encode(d)));
    const resized = x.onResize(sendSize);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);
    x.focus();
    return () => {
      observer.disconnect();
      input.dispose();
      resized.dispose();
      ws.close();
      x.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme changes are applied below without reconnecting
  }, [hub, sessionId]);

  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme(theme);
  }, [theme]);

  return <div className="terminal" ref={host} />;
}
