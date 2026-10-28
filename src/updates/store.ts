import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import type { DeskEvent, Session } from "../hub/types";
import { deskListeners, useDesk } from "../hub/store";
import { resumeLater, takeResume } from "../platform";

/** How often Desk looks for a new version while it runs. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type UpdatePhase =
  | { phase: "idle" }
  | { phase: "downloading"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "installing"; version: string };

interface Updates {
  state: UpdatePhase;
  /** Restart as soon as no session is working. */
  waiting: boolean;
  update: Update | null;
  check: () => Promise<void>;
  wait: (on: boolean) => void;
  /** Installs, keeps `resume` to pick up after the restart, and restarts. */
  restart: (resume: string[]) => Promise<void>;
}

/** A session whose CLI is running: it stops for the restart. */
export const isLive = (s: Session): boolean => s.live;
/** One mid-task: worth waiting for. */
export const isWorking = (s: Session): boolean => s.live && ["starting", "working", "blocked"].includes(s.state);

export const useUpdates = create<Updates>((set, get) => ({
  state: { phase: "idle" },
  waiting: false,
  update: null,
  check: async () => {
    if (get().state.phase !== "idle") return;
    const update = await check();
    if (!update) return;
    set({ update, state: { phase: "downloading", version: update.version } });
    try {
      await update.download();
      set({ state: { phase: "ready", version: update.version } });
    } catch (e) {
      set({ update: null, state: { phase: "idle" } });
      throw e;
    }
  },
  wait: (waiting) => set({ waiting }),
  restart: async (resume) => {
    const { update, state } = get();
    if (!update || state.phase !== "ready") return;
    set({ state: { phase: "installing", version: update.version }, waiting: false });
    try {
      if (resume.length) await resumeLater(resume);
      await update.install();
      await relaunch();
    } catch (e) {
      set({ state: { phase: "ready", version: update.version } });
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
  attempt(Object.values(useDesk.getState().sessions));
}
