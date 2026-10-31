import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type UIEvent } from "react";
import { formAnswer } from "../chat/forms";
import type { ChatMessage } from "../chat/types";
import { useNeeds } from "../floor/store";
import { clock, dayName } from "../floor/time";
import { useDesk, type RoomDraft } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { useMainHidden, useStowed } from "../panels/Stage";
import { AT_NEWEST_PX, useAnchoredScroll, useFollowEnd } from "../restore/scroll";
import { useUi } from "../shell/ui";
import { inRoom } from "../unread/badges";
import { placeKey as readKey, type Place } from "../unread/places";
import { advance, effective, markRoomRead, markUnread, pointOf, unreadFrom, useReads } from "../unread/reads";
import { useSeen } from "../unread/seen";
import { useUnread } from "../unread/summary";
import { Draft } from "./Draft";
import { answerForm } from "./engine";
import { Message } from "./Message";
import { ThreadBar } from "./ThreadBar";
import { useAuthor } from "./names";
import { memberOf } from "./routing";
import { after } from "./time";
import { countsAsUnread, dividerBefore, jumpers, pill, setDivider, useDividers, type Pill } from "./unread";
import { isLive, ofPlace, placeKey, shown, type Window } from "./window";

// One timeline for a room's main messages and for each of its threads: what
// of the place is loaded without a gap, with a day before each day's first
// message, the answers on their way at its end, and an earlier page read as
// you reach its top. A reader scrolled up is never moved by what arrives.

export const asChat = (m: RoomMessage): ChatMessage => ({
  id: m.id,
  role: m.author === "you" ? "user" : m.author === "desk" ? "system" : "assistant",
  content: m.content,
  at: m.createdAt,
  status: "complete",
  tools: [],
  ...(m.delivery ? { delivery: m.delivery } : {}),
  ...(m.requestId ? { requestId: m.requestId } : {}),
  ...(m.attachments?.length ? { attachments: m.attachments } : {}),
});

/** The drafts on their way, by thread (the main timeline's under null),
 *  but not one whose answer is in already. */
export const draftsByThread = (drafts: readonly RoomDraft[], all: readonly RoomMessage[]): Map<string | null, RoomDraft[]> => {
  const posted = new Set(all.flatMap((m) => m.source ?? []));
  const by = new Map<string | null, RoomDraft[]>();
  for (const d of drafts) if (!(d.source && posted.has(d.source))) by.set(d.threadId, [...(by.get(d.threadId) ?? []), d]);
  return by;
};

/** Within this of the top, the earlier page is read. */
const EARLIER_PX = 80;
/** How long a message jumped to flashes. */
const FLASH_MS = 2_000;

const NO_DRAFTS: RoomDraft[] = [];
const NO_MESSAGES: RoomMessage[] = [];
const NO_AUTHORS: string[] = [];

/** A room message as the room shows it; a form an agent posted in it is
 *  answered to that agent, where the form is. Rendered again only when it
 *  changes, not as an answer streams in below it. */
export const RoomMessageView = memo(function RoomMessageView({ room, m, name, home }: { room: Room; m: RoomMessage; name: string; home?: string }) {
  const submitForm = useCallback(
    (summary: string, values: Record<string, unknown>): boolean => {
      if (!memberOf(m.author)) return false;
      void answerForm(room, m, formAnswer(summary, values)).catch(useDesk.getState().fail);
      return true;
    },
    [room, m],
  );
  const message = useMemo(() => asChat(m), [m]);
  const member = useMemo(() => memberOf(m.author), [m.author]);
  return (
    <Message
      message={message}
      author={name}
      authorKey={member ? m.author : undefined}
      home={home}
      origin={member ?? undefined}
      steps={m.steps}
      onSubmitForm={submitForm}
    />
  );
});

/** Whether a key pressed at `target` is being typed into something. */
const typing = (target: EventTarget): boolean =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

/** "Load earlier messages", while there's more before the window. */
function LoadEarlier({ state, onLoad }: { state: "loading" | "failed" | undefined; onLoad: () => void }) {
  return (
    <div className="history-note">
      {state === "failed" ? (
        <span className="faint small">
          Couldn’t load earlier messages.{" "}
          <button type="button" className="link small" onClick={onLoad}>
            Try again
          </button>
        </span>
      ) : (
        <button type="button" className="link small" disabled={state === "loading"} onClick={onLoad}>
          {state === "loading" ? "Loading earlier messages…" : "Load earlier messages"}
        </button>
      )}
    </div>
  );
}

/** The read place a room's main timeline or thread is. */
const readPlaceOf = (room: string, thread: string | null): Place => (thread ? { kind: "thread", room, thread } : { kind: "room", room });

/** Shift+Esc: the main timeline marks the room and all its threads read,
 *  a thread itself alone, and the New line goes. */
