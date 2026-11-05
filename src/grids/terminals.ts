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

import { useEffect } from "react";
import { create } from "zustand";
import { machineTransport } from "../hub/broker";
import { HubError, type DeskHub } from "../hub/client";
import { keyOf, LOCAL, machineOf, splitKey, type MachineId } from "../hub/machines";
import { engineListeners, hubOf, useDesk, useHubOf, type EngineEvent } from "../hub/store";
import type { Session, TerminalInfo } from "../hub/types";
import { backendHome, claudePluginDir, inApp, machinePluginDir, programsUnder } from "../platform";
import { baseName } from "../ui/paths";
import { sessionKeyIn, terminalKeyIn, type Pane, type PaneContent } from "./engine";
import { newId } from "./model";
import { setAskingCheck, setTerminal, setTerminalCheck, useGrids, writes } from "./store";

interface TerminalsState {
  /** Terminals as their engines last said, by key (see `keyOf`): this
   *  computer's by id, a machine's as `<machine>/<id>`. */
  byId: Record<string, TerminalInfo>;
  /** This computer's hub has listed its terminals (one that doesn't host
   *  them never does). */
  known: boolean;
  /** The machines whose engines have listed theirs. */
  knownOn: Record<MachineId, true>;
  /** What runs in each, shell first, where Desk can see, by key. */
  programs: Record<string, string[]>;
  /** Why a pane's terminal couldn't be opened, by pane id. */
  problems: Record<string, string>;
}

export const useTerminals = create<TerminalsState>(() => ({ byId: {}, known: false, knownOn: {}, programs: {}, problems: {} }));

/** Whether engine `machine` has listed its terminals. */
const knownIn = (s: TerminalsState, machine: MachineId): boolean => (machine === LOCAL ? s.known : !!s.knownOn[machine]);

const listed = (s: TerminalsState, machine: MachineId): Partial<TerminalsState> =>
  machine === LOCAL ? { known: true } : s.knownOn[machine] ? {} : { knownOn: { ...s.knownOn, [machine]: true } };

/** Keeps `useTerminals` as each engine announces its terminals. */
export const heardTerminals = (e: EngineEvent): void => {
  const machine = machineOf(e);
  if (e.type === "snapshot" && e.terminals) {
    const terminals = e.terminals;
    useTerminals.setState((s) => ({
      byId: {
        ...Object.fromEntries(Object.entries(s.byId).filter(([k]) => splitKey(k).machine !== machine)),
        ...Object.fromEntries(terminals.map((t) => [keyOf(machine, t.id), t])),
      },
      ...listed(s, machine),
    }));
  } else if (e.type === "terminal") {
    const t = e.terminal;
    useTerminals.setState((s) => ({ byId: { ...s.byId, [keyOf(machine, t.id)]: t }, ...listed(s, machine) }));
  } else if (e.type === "terminalRemoved") {
    const key = keyOf(machine, e.id);
    useTerminals.setState((s) => {
      const { [key]: _gone, ...byId } = s.byId;
      return { byId };
    });
  }
};
engineListeners.add(heardTerminals);

/** A machine let go: its terminals are no longer known here. */
useDesk.subscribe((s, before) => {
  if (s.engines === before.engines) return;
  const gone = Object.keys(before.engines).filter((m) => m !== LOCAL && !s.engines[m]);
  if (!gone.length) return;
  useTerminals.setState((t) => ({
    byId: Object.fromEntries(Object.entries(t.byId).filter(([k]) => !gone.includes(splitKey(k).machine))),
    knownOn: Object.fromEntries(Object.entries(t.knownOn).filter(([m]) => !gone.includes(m))),
  }));
});

const NO_ROUTE = "This hub doesn’t have that yet.";

const setProblem = (pane: string, problem: string | null) =>
  useTerminals.setState((s) => {
    const { [pane]: _was, ...rest } = s.problems;
    return { problems: problem ? { ...rest, [pane]: problem } : rest };
  });

