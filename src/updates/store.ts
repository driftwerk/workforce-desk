import { create } from "zustand";
import type { DeskEvent, Session } from "../hub/types";
import { deskListeners, useDesk, localSessions } from "../hub/store";
import { resumeLater, takeResume, updateCheck, updateDownload, updateInstall, updating } from "../platform";

/** How often Desk looks for a new version while it runs. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type UpdatePhase =
  | { phase: "idle" }
  /** Out, for an install its package manager updates: downloaded by hand. */
  | { phase: "available"; version: string; download: string | null }
  | { phase: "downloading"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "installing"; version: string };

/** "Later" on a version: hidden for the rest of this run of Desk (`started`)
 *  until the next check. */
export interface Later {
  version: string;
  started: number;
}

const LATER_KEY = "desk.update.later";

const readLater = (): Later | null => {
  try {
    const v = JSON.parse(localStorage.getItem(LATER_KEY) ?? "null") as Later | null;
    return v && typeof v.version === "string" && typeof v.started === "number" ? v : null;
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
   *  holder has them), as of the last check. */
  sessionsKept: boolean;
  /** When this run of Desk started, as of the last check. */
  started: number | null;
  /** Why this install never updates (a development build), once checked. */
  never: string | null;
  later: Later | null;
  /** Looks for a new version and downloads it. `launch`: the check as Desk
   *  (or its page) starts, which keeps a Later from this same run; any
   *  other check ends it. */
  check: (opts?: { launch?: boolean }) => Promise<void>;
  wait: (on: boolean) => void;
  /** Hides the notice for this version until the next check or start. */
  postpone: () => void;
  /** Keeps `resume` to pick up after the restart, installs and restarts. */
  restart: (resume: string[]) => Promise<void>;
}

/** A session whose CLI is running. */
export const isLive = (s: Session): boolean => s.live;
/** One mid-task: worth waiting for. */
export const isWorking = (s: Session): boolean => s.live && ["starting", "working", "blocked"].includes(s.state);
/** One that can't be resumed if its CLI stops. */
export const cantResume = (s: Session): boolean => s.caps?.resume === "none";

/** Whether the notice for `version` is put off. */
export const isPostponed = (later: Later | null, version: string, started: number | null): boolean =>
  !!later && later.version === version && later.started === started;

export const useUpdates = create<Updates>((set, get) => ({
  state: { phase: "idle" },
  waiting: false,
  sessionsKept: false,
  started: null,
  never: null,
  later: readLater(),
  check: async (opts) => {
    if (!opts?.launch && get().later) {
      keepLater(null);
      set({ later: null });
    }
    if (get().state.phase !== "idle") return;
    // Asked first: a development build never looks.
    const how = await updating();
    set({ sessionsKept: how.sessionsKept, started: how.started, never: how.how === "never" ? (how.neverBecause ?? "") : null });
    // A Later from an earlier run of Desk is over.
    const later = get().later;
    if (later && later.started !== how.started) {
      keepLater(null);
      set({ later: null });
    }
    if (how.how === "never") return;
    const version = await updateCheck();
    if (!version) return;
    if (how.how === "package") {
      set({ state: { phase: "available", version, download: how.download } });
      return;
    }
    set({ state: { phase: "downloading", version } });
    try {
      await updateDownload();
      set({ state: { phase: "ready", version } });
    } catch (e) {
      set({ state: { phase: "idle" } });
      throw e;
    }
  },
  wait: (waiting) => set({ waiting }),
  postpone: () => {
    const { state, started } = get();
    if (state.phase !== "ready" && state.phase !== "available") return;
    if (started === null) return;
    const later = { version: state.version, started };
    keepLater(later);
    set({ later, waiting: false });
  },
  restart: async (resume) => {
    const { state } = get();
    if (state.phase !== "ready") return;
    set({ state: { phase: "installing", version: state.version }, waiting: false });
    try {
      if (resume.length) await resumeLater(resume);
      // Restarts into the new version once installed.
      await updateInstall();
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
