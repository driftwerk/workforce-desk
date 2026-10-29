// Where the sidebar's groups and the names you give sessions live. A hub that
// keeps them (its snapshot carries `layout`) is the one source: every change
// is applied here at once, sent to it, and replaced by what it answers or
// announces; agents on it see them too. The first time Desk meets such a hub
// it hands over what it kept itself. Against a hub that can't keep them,
// Desk's settings hold them, as before.

import type { DeskHub } from "../hub/client";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, Session } from "../hub/types";
import { useSettings } from "../settings/store";
import { onHub, useHubLayout } from "./hubLayout";
import {
  createGroup as created,
  deleteGroup as deleted,
  forgetSessions,
  moveGroup as movedGroup,
  moveItem as moved,
  removeFromGroup as removed,
  renameGroup as renamed,
  setCollapsed as collapsed,
  UNGROUPED,
  type Drop,
  type ItemKey,
  type Layout,
} from "./model";

export { onHub, useHubLayout };

/** The groups as saved in Desk's settings. */
export const layoutOf = (s: { groups: Layout["groups"]; ungrouped: Layout["ungrouped"] }): Layout => ({
  groups: s.groups,
  ungrouped: s.ungrouped,
});

/** The groups as they are now, wherever they're kept. */
export const currentLayout = (): Layout => useHubLayout.getState().layout ?? layoutOf(useSettings.getState());

/** The same, kept current in a component. */
export const useLayout = (): Layout => {
  const hub = useHubLayout((s) => s.layout);
  const groups = useSettings((s) => s.groups);
  const ungrouped = useSettings((s) => s.ungrouped);
  return hub ?? { groups, ungrouped };
};

// ── Changes ───────────────────────────────────────────────────────────────

/** Changes sent to the hub and not yet answered; while there are any, what
 *  the hub says is held back (it may not include them yet) and the latest
 *  of it taken once they're all answered. */
let inFlight = 0;
let heard: Layout | null = null;
let sending: Promise<void> = Promise.resolve();

const adopt = (layout: Layout) => {
  if (inFlight > 0) heard = layout;
  else useHubLayout.setState({ layout });
};

/** Sends one change to the hub, in order after the others. */
const send = (hub: DeskHub, call: (hub: DeskHub) => Promise<Layout>) => {
  inFlight++;
  sending = sending.then(async () => {
    try {
      heard = await call(hub);
    } catch (e) {
      useDesk.getState().fail(e);
      // Show what the hub really has.
      heard = await hub.layout().catch(() => heard);
    } finally {
      inFlight--;
      if (inFlight === 0 && heard) {
        useHubLayout.setState({ layout: heard });
        heard = null;
      }
    }
  });
};

/** Applies `change` to the groups; on a hub that keeps them, also sends it
 *  through `call` (its group routes), given the layout as changed. */
export const changeLayout = (change: (layout: Layout) => Layout | null, call: (hub: DeskHub, next: Layout) => Promise<Layout>): void => {
  const hubLayout = useHubLayout.getState().layout;
  const hub = useDesk.getState().hub;
  if (hubLayout && hub) {
    const next = change(hubLayout);
    if (!next || next === hubLayout) return;
    useHubLayout.setState({ layout: next });
    send(hub, (h) => call(h, next));
    return;
  }
  const s = useSettings.getState();
  const next = change(layoutOf(s));
  if (next) s.set({ groups: next.groups, ungrouped: next.ungrouped });
};

// Each change, as `model` makes it and as the hub's routes do. Ungrouped's
// order is Desk's to settle (it lists what shows there unplaced, which only
// Desk knows), so changes that place things in it send that order.

export const newGroup = (id: string, name: string, items: readonly ItemKey[] = []): void =>
  changeLayout(
    (l) => created(l, id, name, items),
    (h) => h.createGroup({ id, name, items: [...items] }),
  );

export const renameGroup = (id: string, name: string): void =>
  changeLayout(
    (l) => renamed(l, id, name),
    (h) => h.updateGroup(id, { name: name.trim() }),
  );

export const collapseGroup = (id: string, to: boolean): void =>
  changeLayout(
    (l) => collapsed(l, id, to),
    (h) => h.updateGroup(id, { collapsed: to }),
  );

/** Its members go to the end of Ungrouped. */
export const deleteGroup = (present: readonly ItemKey[], id: string): void =>
  changeLayout(
    (l) => deleted(l, present, id),
    (h, next) => h.deleteGroup(id).then(() => h.orderUngrouped(next.ungrouped.items)),
  );

export const moveGroup = (id: string, before: string | null): void =>
  changeLayout(
    (l) => movedGroup(l, id, before),
    (h) => h.moveGroup(id, before),
  );

