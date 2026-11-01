import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useChat } from "../chat/store";
import { FEATURES, type HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import { deskListeners } from "../hub/store";
import { floorOf, type Choice } from "../hub/floor";
import type { DeskEvent, FloorView, Need, UsageView } from "../hub/types";
import { missing } from "../overview/store";
import { plainError } from "../ui/plainError";
import { useWatching, watched } from "../unread/watching";
import { stillNeeds, useNeedsSeen } from "../unread/needsSeen";
import { merged, type Merged } from "./merge";
import { countsByItem } from "./needs";
import { nextLocalMidnight, startOfLocalDay } from "./time";
import { plans, type PlanCard } from "./usage";

/** What Desk knows of one hub's floor. */
export interface HubFloor {
  state: "loading" | "ready" | "failed" | "unsupported";
  floor: FloorView | null;
  usage: UsageView | null;
  /** The hub's clock less this computer's, from `asOf` when it was read. */
  offset: number;
  /** The last read failed; what's shown is from `at`. */
  stale: boolean;
  at: string | null;
}

/** A need answered elsewhere before Desk's answer reached the hub: gone
 *  from the floor, said once until the hub is read again by a read begun
 *  after `read`, the last one begun when Desk heard. */
export interface Answered {
  hubId: string;
  need: Need;
  read: number;
}

interface FloorStore {
  hubs: Record<string, HubFloor>;
  /** Answers on their way, by need key (`hub/need`). */
  deciding: Record<string, Choice>;
  /** Why an answer didn't go through, by need key. */
  problems: Record<string, string>;
  answered: Record<string, Answered>;
  /** Hubs whose link is up and says when their floor changes. */
  heard: Record<string, true>;
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
/** How many reads of each hub's floor have begun. */
const begun = new Map<string, number>();

const without = <V>(record: Record<string, V>, drop: (key: string, v: V) => boolean): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([k, v]) => !drop(k, v)));

const ofHub = (hubId: string) => (key: string) => key.startsWith(`${hubId}/`);