const remember = (machine: MachineId, info: TerminalInfo) =>
  useTerminals.setState((s) => ({ byId: { ...s.byId, [keyOf(machine, info.id)]: info } }));

const problemOf = (e: unknown): string =>
  e instanceof HubError && e.status === 404 && e.message === NO_ROUTE
    ? "This hub can’t host terminals yet. It needs an update."
    : e instanceof Error
      ? e.message
      : String(e);

let pluginDirs: Promise<string | null> | null = null;
/** Each machine's plugin folder, once asked; one that failed is asked again. */
const machineDirs = new Map<MachineId, Promise<string | null>>();

const dirOn = (machine: MachineId): Promise<string | null> => {
  if (machine === LOCAL) return (pluginDirs ??= claudePluginDir().catch(() => null));
  let dir = machineDirs.get(machine);
  if (!dir) {
    dir = machinePluginDir(machine).catch(() => {
      machineDirs.delete(machine);
      return null;
    });
    machineDirs.set(machine, dir);
  }
  return dir;
};

/** What Desk adds to a terminal's or a session's environment: its Claude
 *  Code plugin folder, which the hub joins to any the person already loads
 *  (the hub has no way to find it itself). The hub adds the terminal's id,
 *  the token its hooks present and where they post. On a machine, it is
 *  the machine's own plugin folder. */
export const pluginEnv = async (machine: MachineId = LOCAL): Promise<Record<string, string>> => {
  const dir = await dirOn(machine);
  return dir ? { CLAUDE_CODE_PLUGIN_DIRS: dir } : {};
};

/** How a machine is asked for its home folder: its folders route (MH1),
 *  which names it. Tests set their own. */
let machineHome = async (machine: MachineId): Promise<string | null> => {
  const res = await machineTransport(machine).fetch("GET", "/api/desk/folders");
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { home?: unknown } | null;
  return typeof body?.home === "string" && body.home ? body.home : null;
};
export const setMachineHome = (f: typeof machineHome): void => {
  machineHome = f;
};

/** Where a new terminal opens when its pane names nowhere: this computer's
 *  home folder; on a machine, the folder its latest session worked in, else
 *  its home folder as it says, else nowhere. */
const homeOn = async (machine: MachineId): Promise<string | null> => {
  if (machine === LOCAL) return inApp ? await backendHome().catch(() => "/") : "/";
  const latest = Object.values(useDesk.getState().sessions)
    .filter((s) => machineOf(s) === machine && s.cwd)
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
  return latest?.cwd ?? (await machineHome(machine).catch(() => null));
};

const opening = new Map<string, Promise<void>>();

/** Opens pane `pane`'s terminal on its engine (`machine`) — in `cwd` when it
 *  had one, else the home folder — under `id` when it had one; once,
 *  however often asked. */
export const openPaneTerminal = (gridId: string, pane: string, cwd?: string | null, id?: string, machine: MachineId = LOCAL): Promise<void> => {
  const was = opening.get(pane);
  if (was) return was;
  const p = (async () => {
    const hub = hubOf(machine);
    if (!hub || !writes(gridId)) return;
    try {
      const where = cwd || (await homeOn(machine));
      if (!where) return setProblem(pane, "Desk doesn’t know a folder on this machine to open a terminal in yet.");
      const info = await hub.openTerminal({ id: id ?? newId(), cwd: where, env: await pluginEnv(machine) });
      setProblem(pane, null);
      remember(machine, info);
      setTerminal(gridId, pane, info.id, info.cwd);
    } catch (e) {
      setProblem(pane, problemOf(e));
    }
  })().finally(() => opening.delete(pane));
  opening.set(pane, p);
  return p;
};

