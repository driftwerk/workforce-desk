import { useCallback, type ReactNode } from "react";
import { useChat } from "../chat/store";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Who } from "../hub/types";
import type { Look } from "./background";
import type { Tagged } from "./merge";
import { isAgentTurn, nameOf, ownName, turnAgentOf } from "./needs";
import { useFloor } from "./store";
import { clock } from "./time";

type Whose = { hubId?: string; local: boolean; who: Who };

/** Who an item is, as Desk can best tell: one of this computer's sessions
 *  that an agent's turn ran as (see `turnAgentOf`) is that agent, and an
 *  agent the hub sent no name for is called as its hub lists it. An agent's
 *  turn Desk can't put to its agent (it knows no folder for it, or the
 *  agent's hub lists no such agent) is no one the person can do anything
 *  with: null. */
export const useWho = (): ((item: Whose) => Who | null) => {
  const sessions = useDesk((s) => s.sessions);
  const restore = useDesk((s) => s.restore);
  const roster = useChat((s) => s.roster);
  const rosterRead = useChat((s) => s.rosterRead);
  const rosterErrors = useChat((s) => s.rosterErrors);
  return useCallback(
    ({ hubId, local, who }: Whose): Who | null => {
      const listed = (id: string) => roster.find((a) => a.hubId === hubId && a.id === id)?.name ?? "";
      if (who.kind === "agent") return who.name.trim() ? who : { ...who, name: listed(who.id) };
      const known = local ? (sessions[who.id] ?? restore.find((r) => r.id === who.id)) : undefined;
      const agent = known?.cwd ? turnAgentOf(known.cwd) : null;
      // An agent its hub has been read without is no one's either.
      const unknown = (id: string) => rosterRead && !(hubId && rosterErrors[hubId]) && !roster.some((a) => a.hubId === hubId && a.id === id);
      if (agent) return unknown(agent) ? null : { kind: "agent", id: agent, name: listed(agent), engine: null };
      return isAgentTurn({ name: who.name }) || (known && isAgentTurn({ name: known.name ?? "" })) ? null : who;
    },
    [sessions, restore, roster, rosterRead, rosterErrors],
  );
};

/** What a session is about, in a word Desk can say without its prompt: the
 *  person's name for it, else the hub's, else its folder's; null for an
 *  agent, or a session with no name to read. */
export const useSubject = (): ((item: Pick<Whose, "local" | "who">) => string | null) => {
  const sessions = useDesk((s) => s.sessions);
  const restore = useDesk((s) => s.restore);
  const names = useSessionNames();
  return useCallback(
    ({ local, who }: Pick<Whose, "local" | "who">): string | null => {
      if (who.kind !== "session") return null;
      const own = (local ? names[who.id] : undefined) ?? ownName(who);
      if (own) return own;
      const cwd = local ? (sessions[who.id] ?? restore.find((r) => r.id === who.id))?.cwd : undefined;
      const folder = cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "";
      return folder && !isAgentTurn({ name: folder, cwd }) ? ownName({ name: folder }) : null;
    },
    [sessions, restore, names],
  );
};

/** What a hub's agent or session is called here, kept current. */
export const useWhoName = (item: Whose): string => {
  const who = useWho()(item) ?? item.who;
  const names = useSessionNames();
  return nameOf({ who, local: item.local }, names);
};

/** "Hub b unreachable since 16:20", for an item from a hub that couldn't be
 *  read last time. */
export const useStaleNote = (item: Tagged): string | undefined => {
  const label = useChat((s) => s.hubs.find((h) => h.id === item.hubId)?.label ?? item.hubId);
  const at = useFloor((s) => s.hubs[item.hubId]?.at);
  return item.stale ? `${label} unreachable since ${at ? clock(at) : "earlier"}` : undefined;
};

/** One row of the floor: who, when, and what, opening where it is (when
 *  it opens anywhere here); `tabbed` false leaves it to a button beside it
 *  to open it from the keyboard. */
export function FloorRow({
  item,
  look,
  time,
  children,
  onOpen,
  tabbed = true,
}: {
  item: Tagged & { who: Who };
  /** Its dot. */
  look: Look | "failed";
  time: string;
  children: ReactNode;
  onOpen?: () => void;
  tabbed?: boolean;
}) {
  const name = useWhoName(item);
  const stale = useStaleNote(item);
  const body = (
    <>
      <span className="floor-item-head">
        <span className={`dot dot-${look}`} aria-hidden="true" />
        <b className={item.who.kind === "session" ? "mono" : undefined}>{name}</b>
        <span className="floor-time">{time}</span>
      </span>
      <span className="floor-item-what">{children}</span>
      {stale && <span className="sr-only"> · {stale}</span>}
    </>
  );
  const className = `floor-item ${item.stale ? "floor-stale" : ""}`;
  return onOpen ? (
    <button type="button" className={className} title={stale} tabIndex={tabbed ? undefined : -1} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className={className} title={stale}>
      {body}
    </div>
  );
}
