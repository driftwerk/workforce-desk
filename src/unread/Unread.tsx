import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { NeedRow } from "../floor/NeedRow";
import { useMinute } from "../floor/RightNow";
import { useNeeds } from "../floor/store";
import { dayClock, durationOf } from "../floor/time";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { flightRows, type FlightRow } from "../rooms/flight";
import { MemberMark } from "../rooms/MemberMark";
import { useAuthor } from "../rooms/names";
import { dismiss, retry } from "../rooms/engine";
import { openTarget } from "../shell/navigate";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { Badge, needsYou } from "../ui/Badge";
import { Menu } from "../ui/Menu";
import { isLive, useUpdates } from "../updates/store";
import { advance, markEverythingRead, markUnread } from "./reads";
import { unreadRows, type UnreadRow } from "./rows";
import { useUnreadUpdate } from "./Marks";
import { useUnread } from "./summary";

// Everything new for you, in one place: what needs you, what's unread in
// every DM, room, thread and session, Desk's report and its update, and
// the answers still on their way in your rooms.

/** Unread rows shown at first, and more each time. */
const PAGE = 50;

const FLIGHT: Record<FlightRow["state"], string> = { needs: "Needs you", failed: "Failed", working: "Working", queued: "Queued", unread: "New" };

function FlightLine({ row, now }: { row: FlightRow; now: number }) {
  const author = useAuthor();
  const chip = row.state === "working" && row.since ? `Working ${durationOf(row.since, now)}` : FLIGHT[row.state];
  return (
    <button
      type="button"
      className="urow"
      onClick={() => openTarget({ kind: "room", roomId: row.room.id, threadId: row.thread })}
    >
      <span className="member-stack">
        {row.members.map((m) => (
          <MemberMark key={m} member={m} name={author(m).name} size="sm" />
        ))}
      </span>
      <span className="urow-body">
        <b>
          {row.room.name}
          {row.thread ? " ▸ thread" : ""}
        </b>
        {row.parent && <span className="faint small"> · {row.parent.content.split("\n")[0]}</span>}
      </span>
      <span className={`chip ${row.state === "failed" ? "state-blocked" : ""}`}>{chip}</span>
      <span className="faint small">{row.lastAt ? dayClock(row.lastAt, now) : ""}</span>
    </button>
  );
}

