// Rooms, boards and the Floor in a grid's pane, beside sessions, agents and
// terminals: each the view Desk already has (the room with its composer, the
// board with its filters and drag, the Floor's main column), shown under the
// pane's own header, which says what it is.

import { useEffect, useId, useMemo } from "react";
import { create } from "zustand";
import { Board } from "../board/BoardView";
import { FILTERS, type BoardFilter } from "../board/board";
import { useBoard } from "../board/store";
import { hubNameOf, useSyncHubs } from "../board/syncStore";
import { useChat } from "../chat/store";
import { useFloorReads } from "../floor/Floor";
import { FloorIds, FloorScope } from "../floor/scope";
import { useLayout } from "../groups/store";
import { SYSTEM_TITLE, syncStatus } from "../hub/boardSync";
import { useDesk } from "../hub/store";
import { useCrewFloor, FloorColumn } from "../overview/CrewFloor";
import { useOverview } from "../overview/store";
import { RoomPaneContext, type RoomPane } from "../rooms/inPane";
import { useAuthor } from "../rooms/names";
import { memberKey } from "../rooms/routing";
import { RoomView } from "../rooms/RoomView";
import { Marks, useRoomMarker } from "../unread/Marks";
import type { Overview } from "../hub/types";
import type { PaneContent } from "./engine";
import { openInMain } from "./elsewhere";

export type ViewKind = "room" | "board" | "floor";

/** Below this width (px) a board's pane shows a column at a time, and the
 *  Floor's plan meters fold to a line each (grids.css, kept in step by
 *  kinds.test.tsx). */
export const NARROW_PANE = 520;
/** Below this height (px) a board's pane shows its counts, and the Floor's
 *  how many are working, need you and are done. */
export const SHORT_PANE = 240;

export const isView = (c: PaneContent | null | undefined): c is Extract<PaneContent, { kind: ViewKind }> =>
  c?.kind === "room" || c?.kind === "board" || c?.kind === "floor";

/** A room, a board or the Floor, drawn small in its pane's header. */
export function KindIcon({ kind }: { kind: ViewKind }) {
  return (
    <svg className="gpane-kind" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {kind === "floor" ? (
        <>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </>
      ) : kind === "board" ? (
        <>
          <rect x="2" y="2" width="3" height="12" rx="1" />
          <rect x="6.5" y="2" width="3" height="8" rx="1" />
          <rect x="11" y="2" width="3" height="10" rx="1" />
        </>
      ) : (
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      )}
    </svg>
  );
}

/** What a room's, a board's or the Floor's pane header says. */
export interface ViewLabel {
  kind: ViewKind;
  name: string;
  meta: string;
  /** What it shows is gone: the room or board deleted, the group removed. */
  gone: boolean;
}

/** The sync a board's header says: "Jira SHOP · synced". */
const syncLine = (b: NonNullable<ReturnType<typeof useBoard.getState>["boards"][string]>, hub: string): string | null => {
  const status = syncStatus(b, hub);
  if (!b.sync || !status) return null;
  return `${SYSTEM_TITLE[b.sync.system]} ${b.sync.target} · ${status.kind === "synced" ? "synced" : status.kind === "paused" ? "paused" : "sync problem"}`;
};

/** The header of a pane showing a room, a board or the Floor; null for
 *  any other. */
export function useViewLabel(content: PaneContent | null): ViewLabel | null {
  const room = useDesk((s) => (content?.kind === "room" ? s.rooms[content.room] : undefined));
  const roomsLoaded = useDesk((s) => s.loaded);
  const author = useAuthor();
  const board = useBoard((s) => (content?.kind === "board" ? s.boards[content.board] : undefined));
  const boardsRead = useBoard((s) => s.supported !== null);
  const tickets = useBoard((s) =>
    content?.kind === "board" ? Object.values(s.tickets).filter((t) => t.board === content.board && t.state !== "dropped").length : 0,
  );
  const kept = useSyncHubs((s) => s.hubs);
  const paired = useChat((s) => s.hubs);
  const groups = useLayout().groups;
  if (content?.kind === "room") {
    if (!room) return { kind: "room", name: "Room", meta: roomsLoaded ? "no longer on the hub" : "", gone: roomsLoaded };
    const members = room.members.map((m) => author(memberKey(m)).name);
    return { kind: "room", name: room.name, meta: `Room · ${[...members, "you"].join(", ")}`, gone: false };
  }
  if (content?.kind === "board") {
    if (!board) return { kind: "board", name: "Board", meta: boardsRead ? "no longer on the hub" : "", gone: boardsRead };
    const sync = board.sync ? syncLine(board, hubNameOf(board.sync.via, kept, paired)) : null;
    return {
      kind: "board",
      name: board.name,
      meta: sync ?? [board.prefix, `${tickets} ${tickets === 1 ? "ticket" : "tickets"}`].filter(Boolean).join(" · "),
      gone: false,
    };
  }
  if (content?.kind === "floor") {
    if (!content.group) return { kind: "floor", name: "Floor", meta: "", gone: false };
    const g = groups.find((x) => x.id === content.group);
    // Joined so a name cut short in a narrow header keeps its space.
    return g ? { kind: "floor", name: `Floor ›\u00a0${g.name}`, meta: "", gone: false } : { kind: "floor", name: "Floor ›\u00a0a removed group", meta: "", gone: true };
  }
  return null;
}

// ── Each kind's header extras ──────────────────────────────────────────────

/** A board pane's filter, by pane, for as long as Desk runs: its header's
 *  chips and its body read the same one. */
