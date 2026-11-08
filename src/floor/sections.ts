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
import type { BossView, FloorView, PlanProgress, Who } from "../hub/types";
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
  /** Latest ended first. */
  done: FloorWork[];
  plans: PlanProgress[];
  /** Each item's group, for those of the main section that sit in a group
   *  with no boss (they keep their chip there), by the item's `key`. */
  chips: Record<string, string>;
}

export type FloorLayout = { kind: "flat" } | { kind: "sections"; sections: Section[] };

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
   *  in, by the sidebar alone (for what carries no stamp, such as the
   *  activity log): a boss in the group it oversees, wherever it sits; null
   *  for anyone else (you, the main boss, Desk itself). */
  ofLocal: (localHub: string, who: { kind: string; id: string }) => string | null;
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
  const ofLocal = (localHub: string, who: { kind: string; id: string }): string | null => {
    if (who.kind !== "agent" && who.kind !== "session") return null;
    if (who.kind === "agent") for (const [g, b] of bossed) if (b.agent === who.id) return g;
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
  chips: {},
});

const hasAnything = (s: Section): boolean => s.needs.length + s.working.length + s.done.length + s.plans.length > 0;

/** The Floor's sections, from every hub's floor merged (`floor`, as the
 *  header counts it), this computer's hub's word on who oversees what, and
 *  the sidebar's layout: flat when no group has a boss of its own (the main
 *  boss alone is no reason for sections). Each need, piece of work and plan
 *  is in exactly one section. Sections with needs come first, the oldest
 *  need first; then the rest in sidebar order, the main boss's last. */
export const floorSections = (floor: Pick<Merged, "needs" | "working" | "done">, oversight: Oversight, layout: Layout): FloorLayout => {
  const place = placer(layout, oversight);
  if (place.bossed.size === 0) return { kind: "flat" };
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
  for (const w of floor.done) into(w).done.push(w);
  for (const p of oversight.plans) (byId.get(place.ofGroup(p.group)) ?? main).plans.push(p);

  // A sealed group with nothing on the floor has nothing to show.
  const shown = [...ordered.filter((s) => s.kind !== "sealed" || hasAnything(s)), main];
  const needing = shown
    .filter((s) => s.needs.length > 0)
    .sort((a, b) => a.needs[0]!.since.localeCompare(b.needs[0]!.since));
  const rest = shown.filter((s) => s.needs.length === 0);
  return { kind: "sections", sections: [...needing, ...rest] };
};

/** What a section is called where it's named in a list (the jump bar, the
 *  Activity's filter): its group's name, else the main boss's. */
export const sectionName = (s: Pick<Section, "group" | "boss">): string => s.group?.name ?? s.boss?.name ?? "Everything else";

/** A section's id as an element's id. */
export const sectionDomId = (id: string): string =>
  `floor-section-${id.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`)}`;
