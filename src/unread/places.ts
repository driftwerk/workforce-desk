// Desk-wide unread: every place new content lands for the person, one read
// point each, read when it has been on screen. The points live with the hub
// that owns the content: rooms, threads, sessions, Activity, the brief and
// the update on this computer's hub; a DM on its agent's hub.

/** Somewhere new content lands for the person. */
export type Place =
  /** A DM, local or remote, the overseer's included. */
  | { kind: "dm"; hub: string; agent: string }
  /** A room's main timeline. */
  | { kind: "room"; room: string }
  | { kind: "thread"; room: string; thread: string }
  /** A Claude Code or Codex session. */
  | { kind: "session"; session: string }
  /** The crew's Activity log. */
  | { kind: "activity" }
  /** The overseer's brief (Desk's report). */
  | { kind: "brief" }
  /** A new version of Desk, downloaded. */
  | { kind: "update" };

/** A place's string form, as the hubs key it. */
export const placeKey = (p: Place): string => {
  switch (p.kind) {
    case "dm":
      return `dm:${p.hub}/${p.agent}`;
    case "room":
      return `room:${p.room}`;
    case "thread":
      return `thread:${p.room}/${p.thread}`;
    case "session":
      return `session:${p.session}`;
    default:
      return p.kind;
  }
};

/** The place a string form names; null for one Desk doesn't know. */
export const parsePlace = (key: string): Place | null => {
  if (key === "activity" || key === "brief" || key === "update") return { kind: key };
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  const [a, b, ...more] = rest.split("/");
  if (colon < 0 || !a || more.length) return null;
  if (kind === "room" && !b) return { kind: "room", room: a };
  if (kind === "session" && !b) return { kind: "session", session: a };
  if (kind === "thread" && b) return { kind: "thread", room: a, thread: b };
  if (kind === "dm" && b) return { kind: "dm", hub: a, agent: b };
  return null;
};
