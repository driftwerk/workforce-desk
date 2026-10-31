import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { NeedRow } from "../floor/NeedRow";
import { useMinute } from "../floor/RightNow";
import { useNeeds } from "../floor/store";
import { dayClock, durationOf, since } from "../floor/time";
import { useDesk, type RoomDraft } from "../hub/store";
import { flightRows, type FlightRow } from "../rooms/flight";
import { MemberMark } from "../rooms/MemberMark";
import { useAuthor } from "../rooms/names";
import { dismiss, retry } from "../rooms/engine";
import { openTarget } from "../shell/navigate";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { logoDot } from "../theme/builtin";
import { useTheme } from "../theme/store";
import { Badge, needsYou } from "../ui/Badge";
import { AgentMark, Mark } from "../ui/Mark";
import { isLive, useUpdates } from "../updates/store";
import { stuckOf } from "./badges";
import { useDmPreview } from "./previews";
import { advance, markEverythingRead, markUnread } from "./reads";
import { firstLine, groupRows, plural, type RowMark, type UnreadRow } from "./rows";
import { useLocalUnread, useUnreadDms, useUnreadRows } from "./Marks";
import { useUnread } from "./summary";

// Everything new for you, in one place, drawn as the Floor is: what needs
// you, what's unread in every DM, room, thread and session, Desk's report
// and its update, and the answers still on their way in your rooms. Each
// section is a card; each row says who and what in words.

/** Unread rows (or a room's group of them) shown at first, and more each time. */
const PAGE = 50;

/** What the page's keys move between, and what a row is. */
const NAV = ".urow-open, .floor-need .floor-item";
const ROW = ".urow, .floor-need";

/** The answers still being written or queued, by room. */
const onTheirWay = (drafts: Readonly<Record<string, readonly RoomDraft[]>>): Record<string, RoomDraft[]> =>
  Object.fromEntries(
    Object.entries(drafts).flatMap(([room, ds]) => {
      const busy = ds.filter((d) => d.state !== "failed" && d.state !== "stopped" && d.state !== "interrupted");
      return busy.length ? [[room, busy]] : [];
    }),
  );

/** Desk's own mark, for its report and its update. */
function DeskMark() {
  const theme = useTheme();
  return (
    <span className="mark mark-sm" aria-hidden="true">
      <span className="mark-face urow-desk-face">
        d<span className="wordmark-dot" style={{ background: logoDot(theme.spec) }} />
      </span>
    </span>
  );
}

/** A room's mark: its sign, in the room's place. */
function RoomMark() {
  return (
    <span className="mark mark-sm" aria-hidden="true">
      <span className="mark-face urow-room-face">#</span>
    </span>
  );
}

function PlaceMark({ mark }: { mark: RowMark }) {
  switch (mark.kind) {
    case "agent":
      return <AgentMark agent={mark.agent} name={mark.name} size="sm" />;
    case "member":
      return <MemberMark member={mark.member} name={mark.name} size="sm" />;
    case "session":
      return <Mark name={mark.name} engine={mark.engine} size="sm" />;
    case "room":
      return <RoomMark />;
    case "desk":
      return <DeskMark />;
  }
}

const STATE: Record<FlightRow["state"], string> = { needs: "Needs you", failed: "Failed", working: "Working", queued: "Queued", unread: "New" };

/** An answer on its way in one of your rooms. */
function FlightLine({ row, now }: { row: FlightRow; now: number }) {
  const author = useAuthor();
  const chip = row.state === "working" && row.since ? `Working ${durationOf(row.since, now)}` : STATE[row.state];
  const who = row.members.map((m) => author(m).name).join(", ");
  const about = firstLine(row.parent?.content);
  return (
    <div className="urow" role="listitem">
      <button
        type="button"
        className="urow-open"
        aria-label={`${row.room.name}${row.thread ? ", a thread" : ""}: ${who} ${chip.toLowerCase()}${about ? `, on ${about}` : ""}`}
        onClick={() => openTarget({ kind: "room", roomId: row.room.id, threadId: row.thread })}
      >
        <span className="member-stack">
          {row.members.map((m) => (
            <MemberMark key={m} member={m} name={author(m).name} size="sm" state={row.state === "working" ? "working" : undefined} />
          ))}
        </span>
        <span className="urow-body">
          <span className="urow-head">
            <b className="urow-title">{row.room.name}</b>
            <span className="urow-where">{row.thread ? "Thread" : "Room"}</span>
          </span>
          <span className="urow-line">{about ? `${who} · ${about}` : who}</span>
        </span>
      </button>
      <span className="urow-meta">
        <span className={`chip ${row.state === "working" ? "chip-live" : ""}`}>{chip}</span>
      </span>
    </div>
  );
}

