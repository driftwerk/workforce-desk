import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import { floorOf, type Choice } from "../hub/floor";
import type { FloorView, Need, UsageView } from "../hub/types";
import { missing } from "../overview/store";
import { plainError } from "../ui/plainError";
import { merged, type Merged } from "./merge";
import { countsByItem } from "./needs";
import { nextLocalMidnight, startOfLocalDay } from "./time";
import { plans, type PlanCard } from "./usage";

/** What Desk knows of one hub's floor. */
export interface HubFloor {
  state: "loading" | "ready" | "failed" | "unsupported";
  floor: FloorView | null;
  usage: UsageView | null;
  /** The hub's clock less this Mac's, from `asOf` when it was read. */
  offset: number;
  /** The last read failed; what's shown is from `at`. */
  stale: boolean;
  at: string | null;
}

/** A need answered elsewhere before Desk's answer reached the hub: gone
 *  from the floor, said once until the hub is read again. */
export interface Answered {
  hubId: string;
  need: Need;
}

interface FloorStore {
  hubs: Record<string, HubFloor>;
  /** Answers on their way, by need key (`hub/need`). */
  deciding: Record<string, Choice>;
  /** Why an answer didn't go through, by need key. */
  problems: Record<string, string>;
  answered: Record<string, Answered>;
  /** The start of the person's day the floor was last read for. */
  day: number;
  /** Reads a hub's floor and usage; a read asked for while one runs follows it. */
  load: (hubId: string) => Promise<void>;
  decide: (hubId: string, need: Need, choice: Choice) => Promise<void>;
}

const blank = (): HubFloor => ({ state: "loading", floor: null, usage: null, offset: 0, stale: false, at: null });

const accountOf = (hubId: string): HubAccount | undefined => useChat.getState().hubs.find((h) => h.id === hubId);

const sameAccount = (a: HubAccount | undefined, b: HubAccount | undefined): boolean => !!a && !!b && a.url === b.url && a.token === b.token;

const running = new Map<string, Promise<void>>();
const again = new Set<string>();

const without = <V>(record: Record<string, V>, drop: (key: string, v: V) => boolean): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([k, v]) => !drop(k, v)));

const ofHub = (hubId: string) => (key: string) => key.startsWith(`${hubId}/`);

export const useFloor = create<FloorStore>((set) => {
  const put = (hubId: string, f: (was: HubFloor) => HubFloor) =>
    set((s) => ({ hubs: { ...s.hubs, [hubId]: f(s.hubs[hubId] ?? blank()) } }));

  const read = async (hubId: string): Promise<void> => {
    const hub = accountOf(hubId);
    if (!hub) return;
    const day = startOfLocalDay();
    const api = floorOf(hub);
    const [floor, usage] = await Promise.allSettled([api.floor(day), api.usage()]);
    const receivedAt = Date.now();
    if (!sameAccount(accountOf(hubId), hub)) return;
    if (floor.status === "rejected") {
      if (missing(floor.reason)) return put(hubId, () => ({ ...blank(), state: "unsupported" }));
      return put(hubId, (was) => (was.floor ? { ...was, state: "ready", stale: true } : { ...was, state: "failed" }));
    }
    const view = floor.value;
    const listed = new Set(view.needs.map((n) => `${hubId}/${n.id}`));
    set((s) => ({
      day: day.getTime(),
      hubs: {
        ...s.hubs,
        [hubId]: {
          state: "ready",
          floor: view,
          usage: usage.status === "fulfilled" ? usage.value : missing(usage.reason) ? null : (s.hubs[hubId]?.usage ?? null),
          offset: Date.parse(view.asOf) - receivedAt,
          stale: false,
          at: new Date(receivedAt).toISOString(),
        },
      },
      deciding: without(s.deciding, (k) => ofHub(hubId)(k) && !listed.has(k)),
      problems: without(s.problems, (k) => ofHub(hubId)(k) && !listed.has(k)),
      answered: without(s.answered, ofHub(hubId)),
    }));
  };

  return {
    hubs: {},
    deciding: {},
    problems: {},
    answered: {},
    day: startOfLocalDay().getTime(),
    load: (hubId) => {
      const now = running.get(hubId);
      if (now) {
        again.add(hubId);
        return now;
      }
      const p = (async () => {
        do {
          again.delete(hubId);
          await read(hubId);
        } while (again.has(hubId));
      })().finally(() => running.delete(hubId));
      running.set(hubId, p);
      return p;
    },
    decide: async (hubId, need, choice) => {
      const hub = accountOf(hubId);
      if (!hub || need.answer.kind !== "decide") return;
      const key = `${hubId}/${need.id}`;
      set((s) => ({ deciding: { ...s.deciding, [key]: choice }, problems: without(s.problems, (k) => k === key) }));
      try {
        await floorOf(hub).decide(need.answer.at, choice);
        ask([hubId]);
      } catch (e) {
        set((s) => ({ deciding: without(s.deciding, (k) => k === key) }));
        if (e instanceof HubError && e.status === 409) {
          put(hubId, (was) =>
            was.floor
              ? {
                  ...was,
                  floor: {
                    ...was.floor,
                    needs: was.floor.needs.filter((n) => n.id !== need.id),
                    counts: { ...was.floor.counts, needsYou: Math.max(0, was.floor.counts.needsYou - 1) },
                  },
                }
              : was,
          );
          set((s) => ({ answered: { ...s.answered, [key]: { hubId, need } } }));
        } else set((s) => ({ problems: { ...s.problems, [key]: plainError(e) } }));
      }
    },
  };
});

