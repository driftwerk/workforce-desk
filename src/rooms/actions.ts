import type { Room, RoomMessage } from "../hub/types";
import { memberKey, memberOf, type RoomMember } from "./routing";

// What can be done with a room message, in the order its menu lists them:
// the first three also show on its hover bar.

export type ActionId =
  | "thread"
  | "copyText"
  | "copyLink"
  | "askSomeone"
  | "askAgain"
  | "postToRoom"
  | "markUnread"
  | "dm"
  | "makeLead"
  | "removeFromRoom";

export interface Action {
  id: ActionId;
  label: string;
  key?: string;
  danger?: boolean;
}

/** How many of a message's actions show on its hover bar. */
export const ON_BAR = 3;

/** The actions room message `m` offers, in menu order. `name` is its
 *  author's, `member` the room member who wrote it (none for you, Desk, or
 *  one who has left). */
export const actionsFor = (m: RoomMessage, ctx: { inThread: boolean; room: Room; name: string }): Action[] => {
  const author = memberOf(m.author);
  const member: RoomMember | null = author && ctx.room.members.some((x) => memberKey(x) === m.author) ? author : null;
  const all: (Action | false)[] = [
    !ctx.inThread && (m.copyOf ? { id: "thread", label: "View thread" } : { id: "thread", label: "Reply in thread", key: "T" }),
    { id: "copyText", label: "Copy text" },
    { id: "askSomeone", label: "Ask…" },
    { id: "copyLink", label: "Copy link" },
    !!member && !!m.inReplyTo && { id: "askAgain", label: "Ask again" },
    ctx.inThread && !!m.threadId && !m.copyOf && !m.postedToRoom && { id: "postToRoom", label: "Post to room" },
    { id: "markUnread", label: "Mark unread from here", key: "Alt+click" },
    !!author && { id: "dm", label: `Message ${ctx.name}` },
    !!member && ctx.room.defaultMember !== m.author && { id: "makeLead", label: "Make lead" },
    !!member && { id: "removeFromRoom", label: "Remove from room", danger: true },
  ];
  return all.filter((a): a is Action => !!a);
};

/** Quoting `m` to ask someone about it: its first six lines, as `>` lines,
 *  under who said it. */
export const quoteFor = (m: Pick<RoomMessage, "content">, name: string): string => {
  const lines = m.content.trim().split("\n");
  const kept = lines.slice(0, 6).map((l) => `> ${l}`);
  if (lines.length > 6) kept.push("> …");
  return `> **${name}:** \n${kept.join("\n")}`;
};
