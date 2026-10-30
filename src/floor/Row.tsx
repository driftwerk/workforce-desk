import { useCallback, type ReactNode } from "react";
import { useChat } from "../chat/store";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Who } from "../hub/types";
import type { Look } from "./background";
import type { Tagged } from "./merge";
import { nameOf, turnAgentOf } from "./needs";
import { useFloor } from "./store";
import { clock } from "./time";

type Whose = { hubId?: string; local: boolean; who: Who };

/** Who an item is, as Desk can best tell: one of this computer's sessions
 *  that an agent's turn ran as (see `turnAgentOf`) is that agent, and an
 *  agent the hub sent no name for is called as its hub lists it. */
export const useWho = (): ((item: Whose) => Who) => {
  const sessions = useDesk((s) => s.sessions);
  const restore = useDesk((s) => s.restore);
  const roster = useChat((s) => s.roster);
  return useCallback(
    ({ hubId, local, who }: Whose): Who => {
      const listed = (id: string) => roster.find((a) => a.hubId === hubId && a.id === id)?.name ?? "";
      if (who.kind === "agent") return who.name.trim() ? who : { ...who, name: listed(who.id) };
      const cwd = local ? (sessions[who.id] ?? restore.find((r) => r.id === who.id))?.cwd : undefined;
      const agent = cwd ? turnAgentOf(cwd) : null;
      return agent ? { kind: "agent", id: agent, name: listed(agent), engine: null } : who;
    },
    [sessions, restore, roster],
  );
};

/** What a hub's agent or session is called here, kept current. */
export const useWhoName = (item: Whose): string => {
  const who = useWho()(item);
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