function Row({ row, dim, now, onRead }: { row: UnreadRow; dim: boolean; now: number; onRead: (r: UnreadRow) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const restart = useUpdates((s) => s.restart);
  const wait = useUpdates((s) => s.wait);
  const sessions = useDesk((s) => s.sessions);
  const fail = useDesk((s) => s.fail);
  const more = useRef<HTMLButtonElement>(null);
  const open = () => {
    if (row.open) openTarget(row.open);
    else if (row.place.kind === "brief") useDesk.getState().setView("floor");
  };
  return (
    <div className={`urow${dim ? " urow-read" : ""}`}>
      <button type="button" className="urow-open" onClick={open}>
        <span className="urow-body">
          <b>{row.title}</b>
          <span className="faint small">{row.line}</span>
        </span>
      </button>
      {row.version && (
        <>
          <button
            type="button"
            className="btn btn-signal"
            onClick={() => {
              onRead(row);
              void restart(Object.values(sessions).filter(isLive).map((s) => s.id)).catch(fail);
            }}
          >
            Restart
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onRead(row);
              wait(true);
            }}
          >
            When sessions finish
          </button>
        </>
      )}
      {row.urgency === "forYou" && row.count > 0 ? <Badge count={row.count} says={needsYou(row.count)} /> : <span className="side-dot" />}
      <span className="faint small">{row.at ? dayClock(row.at, now) : ""}</span>
      {!dim && !row.version && (
        <button type="button" className="link small" onClick={() => onRead(row)}>
          Mark read
        </button>
      )}
      {row.unread && (
        <button
          ref={more}
          type="button"
          className="icon-btn-sm"
          aria-label={`More for ${row.title}`}
          aria-haspopup="menu"
          onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
        >
          ⋯
        </button>
      )}
      {menu && row.unread && (
        <Menu
          label={row.title}
          at={menu}
          entries={[{ kind: "item", label: "Mark unread", onSelect: () => void markUnread(row.place, row.unread!) }]}
          onClose={(refocus) => {
            if (refocus) more.current?.focus();
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** The Unread page. */
export function Unread() {
  const now = useMinute();
  const needs = useNeeds();
  const local = useUnread((s) => s.local);
  const localAt = useUnread((s) => s.localAt);
  const dms = useUnread((s) => s.dms);
  const connected = useDesk((s) => s.connected);
  const rooms = useDesk((s) => s.rooms);
  const sessions = useDesk((s) => s.sessions);
  const timelines = useDesk((s) => s.timelines);
  const drafts = useDesk((s) => s.roomDrafts);
  const roster = useChat((s) => s.roster);
  const sessionNames = useSessionNames();
  const brief = useOverview((s) => s.overview?.brief ?? null);
  const ready = useUnreadUpdate();
  const keys = useSettings((s) => s.keys);
  const author = useAuthor();
  // When the ready version was first seen here, for its point.
  const readyAt = useMemo(() => new Date().toISOString(), [ready]);
  const rows = useMemo(
    () => unreadRows({ local, dms, rooms, roster, sessions, sessionNames, timelines, brief, ready, readyAt }),
    [local, dms, rooms, roster, sessions, sessionNames, timelines, brief, ready, readyAt],
  );
  // A row read during this visit stays, dimmed, until you leave, so Mark
  // unread is still at hand.
  const [kept, setKept] = useState<UnreadRow[]>([]);
  useEffect(() => setKept((was) => [...rows, ...was.filter((r) => !rows.some((x) => x.key === r.key))]), [rows]);
  const live = new Set(rows.map((r) => r.key));
  const [shown, setShown] = useState(PAGE);
  const [undo, setUndo] = useState<{ count: number; run: () => Promise<void> } | null>(null);
  const fail = useDesk((s) => s.fail);

  const flight = useMemo(
    () => flightRows(rooms, local?.rooms ?? [], drafts, needs, timelines).filter((r) => r.state !== "unread" && r.state !== "needs"),
    [rooms, local, drafts, needs, timelines],
  );
  const stuck = Object.entries(drafts).flatMap(([room, ds]) =>
    ds.filter((d) => d.state === "failed" || d.state === "stopped").map((d) => ({ room, d })),
  );

  const readRow = (r: UnreadRow) => void advance(r.place, r.read);
  const markAll = async () => {
    const count = rows.reduce((n, r) => n + Math.max(1, r.count), 0);
    try {
      const run = await markEverythingRead(dms, local?.floor ?? null);
      setUndo({ count, run });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <main className="room unread-page" aria-label="Unread">
      <header className="room-head">
        <span className="room-title">
          <h1 className="display-lg">Unread</h1>
          <span className="faint small">
            Everything new for you, on every workspace · {shortcutLabel(keys.unread)}
            {!connected && localAt ? ` · as of ${dayClock(localAt, now)}` : ""}
          </span>
        </span>
        <span className="room-head-actions">
          {undo && (
            <span className="faint small" role="status">
              Marked {undo.count} read ·{" "}
              <button
                type="button"
                className="link small"
                onClick={() => {
                  const run = undo.run;
                  setUndo(null);
                  void run().catch(fail);
                }}
              >
                Undo
              </button>
            </span>
          )}
          <button type="button" className="btn" disabled={!rows.length} onClick={() => void markAll()}>
            Mark all read
          </button>
        </span>
      </header>
      <div className="room-scroll">
        <section className="unread-section" aria-label="Needs you">
          <span className="side-label">Needs you</span>
          {needs.length === 0 && stuck.length === 0 && <p className="faint small">Nothing needs you.</p>}
          {needs.map((n) => (
            <NeedRow key={n.key} need={n} now={now} actions />
          ))}
          {stuck.map(({ room, d }) => (
            <div key={d.id} className="urow">
              <span className="urow-body">
                <b>
                  {author(d.member).name}’s answer {d.state === "stopped" ? "was stopped" : "failed"}
                </b>
                <span className="faint small"> · in {rooms[room]?.name ?? "a room"}</span>
              </span>
              <button type="button" className="link small" onClick={() => retry(room, d.id)}>
                Retry
              </button>
              <button type="button" className="link small" onClick={() => dismiss(room, d.id)}>
                Dismiss
              </button>
            </div>
          ))}
        </section>
        <section className="unread-section" aria-label="Unread">
          <span className="side-label">Unread</span>
          {kept.length === 0 && <p className="faint small">You’re all caught up.</p>}
          {kept.slice(0, shown).map((r) => (
            <Row key={r.key} row={r} dim={!live.has(r.key)} now={now} onRead={readRow} />
          ))}
          {kept.length > shown && (
            <button type="button" className="link small" onClick={() => setShown((n) => n + PAGE)}>
              Show more
            </button>
          )}
        </section>
        <section className="unread-section" aria-label="In flight">
          <span className="side-label">In flight</span>
          {flight.length === 0 && <p className="faint small">Nothing in flight.</p>}
          {flight.map((r) => (
            <FlightLine key={r.key} row={r} now={now} />
          ))}
        </section>
      </div>
    </main>
  );
}
