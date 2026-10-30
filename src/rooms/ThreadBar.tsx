import type { FloorNeed } from "../floor/merge";
import { useNeeds } from "../floor/store";
import { dayClock } from "../floor/time";
import type { RoomDraft } from "../hub/store";
import type { RoomMessage } from "../hub/types";
import { effective, useReads } from "../unread/reads";
import { useUnread } from "../unread/summary";
import { MemberMark } from "./MemberMark";
import { useAuthor } from "./names";
import { after } from "./time";

/** What's going on in a thread now, most pressing first. */
export type ThreadLive = { kind: "needs" | "answering" | "queued" | "failed"; text: string } | null;

const listed = (names: string[]) => [...new Set(names)].join(", ");

/** Someone needs you there (a Floor need or a draft's prompt), else who is
 *  answering, who's queued, whose answer failed. */
export const threadLive = (
  drafts: readonly RoomDraft[],
  needs: readonly FloorNeed[],
  room: string,
  thread: string,
  name: (member: string) => string,
): ThreadLive => {
  const here = needs.filter((n) => n.place.kind === "room" && n.place.room === room && n.place.thread === thread);
  const asking = [...here.map((n) => n.who.name), ...drafts.filter((d) => d.prompts.length).map((d) => name(d.member))];
  if (asking.length) return { kind: "needs", text: `${listed(asking)} ${new Set(asking).size === 1 ? "needs" : "need"} you` };
  const answering = drafts.filter((d) => d.state === "live" || d.state === "stalled").map((d) => name(d.member));
  if (answering.length) return { kind: "answering", text: `${listed(answering)} ${new Set(answering).size === 1 ? "is" : "are"} answering…` };
  const queued = drafts.filter((d) => d.state === "queued" || d.state === "connecting" || d.state === "busy").map((d) => name(d.member));
  if (queued.length) return { kind: "queued", text: `Queued for ${listed(queued)}` };
  const failed = drafts.filter((d) => d.state === "failed" || d.state === "stopped" || d.state === "interrupted").map((d) => name(d.member));
  if (failed.length) return { kind: "failed", text: `${listed(failed)}’s answer failed` };
  return null;
};

/** "4 replies · last 14:32", or "Reply in thread" with none. */
export const repliesText = (n: number, lastAt: string | null | undefined): string =>
  n ? `${n} repl${n === 1 ? "y" : "ies"}${lastAt ? ` · last ${dayClock(lastAt)}` : ""}` : "Reply in thread";

/** A thread's bar: who replied, how many and when last, and what's going
 *  on in it; bold while its latest reply is unread. As a button under its
 *  first message, or the thread column's header. */
export function ThreadBar({
  room,
  parent,
  count,
  drafts,
  authors,
  onOpen,
}: {
  room: string;
  parent: RoomMessage;
  count: number;
  drafts: readonly RoomDraft[];
  /** Who wrote its replies, latest first. */
  authors: readonly string[];
  onOpen?: () => void;
}) {
  const author = useAuthor();
  const needs = useNeeds();
  const point = useReads((s) => s.local[`thread:${room}/${parent.id}`]);
  const floor = useUnread((s) => s.local?.floor);
  const read = effective(point, floor);
  const unread = !!parent.lastReplyAt && !!read && after({ createdAt: parent.lastReplyAt }, read.at);
  const live = threadLive(drafts, needs, room, parent.id, (m) => author(m).name);
  const inner = (
    <>
      {authors.length > 0 && (
        <span className="thread-marks">
          {authors.map((a) => (
            <MemberMark key={a} member={a} name={author(a).name} size="xs" />
          ))}
        </span>
      )}
      <span className="thread-count">{repliesText(count, parent.lastReplyAt)}</span>
      {live && <span className={`thread-live thread-${live.kind}`}>· {live.text}</span>}
    </>
  );
  return onOpen ? (
    <button type="button" className={`thread-bar small${unread ? " thread-unread" : ""}`} onClick={onOpen}>
      {inner}
    </button>
  ) : (
    <span className={`thread-bar thread-bar-head small${unread ? " thread-unread" : ""}`}>{inner}</span>
  );
}