/** A failed or stopped answer, which needs you: as a need, with Retry. */
function StuckRow({ room, draft }: { room: string; draft: RoomDraft }) {
  const author = useAuthor();
  const rooms = useDesk((s) => s.rooms);
  const name = author(draft.member).name;
  const word = draft.state === "stopped" ? "was stopped" : "failed";
  return (
    <div className="floor-need floor-need-acts" role="listitem">
      <button type="button" className="floor-item" onClick={() => openTarget({ kind: "room", roomId: room, threadId: draft.threadId })}>
        <span className="floor-item-head">
          <span className="dot dot-failed" aria-hidden="true" />
          <b>{name}</b>
          <span className="floor-time">{dayClock(draft.since)}</span>
        </span>
        <span className="floor-item-what">
          {name}’s answer {word}
          <span className="faint"> · in {rooms[room]?.name ?? "a room"}</span>
        </span>
      </button>
      <span className="floor-need-buttons">
        <button type="button" className="btn btn-signal" aria-label={`Retry ${name}’s answer`} onClick={() => retry(room, draft.id)}>
          Retry
        </button>
        <button type="button" className="btn" aria-label={`Dismiss ${name}’s answer`} onClick={() => dismiss(room, draft.id)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

/** One place with something unread: its mark, what it is and where, what
 *  it last said, its count and when; Mark read (or unread) on hover. */
function Row({ row, dim, now, nested = false, onRead }: { row: UnreadRow; dim: boolean; now: number; nested?: boolean; onRead: (r: UnreadRow) => void }) {
  const restart = useUpdates((s) => s.restart);
  const wait = useUpdates((s) => s.wait);
  const sessions = useDesk((s) => s.sessions);
  const fail = useDesk((s) => s.fail);
  const preview = useDmPreview(row.place.kind === "dm" ? row.key.slice("dm:".length) : "", row.read.message);
  const line = preview?.line ?? row.line;
  const title = nested ? (row.place.kind === "room" ? "Room timeline" : row.title) : row.title;
  const where = nested ? (row.place.kind === "thread" ? "Thread" : "") : row.where;
  const opens = !!row.open || row.place.kind === "brief";
  const open = () => {
    if (row.open) openTarget(row.open, { beside: true });
    else if (row.place.kind === "brief") useDesk.getState().setView("floor");
  };
  const mark = dim ? "read" : row.urgency === "forYou" && row.count > 0 ? needsYou(row.count) : "new";
  const time = row.at ? since(row.at, now) : "";
  const label = [title, where, mark, time].filter(Boolean).join(", ") + (line ? `: ${line}` : "");
  const body = (
    <>
      {!nested && <PlaceMark mark={row.mark} />}
      <span className="urow-body">
        <span className="urow-head">
          <b className="urow-title">{title}</b>
          {where && <span className="urow-where">{where}</span>}
        </span>
        {line && <span className="urow-line">{line}</span>}
      </span>
    </>
  );
  return (
    <div className={`urow${dim ? " urow-read" : ""}${nested ? " urow-nested" : ""}`} role="listitem">
      {opens ? (
        <button type="button" className="urow-open" aria-label={label} onClick={open}>
          {body}
        </button>
      ) : (
        <div className="urow-open" tabIndex={-1} aria-label={label}>
          {body}
        </div>
      )}
      {row.version && !dim && (
        <span className="urow-acts">
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
        </span>
      )}
      <span className="urow-meta">
        {!dim &&
          (row.urgency === "forYou" && row.count > 0 ? (
            <Badge count={row.count} says={needsYou(row.count)} />
          ) : (
            <span className="side-dot">
              <span className="sr-only">new</span>
            </span>
          ))}
        <span className="floor-time" title={row.at ? dayClock(row.at, now) : undefined}>
          {time}
        </span>
      </span>
      {dim
        ? row.unread && (
            <button type="button" className="link urow-toggle" aria-label={`Mark ${title} unread`} onClick={() => void markUnread(row.place, row.unread!)}>
              Mark unread
            </button>
          )
        : !row.version && (
            <button type="button" className="link urow-toggle" aria-label={`Mark ${title} read`} onClick={() => onRead(row)}>
              Mark read
            </button>
          )}
    </div>
  );
}

/** A section of the page, as the Floor's cards are. */
function Card({
  label,
  tone,
  count,
  children,
  after,
  busy,
}: {
  label: string;
  tone: "blocked" | "working" | "muted" | "faint";
  count?: number;
  children: ReactNode;
  /** Below the list: what it says when empty, Show more. */
  after?: ReactNode;
  busy?: boolean;
}) {
  return (
    <section className="floor-card unread-card" aria-label={label} aria-busy={busy || undefined}>
      <h2 className={`ov-label ${tone === "muted" || tone === "faint" ? tone : `state-${tone}`}`}>
        {label}
        {count ? ` · ${count}` : ""}
      </h2>
      <div className="unread-list" role="list" aria-label={label} tabIndex={-1}>
        {children}
      </div>
      {after}
    </section>
  );
}

/** Nothing new and nothing needing you. */
function CaughtUp() {
  return (
    <div className="unread-empty" role="status">
      <svg className="unread-empty-art" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
        <circle cx="28" cy="28" r="26" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
        <circle cx="28" cy="28" r="18" fill="currentColor" opacity="0.12" />
        <path d="M20 28.5l5.5 5.5L37 22.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h2 className="display-md">You’re all caught up</h2>
      <p className="muted">New messages, answers and reports from every workspace show up here.</p>
    </div>
  );
}

/** Moves focus between the page's rows (j/k, the arrows, Home, End), and
 *  marks the one in focus read or unread (e), from anywhere on the page
 *  but a field, and from nowhere in particular. */
function useRowKeys(page: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = page.current;
      const at = e.target as HTMLElement | null;
      if (!el || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (at && at !== document.body && !el.contains(at)) return;
      if (at?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='menu']")) return;
      const items = [...el.querySelectorAll<HTMLElement>(NAV)];
      const row = at?.closest(ROW);
      const i = row ? items.findIndex((x) => row.contains(x)) : -1;
      const go = (to: number) => {
        e.preventDefault();
        items[Math.max(0, Math.min(items.length - 1, to))]?.focus();
      };
      switch (e.key) {
        case "j":
        case "ArrowDown":
          return go(i + 1);
        case "k":
        case "ArrowUp":
          return go(i < 0 ? 0 : i - 1);
        case "Home":
          return go(0);
        case "End":
          return go(items.length - 1);
        case "e": {
          const toggle = row?.querySelector<HTMLButtonElement>(".urow-toggle");
          if (!toggle) return;
          e.preventDefault();
          toggle.click();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page]);
}

/** The Unread page. */
export function Unread() {
  const now = useMinute();
  const needs = useNeeds();
  const local = useLocalUnread();
  const localAt = useUnread((s) => s.localAt);
  const dms = useUnreadDms();
  const connected = useDesk((s) => s.connected);
  const rooms = useDesk((s) => s.rooms);
  const timelines = useDesk((s) => s.timelines);
  const drafts = useDesk((s) => s.roomDrafts);
  const keys = useSettings((s) => s.keys);
  const fail = useDesk((s) => s.fail);
  const rows = useUnreadRows();
  const page = useRef<HTMLElement>(null);
  useRowKeys(page);
  // A row read during this visit stays, dimmed, until you leave, so Mark
  // unread is still at hand.
  const [kept, setKept] = useState<UnreadRow[]>(rows);
  useEffect(() => setKept((was) => [...rows, ...was.filter((r) => !rows.some((x) => x.key === r.key))]), [rows]);
  const live = new Set(rows.map((r) => r.key));
  const [shown, setShown] = useState(PAGE);
  const [undo, setUndo] = useState<{ count: number; run: () => Promise<void> } | null>(null);

  // What's on its way: what failed or stopped needs you, above.
  const flight = flightRows(rooms, [], onTheirWay(drafts), [], timelines);
  const stuck = stuckOf(drafts);
  const needing = needs.length + stuck.length;
  // Counted yet, from the hub or from what it last said.
  const counted = local !== null || localAt !== null;
  const loading = connected && !counted;
  const away = !connected && !counted;
  const caughtUp = counted && rows.length === 0 && needing === 0;

  const readRow = (r: UnreadRow) => void advance(r.place, r.read).catch(fail);
  const markAll = async () => {
    const count = rows.reduce((n, r) => n + Math.max(1, r.count), 0);
    try {
      const run = await markEverythingRead(dms, local?.floor ?? null);
      setUndo({ count, run });
    } catch (e) {
      fail(e);
    }
  };

  const said = [needing ? needsYou(needing) : "", rows.length ? `${rows.length} unread` : ""].filter(Boolean).join(" · ");
  const summary = loading ? "Reading what’s new…" : away ? "Waiting for this computer’s hub" : said || "Nothing new";
  const list = rows.length ? kept : [];
  const groups = groupRows(list, rooms);
  const readNow = rows.length ? [] : kept;

  const rowsOf = (gs: ReturnType<typeof groupRows>) =>
    gs.map((g) =>
      g.room ? (
        <div key={g.key} className="urow-group" role="listitem">
          <div className="urow-group-head">
            <RoomMark />
            <b className="urow-title">{g.room.name}</b>
            <span className="urow-where">Room</span>
          </div>
          <div role="list" aria-label={g.room.name}>
            {g.rows.map((r) => (
              <Row key={r.key} row={r} dim={!live.has(r.key)} now={now} nested onRead={readRow} />
            ))}
          </div>
        </div>
      ) : (
        <Row key={g.key} row={g.rows[0]!} dim={!live.has(g.rows[0]!.key)} now={now} onRead={readRow} />
      ),
    );

  return (
    <main ref={page} className="room unread-page" aria-label="Unread">
      <header className="unread-head">
        <div className="unread-title">
          <h1 className="display-lg">Unread</h1>
          <span className="floor-summary" title={`Everything new for you, on every workspace · ${shortcutLabel(keys.unread)}`}>
            {summary}
            {!connected && localAt ? <span className="chip unread-asof">as of {dayClock(localAt, now)}</span> : null}
          </span>
        </div>
        <span className="room-head-actions">
          {undo && (
            <span className="muted small" role="status">
              Marked {undo.count} read ·{" "}
              <button
                type="button"
                className="link unread-undo"
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
      <div className="unread-scroll">
        {needing > 0 && (
          <Card label="Needs you" tone="blocked" count={needing}>
            {needs.map((n) => (
              <div key={n.key} role="listitem">
                <NeedRow need={n} now={now} actions />
              </div>
            ))}
            {stuck.map(({ room, draft }) => (
              <StuckRow key={draft.id} room={room} draft={draft} />
            ))}
          </Card>
        )}
        {caughtUp && <CaughtUp />}
        {away && (
          <div className="unread-empty" role="status">
            <h2 className="display-md">Waiting for the hub</h2>
            <p className="muted">Desk can’t reach this computer’s hub yet, so it can’t say what’s unread. It shows here as soon as the hub answers.</p>
          </div>
        )}
        {loading && (
          <Card label="Unread" tone="muted" busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="urow urow-skeleton" aria-hidden="true">
                <span className="mark mark-sm" />
                <span className="urow-body">
                  <span className="urow-bar" />
                  <span className="urow-bar urow-bar-short" />
                </span>
              </div>
            ))}
          </Card>
        )}
        {counted && !caughtUp && (
          <Card
            label="Unread"
            tone="muted"
            count={rows.length}
            after={
              <>
                {rows.length === 0 && <p className="muted unread-none">Nothing unread.</p>}
                {groups.length > shown && (
                  <button type="button" className="link unread-more" onClick={() => setShown((n) => n + PAGE)}>
                    Show {plural(Math.min(PAGE, groups.length - shown), "more place", "more places")}
                  </button>
                )}
              </>
            }
          >
            {rowsOf(groups.slice(0, shown))}
          </Card>
        )}
        {readNow.length > 0 && (
          <Card label="Read just now" tone="faint">
            {rowsOf(groupRows(readNow, rooms))}
          </Card>
        )}
        {flight.length > 0 && (
          <Card label="In flight" tone="working" count={flight.length}>
            {flight.map((r) => (
              <FlightLine key={r.key} row={r} now={now} />
            ))}
          </Card>
        )}
      </div>
    </main>
  );
}
