// The sidebar's groups: kept by the hub when it keeps them (see store.ts),
// else in Desk's settings. A group holds
// agents (local and remote) and sessions by stable key; whatever isn't in a
// group is Ungrouped, which always comes last. Every change — dragged, by
// keyboard or from a menu — goes through these functions.

import { agentKey, type Agent } from "../chat/types";

/** `agent:<hub>/<agent>` or `session:<desk session id>`. */
export type ItemKey = string;

export interface DeskGroup {
  id: string;
  name: string;
  collapsed: boolean;
  /** In order. Can name items Desk can't see right now (a remote hub that's
   *  offline), which keep their place for when it's back. */
  items: ItemKey[];
}

export interface Ungrouped {
  collapsed: boolean;
  /** The order of items placed here; anything in no group and not listed
   *  follows, as it comes. */
  items: ItemKey[];
}

export interface Layout {
  groups: DeskGroup[];
  ungrouped: Ungrouped;
}

export const UNGROUPED = "ungrouped";

export const EMPTY_LAYOUT: Layout = { groups: [], ungrouped: { collapsed: false, items: [] } };

export const agentItem = (a: Pick<Agent, "hubId" | "id">): ItemKey => `agent:${agentKey(a)}`;
export const sessionItem = (id: string): ItemKey => `session:${id}`;
export const sessionOf = (key: ItemKey): string | null => (key.startsWith("session:") ? key.slice("session:".length) : null);

/** A group as shown: only the items Desk can see, in order. */
export interface Shown {
  id: string;
  name: string;
  collapsed: boolean;
  items: ItemKey[];
}

/** The groups as shown, Ungrouped last: each group's items that are present,
 *  then Ungrouped's listed ones, then everything else present, as `present`
 *  orders it. */
export const resolve = (layout: Layout, present: readonly ItemKey[]): Shown[] => {
  const here = new Set(present);
  const placed = new Set<ItemKey>();
  const take = (items: readonly ItemKey[]) =>
    items.filter((k) => {
      if (!here.has(k) || placed.has(k)) return false;
      placed.add(k);
      return true;
    });
  const groups = layout.groups.map((g) => ({ id: g.id, name: g.name, collapsed: g.collapsed, items: take(g.items) }));
  const listed = take(layout.ungrouped.items);
  const rest = take(present);
  return [...groups, { id: UNGROUPED, name: "Ungrouped", collapsed: layout.ungrouped.collapsed, items: [...listed, ...rest] }];
};

/** Which group an item is in; Ungrouped when none. */
export const groupOf = (layout: Layout, key: ItemKey): string => layout.groups.find((g) => g.items.includes(key))?.id ?? UNGROUPED;

const without = (items: readonly ItemKey[], key: ItemKey): ItemKey[] => items.filter((k) => k !== key);

const insert = (items: readonly ItemKey[], key: ItemKey, before: ItemKey | null): ItemKey[] => {
  const rest = without(items, key);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)];
};

/** Ungrouped's order with everything it shows listed, so a place among
 *  items that only follow can be kept. */
const settled = (layout: Layout, present: readonly ItemKey[]): ItemKey[] => {
  const shown = resolve(layout, present).at(-1)!.items;
  const hidden = layout.ungrouped.items.filter((k) => !shown.includes(k));
  return [...shown, ...hidden];
};

export const createGroup = (layout: Layout, id: string, name: string, items: readonly ItemKey[] = []): Layout => {
  const moved = new Set(items);
  return {
    groups: [...layout.groups.map((g) => ({ ...g, items: g.items.filter((k) => !moved.has(k)) })), { id, name, collapsed: false, items: [...items] }],
    ungrouped: { ...layout.ungrouped, items: layout.ungrouped.items.filter((k) => !moved.has(k)) },
  };
};

export const renameGroup = (layout: Layout, id: string, name: string): Layout => {
  const trimmed = name.trim();
  if (!trimmed) return layout;
  return { ...layout, groups: layout.groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)) };
};

