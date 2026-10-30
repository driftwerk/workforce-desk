// Grid terminals: login shells the hub hosts (`/api/desk/terminals`), one
// per terminal pane. The hub keeps each running whether or not Desk is
// open, follows its folder, and announces it on the events socket; Desk opens
// one (once, under an id it chooses) when a pane first needs it, opens it
// again where it was if a reboot ended it, and closes it when its pane is
// closed.
//
// A shell is opened with Desk's Claude Code plugin among its plugin folders
// and a token for Desk's hooks, so a `claude` started in it registers with
// the hub as a Desk session hosted in that terminal (see
// src-tauri/resources/claude-plugin).

import { homeDir } from "@tauri-apps/api/path";
import { useEffect } from "react";
import { create } from "zustand";
import { HubError } from "../hub/client";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, Session, TerminalInfo } from "../hub/types";
import { claudePluginDir, inApp, programsUnder } from "../platform";
import { baseName } from "../ui/paths";
import type { Pane, PaneContent } from "./engine";
import { newId } from "./model";
import { setAskingCheck, setTerminal, setTerminalCheck, useGrids, writes } from "./store";

interface TerminalsState {
  /** Terminals as the hub last said. */
  byId: Record<string, TerminalInfo>;
  /** The hub has listed its terminals (one that doesn't host them never does). */
  known: boolean;
  /** What runs in each, shell first, where Desk can see. */
  programs: Record<string, string[]>;
  /** Why a pane's terminal couldn't be opened, by pane id. */
  problems: Record<string, string>;
}

export const useTerminals = create<TerminalsState>(() => ({ byId: {}, known: false, programs: {}, problems: {} }));

/** Keeps `useTerminals` as the hub announces terminals. */
export const heardTerminals = (e: DeskEvent): void => {
  if (e.type === "snapshot" && e.terminals) {
    useTerminals.setState({ byId: Object.fromEntries(e.terminals.map((t) => [t.id, t])), known: true });
  } else if (e.type === "terminal") {
    useTerminals.setState((s) => ({ byId: { ...s.byId, [e.terminal.id]: e.terminal }, known: true }));
  } else if (e.type === "terminalRemoved") {
    useTerminals.setState((s) => {
      const { [e.id]: _gone, ...byId } = s.byId;
      return { byId };
    });
  }
};
deskListeners.add(heardTerminals);

const NO_ROUTE = "This hub doesn’t have that yet.";

const setProblem = (pane: string, problem: string | null) =>
  useTerminals.setState((s) => {
    const { [pane]: _was, ...rest } = s.problems;
    return { problems: problem ? { ...rest, [pane]: problem } : rest };
  });

const remember = (info: TerminalInfo) => useTerminals.setState((s) => ({ byId: { ...s.byId, [info.id]: info } }));

const problemOf = (e: unknown): string =>
  e instanceof HubError && e.status === 404 && e.message === NO_ROUTE
    ? "This hub can’t host terminals yet. It needs an update."
    : e instanceof Error
      ? e.message
      : String(e);

let pluginDirs: Promise<string | null> | null = null;

/** What Desk adds to a terminal's or a session's environment: its Claude
 *  Code plugin folder, which the hub joins to any the person already loads
 *  (the hub has no way to find it itself). The hub adds the terminal's id,
 *  the token its hooks present and where they post. */
export const pluginEnv = async (): Promise<Record<string, string>> => {
  const dir = await (pluginDirs ??= claudePluginDir().catch(() => null));
  return dir ? { CLAUDE_CODE_PLUGIN_DIRS: dir } : {};
};

const opening = new Map<string, Promise<void>>();

/** Opens pane `pane`'s terminal on the hub — in `cwd` when it had one, else
 *  the home folder — under `id` when it had one; once, however often asked. */
export const openPaneTerminal = (gridId: string, pane: string, cwd?: string | null, id?: string): Promise<void> => {
  const was = opening.get(pane);
  if (was) return was;
  const p = (async () => {
    const hub = useDesk.getState().hub;
    if (!hub || !writes(gridId)) return;
    try {
      const where = cwd || (inApp ? await homeDir().catch(() => "/") : "/");
      const info = await hub.openTerminal({ id: id ?? newId(), cwd: where, env: await pluginEnv() });
      setProblem(pane, null);
      remember(info);
      setTerminal(gridId, pane, info.id, info.cwd);
    } catch (e) {
      setProblem(pane, problemOf(e));
    }
  })().finally(() => opening.delete(pane));
  opening.set(pane, p);
  return p;
};

