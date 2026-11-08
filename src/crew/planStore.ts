import { create } from "zustand";
import { useChat } from "../chat/store";
import { HubError } from "../hub/client";
import { floorOf } from "../hub/floor";
import { deskListeners, useDesk } from "../hub/store";
import type { BossPlan, BossPlanDetail, BossPlanEdit, DeskEvent, OnPlanDrop, PlanBudget } from "../hub/types";

/** What the person was told of a plan after the hub refused them: a newer
 *  revision they now see (to look at before asking again), or why. */
export interface PlanRefusal {
  text: string;
  /** The revision they had read, when a newer one has come since. */
  from?: number;
}

interface PlanState {
  /** This computer's hub keeps plans: false once it said it doesn't (an
   *  older one). */
  supported: boolean | null;
  /** Every plan, by id, with where its tickets stand. */
  plans: Record<string, BossPlan>;
  /** The plans read in full, by id. */
  details: Record<string, BossPlanDetail>;
  /** A plan that couldn't be read in full, by id: why. */
  unread: Record<string, string>;
  /** What the hub last refused about a plan, by id. */
  refusals: Record<string, PlanRefusal>;
  /** The revisions each plan's cards in the DMs were posted for, by id:
   *  the newest is shown whole. */
  cards: Record<string, number[]>;
  /** The newest revision of each plan the person has seen whole on its
   *  card in this window, by id: the Floor approves no other. */
  seen: Record<string, number>;
  /** The person sees revision `revision` of plan `id` whole. */
  saw: (id: string, revision: number) => void;
  /** Plans the person asked to look at from the Floor: their card scrolls
   *  itself into view. */
  looking: Record<string, true>;
  look: (id: string) => void;
  looked: (id: string) => void;
  load: () => Promise<void>;
  /** Reads plan `id` in full. */
  fetch: (id: string) => Promise<void>;
  /** A card for plan `id` at `revision` is shown; the function forgets it. */
  showCard: (id: string, revision: number) => () => void;
  /** The person's answer to plan `id` as of `revision`, as the Floor gives
   *  it (their device's, never Desk's own token): allow approves it (or
   *  the change of scope waiting, or goes on after its starts kept
   *  failing); deny turns a waiting change down. */
  decide: (id: string, revision: number, choice: "allow" | "deny", budget?: PlanBudget | null) => Promise<void>;
  edit: (id: string, edit: BossPlanEdit) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  drop: (id: string, sessions: OnPlanDrop) => Promise<void>;
  /** Forgets what was refused about plan `id`. */
  clear: (id: string) => void;
}

const hubNow = () => useDesk.getState().hub;

/** Bumped by each plan heard: a read begun before it may be older. */
const heardOf = new Map<string, number>();
const mark = (id: string): number => heardOf.get(id) ?? 0;

const summaryOf = (d: BossPlanDetail): BossPlan => {
  const { tickets: _t, waves: _w, revisions: _r, ...plan } = d;
  return plan;
};

const without = <V>(r: Record<string, V>, id: string): Record<string, V> => {
  if (!(id in r)) return r;
  const { [id]: _, ...rest } = r;
  return rest;
};