/** How long reads asked for together wait, so they make one. */
export const SETTLE_MS = 250;

/** How often the floor is read while it's shown. */
export const TICK_MS = 60_000;

const asked = new Set<string>();
let settle: ReturnType<typeof setTimeout> | undefined;

/** Reads these hubs' floors once things settle. */
export const ask = (hubIds: readonly string[]): void => {
  hubIds.forEach((id) => asked.add(id));
  if (settle !== undefined || asked.size === 0) return;
  settle = setTimeout(() => {
    settle = undefined;
    const ids = [...asked];
    asked.clear();
    ids.forEach((id) => void useFloor.getState().load(id));
  }, SETTLE_MS);
};

const supported = (): string[] =>
  useChat
    .getState()
    .hubs.map((h) => h.id)
    .filter((id) => useFloor.getState().hubs[id]?.state !== "unsupported");

const everyHub = (): string[] => useChat.getState().hubs.map((h) => h.id);

/** The floor kept in step with the hubs: read when a hub is added or
 *  paired again (one removed is dropped), when Desk comes forward (asking
 *  again of hubs that had none), and again at midnight for the new day. */
export const watchFloor = (): (() => void) => {
  const sync = (hubs: readonly HubAccount[], before: readonly HubAccount[]) => {
    const changed = hubs.filter((h) => !sameAccount(before.find((b) => b.id === h.id), h)).map((h) => h.id);
    useFloor.setState((s) => {
      const gone = (k: string) => !hubs.some((h) => k === h.id || k.startsWith(`${h.id}/`));
      const fresh = (k: string) => changed.some((id) => k === id || ofHub(id)(k));
      return {
        hubs: { ...without(s.hubs, (k) => gone(k) || fresh(k)), ...Object.fromEntries(changed.map((id) => [id, blank()])) },
        deciding: without(s.deciding, (k) => gone(k) || fresh(k)),
        problems: without(s.problems, (k) => gone(k) || fresh(k)),
        answered: without(s.answered, (k) => gone(k) || fresh(k)),
      };
    });
    ask(changed);
  };
  sync(useChat.getState().hubs, []);
  const unsubscribe = useChat.subscribe((s, prev) => s.hubs !== prev.hubs && sync(s.hubs, prev.hubs));
  const focused = () => ask(everyHub());
  window.addEventListener("focus", focused);
  let midnight: ReturnType<typeof setTimeout> | undefined;
  const atMidnight = () => {
    midnight = setTimeout(() => {
      useFloor.setState({ day: startOfLocalDay().getTime() });
      ask(supported());
      atMidnight();
    }, nextLocalMidnight().getTime() - Date.now());
  };
  atMidnight();
  return () => {
    unsubscribe();
    window.removeEventListener("focus", focused);
    clearTimeout(midnight);
  };
};

/** Reads the floor every minute while `on`. */
export const useFloorTick = (on: boolean): void => {
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => ask(supported()), TICK_MS);
    return () => clearInterval(t);
  }, [on]);
};

/** Every hub's floor as one. */
export const useMerged = (): Merged => {
  const hubs = useFloor((s) => s.hubs);
  const list = useChat((s) => s.hubs);
  return useMemo(() => merged(hubs, list), [hubs, list]);
};

/** What's still waiting on the person, on every hub, oldest first. */
export const useNeeds = () => useMerged().needs;

/** How many needs wait on each sidebar item. */
export const useNeedCounts = (): Map<string, number> => {
  const needs = useNeeds();
  return useMemo(() => countsByItem(needs), [needs]);
};

/** The plan cards, from every hub's usage. */
export const usePlans = (): PlanCard[] => {
  const hubs = useFloor((s) => s.hubs);
  const list = useChat((s) => s.hubs);
  return useMemo(
    () =>
      plans(
        list.flatMap((h) => {
          const f = hubs[h.id];
          return f?.usage ? [{ hubId: h.id, label: h.label, local: h.local, usage: f.usage, offset: f.offset }] : [];
        }),
      ),
    [hubs, list],
  );
};
