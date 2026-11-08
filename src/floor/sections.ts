// The Floor by group (boss-gaps W10): with a sidebar group that has a boss of
// its own, the Floor is in sections, one for each such group and one for the
// main boss (what is ungrouped, and groups with no boss, which keep their
// chip). A sealed group, named for a boss that isn't overseeing it now, is
// no one's: its own section says so, never the main boss's. With no bossed
// group the Floor is flat, exactly as before.
//
// Only this computer's hub knows the bosses, and it stamps only its own items
// with where they are (`group`, `boss`). Other hubs' agents and machines'
// sessions are named by keys only Desk knows (`agent:<hub>/<agent>`,
// `session:<machine>/<id>`), so Desk places them by those keys in its one
// sidebar layout, against this computer's hub's bosses and sealed groups.
// What any other hub stamps or says of bosses is never read.
//
// Pure: the hook and the drawing are in FloorSection.tsx.

import { groupOf, UNGROUPED, type ItemKey, type Layout } from "../groups/model";
import type { ActivityEvent, BossView, Engine, FloorView, PlanProgress, Who } from "../hub/types";
import type { FloorNeed, FloorWork, Merged, Tagged } from "./merge";
import { itemKeyOf } from "./needs";

/** The main boss's section. */
export const MAIN = "main";

/** A sealed group's section: apart from the group's own id, so it can never
 *  be taken for a bossed group's. */
export const sealedSection = (group: string): string => `sealed:${group}`;

/** What this computer's hub says of who oversees what, from its floor: the
 *  only one Desk reads it from. */
export interface Oversight {
  bosses: readonly BossView[];
  sealed: readonly string[];
  plans: readonly PlanProgress[];
}

export const NO_OVERSIGHT: Oversight = { bosses: [], sealed: [], plans: [] };

export const oversightOf = (view: FloorView | null | undefined): Oversight =>
  view ? { bosses: view.bosses ?? [], sealed: view.sealed ?? [], plans: view.plans ?? [] } : NO_OVERSIGHT;

export type SectionKind = "group" | "main" | "sealed";

export interface Section {
  /** `main`, a bossed group's id, or `sealed:<group>`. */
  id: string;
  kind: SectionKind;
  /** The group it is (none for the main boss's). */
  group: { id: string; name: string } | null;
  /** Who runs it: the group's boss, or the main boss; none for a sealed
   *  group, and for the main section when the hub names no main boss. */
  boss: BossView | null;
  /** The main section's groups with no boss of their own, in sidebar order. */
  unbossed: { id: string; name: string }[];
  /** Oldest first. */
  needs: FloorNeed[];
  /** Latest started first. */
  working: FloorWork[];
  /** What ended today, latest first. */
  done: FloorWork[];
  plans: PlanProgress[];
  /** What Desk itself shows as needing you, working or done today that no
   *  hub's floor has a need or a turn for: kept in its section's Working,
   *  so nothing leaves the Floor. */
  desk: DeskItem[];
  /** Each item's group, for those of the main section that sit in a group
   *  with no boss (they keep their chip there), by the item's `key`. */
  chips: Record<string, string>;
}

/** One of this computer's sessions or agents as Desk's own Floor groups it
 *  (Needs you, Working, Done today). */
export interface DeskItem {
  /** Its sidebar item: `session:<id>`, `agent:<hub>/<agent>`. */
  key: ItemKey;
  who: { kind: "agent" | "session"; id: string };
  name: string;
  engine: Engine | null;
  /** What it is doing or for, when Desk knows. */
  text: string | null;
  /** Blocked: Desk shows it waiting on you, though nothing asks you. */
  look: "blocked" | "working" | "done";
}

/** A sealed group's items while no group has a boss: the Floor is flat, and
 *  says no one oversees it so the person can give it one. */
export interface SealedNote {
  group: { id: string; name: string };
  items: (FloorNeed | FloorWork)[];
}

export type FloorLayout = { kind: "flat"; sealed: SealedNote[] } | { kind: "sections"; sections: Section[] };

/** An item on the merged floor, wherever it came from. */
type Placeable = Pick<Tagged, "hubId" | "local" | "machine"> & { who: Pick<Who, "kind" | "id">; group?: string | null };

