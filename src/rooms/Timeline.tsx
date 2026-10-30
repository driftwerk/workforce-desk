import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useCallback, type KeyboardEvent, type UIEvent } from "react";
import { formAnswer } from "../chat/forms";
import type { ChatMessage } from "../chat/types";
import { dayName } from "../floor/time";
import { useDesk, type RoomDraft } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { useAnchoredScroll, useFollowEnd } from "../restore/scroll";
import { useUi } from "../shell/ui";
import { Draft } from "./Draft";
import { answerForm } from "./engine";
import { Message } from "./Message";
import { useAuthor } from "./names";
import { memberOf } from "./routing";
import { isLive, ofPlace, placeKey, shown } from "./window";

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

/** Whether a draft's member is answering now, not waiting or stopped. */
const answering = (d: RoomDraft): boolean => d.state === "live" || d.state === "stalled";

/** Within this of the top, the earlier page is read. */
const EARLIER_PX = 80;
/** How long a message jumped to flashes. */
const FLASH_MS = 2_000;

const NO_DRAFTS: RoomDraft[] = [];
const NO_MESSAGES: RoomMessage[] = [];

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

  const messages = useMemo(() => shown(ofPlace(all, thread), window), [all, thread, window]);
  const parent = thread ? all.find((m) => m.id === thread) : undefined;
  const replies = useMemo(() => {
    const by = new Map<string, number>();
    for (const m of all) if (m.threadId) by.set(m.threadId, (by.get(m.threadId) ?? 0) + 1);
    return by;
  }, [all]);
  const byThread = useMemo(() => draftsByThread(drafts, all), [drafts, all]);
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
  // Distance from the bottom when an earlier page was asked for, so the
  // messages being read stay put as it lands above them.
  const hold = useRef<{ distance: number; before: readonly RoomMessage[] } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const held = hold.current;
    if (!held) followed.follow();
    else if (el && held.before !== messages) {
      el.scrollTop = el.scrollHeight - held.distance;
      hold.current = null;
    }
  });

  const more = window?.older.kind === "at";
  const earlier = () => {
    if (!more || paging === "loading") return;
    const el = scroller.current;
    if (el) hold.current = { distance: el.scrollHeight - el.scrollTop, before: messages };
    void useDesk
      .getState()
      .page(room.id, thread, "older")
      .catch(() => (hold.current = null));
  };
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop < EARLIER_PX && more && !paging) earlier();
  };

  // A message jumped to scrolls to the middle and flashes.
  const flashing = flash && (messages.some((m) => m.id === flash.id) || parent?.id === flash.id) ? flash : null;
  useEffect(() => {
    const el = flashing && [...(scroller.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])].find((r) => r.dataset.row === flashing.id);
    if (!el) return;
    setAtEnd(false);
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("msg-flash");
    const t = setTimeout(() => el.classList.remove("msg-flash"), FLASH_MS);
    return () => clearTimeout(t);
  }, [flashing, setAtEnd]);

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

  const names = (ds: RoomDraft[]) => [...new Set(ds.map((d) => author(d.member).name))];
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
    <div ref={pane} className="room-scroll" onScroll={onScroll} onKeyDown={onKeyDown}>
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
          const divider = dayBefore(m);
          const home = memberOf(m.author) ? a.home : undefined;
          if (thread)
            return (
              <Fragment key={m.id}>
                {divider}
                <div className="room-msg" data-row={m.id} tabIndex={-1}>
                  <RoomMessageView room={room} m={m} name={a.name} home={home} />
                </div>
              </Fragment>
            );
          const n = m.replyCount ?? replies.get(m.id) ?? 0;
          const there = openThread === m.id ? NO_DRAFTS : (byThread.get(m.id) ?? NO_DRAFTS);
          const replying = names(there.filter(answering));
          const stopped = names(there.filter((d) => d.state === "failed" || d.state === "interrupted" || d.state === "stopped"));
          return (
            <Fragment key={m.id}>
              {divider}
              <div className="room-msg" data-row={m.id} tabIndex={-1}>
                <RoomMessageView room={room} m={m} name={a.name} home={home} />
                <button type="button" className="link small thread-link" onClick={() => setRoomThread(room.id, m.id)}>
                  {n ? `${n} repl${n === 1 ? "y" : "ies"}` : "Reply in thread"}
                </button>
                {replying.length > 0 && (
                  <span className="small faint thread-replying">
                    {replying.join(", ")} {replying.length === 1 ? "is" : "are"} replying…
                  </span>
                )}
                {stopped.length > 0 && <span className="small state-blocked thread-replying">{stopped.join(", ")} couldn’t answer</span>}
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
              onClick={() =>
                void useDesk
                  .getState()
                  .toNewest(room.id, thread)
                  .catch((e: unknown) => useDesk.getState().fail(e))
              }
            >
              Jump to the newest
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
