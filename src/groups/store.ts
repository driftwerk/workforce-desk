import { deskListeners } from "../hub/store";
import type { DeskEvent } from "../hub/types";
import { useSettings } from "../settings/store";
import { forgetSessions, type Layout } from "./model";

/** The groups as saved in Desk's settings. */
export const layoutOf = (s: { groups: Layout["groups"]; ungrouped: Layout["ungrouped"] }): Layout => ({
  groups: s.groups,
  ungrouped: s.ungrouped,
});

/** Changes the groups and saves them with the rest of Desk's settings. */
export const changeLayout = (change: (layout: Layout) => Layout | null): void => {
  const s = useSettings.getState();
  const next = change(layoutOf(s));
  if (next) s.set({ groups: next.groups, ungrouped: next.ungrouped });
};

/** Names a session in Desk; an empty name, or the hub's own, goes back to
 *  the hub's. */
export const nameSession = (id: string, name: string, hubName: string): void => {
  const s = useSettings.getState();
  const trimmed = name.trim();
  const { [id]: _was, ...rest } = s.sessionNames;
  s.set({ sessionNames: trimmed && trimmed !== hubName ? { ...rest, [id]: trimmed } : rest });
};

/** Forgets sessions the hub says are gone (removed, closed, or missing from
 *  its snapshot of every session), from the groups and their names. Agents
 *  are never forgotten this way: their hub may just be offline. */
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
  const gone = goneIn(e);
  if (!gone) return;
  if (useSettings.getState().loaded) forgetGone(gone);
  else if (e.type === "snapshot") waiting = gone;
});

useSettings.subscribe((s, before) => {
  if (s.loaded && !before.loaded && waiting) {
    const gone = waiting;
    waiting = null;
    forgetGone(gone);
  }
});
