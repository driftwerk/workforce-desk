import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useId, useRef, useState } from "react";
import { registerZone, useDropOver, ZONE_ATTR } from "../drop/route";
import { clipboardImage, giveDropped, givePasted, type DropNote, type Target } from "../drop/terminal";
import { useMachines } from "../hub/engines";
import { nameOfMachine } from "../machines/words";
import { trackedIn } from "../grids/terminals";
import { keyOf, LOCAL, sessionKey, type MachineId } from "../hub/machines";
import { hubOf, useDesk, useHubOf } from "../hub/store";
import type { DeskSocket } from "../hub/transport";
import { useFocusRequest } from "../shell/focus";
import { useSettings } from "../settings/store";
import { matches, scopeOf, terminalKeys, type ShortcutId } from "../shortcuts/keys";
import { useTheme } from "../theme/store";
import { monoStack } from "../theme/tokens";
import { xtermTheme } from "../theme/xterm";
import { Viewer } from "./viewer";

/** The hub closes a terminal's socket with a close frame when the terminal
 *  ends (no code: 1005), as the page does its own (1000). Any other close
 *  (1006: the connection dropped) is the hub going away, perhaps to
 *  restart, its terminals kept. */
export const closedByHub = (e: { code: number }): boolean => e.code === 1000 || e.code === 1005;

/** How long a pane waits before its `n`th try to attach again: half a
 *  second, doubling, at most ten. */
export const reattachDelay = (n: number): number => Math.min(10_000, 500 * 2 ** n);

/** How long a socket must stay open before the pane counts the hub as
 *  back, and tries again from the shortest wait should it drop. */
export const STEADY_MS = 5_000;

/** Written before the replay of a pane attached again. The hub's replay
 *  (its history, then the screen) expects a fresh terminal: the old output
 *  is kept, pushed up into the scrollback under a line that says so, and
 *  the replay drawn below it from the top. Nothing is erased, so the
 *  scrollback beyond what the hub keeps stays. */
export const reattachPrefix = (rows: number, alternate = false): string =>
  // Off the alternate screen first (where nothing reaches the scrollback);
  // only when on it, as leaving it also moves the cursor back.
  `${alternate ? "\x1b[?1049l" : ""}\x1b[m\r\n\x1b[2m— reconnected —\x1b[0m${"\n".repeat(Math.max(1, rows))}\x1b[H`;

/** A session's terminal, or a grid's: the hub's pseudo-terminal, attached
 *  over its socket (which replays what it kept, then streams). Where the
 *  same terminal shows in more than one place, the one the person last
 *  turned to types into it and sets its size; the others mirror it. */
