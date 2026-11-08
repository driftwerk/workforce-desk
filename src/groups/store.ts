// Where the sidebar's groups and the names you give sessions live. A hub that
// keeps them (its snapshot carries `layout`) is the one source: every change
// is applied here at once, sent to it, and replaced by what it answers or
// announces; agents on it see them too. The first time Desk meets such a hub
// it hands over what it kept itself. Against a hub that can't keep them,
// Desk's settings hold them, as before.

import { crossesBoss, HubError, type DeskHub } from "../hub/client";
import { deskListeners, hubOf, useDesk } from "../hub/store";
import { LOCAL, splitKey } from "../hub/machines";
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

/** Whether where the groups are kept is known, and they're there to be
 *  changed: Desk's settings are read, this computer's hub has said whether
 *  it keeps them, and if it does, Desk has them from it. Until then a
 *  change made unasked (a machine's sessions forgotten or merged in) waits,
 *  so it isn't made to the copy that's about to be replaced. */
export const layoutSettled = (): boolean => {
  const { layout, kept } = useHubLayout.getState();
  return useSettings.getState().loaded && kept !== null && (!kept || layout !== null);
};

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

/** What a failed change does: shown to the person (`false`), only logged
 *  (`true`: one Desk retries itself), or handed to its caller to say. */
type OnFailure = boolean | ((e: unknown) => void);

/** Sends one change to the hub, in order after the others; whether the hub
 *  took it. */