/** Whose section an item, or a group, is in. */
export interface Placer {
  /** The section a group's items are in; `main` for none, Ungrouped, and a
   *  group with no boss. */
  ofGroup: (group: string | null | undefined) => string;
  /** The group an item is in: this computer's hub's word for its own items,
   *  the sidebar's by key for everything else. */
  groupOfItem: (item: Placeable) => string | null;
  /** The section an item is in. */
  of: (item: Placeable) => string;
  /** The section an agent or session of this computer's hub (`localHub`) is
   *  in, by the sidebar alone (for what carries no stamp): a boss in the
   *  group it oversees, wherever it sits; the main boss, you and Desk itself
   *  in the main boss's. */
  ofLocal: (localHub: string, who: { kind: string; id: string }) => string;
  /** The bossed groups' bosses, by group id. */
  bossed: ReadonlyMap<string, BossView>;
  sealed: ReadonlySet<string>;
}

/** The groups with a boss of their own (only those the sidebar has), and how
 *  to place what's on the floor among them. */
export const placer = (layout: Layout, oversight: Oversight): Placer => {
  const inLayout = new Set(layout.groups.map((g) => g.id));
  const bossed = new Map<string, BossView>();
  for (const b of oversight.bosses) if (b.scope.kind === "group" && inLayout.has(b.scope.group)) bossed.set(b.scope.group, b);
  const sealed = new Set(oversight.sealed.filter((g) => inLayout.has(g) && !bossed.has(g)));
  const ofGroup = (group: string | null | undefined): string => {
    if (!group || group === UNGROUPED) return MAIN;
    if (bossed.has(group)) return group;
    if (sealed.has(group)) return sealedSection(group);
    return MAIN;
  };
  const groupOfItem = (item: Placeable): string | null => {
    // This computer's hub stamps its own items as it reads the layout,
    // a boss's own turns in the group it oversees.
    if (item.local && !item.machine) return item.group ?? null;
    const g = groupOf(layout, itemKeyOf(item) as ItemKey);
    return g === UNGROUPED ? null : g;
  };
  const mainBoss = oversight.bosses.find((b) => b.scope.kind === "ungrouped")?.agent ?? null;
  const ofLocal = (localHub: string, who: { kind: string; id: string }): string => {
    if (who.kind !== "agent" && who.kind !== "session") return MAIN;
    if (who.kind === "agent") {
      if (who.id === mainBoss) return MAIN;
      for (const [g, b] of bossed) if (b.agent === who.id) return g;
    }
    const key = itemKeyOf({ hubId: localHub, local: true, who: { kind: who.kind, id: who.id } });
    return ofGroup(groupOf(layout, key));
  };
  return { ofGroup, groupOfItem, of: (item) => ofGroup(groupOfItem(item)), ofLocal, bossed, sealed };
};

const blank = (id: string, kind: SectionKind, group: Section["group"], boss: BossView | null): Section => ({
  id,
  kind,
  group,
  boss,
  unbossed: [],
  needs: [],
  working: [],
  done: [],
  plans: [],
  desk: [],
  chips: {},
});

const hasAnything = (s: Section): boolean => s.needs.length + s.working.length + s.done.length + s.plans.length + s.desk.length > 0;

export interface SectionsOptions {
  /** The start of the person's day (ms): what ended before it isn't done
   *  today, though the hubs' `done` reaches back 24 hours. */
  day?: number;
  /** Desk's own Needs you, Working and Done today, of this computer. */
  desk?: readonly DeskItem[];
  /** This computer's hub, whose agents Desk's own items are. */
  localHub?: string | null;
}

/** The Floor's sections, from every hub's floor merged (`floor`, as the
 *  header counts it), this computer's hub's word on who oversees what, and
 *  the sidebar's layout: flat when no group has a boss of its own (the main
 *  boss alone is no reason for sections). Each need, piece of work and plan
 *  is in exactly one section. Sections with needs come first, the oldest
 *  need first; then the rest in sidebar order, the main boss's last. */