/** Starts a terminal whose shell ended again, where it was. */
export const reopenTerminal = (pane: string, id: string): Promise<void> => {
  const was = opening.get(pane);
  if (was) return was;
  const p = (async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    try {
      remember(await hub.reopenTerminal(id));
      setProblem(pane, null);
    } catch (e) {
      setProblem(pane, problemOf(e));
    }
  })().finally(() => opening.delete(pane));
  opening.set(pane, p);
  return p;
};

/** Closes what a pane held, if the hub hosts it for the pane (a terminal). */
export const closeContent = (c: PaneContent): void => {
  if (c.kind !== "terminal" || !c.terminalId) return;
  const { hub, fail } = useDesk.getState();
  hub?.closeTerminal(c.terminalId).catch(fail);
};

/** How often what runs in a terminal is looked at. */
const WATCH_MS = 4_000;

/** Keeps pane `pane`'s terminal open: opened when it has none; opened again
 *  under its id if the hub no longer has it, or where it was if a reboot
 *  ended it; its folder kept with the pane; what runs in it looked at. */
export function useTerminalPane(gridId: string, pane: string, content: Extract<PaneContent, { kind: "terminal" }>) {
  const hub = useDesk((s) => s.hub);
  const known = useTerminals((s) => s.known);
  const { terminalId, cwd } = content;
  const info = useTerminals((s) => (terminalId ? s.byId[terminalId] : undefined));
  const writer = useGridsWriter(gridId);

  useEffect(() => {
    if (!hub || !writer) return;
    if (!terminalId) void openPaneTerminal(gridId, pane, cwd);
    else if (known && !info) void openPaneTerminal(gridId, pane, cwd, terminalId);
    else if (info?.state === "lost") void reopenTerminal(pane, info.id);
    // `cwd` is where to open, read when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, writer, gridId, pane, terminalId, known, !!info, info?.state]);

  useEffect(() => {
    if (writer && terminalId && info?.cwd && info.cwd !== cwd) setTerminal(gridId, pane, terminalId, info.cwd);
  }, [writer, gridId, pane, terminalId, info?.cwd, cwd]);

  const pid = info?.live ? info.pid : null;
  useEffect(() => {
    if (!terminalId || !pid) return;
    let stopped = false;
    const look = () =>
      void programsUnder(pid)
        .catch(() => [])
        .then((programs) => !stopped && useTerminals.setState((s) => ({ programs: { ...s.programs, [terminalId]: programs } })));
    look();
    const t = setInterval(look, WATCH_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [terminalId, pid]);

  return { info, known };
}

const useGridsWriter = (gridId: string): boolean => useGrids((s) => writes(gridId, s));

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "tcsh", "ksh", "login"]);

/** What a terminal shows in its header: the shell and what's running in it
 *  (Codex is recognised here, by its process). */
export const describeTerminal = (info: TerminalInfo | undefined, programs: string[] | undefined) => {
  const [first, ...rest] = programs ?? [];
  const shell = first ?? (info && baseName(info.shell)) ?? "zsh";
  const running = rest.find((p) => !SHELLS.has(p)) ?? null;
  return { shell, running, codex: rest.some((p) => /^codex\b/.test(p)), claude: rest.some((p) => p === "claude") };
};

/** The session running in terminal `id`, once Desk's hooks have registered it. */
export const trackedIn = (sessions: Record<string, Session>, id: string | null): Session | null =>
  id ? (Object.values(sessions).find((s) => s.terminalId === id && s.live) ?? null) : null;

/** The session pane `content` shows, or the one started in its terminal. */
export const sessionIn = (sessions: Record<string, Session>, content: PaneContent | null): Session | null =>
  content?.kind === "session" ? (sessions[content.sessionId] ?? null) : content?.kind === "terminal" ? trackedIn(sessions, content.terminalId) : null;

/** The panes whose session is waiting on an approval. */
export const askingIn = (panes: readonly Pane[], sessions: Record<string, Session> = useDesk.getState().sessions): string[] =>
  panes.filter((p) => sessionIn(sessions, p.content)?.pending).map((p) => p.id);

/** The Desk terminal `content` keeps open: a terminal's own, or the one a
 *  session runs in, while the hub still has it. */
export const terminalOf = (content: PaneContent): string | null => {
  if (content.kind === "terminal") return content.terminalId;
  const id = content.kind === "session" ? useDesk.getState().sessions[content.sessionId]?.terminalId : null;
  return id && useTerminals.getState().byId[id] ? id : null;
};

// A smaller layout keeps these first.
setAskingCheck((panes) => askingIn(panes));
// A terminal replaced or shown as its session is kept, not lost.
setTerminalCheck(terminalOf);