const send = (hub: DeskHub, call: (hub: DeskHub) => Promise<Layout>, quiet: OnFailure = false): Promise<boolean> => {
  inFlight++;
  let took = false;
  sending = sending.then(async () => {
    try {
      heard = await call(hub);
      took = true;
    } catch (e) {
      if (typeof quiet === "function") quiet(e);
      else if (quiet) console.warn("couldn't change the groups on the hub:", e);
      else useDesk.getState().fail(e);
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
  return sending.then(() => took);
};

/** Applies `change` to the groups; on a hub that keeps them, also sends it
 *  through `call` (its group routes), given the layout as changed. Settles
 *  with whether it was kept (at once in Desk's settings; once the hub took
 *  it on a hub). */
export const changeLayout = (
  change: (layout: Layout) => Layout | null,
  call: (hub: DeskHub, next: Layout) => Promise<Layout>,
  quiet: OnFailure = false,
): Promise<boolean> => {
  const hubLayout = useHubLayout.getState().layout;
  const hub = useDesk.getState().hub;
  if (hubLayout && hub) {
    const next = change(hubLayout);
    if (!next || next === hubLayout) return Promise.resolve(true);
    useHubLayout.setState({ layout: next });
    return send(hub, (h) => call(h, next), quiet);
  }
  const s = useSettings.getState();
  const next = change(layoutOf(s));
  if (next) s.set({ groups: next.groups, ungrouped: next.ungrouped });
  return Promise.resolve(true);
};

// Each change, as `model` makes it and as the hub's routes do. Ungrouped's
// order is Desk's to settle (it lists what shows there unplaced, which only
// Desk knows), so changes that place things in it send that order.

/** Settles with whether it was kept (once the hub has it, on a hub). */
export const newGroup = (id: string, name: string, items: readonly ItemKey[] = []): Promise<boolean> =>
  changeLayout(
    (l) => created(l, id, name, items),
    (h) => h.createGroup({ id, name, items: [...items] }),
  );

export const renameGroup = (id: string, name: string): void =>
  void changeLayout(
    (l) => renamed(l, id, name),
    (h) => h.updateGroup(id, { name: name.trim() }),
  );

export const collapseGroup = (id: string, to: boolean): void =>
  void changeLayout(
    (l) => collapsed(l, id, to),
    (h) => h.updateGroup(id, { collapsed: to }),
  );

/** How a delete went: done, done but Ungrouped's new order not kept, or
 *  not done. */
export type Deleted = "deleted" | "unordered" | "failed";

/** Its members go to the end of Ungrouped. Settles with how it went;
 *  `failed`, when given, is told why it wasn't deleted (or why its order
 *  wasn't kept) instead of the person. */
export const deleteGroup = async (present: readonly ItemKey[], id: string, failed?: (e: unknown) => void): Promise<Deleted> => {
  let unordered = false;
  const took = await changeLayout(
    (l) => deleted(l, present, id),
    async (h, next) => {
      const gone = await h.deleteGroup(id);
      try {
        return await h.orderUngrouped(next.ungrouped.items);
      } catch (e) {
        // Deleted all the same: only where its members went isn't kept.
        unordered = true;
        if (failed) failed(e);
        else useDesk.getState().fail(e);
        return gone;
      }
    },
    failed ?? false,
  );
  return !took ? "failed" : unordered ? "unordered" : "deleted";
};

export const moveGroup = (id: string, before: string | null): void =>
  void changeLayout(
    (l) => movedGroup(l, id, before),
    (h) => h.moveGroup(id, before),
  );

/** Any session, this computer's or a machine's (`session:<machine>/<id>`),
 *  and any agent can be in any group. */
export const moveItem = (present: readonly ItemKey[], key: ItemKey, to: string, before: ItemKey | null, failed: OnFailure = false): void =>
  void changeLayout(
    (l) => moved(l, present, key, to, before),
    (h, next) => (to === UNGROUPED ? h.orderUngrouped(next.ungrouped.items) : h.putInGroup(to, key, before)),
    failed,
  );

export const removeFromGroup = (present: readonly ItemKey[], key: ItemKey, failed: OnFailure = false): void =>
  void changeLayout(
    (l) => removed(l, present, key),
    (h, next) => h.orderUngrouped(next.ungrouped.items),
    failed,
  );

export const dropItem = (present: readonly ItemKey[], dragged: string, drop: Drop): void =>
  drop.kind === "item" ? moveItem(present, dragged, drop.group, drop.before) : moveGroup(dragged, drop.before);

/** How many times a whole-layout change is made again to what the hub
 *  has, when the hub changed it meanwhile. */
export const REPLACE_TRIES = 3;

/** A change no one route says (a machine's sessions forgotten, its groups
 *  merged in): the whole layout as changed, in turn with the rest. The hub
 *  may change it itself meanwhile (an agent groups something, a session of
 *  its own is placed or forgotten), so the change is made to what it has
 *  now and sent saying so; if it changed again before the write (409), it's
 *  read and made again, a few times. Settles with whether the hub took it.
 *  Failures are only logged: what calls this tries again itself. */
export const replaceLayout = (change: (layout: Layout) => Layout | null): Promise<boolean> =>
  changeLayout(
    change,
    async (h) => {
      for (let tries = 1; ; tries++) {
        const fresh = await h.layout();
        const next = change(fresh);
        if (!next) return fresh;
        try {
          return await h.replaceLayout(next, fresh);
        } catch (e) {
          // Only a layout that changed meanwhile is tried again; one that
          // would take a session to another boss never is.
          if (!(e instanceof HubError && e.status === 409) || crossesBoss(e) || tries >= REPLACE_TRIES) throw e;
        }
      }
    },
    true,
  );

// ── Names ─────────────────────────────────────────────────────────────────

/** Names a session; an empty name, or the hub's own, goes back to the
 *  hub's. */
export const nameSession = (id: string, name: string, hubName: string): void => {
  const trimmed = name.trim();
  const given = trimmed && trimmed !== hubName ? trimmed : null;
  const { hub, sessions, fail } = useDesk.getState();
  // A machine's session (by its key) is named on its own engine, which
  // keeps its names.
  const on = splitKey(id);
  if (on.machine !== LOCAL) {
    hubOf(on.machine)
      ?.nameSession(on.id, given)
      .then((now: Session) => useDesk.setState((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...now, machine: on.machine } } } : {})))
      .catch(fail);
    return;
  }
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
 *  offline; nor are machines' sessions, which this computer's hub doesn't
 *  know (their own engines say when they're gone: see machines.ts). */
export const forgetGone = (gone: (id: string) => boolean): void => {
  const s = useSettings.getState();
  const next = forgetSessions(layoutOf(s), s.sessionNames, (id) => splitKey(id).machine === LOCAL && gone(id));
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
    useHubLayout.setState({ kept: !!e.layout });
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
    useHubLayout.setState({ layout: null, kept: null });
  }
});