export const moveItem = (present: readonly ItemKey[], key: ItemKey, to: string, before: ItemKey | null): void =>
  changeLayout(
    (l) => moved(l, present, key, to, before),
    (h, next) => (to === UNGROUPED ? h.orderUngrouped(next.ungrouped.items) : h.putInGroup(to, key, before)),
  );

export const removeFromGroup = (present: readonly ItemKey[], key: ItemKey): void =>
  changeLayout(
    (l) => removed(l, present, key),
    (h, next) => h.orderUngrouped(next.ungrouped.items),
  );

export const dropItem = (present: readonly ItemKey[], dragged: string, drop: Drop): void =>
  drop.kind === "item" ? moveItem(present, dragged, drop.group, drop.before) : moveGroup(dragged, drop.before);

// ── Names ─────────────────────────────────────────────────────────────────

/** Names a session; an empty name, or the hub's own, goes back to the
 *  hub's. */
export const nameSession = (id: string, name: string, hubName: string): void => {
  const trimmed = name.trim();
  const given = trimmed && trimmed !== hubName ? trimmed : null;
  const { hub, sessions, fail } = useDesk.getState();
  if (onHub() && hub) {
    const was = sessions[id];
    if (was) useDesk.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...was, displayName: given } } }));
    hub
      .nameSession(id, given)
      .then((now: Session) => useDesk.setState((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: now } } : {})))
      .catch((e: unknown) => {
        fail(e);
        if (was) useDesk.setState((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: was } } : {}));
      });
    return;
  }
  const s = useSettings.getState();
  const { [id]: _was, ...rest } = s.sessionNames;
  s.set({ sessionNames: given ? { ...rest, [id]: given } : rest });
};

// ── Following the hub ─────────────────────────────────────────────────────

/** Hands the groups and names Desk kept itself to the hub, once ever (the
 *  hub keeps its own if it already has some), then follows the hub's. Only
 *  the main window does this: it is the one that saves the settings. */
let handing: Promise<void> | null = null;
/** The hub's layout from a snapshot, waiting for the settings to be read. */
let offered: Layout | null = null;

const handOver = (hubLayout: Layout): void => {
  const { hub, detached } = useDesk.getState();
  const s = useSettings.getState();
  if (detached || s.layoutOnHub) return adopt(hubLayout);
  if (!s.loaded) {
    offered = hubLayout;
    return;
  }
  if (!hub || handing) return;
  handing = hub
    .importLayout({ layout: layoutOf(s), sessionNames: s.sessionNames })
    .then((r) => {
      adopt(r.layout);
      useSettings.getState().set({ layoutOnHub: true });
    })
    .catch((e: unknown) => {
      // Kept in the settings meanwhile; tried again on the next snapshot.
      console.warn("couldn't hand Desk's groups to the hub:", e);
    })
    .finally(() => (handing = null));
};

/** Forgets sessions the hub says are gone (removed, closed, or missing from
 *  its snapshot of every session) from the groups and names in Desk's
 *  settings. Agents are never forgotten this way: their hub may just be
 *  offline. */
export const forgetGone = (gone: (id: string) => boolean): void => {
  const s = useSettings.getState();
  const next = forgetSessions(layoutOf(s), s.sessionNames, gone);
  if (next) s.set({ groups: next.layout.groups, ungrouped: next.layout.ungrouped, sessionNames: next.names });
};

/** What the hub's events say is gone, as a test; null for none. */
export const goneIn = (e: DeskEvent): ((id: string) => boolean) | null => {
  switch (e.type) {
    case "snapshot": {
      const known = new Set([...e.sessions.filter((x) => x.state !== "closed"), ...e.restore].map((x) => x.id));
      return (id) => !known.has(id);
    }
    case "removed":
      return (id) => id === e.id;
    case "session":
      return e.session.state === "closed" ? (id) => id === e.session.id : null;
    default:
      return null;
  }
};

/** A snapshot that came before the settings were read is applied once they
 *  are, so it isn't overwritten by the file. */
let waiting: ((id: string) => boolean) | null = null;

deskListeners.add((e) => {
  if (e.type === "snapshot") {
    if (e.layout) handOver(e.layout);
    else useHubLayout.setState({ layout: null });
  } else if (e.type === "layout") {
    if (onHub()) adopt(e.layout);
  }
  const gone = goneIn(e);
  if (!gone) return;
  if (useSettings.getState().loaded) forgetGone(gone);
  else if (e.type === "snapshot") waiting = gone;
});

useSettings.subscribe((s, before) => {
  if (s.loaded && !before.loaded) {
    if (waiting) {
      const gone = waiting;
      waiting = null;
      forgetGone(gone);
    }
    if (offered) {
      const layout = offered;
      offered = null;
      handOver(layout);
    }
  }
});

/** Another hub (or none) starts from Desk's own until its snapshot. */
useDesk.subscribe((s, before) => {
  if (s.hub !== before.hub) {
    offered = null;
    useHubLayout.setState({ layout: null });
  }
});
