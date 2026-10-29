// Grid terminals: login shells the hub hosts, one per terminal pane. The hub
// keeps each running whether or not Desk is open; Desk opens it (once) when
// a pane first needs it, opens it again in the same folder if the hub lost
// it (a hub restart), and closes it when its pane is closed.
//
// A shell is opened with Desk's Claude Code plugin among its plugin folders,
// so a `claude` started in it registers with the hub as a Desk session
// hosted in that terminal (see src-tauri/resources/claude-plugin).

import { useEffect } from "react";
import { create } from "zustand";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { Session, TerminalInfo } from "../hub/types";
import { claudePluginDir, programsUnder } from "../platform";
import type { PaneContent } from "./engine";
import { setTerminal, writes } from "./store";

interface Watched {
  info: TerminalInfo;
  /** The shell, then what it started. */
  programs: string[];
}

interface TerminalsState {
  byId: Record<string, Watched>;
  /** Why a pane's terminal couldn't be opened, by pane id. */
  problems: Record<string, string>;
}

export const useTerminals = create<TerminalsState>(() => ({ byId: {}, problems: {} }));

const NO_ROUTE = "This hub doesn’t have that yet.";

const setProblem = (pane: string, problem: string | null) =>
  useTerminals.setState((s) => {
    const { [pane]: _was, ...rest } = s.problems;
    return { problems: problem ? { ...rest, [pane]: problem } : rest };
  });

const remember = (info: TerminalInfo, programs?: string[]) =>
  useTerminals.setState((s) => ({ byId: { ...s.byId, [info.id]: { info, programs: programs ?? s.byId[info.id]?.programs ?? [] } } }));

const problemOf = (e: unknown): string =>
  e instanceof HubError && e.status === 404 && e.message === NO_ROUTE
    ? "This hub can’t host terminals yet. It needs an update."
    : e instanceof Error
      ? e.message
      : String(e);

let env: Promise<Record<string, string>> | null = null;

/** What Desk adds to a terminal's environment: its Claude Code plugin
 *  folder. The hub adds the terminal's own id, token and hook address. */
export const terminalEnv = (): Promise<Record<string, string>> =>
  (env ??= claudePluginDir()
    .then((dir): Record<string, string> => (dir ? { CLAUDE_CODE_PLUGIN_DIRS: dir } : {}))
    .catch(() => ({})));

const opening = new Map<string, Promise<void>>();

/** Opens pane `pane`'s terminal on the hub, in `cwd` when it had one; once,
 *  however often it's asked. */
export const openPaneTerminal = (gridId: string, pane: string, cwd?: string | null): Promise<void> => {
  const was = opening.get(pane);
  if (was) return was;
  const p = (async () => {
    const hub = useDesk.getState().hub;
    if (!hub || !writes(gridId)) return;
    try {
      const info = await hub.openTerminal({ cwd: cwd ?? undefined, env: await terminalEnv() });
      setProblem(pane, null);
      remember(info, []);
      setTerminal(gridId, pane, info.id, info.cwd ?? cwd);
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

/** How often a terminal is looked at: its folder, what runs in it. */
const WATCH_MS = 4_000;

/** Keeps pane `pane`'s terminal open and known: opened when it has none,
 *  opened again where it was if the hub no longer has it, and read every few
 *  seconds for where it is and what runs in it. */
export function useTerminalPane(gridId: string, pane: string, content: Extract<PaneContent, { kind: "terminal" }>) {
  const hub = useDesk((s) => s.hub);
  const { terminalId, cwd } = content;
  useEffect(() => {
    if (!hub) return;
    if (!terminalId) {
      void openPaneTerminal(gridId, pane, cwd);
      return;
    }
    let stopped = false;
    const look = async () => {
      try {
        const info = await hub.terminal(terminalId);
        if (stopped) return;
        const programs = info.pid ? await programsUnder(info.pid).catch(() => []) : [];
        if (!stopped) remember(info, programs);
        if (info.cwd && info.cwd !== cwd) setTerminal(gridId, pane, terminalId, info.cwd);
      } catch (e) {
        if (stopped) return;
        // Gone (the hub restarted): a new shell where this one was.
        if (e instanceof HubError && e.status === 404 && e.message !== NO_ROUTE) {
          stopped = true;
          void openPaneTerminal(gridId, pane, cwd);
        }
      }
    };
    void look();
    const t = setInterval(() => void look(), WATCH_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // `cwd` is where to reopen, read when needed; it changing isn't a reason to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, gridId, pane, terminalId]);
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "tcsh", "ksh", "login"]);

/** What a terminal shows in its header: the shell and what's running in it
 *  (Codex is recognised here, by its process). */
export const describeTerminal = (w: Watched | undefined): { shell: string; running: string | null; codex: boolean; claude: boolean } => {
  const [shell = "zsh", ...rest] = w?.programs ?? [];
  const running = rest.find((p) => !SHELLS.has(p)) ?? null;
  return { shell, running, codex: rest.some((p) => /^codex\b/.test(p)), claude: rest.some((p) => p === "claude") };
};

/** The session running in terminal `id`, once Desk's hooks have registered it. */
export const trackedIn = (sessions: Record<string, Session>, id: string | null, w?: Watched): Session | null => {
  if (!id) return null;
  const named = w?.info.sessionId ? sessions[w.info.sessionId] : undefined;
  if (named?.live) return named;
  return Object.values(sessions).find((s) => s.terminalId === id && s.live) ?? null;
};