export const floorSections = (
  floor: Pick<Merged, "needs" | "working" | "done">,
  oversight: Oversight,
  layout: Layout,
  { day = 0, desk = [], localHub = null }: SectionsOptions = {},
): FloorLayout => {
  const place = placer(layout, oversight);
  if (place.bossed.size === 0) {
    const notes = layout.groups
      .filter((g) => place.sealed.has(g.id))
      .map((g) => ({
        group: { id: g.id, name: g.name },
        items: [...floor.needs, ...floor.working].filter((i) => place.groupOfItem(i) === g.id),
      }))
      .filter((n) => n.items.length > 0);
    return { kind: "flat", sealed: notes };
  }
  const main = blank(
    MAIN,
    "main",
    null,
    oversight.bosses.find((b) => b.scope.kind === "ungrouped") ?? null,
  );
  const byId = new Map<string, Section>([[MAIN, main]]);
  // Sidebar order: each bossed or sealed group where it sits.
  const ordered: Section[] = [];
  for (const g of layout.groups) {
    const boss = place.bossed.get(g.id);
    const group = { id: g.id, name: g.name };
    if (boss) ordered.push(blank(g.id, "group", group, boss));
    else if (place.sealed.has(g.id)) ordered.push(blank(sealedSection(g.id), "sealed", group, null));
    else main.unbossed.push(group);
  }
  ordered.forEach((s) => byId.set(s.id, s));
  const into = (item: Placeable & { key: string }): Section => {
    const group = place.groupOfItem(item);
    const s = byId.get(place.ofGroup(group)) ?? main;
    if (s === main && group && main.unbossed.some((g) => g.id === group)) main.chips[item.key] = group;
    return s;
  };
  for (const n of floor.needs) into(n).needs.push(n);
  for (const w of floor.working) into(w).working.push(w);
  for (const w of floor.done) if (w.endedAt && Date.parse(w.endedAt) >= day) into(w).done.push(w);
  for (const p of oversight.plans) (byId.get(place.ofGroup(p.group)) ?? main).plans.push(p);
  // Desk's own, where no hub's floor has them: in their sidebar section.
  // Each list on its own: a session done this morning and blocked now is
  // still to show in Working.
  const live = new Set([...floor.needs, ...floor.working].map((i) => itemKeyOf(i)));
  const doneToday = new Set(floor.done.filter((w) => w.endedAt && Date.parse(w.endedAt) >= day).map((i) => itemKeyOf(i)));
  for (const d of desk) {
    if ((d.look === "done" ? doneToday : live).has(d.key)) continue;
    const s = (localHub ? byId.get(place.ofLocal(localHub, d.who)) : undefined) ?? main;
    s.desk.push(d);
    const g = groupOf(layout, d.key);
    if (s === main && main.unbossed.some((x) => x.id === g)) main.chips[d.key] = g;
  }

  // A sealed group with nothing on the floor has nothing to show.
  const shown = [...ordered.filter((s) => s.kind !== "sealed" || hasAnything(s)), main];
  const needing = shown
    .filter((s) => s.needs.length > 0)
    .sort((a, b) => a.needs[0]!.since.localeCompare(b.needs[0]!.since));
  const rest = shown.filter((s) => s.needs.length === 0);
  return { kind: "sections", sections: [...needing, ...rest] };
};

/** The section an event of this computer's hub belongs to: the group it
 *  was in when it happened, as the hub stamped it (none: ungrouped), so a
 *  moved session's past stays where it was. Sections exist only with a hub
 *  that names bosses, and such a hub stamps every event. */
export const sectionOfEvent = (place: Placer, e: Pick<ActivityEvent, "group">): string => place.ofGroup(e.group ?? null);

/** What a section shows as working: the hubs' turns, and Desk's own that
 *  no hub has a turn for (blocked ones too). */
export const workingIn = (s: Pick<Section, "working" | "desk">): number => s.working.length + s.desk.filter((d) => d.look !== "done").length;

/** What a section shows as done today. */
export const doneIn = (s: Pick<Section, "done" | "desk">): number => s.done.length + s.desk.filter((d) => d.look === "done").length;

/** The header's counts, from the sections' own lists, so they agree. */
export const totals = (sections: readonly Section[]): { working: number; needsYou: number; doneToday: number } => ({
  working: sections.reduce((n, s) => n + workingIn(s), 0),
  needsYou: sections.reduce((n, s) => n + s.needs.length, 0),
  doneToday: sections.reduce((n, s) => n + doneIn(s), 0),
});

/** What a section is called where it's named in a list (the jump bar, the
 *  Activity's filter): its group's name, else the main boss's. */
export const sectionName = (s: Pick<Section, "group" | "boss">): string => s.group?.name ?? s.boss?.name ?? "Everything else";

/** A section's id as an element's id. */
export const sectionDomId = (id: string): string =>
  `floor-section-${id.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`)}`;