/** Starts a terminal whose shell ended again, where it was. */
export const reopenTerminal = (pane: string, id: string, machine: MachineId = LOCAL): Promise<void> => {
  const was = opening.get(pane);
  if (was) return was;
  const p = (async () => {
    const hub = hubOf(machine);
    if (!hub) return;
    try {
      remember(machine, await hub.reopenTerminal(id));
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
  hubOf(machineOf(c))?.closeTerminal(c.terminalId).catch(useDesk.getState().fail);
};

/** How often what runs in a terminal is looked at. */
const WATCH_MS = 4_000;

/** Keeps pane `pane`'s terminal open: opened when it has none; opened again
 *  under its id if the hub no longer has it, or where it was if a reboot
 *  ended it; its folder kept with the pane; what runs in it looked at. */
export function useTerminalPane(gridId: string, pane: string, content: Extract<PaneContent, { kind: "terminal" }>) {
  const machine = machineOf(content);
  const hub: DeskHub | null = useHubOf(machine);
  const known = useTerminals((s) => knownIn(s, machine));
  const { terminalId, cwd } = content;
  const key = terminalKeyIn(content);
  const info = useTerminals((s) => (key ? s.byId[key] : undefined));
  const writer = useGridsWriter(gridId);

  useEffect(() => {
    if (!hub || !writer) return;
    if (!terminalId) void openPaneTerminal(gridId, pane, cwd, undefined, machine);
    else if (known && !info) void openPaneTerminal(gridId, pane, cwd, terminalId, machine);
    else if (info?.state === "lost") void reopenTerminal(pane, info.id, machine);
    // `cwd` is where to open, read when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, writer, gridId, pane, terminalId, machine, known, !!info, info?.state]);

  useEffect(() => {
    if (writer && terminalId && info?.cwd && info.cwd !== cwd) setTerminal(gridId, pane, terminalId, info.cwd);
  }, [writer, gridId, pane, terminalId, info?.cwd, cwd]);

  // What runs in it is looked at on this computer only: a machine's pid is
  // no process here (its engine will say, once the page may ask it).
  const pid = info?.live && machine === LOCAL ? info.pid : null;
  useEffect(() => {
    if (!key || !pid) return;
    let stopped = false;
    const look = () =>
      void programsUnder(pid)
        .catch(() => [])
        .then((programs) => !stopped && useTerminals.setState((s) => ({ programs: { ...s.programs, [key]: programs } })));
    look();
    const t = setInterval(look, WATCH_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [key, pid]);

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

/** The session running in terminal `key` (see `keyOf`), once Desk's hooks
 *  have registered it: one on the terminal's own engine. */
export const trackedIn = (sessions: Record<string, Session>, key: string | null): Session | null => {
  if (!key) return null;
  const { machine, id } = splitKey(key);
  return Object.values(sessions).find((s) => s.terminalId === id && s.live && machineOf(s) === machine) ?? null;
};

/** The session pane `content` shows, or the one started in its terminal. */
export const sessionIn = (sessions: Record<string, Session>, content: PaneContent | null): Session | null =>
  content?.kind === "session" ? (sessions[sessionKeyIn(content)!] ?? null) : content?.kind === "terminal" ? trackedIn(sessions, terminalKeyIn(content)) : null;

/** The panes whose session is waiting on the person: on an approval, or on
 *  what its turn ended asking. */
export const askingIn = (panes: readonly Pane[], sessions: Record<string, Session> = useDesk.getState().sessions): string[] =>
  panes
    .filter((p) => {
      const s = sessionIn(sessions, p.content);
      return !!s?.pending || s?.state === "asking";
    })
    .map((p) => p.id);

/** The Desk terminal `content` keeps open, by key: a terminal's own, or the
 *  one a session runs in, while its engine still has it. */
export const terminalOf = (content: PaneContent): string | null => {
  if (content.kind === "terminal") return terminalKeyIn(content);
  if (content.kind !== "session") return null;
  const id = useDesk.getState().sessions[sessionKeyIn(content)!]?.terminalId;
  const key = id ? keyOf(machineOf(content), id) : null;
  return key && useTerminals.getState().byId[key] ? key : null;
};

// A smaller layout keeps these first.
setAskingCheck((panes) => askingIn(panes));
// A terminal replaced or shown as its session is kept, not lost.
setTerminalCheck(terminalOf);
