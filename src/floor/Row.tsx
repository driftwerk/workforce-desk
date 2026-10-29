import type { ReactNode } from "react";
import { useChat } from "../chat/store";
import { useSessionNames } from "../groups/names";
import type { Who } from "../hub/types";
import type { Look } from "./background";
import type { Tagged } from "./merge";
import { useFloor } from "./store";
import { clock } from "./time";

/** What a hub's agent or session is called here: a session by the name
 *  the person gave it. */
export const useWhoName = (who: Who): string => {
  const names = useSessionNames();
  return (who.kind === "session" ? names[who.id] : undefined) ?? who.name;
};

/** "Hub b unreachable since 16:20", for an item from a hub that couldn't be
 *  read last time. */
export const useStaleNote = (item: Tagged): string | undefined => {
  const label = useChat((s) => s.hubs.find((h) => h.id === item.hubId)?.label ?? item.hubId);
  const at = useFloor((s) => s.hubs[item.hubId]?.at);
  return item.stale ? `${label} unreachable since ${at ? clock(at) : "earlier"}` : undefined;
};

/** One row of the floor: who, when, and what, opening where it is. */
export function FloorRow({
  item,
  look,
  time,
  children,
  onOpen,
}: {
  item: Tagged & { who: Who };
  /** Its dot. */
  look: Look | "failed";
  time: string;
  children: ReactNode;
  onOpen: () => void;
}) {
  const name = useWhoName(item.who);
  const stale = useStaleNote(item);
  return (
    <button type="button" className={`floor-item ${item.stale ? "floor-stale" : ""}`} title={stale} onClick={onOpen}>
      <span className="floor-item-head">
        <span className={`dot dot-${look}`} aria-hidden="true" />
        <b className={item.who.kind === "session" ? "mono" : undefined}>{name}</b>
        <span className="floor-time">{time}</span>
      </span>
      <span className="floor-item-what">{children}</span>
    </button>
  );
}