export function readAllHere(room: string, thread: string | null): void {
  const { timelines } = useDesk.getState();
  setDivider(placeKey(room, thread), null);
  if (!thread) {
    for (const key of Object.keys(useDividers.getState())) if (key.startsWith(`${room}/`)) setDivider(key, null);
    void markRoomRead(room).catch((e: unknown) => useDesk.getState().fail(e));
    return;
  }
  const newest = ofPlace(timelines[room] ?? [], thread).at(-1);
  const lastAt = useUnread.getState().local?.rooms.find((r) => r.roomId === room)?.threads.find((t) => t.parent.id === thread)?.unread.lastAt;
  const point = newest && (!lastAt || !after({ createdAt: lastAt }, newest.createdAt)) ? { at: newest.createdAt, message: newest.id } : lastAt ? { at: lastAt, message: null } : null;
  if (point) void advance(readPlaceOf(room, thread), point);
}

/** "3 new · Allan answered", "12 new since 09:14". */
const pillText = (p: Pill): string => (p.dir === "up" ? `${p.count} new since ${clock(p.since)}` : `${p.count} new${p.lead ? ` · ${p.lead} answered` : ""}`);

/** A room's main timeline (`thread` null) or one of its threads. */
export function Timeline({ room, thread }: { room: Room; thread: string | null }) {
  const all = useDesk((s) => s.timelines[room.id]) ?? NO_MESSAGES;
  const key = placeKey(room.id, thread);
  const window = useDesk((s) => s.windows[key]);
  const paging = useDesk((s) => s.paging[key]);
  const drafts = useDesk((s) => s.roomDrafts[room.id]) ?? NO_DRAFTS;
  const openThread = useUi((u) => u.roomThreads[room.id] ?? null);
  const setRoomThread = useUi((u) => u.setRoomThread);
  const flash = useUi((u) => u.flash);
  const author = useAuthor();
  const live = isLive(window);
  const readPlace = useMemo(() => readPlaceOf(room.id, thread), [room.id, thread]);
  const point = useReads((s) => s.local[readKey(readPlace)]);
  const readsLoaded = useReads((s) => s.loaded);
  const floor = useUnread((s) => s.local?.floor);
  const summary = useUnread((s) => {
    const r = s.local?.rooms.find((x) => x.roomId === room.id);
    return thread ? r?.threads.find((t) => t.parent.id === thread)?.unread : r?.main;
  });
  const readNow = effective(point, floor);
  const readAtOpen = useDividers((d) => d[key]);
  const hidden = useMainHidden();
  const stowed = useStowed();

  const messages = useMemo(() => shown(ofPlace(all, thread), window), [all, thread, window]);
  const parent = thread ? all.find((m) => m.id === thread) : undefined;
  const replies = useMemo(() => {
    const by = new Map<string, number>();
    for (const m of all) if (m.threadId) by.set(m.threadId, (by.get(m.threadId) ?? 0) + 1);
    return by;
  }, [all]);
  const byThread = useMemo(() => draftsByThread(drafts, all), [drafts, all]);
  // The Floor's needs placed in the room, read once for every thread's bar.
  const floorNeeds = useNeeds();
  const needs = useMemo(() => inRoom(floorNeeds, room.id), [floorNeeds, room.id]);
  const here = byThread.get(thread) ?? NO_DRAFTS;

  const anchorKey = thread ? null : `room:${room.id}`;
  const anchored = useAnchoredScroll<HTMLDivElement>(anchorKey);
  const followed = useFollowEnd(live, !(anchorKey && useUi.getState().anchors[anchorKey]));
  const { setAtEnd } = followed;
  const scroller = useRef<HTMLDivElement | null>(null);
  const pane = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      anchored(el);
      followed.pane(el);
    },
    [anchored, followed.pane],
  );
  // What you send shows: a message of yours new at the end of a live
  // window takes the view to the end, wherever it was.
  const mine = live ? messages.findLast((m) => m.author === "you")?.id : undefined;
  const sentLast = useRef(mine);
  useLayoutEffect(() => {
    if (mine === sentLast.current) return;
    sentLast.current = mine;
    if (mine && messages.at(-1)?.id === mine) setAtEnd(true);
  }, [mine, messages, setAtEnd]);
  // Where the reader was when an earlier page was asked for: the first row
  // in sight and how far down it sat (else the distance from the bottom),
  // so what's being read stays put as the page lands above it, whatever
  // arrives meanwhile.
  const hold = useRef<{ window: Window | undefined; distance: number; row: InSight | null } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const held = hold.current;
    if (!held) followed.follow();
    else if (el && held.window !== window) {
      const row = held.row && rowOf(el, held.row.id);
      if (row && held.row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - held.row.offset;
      else el.scrollTop = el.scrollHeight - held.distance;
      hold.current = null;
    }
  });

  // The New line stays where the place was read to when it was shown (once
  // the summary says where Desk began keeping points), and moves when Desk
  // comes back into focus with something unread.
  const floorKnown = floor !== undefined;
  useEffect(() => {
    if (!readsLoaded) return;
    setDivider(key, effective(pointOf(readPlace), useUnread.getState().local?.floor));
    const back = () => {
      const local = useUnread.getState().local;
      const r = local?.rooms.find((x) => x.roomId === room.id);
      const u = thread ? r?.threads.find((t) => t.parent.id === thread)?.unread : r?.main;
      if (u?.count) setDivider(key, effective(pointOf(readPlace), local?.floor));
    };
    globalThis.addEventListener("focus", back);
    return () => {
      globalThis.removeEventListener("focus", back);
      const { [key]: _gone, ...rest } = useDividers.getState();
      useDividers.setState(rest, true);
    };
  }, [readsLoaded, floorKnown, key, readPlace, room.id, thread]);

  const seenItems = useMemo(() => messages.map((m) => ({ id: m.id, at: m.createdAt })), [messages]);
  useSeen(readPlace, scroller, seenItems, { enabled: !(thread ? stowed : hidden) });

  // The last message showing, for what the pill counts below it.
  const [lastVisible, setLastVisible] = useState<string | null>(null);
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= AT_NEWEST_PX) return setLastVisible(lastRow(el));
    const bottom = el.getBoundingClientRect().bottom;
    let last: string | null = null;
    for (const r of el.querySelectorAll<HTMLElement>("[data-row]")) if (r.getBoundingClientRect().top < bottom) last = r.dataset.row ?? last;
    setLastVisible(last);
  }, []);
  // Measured as the messages change, the pane scrolls or resizes: not as
  // an answer streams in below them.
  useLayoutEffect(measure, [measure, messages]);
  const shownPill = pill({ shown: messages, read: readNow, lastVisible, window, unread: summary, name: (a) => author(a).name });
  const jump = useCallback(async () => {
    const desk = useDesk.getState();
    if (shownPill?.dir === "up" && summary?.first) {
      await desk.page(room.id, thread, { around: summary.first }).catch((e: unknown) => desk.fail(e));
      useUi.getState().setFlash(summary.first);
      return;
    }
    if (!live) await desk.toNewest(room.id, thread).catch((e: unknown) => desk.fail(e));
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      const rows = [...el.querySelectorAll<HTMLElement>("[data-row]")];
      const from = rows.findIndex((r) => r.dataset.row === lastVisible) + 1;
      const next = rows.slice(from).find((r) => r.dataset.unread !== undefined);
      if (next) next.scrollIntoView?.({ block: "start" });
      else el.scrollTop = el.scrollHeight;
    });
  }, [shownPill?.dir, summary?.first, live, room.id, thread, lastVisible]);
  useEffect(() => {
    jumpers.set(key, () => void jump());
    return () => void jumpers.delete(key);
  }, [key, jump]);

  // Alt+click: unread from here.
  const unreadHere = (e: MouseEvent, m: RoomMessage) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const i = messages.findIndex((x) => x.id === m.id);
    const p = unreadFrom(m, i > 0 ? messages[i - 1]! : null);
    void markUnread(readPlace, p);
    setDivider(key, p);
  };
  const divider = dividerBefore(messages, readAtOpen);
  const unreadNow = (m: RoomMessage) => countsAsUnread(m) && (!readNow || after(m, readNow.at));

  const more = window?.older.kind === "at";
  const earlier = () => {
    if (!more || paging === "loading") return;
    const el = scroller.current;
    if (el) hold.current = { window, distance: el.scrollHeight - el.scrollTop, row: firstInSight(el) };
    void useDesk
      .getState()
      .page(room.id, thread, "older")
      .catch(() => (hold.current = null));
  };
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop < EARLIER_PX && more && !paging) earlier();
    measure();
  };

  // A message jumped to scrolls to the middle and flashes, once: a timeline
  // shown again later leaves the reader where they were.
  const flashing =
    flash && Date.now() - flash.at < FLASH_MS && (messages.some((m) => m.id === flash.id) || parent?.id === flash.id) ? flash : null;
  useEffect(() => {
    const el = flashing && [...(scroller.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])].find((r) => r.dataset.row === flashing.id);
    if (!el) return;
    setAtEnd(false);
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("msg-flash");
    const t = setTimeout(() => el.classList.remove("msg-flash"), FLASH_MS);
    return () => {
      clearTimeout(t);
      el.classList.remove("msg-flash");
    };
  }, [flashing, setAtEnd]);

  // One message is reached with Tab, the last focused (else the newest);
  // the arrows move between them from there.
  const [current, setCurrent] = useState<string | null>(null);
  const tabTo = current && messages.some((m) => m.id === current) ? current : (messages.at(-1)?.id ?? null);
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-row]") : null;
    if (row?.dataset.row && row.dataset.row !== parent?.id) setCurrent(row.dataset.row);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (typing(e.target) || !(e.target instanceof Element)) return;
    const row = e.target.closest<HTMLElement>("[data-row]");
    if (!row) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
      const next = rows[rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      next.focus();
    } else if (!thread && e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setRoomThread(room.id, row.dataset.row!);
    }
  };

  let day = "";
  const dayBefore = (m: RoomMessage) => {
    const d = dayName(m.createdAt);
    const show = d && d !== day;
    day = d || day;
    return show ? (
      <div className="day-divider" role="separator">
        <span>{d}</span>
      </div>
    ) : null;
  };

  return (
    <div className="timeline">
      <div ref={pane} className="room-scroll" onScroll={onScroll} onKeyDown={onKeyDown} onFocus={onFocus}>
        <div ref={followed.list} className="room-list">
          {parent && (
            <>
              {dayBefore(parent)}
              <div className="room-msg" data-row={parent.id} tabIndex={-1}>
                <RoomMessageView room={room} m={parent} name={author(parent.author).name} />
              </div>
            </>
          )}
          {more && <LoadEarlier state={paging} onLoad={earlier} />}
          {messages.map((m) => {
            const a = author(m.author);
            const dayLine = dayBefore(m);
            const home = memberOf(m.author) ? a.home : undefined;
            const row = { "data-row": m.id, "data-unread": unreadNow(m) ? "" : undefined, tabIndex: m.id === tabTo ? 0 : -1, onClickCapture: (e: MouseEvent) => unreadHere(e, m) };
            const fresh = m.id === divider && (
              <div className="new-divider" role="separator" aria-label="New messages">
                <span>New</span>
              </div>
            );
            if (thread)
              return (
                <Fragment key={m.id}>
                  {dayLine}
                  {fresh}
                  <div className="room-msg" {...row}>
                    <RoomMessageView room={room} m={m} name={a.name} home={home} />
                  </div>
                </Fragment>
              );
            const n = m.replyCount ?? replies.get(m.id) ?? 0;
            const there = openThread === m.id ? NO_DRAFTS : (byThread.get(m.id) ?? NO_DRAFTS);
            return (
              <Fragment key={m.id}>
                {dayLine}
                {fresh}
                <div className="room-msg" {...row}>
                  <RoomMessageView room={room} m={m} name={a.name} home={home} />
                  <ThreadBar
                    room={room.id}
                    parent={m}
                    count={n}
                    drafts={there}
                    authors={m.replyAuthors ?? NO_AUTHORS}
                    needs={needs}
                    opens
                  />
                </div>
              </Fragment>
            );
          })}
          {live ? (
            here.map((d) => <Draft key={d.id} roomId={room.id} draft={d} name={author(d.member).name} />)
          ) : (
            <div className="history-note timeline-older" role="status">
              <span className="faint small">Viewing older messages · </span>
              <button
                type="button"
                className="link small"
                onClick={() => {
                  setAtEnd(true);
                  void useDesk
                    .getState()
                    .toNewest(room.id, thread)
                    .catch((e: unknown) => useDesk.getState().fail(e));
                }}
              >
                Jump to the newest
              </button>
            </div>
          )}
        </div>
      </div>
      {shownPill && (
        <button type="button" className="jump-pill" title="Jump to new messages" aria-live="polite" onClick={() => void jump()}>
          {pillText(shownPill)} <span aria-hidden="true">{shownPill.dir === "up" ? "↑" : "↓"}</span>
        </button>
      )}
    </div>
  );
}

/** The id of the last message row in `el`. */
const lastRow = (el: HTMLElement): string | null => {
  const rows = el.querySelectorAll<HTMLElement>("[data-row]");
  return rows[rows.length - 1]?.dataset.row ?? null;
};

/** A row in sight: its id, and how far below the pane's top it sits. */
type InSight = { id: string; offset: number };

/** The first message row in sight in `el`. */
const firstInSight = (el: HTMLElement): InSight | null => {
  const top = el.getBoundingClientRect().top;
  for (const r of el.querySelectorAll<HTMLElement>("[data-row]")) {
    const b = r.getBoundingClientRect();
    if (b.bottom > top && r.dataset.row) return { id: r.dataset.row, offset: b.top - top };
  }
  return null;
};

const rowOf = (el: HTMLElement, id: string): HTMLElement | undefined =>
  [...el.querySelectorAll<HTMLElement>("[data-row]")].find((r) => r.dataset.row === id);
