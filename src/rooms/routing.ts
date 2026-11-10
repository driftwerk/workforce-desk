import type { Agent, DeskLine, DeskMember, HubAccount } from "../chat/types";
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

/** One line of a name, whoever chose it: no line breaks or control
 *  characters to start a line of its own, clipped. */
export const defang = (name: string, max = NAME_CHARS): string =>
  clip(name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " "), max);

/** How many members a room turn names. */
export const ROSTER_MAX = 24;

/** A room's members as a turn names them, each name made safe. */
export const rosterOf = (members: readonly DeskMember[]): DeskMember[] =>
  members.slice(0, ROSTER_MAX).map((m) => ({ name: defang(m.name), hub: defang(m.hub), lead: m.lead }));

/** The room's members, in Desk's words, as one line for a hub that takes no
 *  roster: who is there, that @name reaches them, and whose the room is. */
export const rosterLine = (members: readonly DeskMember[]): DeskLine => ({
  from: "Desk",
  text: clip(
    `In this room: ${rosterOf(members)
      .map((m) => `${m.name} (${m.hub}${m.lead ? ", lead" : ""})`)
      .join(", ")}. @name reaches any of them; the person decides who is in the room.`,
    LINE_CHARS,
  ),
});

const sizeOf = (l: DeskLine) => utf8.encode(l.from).length + 2 + utf8.encode(l.text).length;

/** The lines a member is asked with: the newest said in the thread (or the
 *  main timeline), whoever said them, other agents and the member included,
 *  and the thread's first message when that's further back, within the
 *  hub's bounds. A member keeps no copy of these (its conversation keeps
 *  only what it was asked), so each ask carries them again, never only
 *  those since it last spoke: an answer it gave alongside another's would
 *  hide the other's from it for good. `exclude` is the message being asked;
 *  `nameOf` says who wrote a message; `last` (the roster, on a hub that
 *  takes none) goes after them, within the same bounds. */
export const contextFor = (
  timeline: readonly RoomMessage[],
  threadId: string | null,
  exclude: string | null,
  nameOf: (author: string) => string,
  last?: DeskLine,
): DeskLine[] => {
  const here = timeline
    .filter((m) => (m.threadId ?? null) === threadId && m.id !== exclude && m.id !== threadId)
    .sort(byTime);
  const root = threadId ? timeline.find((m) => m.id === threadId && m.id !== exclude) : undefined;
  const line = (m: RoomMessage): DeskLine => ({ from: clip(nameOf(m.author), NAME_CHARS), text: clip(m.content, LINE_CHARS) });
  const lines = here.map(line).filter((l) => l.text);
  const first = root && line(root).text ? line(root) : null;
  const fixed = [first, last].filter((l): l is DeskLine => !!l);
  const budget = { lines: CONTEXT_LINES - fixed.length, bytes: CONTEXT_BYTES - fixed.reduce((n, l) => n + sizeOf(l), 0) };
  const kept: DeskLine[] = [];
  for (const l of [...lines].reverse()) {
    if (kept.length >= budget.lines || budget.bytes < sizeOf(l)) break;
    budget.bytes -= sizeOf(l);
    kept.unshift(l);
  }
  return [...(first ? [first] : []), ...kept, ...(last ? [last] : [])];
};

/** How many of the room's lines go with a message to a hub that takes no
 *  structured turns: its conversation keeps each message whole, lines and
 *  all, so only a few. */
export const LEGACY_LINES = 6;

/** What a hub that takes no structured turns is sent: the room's newest
 *  lines and its members, each as the room says it, then the message. */
export const legacyAsk = (room: string, from: string, text: string, lines: readonly DeskLine[]): string =>
  [...lines.slice(-LEGACY_LINES).map((l) => relay(room, l.from, l.text)), relay(room, from, text)].join("\n");
