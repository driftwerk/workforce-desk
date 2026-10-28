import type { Agent, HubAccount } from "../chat/types";
import type { RoomMember } from "./routing";

/** How a name is written after `@`: "Release Captain" → "release-captain". */
export const handle = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_.-]/gu, "")
    .replace(/^[.-]+|[.-]+$/g, "");

const HANDLE = String.raw`[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*`;

/** `@name` or `@name@hub`, at the start or after something that isn't part
 *  of a word (so `kings@example.com` isn't one); a full stop or comma after
 *  it isn't part of the name. */
const MENTION = new RegExp(String.raw`(?<![\p{L}\p{N}_@.])@(${HANDLE})(?:@(${HANDLE}))?`, "gu");

export interface Mention {
  name: string;
  hub?: string;
}

export const parseMentions = (text: string): Mention[] =>
  [...text.matchAll(MENTION)].map((x) => ({ name: x[1]!.toLowerCase(), hub: x[2]?.toLowerCase() }));

const hubLabel = (hubs: readonly HubAccount[], id: string) => hubs.find((h) => h.id === id)?.label;

/** Whether `m` names `a`: by name or id, and by its hub's id or name when
 *  it says one. */
export const names = (m: Mention, a: Agent, hubs: readonly HubAccount[] = []): boolean => {
  if (m.name !== handle(a.name) && m.name !== a.id.toLowerCase() && m.name !== handle(a.id)) return false;
  if (!m.hub) return true;
  const label = hubLabel(hubs, a.hubId);
  return m.hub === a.hubId.toLowerCase() || (!!label && m.hub === handle(label));
};

/** What picking `a` writes after `@`: their name, with their workspace
 *  when someone else in the crew shares it. */
export const mentionFor = (a: Agent, roster: readonly Agent[], hubs: readonly HubAccount[]): string => {
  const own = handle(a.name) || handle(a.id);
  const shared = roster.some((o) => (o.hubId !== a.hubId || o.id !== a.id) && names({ name: own }, o, hubs));
  if (!shared) return own;
  const label = hubLabel(hubs, a.hubId);
  const hub = label && handle(label);
  // A label two hubs share can't tell them apart; their ids can.
  const labelUnique = !!hub && hubs.filter((h) => handle(h.label) === hub).length === 1;
  return `${own}@${labelUnique ? hub : a.hubId.toLowerCase()}`;
};

export interface Resolved {
  /** Members a message names. */
  members: RoomMember[];
  /** Crew it names who aren't in the room yet. */
  outsiders: Agent[];
  /** Mentions that could be more than one of the crew, none of them here. */
  ambiguous: string[];
}

const isMember = (members: readonly RoomMember[], a: Agent) => members.some((m) => m.hub === a.hubId && m.agent === a.id);

/** Who a message names, among the room's members and the rest of the crew.
 *  A member answers to their own name or id even when the roster hasn't
 *  listed them. */
export const resolveMentions = (
  text: string,
  members: readonly RoomMember[],
  roster: readonly Agent[],
  hubs: readonly HubAccount[] = [],
): Resolved => {
  const known = (m: RoomMember): Agent =>
    roster.find((a) => a.hubId === m.hub && a.id === m.agent) ?? {
      hubId: m.hub,
      id: m.agent,
      name: m.agent,
      model: null,
      provider: null,
      isDefault: false,
    };
  const out: Resolved = { members: [], outsiders: [], ambiguous: [] };
  for (const mention of parseMentions(text)) {
    const here = members.filter((m) => names(mention, known(m), hubs));
    if (here.length) {
      for (const m of here) if (!out.members.some((x) => x.hub === m.hub && x.agent === m.agent)) out.members.push(m);
      continue;
    }
    const crew = roster.filter((a) => !isMember(members, a) && names(mention, a, hubs));
    if (crew.length === 1) {
      const a = crew[0]!;
      if (!out.outsiders.some((x) => x.hubId === a.hubId && x.id === a.id)) out.outsiders.push(a);
    } else if (crew.length > 1 && !out.ambiguous.includes(mention.name)) out.ambiguous.push(mention.name);
  }
  return out;
};

/** The `@…` being typed at `caret`, if any: where it starts and what's
 *  been typed after the `@`. */
export const mentionAt = (text: string, caret: number): { start: number; query: string } | null => {
  const before = text.slice(0, caret);
  const m = before.match(/(?:^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}_.-]*)$/u);
  if (!m) return null;
  return { start: caret - m[1]!.length - 1, query: m[1]!.toLowerCase() };
};

/** Crew to offer for `query`: whose name (any word of it) or id starts
 *  with it; members first, then the rest by name. */
export const suggestions = (query: string, roster: readonly Agent[], members: readonly RoomMember[], limit = 8): Agent[] => {
  const q = query.toLowerCase();
  const fits = (a: Agent) =>
    !q ||
    handle(a.name).startsWith(q) ||
    a.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ||
    a.id.toLowerCase().startsWith(q);
  return roster
    .filter(fits)
    .sort((a, b) => Number(isMember(members, b)) - Number(isMember(members, a)) || a.name.localeCompare(b.name))
    .slice(0, limit);
};

/** `text` with the `@…` from `start` to `caret` replaced by a mention of
 *  `token`, and where the caret goes after it. */
export const insertMention = (text: string, start: number, caret: number, token: string): { text: string; caret: number } => {
  const after = text.slice(caret).replace(/^[\p{L}\p{N}_.-]*/u, "");
  const spaced = after.startsWith(" ") ? after : ` ${after}`;
  const head = `${text.slice(0, start)}@${token}`;
  return { text: head + spaced, caret: head.length + 1 };
};