export function Terminal({
  sessionId,
  terminalId,
  machine = LOCAL,
  autoFocus = true,
}: {
  sessionId?: string;
  /** A terminal the hub hosts for a grid pane, instead of a session's. */
  terminalId?: string;
  /** The engine it is on: this computer's when none. */
  machine?: MachineId;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const hub = useHubOf(machine);
  const session = useDesk((s) => {
    if (sessionId) return keyOf(machine, sessionId);
    const tracked = trackedIn(s.sessions, terminalId ? keyOf(machine, terminalId) : null);
    return tracked ? sessionKey(tracked) : null;
  });
  useFocusRequest(session && `session:${session}`, term);
  const theme = useTheme();
  /** Shown while another viewer is the one typing into this terminal. */
  const [viewing, setViewing] = useState(false);
  /** Files dropped here, or an image pasted, on their way to a machine; or
   *  why they couldn't be given. */
  const [note, setNote] = useState<DropNote | null>(null);
  const zoneId = useId();
  const dropOver = useDropOver((s) => s.over === zoneId);

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
    let ws: DeskSocket | null = null;
    const isOpen = () => ws?.readyState === WebSocket.OPEN;
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
      send: (c) => isOpen() && ws!.send(JSON.stringify(c)),
      role: (active) => setViewing(!active),
    });
    viewerRef.current = viewer;
    const inPane = () => !!host.current && host.current.contains(document.activeElement);
    const note = (text: string) => x.write(`\r\n\x1b[2m— ${text} —\x1b[0m\r\n`);
    const ended = () => note(terminalId ? "terminal closed" : "session detached");
    let gone = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let away = false;
    /** Set once a socket has stayed open long enough to count as back. */
    let steady: ReturnType<typeof setTimeout> | undefined;
    const attach = () => {
      // The hub as Desk now has it: where to reach it is read again for
      // each socket, so one that moved is found.
      const current = hubOf(machine) ?? hub;
      const again = away;
      const s = terminalId ? current.terminalSocket(terminalId) : current.ptySocket(sessionId!);
      ws = s;
      s.onopen = () => {
        // Only a socket that stays up is back: one that drops at once
        // goes on waiting longer, rather than every half second.
        steady = setTimeout(() => {
          retry = 0;
          away = false;
        }, STEADY_MS);
        // The hub replays the screen as for a fresh terminal: the old
        // output is kept above it.
        if (again) x.write(reattachPrefix(x.rows, x.buffer.active.type === "alternate"));
        viewer.opened(inPane());
      };
      s.onmessage = (m) => {
        // A brokered socket is given more once xterm has written this.
        if (m.data instanceof ArrayBuffer) x.write(new Uint8Array(m.data), s.hold?.());
        else if (typeof m.data === "string") {
          try {
            viewer.heard(JSON.parse(m.data));
          } catch {
            // Not a control message this Desk knows.
          }
        }
      };
      s.onclose = (e) => {
        clearTimeout(steady);
        if (gone || ws !== s) return;
        setViewing(false);
        if (closedByHub(e)) return ended();
        if (!away) note("reconnecting…");
        away = true;
        later();
      };
    };
    const later = () => {
      timer = setTimeout(() => void reattach(), reattachDelay(retry++));
    };
    // The socket dropped (the hub stopped, or can't be reached): once the
    // hub answers again, attach again, unless it no longer has it.
    const reattach = async () => {
      if (gone) return;
      const current = hubOf(machine) ?? hub;
      let there: boolean;
      try {
        const id = terminalId ?? sessionId;
        const all: { id: string; live: boolean }[] = terminalId ? await current.terminals() : await current.sessions();
        there = all.some((t) => t.id === id && t.live);
      } catch {
        if (!gone) later();
        return;
      }
      if (gone) return;
      if (there) attach();
      else ended();
    };
    attach();
    // Keys go to the hub as typed; it keeps only the active viewer's. The
    // claim comes from the person turning here (a click, focus, a key, a
    // paste), never from onData, which also carries xterm's answers to the
    // program's queries. The listeners capture, so the claim goes ahead of
    // what xterm sends for the same event (a focus report, a mouse report).
    const input = x.onData((d) => isOpen() && ws!.send(encoder.encode(d)));
    const turnedHere = () => viewer.claim();
    const el = host.current;
    const turns = ["mousedown", "focus", "paste"] as const;
    for (const t of turns) el.addEventListener(t, turnedHere, true);
    // Desk's own shortcuts (New terminal, New session, Settings) reach Desk,
    // not the shell, with the keys they take in a terminal: Ctrl and a
    // letter stays the shell's on Windows and Linux.
    x.attachCustomKeyEventHandler((e) => {
      const keys = useSettings.getState().keys;
      const desks = (Object.keys(keys) as ShortcutId[]).some((id) => scopeOf(id) === "app" && matches(e, terminalKeys(keys[id])));
      if (!desks && e.type === "keydown") viewer.claim();
      return !desks;
    });
    // Files dropped on the pane, and an image pasted into it: their paths
    // are typed in as a paste, as the person who dropped them is the one
    // typing here now. A paste with text in it stays xterm's.
    const target = (): Target => ({
      machine,
      machineName: nameOfMachine(machine, useMachines.getState().machines),
      scope: terminalId ?? sessionId!,
      write: (text) => {
        viewer.claim();
        x.focus();
        x.paste(text);
      },
      running: isOpen,
      note: setNote,
    });
    const unzone = registerZone(zoneId, {
      label: terminalId ? "terminal" : "session",
      drop: (paths) => {
        viewer.claim();
        x.focus();
        void giveDropped(target(), paths);
      },
    });
    const onPaste = (e: ClipboardEvent) => {
      const image = clipboardImage(e.clipboardData);
      if (!image) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void givePasted(target(), image);
    };
    el.addEventListener("paste", onPaste, true);
    const observer = new ResizeObserver(() => viewer.boxChanged());
    observer.observe(el);
    if (autoFocus) x.focus();
    return () => {
      gone = true;
      clearTimeout(timer);
      clearTimeout(steady);
      observer.disconnect();
      for (const t of turns) el.removeEventListener(t, turnedHere, true);
      el.removeEventListener("paste", onPaste, true);
      unzone();
      input.dispose();
      ws?.close();
      x.dispose();
      term.current = null;
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme changes are applied below without reconnecting
  }, [hub, sessionId, terminalId, machine]);

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
    <div className={dropOver ? "terminal-frame drop-over" : "terminal-frame"} {...{ [ZONE_ATTR]: zoneId }}>
      <div className="terminal" data-terminal ref={host} />
      {note && (
        <div className={`terminal-note${note.kind === "error" ? " terminal-note-error" : ""}`} role={note.kind === "error" ? "alert" : "status"}>
          <span>{note.text}</span>
          {note.kind === "copying" && note.cancel && (
            <button type="button" className="link small" onClick={note.cancel}>
              Cancel
            </button>
          )}
          {note.kind === "error" && (
            <button type="button" className="icon-btn-sm" aria-label="Dismiss" onClick={() => setNote(null)}>
              <svg width="11" height="11" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          )}
        </div>
      )}
      {viewing && (
        <button type="button" className="terminal-viewing" onClick={() => term.current?.focus()}>
          Viewing · click to type here
        </button>
      )}
    </div>
  );
}
