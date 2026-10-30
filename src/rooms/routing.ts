import type { Agent, DeskLine, HubAccount } from "../chat/types";
import type { Room, RoomMessage } from "../hub/types";
import { resolveMentions } from "./mentions";
import { byTime } from "./time";

export interface RoomMember {
  hub: string;
  agent: string;
}

export const memberKey = (m: RoomMember): string => `${m.hub}/${m.agent}`;

/** The member a message's author key (`hub/agent`) names; none for you or
 *  Desk. */
export const memberOf = (author: string): RoomMember | null => {
  const [hub, agent, ...rest] = author.split("/");
  return hub && agent && !rest.length ? { hub, agent } : null;
};

/** How many agent-to-agent hand-offs one ask may chain: the hub's
 *  `MAX_HOPS`, which it holds turns and room posts to. */
export const MAX_HOPS = 3;

/** The channel a room's agents' conversations are on: its own, frozen when
 *  it was made, or its slug's on a hub too old to say. */
export const roomChannel = (room: Pick<Room, "channel" | "slug">): string => room.channel ?? `desk:${room.slug}`;

/** Members a message addresses: every member an `@name` (or `@name@hub`)
 *  names, else the room's default member. Never anyone outside the room:
 *  bringing someone in is yours to do (`say`), not an agent's. */
export const addressees = (
  text: string,
  members: RoomMember[],
  roster: Agent[],
  defaultMember: string | null,
  exclude?: string,
  hubs: readonly HubAccount[] = [],
): RoomMember[] => {
  const hit = resolveMentions(text, members, roster, hubs).members;
  const chosen = hit.length ? hit : members.filter((m) => memberKey(m) === defaultMember);
  return chosen.filter((m) => memberKey(m) !== exclude);
};

/** What a member is sent by a hub that takes no structured turns: who said
 *  it and where, so a per-room conversation reads as the room. */
export const relay = (room: string, from: string, text: string): string => `[#${room}] ${from}: ${text}`;

/** The bounds of a turn's thread lines: the hub's own, so it never cuts
 *  them again (`CONTEXT_BYTES` as UTF-8, rendered `from: text`). */
export const CONTEXT_LINES = 12;
export const LINE_CHARS = 500;
export const NAME_CHARS = 100;
export const CONTEXT_BYTES = 4_000;

const clip = (text: string, max: number): string => [...text.trim()].slice(0, max).join("");

const utf8 = new TextEncoder();

/** The thread lines a member is asked with: what was said in the thread
 *  (or the main timeline) since the member last spoke there, and the
 *  thread's first message when that's further back, newest kept within
 *  the bounds. `exclude` is the message being asked; `nameOf` says who
 *  wrote a message. */
export const contextFor = (
  timeline: readonly RoomMessage[],
  member: string,
  threadId: string | null,
  exclude: string | null,
  nameOf: (author: string) => string,
): DeskLine[] => {
  const here = timeline
    .filter((m) => (m.threadId ?? null) === threadId && m.id !== exclude)
    .sort(byTime);
  const last = here.map((m) => m.author).lastIndexOf(member);
  const window = here.slice(last + 1);
  const root = threadId ? timeline.find((m) => m.id === threadId && m.id !== exclude) : undefined;
  const line = (m: RoomMessage): DeskLine => ({ from: clip(nameOf(m.author), NAME_CHARS), text: clip(m.content, LINE_CHARS) });
  const size = (l: DeskLine) => utf8.encode(l.from).length + 2 + utf8.encode(l.text).length;
  const lines = window.map(line).filter((l) => l.text);
  const first = root && line(root).text ? line(root) : null;
  const budget = { lines: CONTEXT_LINES - (first ? 1 : 0), bytes: CONTEXT_BYTES - (first ? size(first) : 0) };
  const kept: DeskLine[] = [];
  for (const l of [...lines].reverse()) {
    if (kept.length >= budget.lines || budget.bytes < size(l)) break;
    budget.bytes -= size(l);
    kept.unshift(l);
  }
  return first ? [first, ...kept] : kept;
};