/** A deleted group's members go to the end of Ungrouped, in their order. */
export const deleteGroup = (layout: Layout, present: readonly ItemKey[], id: string): Layout => {
  const gone = layout.groups.find((g) => g.id === id);
  if (!gone) return layout;
  const items = settled(layout, present).filter((k) => !gone.items.includes(k));
  return { groups: layout.groups.filter((g) => g.id !== id), ungrouped: { ...layout.ungrouped, items: [...items, ...gone.items] } };
};

export const setCollapsed = (layout: Layout, id: string, collapsed: boolean): Layout =>
  id === UNGROUPED
    ? { ...layout, ungrouped: { ...layout.ungrouped, collapsed } }
    : { ...layout, groups: layout.groups.map((g) => (g.id === id ? { ...g, collapsed } : g)) };

/** Puts an item in a group before another item (at the end for null),
 *  taking it out of wherever it was. Moving into a collapsed group opens it,
 *  so what moved stays in sight. */
export const moveItem = (layout: Layout, present: readonly ItemKey[], key: ItemKey, to: string, before: ItemKey | null): Layout => {
  if (before === key) return layout;
  if (to !== UNGROUPED && !layout.groups.some((g) => g.id === to)) return layout;
  const groups = layout.groups.map((g) =>
    g.id === to ? { ...g, collapsed: false, items: insert(g.items, key, before) } : { ...g, items: without(g.items, key) },
  );
  const ungrouped =
    to === UNGROUPED
      ? { collapsed: false, items: insert(settled(layout, present), key, before) }
      : { ...layout.ungrouped, items: without(layout.ungrouped.items, key) };
  return { groups, ungrouped };
};

/** Back to Ungrouped, at its end. */
export const removeFromGroup = (layout: Layout, present: readonly ItemKey[], key: ItemKey): Layout => {
  const from = groupOf(layout, key);
  return from === UNGROUPED ? layout : moveItem(layout, present, key, UNGROUPED, null);
};

/** Puts a group before another (at the end, above Ungrouped, for null). */
export const moveGroup = (layout: Layout, id: string, before: string | null): Layout => {
  const group = layout.groups.find((g) => g.id === id);
  if (!group || before === id) return layout;
  const rest = layout.groups.filter((g) => g.id !== id);
  const at = before === null ? -1 : rest.findIndex((g) => g.id === before);
  return { ...layout, groups: at < 0 ? [...rest, group] : [...rest.slice(0, at), group, ...rest.slice(at)] };
};

export type Step = -1 | 1;

/** Where Alt+↑ / Alt+↓ moves an item: past its neighbour, or over the
 *  edge of its group into the next one (the end of the one above, the start
 *  of the one below). Null at the very top or bottom. */
export const nudgeTarget = (
  layout: Layout,
  present: readonly ItemKey[],
  key: ItemKey,
  step: Step,
): { to: string; before: ItemKey | null } | null => {
  const shown = resolve(layout, present);
  const g = shown.findIndex((x) => x.items.includes(key));
  if (g < 0) return null;
  const items = shown[g]!.items;
  const i = items.indexOf(key);
  const id = shown[g]!.id;
  if (step < 0 && i > 0) return { to: id, before: items[i - 1]! };
  if (step > 0 && i < items.length - 1) return { to: id, before: items[i + 2] ?? null };
  const next = shown[g + step];
  if (!next) return null;
  return { to: next.id, before: step < 0 ? null : (next.items[0] ?? null) };
};

/** Alt+↑ / Alt+↓ on an item, applied. */
export const nudgeItem = (layout: Layout, present: readonly ItemKey[], key: ItemKey, step: Step): Layout | null => {
  const t = nudgeTarget(layout, present, key, step);
  return t && moveItem(layout, present, key, t.to, t.before);
};

/** Where Alt+↑ / Alt+↓ moves a group: before which (null: last). Null when
 *  it can't go further. Ungrouped stays last. */
