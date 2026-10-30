import type { ReactNode } from "react";
import { useChat } from "../chat/store";
import { useSessionNames } from "../groups/names";
import type { Who } from "../hub/types";
import type { Look } from "./background";
import type { Tagged } from "./merge";
import { nameOf } from "./needs";
import { useFloor } from "./store";
import { clock } from "./time";

/** What a hub's agent or session is called here, kept current. */
export const useWhoName = (item: { who: Who; local: boolean }): string => nameOf(item, useSessionNames());

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