export const useFloor = create<FloorStore>((set, get) => {
  const put = (hubId: string, f: (was: HubFloor) => HubFloor) => set((s) => ({ hubs: { ...s.hubs, [hubId]: f(s.hubs[hubId] ?? blank()) } }));

  const read = async (hubId: string): Promise<void> => {
    const hub = accountOf(hubId);
    if (!hub) return;
    const day = startOfLocalDay(Date.now() + Math.min(0, useFloor.getState().hubs[hubId]?.offset ?? 0));
    const nth = (begun.get(hubId) ?? 0) + 1;
    begun.set(hubId, nth);
    const api = floorOf(hub);
    const [floor, usage] = await Promise.allSettled([api.floor(day).then((view) => ({ view, receivedAt: Date.now() })), api.usage()]);
    if (!sameAccount(accountOf(hubId), hub)) return;
    if (floor.status === "rejected") {
      if (missing(floor.reason)) return put(hubId, () => ({ ...blank(), state: "unsupported" }));
      return put(hubId, (was) => (was.floor ? { ...was, state: "ready", stale: true } : { ...was, state: "failed" }));
    }
    const { view, receivedAt } = floor.value;
    const listed = new Set(view.needs.map((n) => `${hubId}/${n.id}`));
    set((s) => ({
      day: day.getTime(),
      hubs: {
        ...s.hubs,
        [hubId]: {
          state: "ready",
          floor: { ...view, needs: view.needs.filter((n) => (s.answered[`${hubId}/${n.id}`]?.read ?? 0) < nth) },
          usage: usage.status === "fulfilled" ? usage.value : missing(usage.reason) ? null : (s.hubs[hubId]?.usage ?? null),
          offset: Date.parse(view.asOf) - receivedAt,
          stale: false,
          at: new Date(receivedAt).toISOString(),
        },
      },
      deciding: without(s.deciding, (k) => ofHub(hubId)(k) && !listed.has(k)),
      problems: without(s.problems, (k) => ofHub(hubId)(k) && !listed.has(k)),
      answered: without(s.answered, (k, a) => ofHub(hubId)(k) && a.read < nth),
    }));
  };

  return {
    hubs: {},
    deciding: {},
    problems: {},
    answered: {},
    heard: {},
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
      if (get().deciding[key]) return;
      set((s) => ({ deciding: { ...s.deciding, [key]: choice }, problems: without(s.problems, (k) => k === key) }));
      try {
        await floorOf(hub).decide(need.answer.at, choice);
        ask([hubId]);
      } catch (e) {
        set((s) => ({ deciding: without(s.deciding, (k) => k === key) }));
        if (e instanceof HubError && e.status === 409) {
          put(hubId, (was) => (was.floor ? { ...was, floor: { ...was.floor, needs: was.floor.needs.filter((n) => n.id !== need.id) } } : was));
          set((s) => ({ answered: { ...s.answered, [key]: { hubId, need, read: begun.get(hubId) ?? 0 } } }));
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

/** The events of this computer's hub after which its floor may differ, while
 *  its link doesn't say so. */
const MOVES = new Set<DeskEvent["type"]>(["snapshot", "session", "removed", "activity"]);

/** The floor kept in step with the hubs: read when a hub is added or
 *  paired again (one removed is dropped), when its link says the floor
 *  changed (see `floorHeard`), when Desk comes forward (asking again of hubs
 *  that had none), again at midnight for the new day, and on this computer's hub
 *  whenever its events say a session or the crew moved. */
export const watchFloor = (): (() => void) => {
  const sync = (hubs: readonly HubAccount[], before: readonly HubAccount[]) => {
    const changed = hubs
      .filter(
        (h) =>
          !sameAccount(
            before.find((b) => b.id === h.id),
            h,
          ),
      )
      .map((h) => h.id);
    useFloor.setState((s) => {
      const gone = (k: string) => !hubs.some((h) => k === h.id || k.startsWith(`${h.id}/`));
      const fresh = (k: string) => changed.some((id) => k === id || ofHub(id)(k));
      return {
        hubs: { ...without(s.hubs, (k) => gone(k) || fresh(k)), ...Object.fromEntries(changed.map((id) => [id, blank()])) },
        deciding: without(s.deciding, (k) => gone(k) || fresh(k)),
        problems: without(s.problems, (k) => gone(k) || fresh(k)),
        answered: without(s.answered, (k) => gone(k) || fresh(k)),
        heard: without(s.heard, gone),
      };
    });
    ask(changed);
  };
  sync(useChat.getState().hubs, []);
  const unsubscribe = useChat.subscribe((s, prev) => s.hubs !== prev.hubs && sync(s.hubs, prev.hubs));
  const focused = () => ask(everyHub());
  window.addEventListener("focus", focused);
  const heard = (e: DeskEvent) => {
    const local = useChat.getState().hubs.find((h) => h.local)?.id;
    if (local && MOVES.has(e.type) && !useFloor.getState().heard[local] && supported().includes(local)) ask([local]);
  };
  deskListeners.add(heard);
  let midnight: ReturnType<typeof setTimeout> | undefined;
  const atMidnight = () => {
    midnight = setTimeout(() => {
      useFloor.setState({ day: startOfLocalDay().getTime() });
      const behind = Math.max(0, ...Object.values(useFloor.getState().hubs).map((h) => -h.offset));
      const read = () => {
        ask(supported());
        atMidnight();
      };
      if (behind > 0) midnight = setTimeout(read, behind);
      else read();
    }, nextLocalMidnight().getTime() - Date.now());
  };
  atMidnight();
  return () => {
    unsubscribe();
    window.removeEventListener("focus", focused);
    deskListeners.delete(heard);
    clearTimeout(midnight);
  };
};

/** A hub's link said hello. One that says when its floor changes is read
 *  now and then on its word; one that had no floor is asked again. */
export const floorHeard = (hubId: string, features: ReadonlySet<string>): void => {
  if (!features.has(FEATURES.floor)) return floorUnheard(hubId);
  useFloor.setState((s) => ({
    heard: { ...s.heard, [hubId]: true },
    hubs: s.hubs[hubId]?.state === "unsupported" ? { ...s.hubs, [hubId]: blank() } : s.hubs,
  }));
  ask([hubId]);
};

/** A hub's link is down: its floor is read on the minute until it's back. */
export const floorUnheard = (hubId: string): void => {
  if (useFloor.getState().heard[hubId]) useFloor.setState((s) => ({ heard: without(s.heard, (k) => k === hubId) }));
};

/** The hubs the minute's read is for: those whose link isn't saying when
 *  their floor changes, those with work running, whose progress is never
 *  signalled, and those whose last read failed. */
const unheard = (): string[] => {
  const { heard, hubs } = useFloor.getState();
  return supported().filter((id) => {
    const f = hubs[id];
    return !heard[id] || f?.stale || f?.state === "failed" || (f?.floor?.working.length ?? 0) > 0;
  });
};

/** Reads the floor every minute while `on`, of the hubs whose links don't
 *  keep it. */
export const useFloorTick = (on: boolean): void => {
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => ask(unheard()), TICK_MS);
    return () => clearInterval(t);
  }, [on]);
};

/** Whether this computer's hub has a floor: with an older one, the Floor
 *  and Activity stay as they were. */
export const useLocalFloor = (): boolean => {
  const localId = useChat((s) => s.hubs.find((h) => h.local)?.id);
  return useFloor((s) => !!localId && s.hubs[localId]?.state === "ready");
};

/** Every hub's floor as one, less the questions agents asked in DMs that
 *  are on screen here or were opened since (see `needsSeen`). */
export const useMerged = (): Merged => {
  const hubs = useFloor((s) => s.hubs);
  const list = useChat((s) => s.hubs);
  const seen = useNeedsSeen((s) => s.seen);
  const w = useWatching();
  return useMemo(() => {
    const all = merged(hubs, list);
    const needs = all.needs.filter((n) => stillNeeds(n, seen, (key) => watched(w, key)));
    return needs.length === all.needs.length ? all : { ...all, needs, counts: { ...all.counts, needsYou: needs.length } };
  }, [hubs, list, seen, w]);
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