export const usePlans = create<PlanState>((set, get) => {
  const keep = (d: BossPlanDetail) =>
    set((s) => ({ details: { ...s.details, [d.id]: d }, plans: { ...s.plans, [d.id]: summaryOf(d) }, unread: without(s.unread, d.id) }));

  /** Does `request` about plan `id`, keeping the plan it answers with. A
   *  refusal reads the plan again; a newer revision found then is said as
   *  one, else the hub's own words. The refusal is thrown on. */
  const act = async (id: string, request: () => Promise<BossPlanDetail>): Promise<void> => {
    const hub = hubNow();
    if (!hub) throw new Error("This computer's hub isn't running.");
    const shown = get().details[id]?.revision ?? get().plans[id]?.revision;
    set((s) => ({ refusals: without(s.refusals, id) }));
    try {
      keep(await request());
    } catch (e) {
      if (!(e instanceof HubError) || (e.status !== 409 && e.status !== 400 && e.status !== 404 && e.status !== 422)) throw e;
      if (e.status === 404) {
        set((s) => ({ refusals: { ...s.refusals, [id]: { text: "This plan isn't on this computer any more." } } }));
        throw e;
      }
      const now = await hub.plan(id).catch(() => null);
      if (now) keep(now);
      const newer = e.status === 409 && now && shown !== undefined && now.revision > shown;
      const refusal: PlanRefusal = newer
        ? { text: `${now.bossName || "The boss"} changed the plan since you read it. This is revision ${now.revision}: look at it, then ask again.`, from: shown }
        : {
            text:
              e.message === "already_answered"
                ? "That was answered already, here or on another device."
                : e.message === "not_offered"
                  ? "The plan can't be answered that way now: look at it as it is."
                  : e.message,
          };
      set((s) => ({ refusals: { ...s.refusals, [id]: refusal } }));
      throw e;
    }
  };

  return {
    supported: null,
    plans: {},
    details: {},
    unread: {},
    refusals: {},
    cards: {},
    seen: {},
    looking: {},
    look: (id) => set((s) => ({ looking: { ...s.looking, [id]: true } })),
    looked: (id) => set((s) => ({ looking: without(s.looking, id) })),
    saw: (id, revision) => {
      if ((get().seen[id] ?? 0) < revision) set((s) => ({ seen: { ...s.seen, [id]: revision } }));
    },
    load: async () => {
      const hub = hubNow();
      if (!hub) return;
      try {
        const list = await hub.plans();
        if (hubNow() !== hub) return;
        if (list === null) return set({ supported: false, plans: {}, details: {} });
        set({ supported: true, plans: Object.fromEntries(list.map((p) => [p.id, p])) });
        // What is read in full is read again: its tickets may have moved.
        for (const id of Object.keys(get().details)) void get().fetch(id);
      } catch {
        // Kept as last read; the next snapshot reads them again.
      }
    },
    fetch: async (id) => {
      const hub = hubNow();
      if (!hub) return;
      const since = mark(id);
      try {
        const d = await hub.plan(id);
        if (hubNow() !== hub || mark(id) !== since) return;
        keep(d);
        set({ supported: true });
      } catch (e) {
        if (hubNow() !== hub) return;
        const text = e instanceof HubError && e.status === 404 ? "This plan isn't on this computer any more." : e instanceof Error ? e.message : String(e);
        set((s) => ({ unread: { ...s.unread, [id]: text } }));
      }
    },
    showCard: (id, revision) => {
      set((s) => ({ cards: { ...s.cards, [id]: [...(s.cards[id] ?? []), revision] } }));
      return () =>
        set((s) => {
          const list = [...(s.cards[id] ?? [])];
          const i = list.indexOf(revision);
          if (i >= 0) list.splice(i, 1);
          return { cards: { ...s.cards, [id]: list } };
        });
    },
    decide: (id, revision, choice, budget) =>
      act(id, async () => {
        const local = useChat.getState().hubs.find((h) => h.local);
        if (!local) throw new Error("This computer's hub isn't paired yet.");
        // The hub answers with the plan as it now is (an older one, with nothing).
        const now = await floorOf(local).decidePlan({ kind: "plan", plan: id, revision }, choice, budget);
        return now && typeof now === "object" && "tickets" in now ? now : hubNow()!.plan(id);
      }),
    edit: (id, edit) => act(id, async () => (await hubNow()!.editPlan(id, edit)).plan),
    pause: (id) => act(id, () => hubNow()!.pausePlan(id)),
    resume: (id) => act(id, () => hubNow()!.resumePlan(id)),
    drop: (id, sessions) => act(id, () => hubNow()!.dropPlan(id, sessions)),
    clear: (id) => set((s) => ({ refusals: without(s.refusals, id) })),
  };
});

const onEvent = (e: DeskEvent) => {
  const s = usePlans.getState();
  switch (e.type) {
    case "plan": {
      const p = e.plan;
      heardOf.set(p.id, mark(p.id) + 1);
      usePlans.setState((st) => ({ supported: true, plans: { ...st.plans, [p.id]: p } }));
      // Its tickets, waves and revisions as they now are.
      if (s.details[p.id]) void s.fetch(p.id);
      break;
    }
    case "snapshot":
      void s.load();
      break;
    default:
      break;
  }
};
deskListeners.add(onEvent);

// Another hub (or none): what the last one said is no longer so.
useDesk.subscribe((now, before) => {
  if (now.hub !== before.hub) usePlans.setState({ supported: null, plans: {}, details: {}, unread: {}, refusals: {}, seen: {} });
});

/** The plans on board `board` that aren't dropped, newest first. */
export const plansOn = (plans: Readonly<Record<string, BossPlan>>, board: string): BossPlan[] =>
  Object.values(plans)
    .filter((p) => p.board === board && p.state !== "dropped")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
