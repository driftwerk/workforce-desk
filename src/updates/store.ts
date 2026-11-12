import { create } from "zustand";
import type { DeskEvent, Session } from "../hub/types";
import { deskListeners, useDesk, localSessions } from "../hub/store";
import { resumeLater, takeResume, updateCheck, updateDownload, updateInstall, updating } from "../platform";
import { flushEverywhere } from "./away";

/** How often Desk looks for a new version while it runs. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type UpdatePhase =
  | { phase: "idle" }
  /** Out, for an install its package manager updates: downloaded by hand. */
  | { phase: "available"; version: string; download: string | null }
  | { phase: "downloading"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "installing"; version: string };

/** "Later" on a version: hidden until a newer version is out, through
 *  restarts and the checks every few hours. Asking for a check (Help's
 *  Check for updates) shows it again. */
export interface Later {
  version: string;
}

const LATER_KEY = "desk.update.later";

const readLater = (): Later | null => {
  try {
    const v = JSON.parse(localStorage.getItem(LATER_KEY) ?? "null") as Later | null;
    return v && typeof v.version === "string" ? { version: v.version } : null;
  } catch {
    return null;
  }
};

const keepLater = (later: Later | null) => {
  try {
    if (later) localStorage.setItem(LATER_KEY, JSON.stringify(later));
    else localStorage.removeItem(LATER_KEY);
  } catch {
    // Without storage, Later lasts until the page reloads.
  }
};

interface Updates {
  state: UpdatePhase;
  /** Restart as soon as no session is working. */
  waiting: boolean;
  /** This computer's sessions keep running through the restart (the PTY
   *  holder has them), as last asked. */
  sessionsKept: boolean;
  /** Why this install never updates (a development build), once checked. */
  never: string | null;
  later: Later | null;
  /** Looks for a new version, also while one is ready or out (a newer one
   *  replaces it, and is downloaded), and downloads it. `asked`: the
   *  person asked for this check, which shows a version put off. */
  check: (opts?: { asked?: boolean }) => Promise<void>;
  wait: (on: boolean) => void;
  /** Hides the notice for this version until a newer one is out. */
  postpone: () => void;
  /** Asks again whether the PTY holder keeps the sessions; what it says. */
  probe: () => Promise<boolean>;
  /** Keeps `resume` to pick up after the restart, installs and restarts. */
  restart: (resume: string[]) => Promise<void>;
}

/** A session whose CLI is running. */
export const isLive = (s: Session): boolean => s.live;
/** One mid-task, or one Desk can't tell isn't: worth waiting for. Asking
 *  the person, with background work still running, one whose engine says
 *  nothing of its state, or one adopted from a terminal (idle as far as
 *  Desk can tell). */
export const isWorking = (s: Session): boolean =>
  s.live &&
  (["starting", "working", "blocked", "asking"].includes(s.state) || (s.background?.count ?? 0) > 0 || s.caps?.state === "none" || s.origin === "external");
/** One that can't be resumed if its CLI stops. */
export const cantResume = (s: Session): boolean => s.caps?.resume === "none";

/** Whether the notice for `version` is put off. */
export const isPostponed = (later: Later | null, version: string): boolean => !!later && later.version === version;

const shown = (state: UpdatePhase): string | null =>
  state.phase === "ready" || state.phase === "available" ? state.version : null;

/** A restart is being started (between its probe and installing). */
let restarting = false;

export const useUpdates = create<Updates>((set, get) => ({
  state: { phase: "idle" },
  waiting: false,
  sessionsKept: false,
  never: null,
  later: readLater(),
  check: async (opts) => {
    if (opts?.asked && get().later) {
      keepLater(null);
      // Put off no longer: a version already here installs when idle again.
      set({ later: null, waiting: get().state.phase === "ready" });
    }
    const phase = get().state.phase;
    if (phase === "downloading" || phase === "installing") return;
    // Asked first: a development build never looks.
    const how = await updating();
    set({ sessionsKept: how.sessionsKept, never: how.how === "never" ? (how.neverBecause ?? "") : null });
    if (how.how === "never") return;
    const version = await updateCheck();
    // Something else began meanwhile (a restart, another check).
    const now = get().state;
    if (now.phase === "downloading" || now.phase === "installing") return;
    if (!version) {
      // None newer than this Desk: what was offered is gone too (the native
      // side let it go).
      if (now.phase !== "idle") set({ state: { phase: "idle" }, waiting: false });
      return;
    }
    if (shown(now) === version) return;
    // A version put off is over once a newer one is out.
    const later = get().later;
    if (later && later.version !== version) {
      keepLater(null);
      set({ later: null });
    }
    if (how.how === "package") {
      set({ state: { phase: "available", version, download: how.download } });
      return;
    }
    set({ state: { phase: "downloading", version } });
    try {
      await updateDownload();
      // It installs by itself once nothing is working and the person has
      // stepped away (`useRestartWhenIdle`), unless they put it off.
      set({ state: { phase: "ready", version }, waiting: !isPostponed(get().later, version) });
    } catch (e) {
      set({ state: { phase: "idle" }, waiting: false });
      throw e;
    }
  },
  wait: (waiting) => set({ waiting }),
  postpone: () => {
    const version = shown(get().state);
    if (!version) return;
    const later = { version };
    keepLater(later);
    set({ later, waiting: false });
  },
  probe: async () => {
    try {
      const { sessionsKept } = await updating();
      set({ sessionsKept });
      return sessionsKept;
    } catch {
      return get().sessionsKept;
    }
  },
  restart: async (resume) => {
    const { state } = get();
    // One restart at a time: a second asked meanwhile is the same one.
    if (state.phase !== "ready" || restarting) return;
    restarting = true;
    try {
      // As it is now, not as of the last check.
      await get().probe();
      if (get().state !== state) return;
      set({ state: { phase: "installing", version: state.version }, waiting: false });
    } finally {
      restarting = false;
    }
    try {
      // What every window hasn't written yet (drafts among it) goes first.
      await flushEverywhere();
      if (resume.length) await resumeLater(resume);
      // Installs this version (refused unless it's the newest downloaded)
      // and restarts into it.
      await updateInstall(state.version);
    } catch (e) {
      set({ state: { phase: "ready", version: state.version } });
      throw e;
    }
  },
}));

/** How long after a restart Desk keeps trying to resume what was open. */
const RESUME_FOR_MS = 15 * 60 * 1000;

/** Sessions, among those saved before the restart, that are ready to
 *  resume: no longer running, because the hub restarted into the update. */
export const readyToResume = (pending: ReadonlySet<string>, sessions: Session[]): string[] =>
  sessions.filter((s) => pending.has(s.id) && !s.live).map((s) => s.id);

/** After restarting into an update: resumes the sessions that were open
 *  before it, once the updated hub has them (Desk Helper hands over to the
 *  new version a few seconds after the app restarts). */
export async function resumeAfterUpdate(): Promise<void> {
  const pending = new Set(await takeResume());
  if (!pending.size) return;
  const until = Date.now() + RESUME_FOR_MS;
  const attempt = (sessions: Session[]) => {
    const ids = readyToResume(pending, sessions);
    if (!ids.length) return;
    for (const id of ids) pending.delete(id);
    const { hub, fail } = useDesk.getState();
    void hub?.restore(ids).catch(fail);
  };
  const listener = (e: DeskEvent) => {
    if (e.type === "snapshot") attempt(e.sessions);
    if (e.type === "session") attempt([e.session]);
    if (!pending.size || Date.now() > until) deskListeners.delete(listener);
  };
  deskListeners.add(listener);
  attempt(Object.values(localSessions(useDesk.getState().sessions)));
}
