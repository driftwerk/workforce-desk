import { create } from "zustand";
import { useChat } from "../chat/store";
import { connectionsOf } from "../hub/connections";
import { useMachines } from "../hub/engines";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { helperStatus, type HelperStatus } from "../platform";
import { NO_SETUP, useSettings } from "../settings/store";

/** The first-run setup's steps, in the order they're offered. */
export type StepId = "plan" | "helper" | "overseer" | "connections" | "workspaces" | "machines";

export const STEPS: readonly StepId[] = ["plan", "helper", "overseer", "connections", "workspaces", "machines"];

/** What each step is, said by Desk's agent. */
export const STEP_TEXT: Record<StepId, { title: string; why: string }> = {
  plan: {
    title: "Sign in to a plan",
    why: "Your agents think with your Claude or ChatGPT plan. Sign in once and every agent here can use it.",
  },
  helper: {
    title: "Keep Desk's helper running",
    why: "Desk's helper keeps your agents and sessions going when Desk is closed.",
  },
  overseer: {
    title: "Pick who oversees your crew",
    why: "An overseer keeps track of every agent and session and tells you what needs you.",
  },
  connections: {
    title: "Connect the services you work in",
    why: "GitHub, Jira, Linear and the rest: connect each once, then turn it on for the agents that need it.",
  },
  workspaces: {
    title: "Pair a workspace",
    why: "Agents your team runs on a shared workspace can join you here. Skip this if you work alone.",
  },
  machines: {
    title: "Add a machine",
    why: "Run sessions on a build server or another computer you own. Skip this if this computer is enough.",
  },
};

/** Where a step stands now: done, still to do, or not known yet. */
export type StepState = "done" | "todo" | "unknown";

/** What the steps are worked out from, read when the setup shows. */
export interface Facts {
  /** A provider agents can think with is connected. */
  plan: boolean | null;
  helper: HelperStatus | null;
  connections: boolean | null;
}

export const useFacts = create<Facts & { read: () => Promise<void> }>((set) => ({
  plan: null,
  helper: null,
  connections: null,
  read: async () => {
    // One read at a time.
    if (reading) return reading;
    reading = readFacts(set).finally(() => (reading = null));
    return reading;
  },
}));

let reading: Promise<void> | null = null;

async function readFacts(set: (p: Partial<Facts>) => void): Promise<void> {
  {
    const hub = useDesk.getState().hub;
    const local = useChat.getState().hubs.find((h) => h.local);
    await Promise.all([
      hub
        ?.providers()
        .then((ps) => set({ plan: ps.some((p) => p.connected) }))
        .catch(() => undefined),
      helperStatus()
        .then((helper) => set({ helper }))
        .catch(() => undefined),
      local
        ? connectionsOf(local)
            .list()
            .then((l) =>
              set({
                connections: l.connectors.some((c) => c.connections.length > 0),
              }),
            )
            .catch(() => undefined)
        : undefined,
    ]);
  }
}

/** Whether the helper is doing its job: running, or a development build,
 *  which runs one of its own. */
export const helperFine = (h: HelperStatus | null): boolean | null => (h === null ? null : h.state === "running" || h.state === "development");

const known = (b: boolean | null | undefined): StepState => (b === null || b === undefined ? "unknown" : b ? "done" : "todo");

/** Where every step stands, from what Desk knows now. */
export function useSteps(): Record<StepId, StepState> {
  const facts = useFacts();
  const workspaces = useChat((s) => s.hubs.some((h) => !h.local));
  const machines = useMachines((s) => (s.listed ? s.machines.length > 0 : null));
  const overseer = useOverview((s) => (s.managerSupport === "yes" ? !!s.manager?.agentId : s.managerSupport === "no" ? true : null));
  return {
    plan: known(facts.plan),
    helper: known(helperFine(facts.helper)),
    overseer: known(overseer),
    connections: known(facts.connections),
    workspaces: workspaces ? "done" : "todo",
    machines: known(machines),
  };
}

/** The steps left: neither done nor skipped. */
export const leftOf = (steps: Record<StepId, StepState>, skipped: readonly string[]): StepId[] =>
  STEPS.filter((s) => steps[s] !== "done" && !skipped.includes(s));

/** The setup's progress, as Desk's settings file keeps it. */
export const useProgress = () => useSettings((s) => s.setup ?? NO_SETUP);

/** Changes the setup's progress, stamped so a later write from another
 *  window doesn't roll it back. */
const change = (patch: Partial<typeof NO_SETUP>): void => {
  const { setup, set } = useSettings.getState();
  set({
    setup: { ...(setup ?? NO_SETUP), ...patch, at: new Date().toISOString() },
  });
};

export const skip = (step: StepId): void => {
  const skipped = (useSettings.getState().setup ?? NO_SETUP).skipped;
  if (!skipped.includes(step)) change({ skipped: [...skipped, step] });
};
export const unskip = (step: StepId): void =>
  change({
    skipped: (useSettings.getState().setup ?? NO_SETUP).skipped.filter((s) => s !== step),
  });
export const closeSetup = (): void => change({ closed: true, started: true });
/** Offered without showing it: for someone already set up. */
export const setupSeen = (): void => change({ closed: true, started: true });
export const openSetup = (): void => change({ closed: false, started: true });

export { useDeskAgent, useSetupOpen } from "./slot";

/** How often what the steps stand on is read again while the setup shows,
 *  so a step done elsewhere (a sign-in in the browser) ticks itself. */
export const REREAD_MS = 5000;

let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Reads the facts now and every few seconds while anything watches: one
 *  timer however many views watch, skipped while Desk isn't on screen and
 *  while a read is still under way. What it returns stops this watcher. */
export const watchFacts = (): (() => void) => {
  watchers += 1;
  void useFacts.getState().read();
  timer ??= setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void useFacts.getState().read();
  }, REREAD_MS);
  return () => {
    watchers -= 1;
    if (watchers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};