export const usePaneFilters = create<Record<string, BoardFilter>>(() => ({}));

const filterKey = (gridId: string, paneId: string) => `${gridId}/${paneId}`;

export const setPaneFilter = (gridId: string, paneId: string, f: BoardFilter): void =>
  usePaneFilters.setState({ [filterKey(gridId, paneId)]: f });

export const usePaneFilter = (gridId: string, paneId: string): BoardFilter => usePaneFilters((s) => s[filterKey(gridId, paneId)] ?? "all");

/** A board pane's filter, in its header: All, Waiting on me, Pinned. */
export function BoardChips({ gridId, paneId }: { gridId: string; paneId: string }) {
  const filter = usePaneFilter(gridId, paneId);
  return (
    <span className="gpane-chips search-filters" role="group" aria-label="Show">
      {FILTERS.map((f) => (
        <button key={f.id} type="button" className="chip-btn" aria-pressed={filter === f.id} onClick={() => setPaneFilter(gridId, paneId, f.id)}>
          {f.label}
        </button>
      ))}
    </span>
  );
}

/** A room pane's badge: what's unread in it, as its sidebar row says. */
export function RoomPaneMarks({ room }: { room: string }) {
  return <Marks badge={useRoomMarker(room)} />;
}

/** "3 working · 1 needs you · 4 done today", of the Floor a pane shows. */
export function FloorMeta({ group, id }: { group: string | null; id?: string }) {
  const overview = useOverview((s) => s.overview);
  if (!overview) return null;
  return (
    <FloorScope.Provider value={group}>
      <FloorCountsLine overview={overview} id={id} />
    </FloorScope.Provider>
  );
}

function FloorCountsLine({ overview, id }: { overview: Overview; id?: string }) {
  const { counts } = useCrewFloor(overview);
  return (
    <span id={id} className="gpane-meta">
      {counts.working} working ·{" "}
      <span className={counts.needsYou ? "state-blocked strong" : undefined}>
        {counts.needsYou} need{counts.needsYou === 1 ? "s" : ""} you
      </span>{" "}
      · {counts.doneToday} done today
    </span>
  );
}

// ── Bodies ─────────────────────────────────────────────────────────────────

/** A room in a pane: its timeline and composer, read as the room view reads
 *  (while it's on screen); a thread opens in Rooms. */
export function RoomPaneBody({ room: id }: { room: string }) {
  const room = useDesk((s) => s.rooms[id]);
  const loaded = useDesk((s) => s.loaded);
  const connected = useDesk((s) => s.connected);
  // Its timeline is read here, as Rooms reads the room it shows, and again
  // when the hub is back after a restart.
  useEffect(() => {
    if (!connected) return;
    const desk = useDesk.getState();
    if (!desk.hub) return;
    if (desk.windows[id]) void desk.reloadRoom(id);
    else void desk.page(id, null, "newest").catch(() => undefined);
  }, [id, connected]);
  const inPane = useMemo<RoomPane>(() => ({ openThread: (r, thread) => openInMain({ kind: "thread", room: r, thread }) }), []);
  if (!room) {
    return (
      <div className="pane-note">
        <p className="muted small">{loaded ? "This room is no longer on this computer's hub." : "Reading the room…"}</p>
      </div>
    );
  }
  return (
    <RoomPaneContext.Provider value={inPane}>
      <RoomView key={room.id} room={room} />
    </RoomPaneContext.Provider>
  );
}

/** A board in a pane, with the filter its header shows. */
export function BoardPaneBody({ gridId, paneId, board }: { gridId: string; paneId: string; board: string }) {
  const filter = usePaneFilter(gridId, paneId);
  const pane = useMemo(
    () => ({
      board,
      filter,
      onFilter: (f: BoardFilter) => setPaneFilter(gridId, paneId, f),
      openTicket: (id: string) => openInMain({ kind: "ticket", id }),
    }),
    [board, filter, gridId, paneId],
  );
  return <Board pane={pane} />;
}

/** The Floor's main column in a pane: everything's, or one group's. A
 *  short pane says how many are working, need you and are done. */
export function FloorPaneBody({ group }: { group: string | null }) {
  useFloorReads();
  const overview = useOverview((s) => s.overview);
  const groups = useLayout().groups;
  const ids = useId();
  if (group && !groups.some((g) => g.id === group)) {
    return (
      <div className="pane-note">
        <p className="muted small">This group is no longer in the sidebar, so its Floor has nothing to show.</p>
      </div>
    );
  }
  if (!overview) {
    return (
      <div className="pane-note">
        <p className="muted small">Reading the Floor…</p>
      </div>
    );
  }
  return (
    <FloorScope.Provider value={group}>
      <FloorIds.Provider value={`${ids}-`}>
        <FloorColumn overview={overview} scrollKey={null} className="crew-floor-main floor-in-pane" />
        <FloorShort overview={overview} />
      </FloorIds.Provider>
    </FloorScope.Provider>
  );
}

/** The Floor in a short pane: its counts, each with its dot. */
function FloorShort({ overview }: { overview: Overview }) {
  const { counts } = useCrewFloor(overview);
  return (
    <ul className="floor-short" aria-label="Counts">
      <li>
        <span className="dot dot-working" aria-hidden="true" />
        {counts.working} working
      </li>
      <li>
        <span className="dot dot-blocked" aria-hidden="true" />
        {counts.needsYou} need{counts.needsYou === 1 ? "s" : ""} you
      </li>
      <li>
        <span className="dot dot-done" aria-hidden="true" />
        {counts.doneToday} done
      </li>
    </ul>
  );
}