export const nudgeGroupTarget = (layout: Layout, id: string, step: Step): { before: string | null } | null => {
  const i = layout.groups.findIndex((g) => g.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= layout.groups.length) return null;
  return { before: step < 0 ? layout.groups[j]!.id : (layout.groups[j + 1]?.id ?? null) };
};

/** Alt+↑ / Alt+↓ on a group's header, applied. */
export const nudgeGroup = (layout: Layout, id: string, step: Step): Layout | null => {
  const t = nudgeGroupTarget(layout, id, step);
  return t && moveGroup(layout, id, t.before);
};

/** Forgets sessions that are gone: out of every group, and their names. */
export const forgetSessions = (
  layout: Layout,
  names: Record<string, string>,
  gone: (id: string) => boolean,
): { layout: Layout; names: Record<string, string> } | null => {
  const drop = (k: ItemKey) => {
    const id = sessionOf(k);
    return id !== null && gone(id);
  };
  const touched =
    layout.groups.some((g) => g.items.some(drop)) || layout.ungrouped.items.some(drop) || Object.keys(names).some(gone);
  if (!touched) return null;
  return {
    layout: {
      groups: layout.groups.map((g) => ({ ...g, items: g.items.filter((k) => !drop(k)) })),
      ungrouped: { ...layout.ungrouped, items: layout.ungrouped.items.filter((k) => !drop(k)) },
    },
    names: Object.fromEntries(Object.entries(names).filter(([id]) => !gone(id))),
  };
};

/** Where a drag would land. */
export type Drop = { kind: "item"; group: string; before: ItemKey | null } | { kind: "group"; before: string | null };

/** Where an item dragged over another lands: before it when the pointer is
 *  in its top half, else after it. */
export const itemDrop = (shown: readonly Shown[], over: ItemKey, upperHalf: boolean): Drop | null => {
  const g = shown.find((x) => x.items.includes(over));
  if (!g) return null;
  const i = g.items.indexOf(over);
  return { kind: "item", group: g.id, before: upperHalf ? over : (g.items[i + 1] ?? null) };
};

/** Where a group dragged over another lands: before it in its top half,
 *  else after it. Over Ungrouped, it goes last of the groups. */
export const groupDrop = (layout: Layout, over: string, upperHalf: boolean): Drop => {
  if (over === UNGROUPED) return { kind: "group", before: null };
  const i = layout.groups.findIndex((g) => g.id === over);
  return { kind: "group", before: upperHalf ? over : (layout.groups[i + 1]?.id ?? null) };
};

/** What's being dragged, or dragged over: an item by key, or a group by id. */
export interface DragEnd {
  type: "item" | "group";
  id: string;
}

/** Where a drag lands, or null where it would change nothing (so no line is
 *  drawn): an item over an item goes before or after it, over a group's
 *  header or empty space to its end; a group over a group goes before or
 *  after it. */
export const dropAt = (layout: Layout, shown: readonly Shown[], source: DragEnd, target: DragEnd, upperHalf: boolean): Drop | null => {
  if (source.type === "item") {
    const d: Drop | null =
      target.type === "item"
        ? target.id === source.id
          ? null
          : itemDrop(shown, target.id, upperHalf)
        : { kind: "item", group: target.id, before: null };
    if (!d || d.kind !== "item") return d;
    const g = shown.find((x) => x.items.includes(source.id));
    if (g?.id === d.group) {
      const at = g.items.indexOf(source.id);
      if (d.before === source.id || d.before === (g.items[at + 1] ?? null)) return null;
    }
    return d;
  }
  if (target.type !== "group") return null;
  const d = groupDrop(layout, target.id, upperHalf);
  if (d.kind !== "group" || d.before === source.id) return null;
  const i = layout.groups.findIndex((x) => x.id === source.id);
  return i < 0 || d.before === (layout.groups[i + 1]?.id ?? null) ? null : d;
};

/** Applies a drop. */
export const dropOn = (layout: Layout, present: readonly ItemKey[], dragged: string, drop: Drop): Layout =>
  drop.kind === "item" ? moveItem(layout, present, dragged, drop.group, drop.before) : moveGroup(layout, dragged, drop.before);
