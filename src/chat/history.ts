import type { DeskExtras } from "../hub/types";
import { preview } from "../preview";
import type { Attachment, Author, ChatMessage, DeskMark, HubAccount } from "./types";
import { hubFetch } from "../hub/net";

/** One message of a Desk conversation as the hub keeps it. */
export interface HubMessage {
  id: string;
  from: string;
  text?: string;
  /** What the live channel calls the text, should a hub send it so. */
  content?: string;
  at?: string;
  /** What an overseer's message mentions to act on in place. */
  desk?: DeskExtras;
  /** Who said it; an older hub doesn't say. */
  author?: Partial<Author> | null;
  /** Its place in the conversation: room, thread, why it was delivered. */
  mark?: DeskMark | null;
  attachments?: Attachment[];
}

export interface HistoryPage {
  /** Oldest first. */
  messages: ChatMessage[];
  /** Whether there is more before the first of them. */
  more: boolean;
}

export const PAGE = 200;

const KINDS: readonly string[] = ["you", "overseer", "agent"];

/** `a` as an author Desk can show, if it is one. */
export const authorOf = (a: Partial<Author> | null | undefined): Author | null =>
  a && typeof a.kind === "string" && KINDS.includes(a.kind)
    ? { kind: a.kind, id: typeof a.id === "string" ? a.id : "", name: typeof a.name === "string" ? a.name : "" }
    : null;

/** The text of a kept message. */
export const textOf = (m: HubMessage): string => m.text ?? m.content ?? "";

const fromHub = (m: HubMessage): ChatMessage => {
  const author = authorOf(m.author);
  return {
    id: m.id,
    role: m.from === "user" ? "user" : "assistant",
    content: textOf(m),
    at: m.at ?? "",
    status: "complete",
    tools: [],
    ...(m.desk && m.from !== "user" ? { desk: m.desk } : {}),
    ...(author ? { author } : {}),
    ...(m.mark?.delivery ? { delivery: m.mark.delivery } : {}),
    ...(m.mark?.request_id ? { requestId: m.mark.request_id } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  };
};

const shown = (m: ChatMessage): boolean =>
  m.content.trim() !== "" || !!(m.desk?.approvals?.length || m.desk?.suggestions?.length) || !!m.attachments?.length || !!m.requestId;

/** Where a page of a conversation is read from: a Desk channel (the DM
 *  unless said), and the messages before or after one. */
export interface PageAt {
  channel?: string;
  before?: string;
  after?: string;
  limit?: number;
}

/** A page of your conversation with an agent on a Desk channel, as the hub
 *  keeps it. Null where the hub doesn't keep it for Desk (an older hub, or
 *  one that won't share it with this device). Anything else that goes
 *  wrong throws. */
export async function readConversation(
  hub: HubAccount,
  agentId: string,
  at: PageAt = {},
): Promise<{ messages: HubMessage[]; more: boolean } | null> {
  const url = new URL(`/api/desk/conversations/${encodeURIComponent(agentId)}`, hub.url);
  url.searchParams.set("limit", String(at.limit ?? PAGE));
  if (at.channel) url.searchParams.set("channel", at.channel);
  if (at.before) url.searchParams.set("before", at.before);
  if (at.after) url.searchParams.set("after", at.after);
  const res = await hubFetch(url, { headers: { authorization: `Bearer ${hub.token}` } });
  if (absent(res)) return null;
  if (!res.ok) throw new Error(`history: ${res.status}`);
  const body = (await res.json()) as { messages?: HubMessage[]; more?: boolean };
  return { messages: (body.messages ?? []).filter((m) => m && typeof m.id === "string"), more: body.more ?? false };
}

/** Whether `res` says the hub has no such route: an older one (which
 *  answers a route it doesn't have with its web page), or one that won't
 *  share it with this device. */
export const absent = (res: Response): boolean =>
  [401, 403, 404, 405].includes(res.status) || (res.ok && !(res.headers.get("content-type") ?? "").includes("json"));

/** A page of your DM with an agent, from before message `before` (the
 *  latest when not given). Null where the hub doesn't keep DMs for Desk:
 *  the conversation starts empty there, as it always has. */
export async function fetchHistory(hub: HubAccount, agentId: string, before?: string): Promise<HistoryPage | null> {
  const read = await readConversation(hub, agentId, { before });
  const page = read && { messages: read.messages.map(fromHub).filter(shown), more: read.more };
  if (!preview || before) return page;
  // The browser preview shows the overseer's DM of the design.
  const { devConversation } = await import("../devBridge");
  const extra = devConversation(agentId).map(fromHub);
  return extra.length ? { messages: [...(page?.messages ?? []), ...extra], more: page?.more ?? false } : page;
}

/** The id a page before or after `messages` can be read from: the first
 *  (or last) that is a message of the transcript, not a file of its own. */
export const cursorIn = (messages: readonly { id: string }[], end: "first" | "last"): string | undefined =>
  (end === "first" ? messages : [...messages].reverse()).find((m) => !m.id.startsWith(FILE_PREFIX))?.id;

/** A file the hub shows as a message of its own carries an id no
 *  transcript message has. */
export const FILE_PREFIX = "file:";

/** `earlier` put before `messages`, each message once. */
export const prepend = (earlier: ChatMessage[], messages: ChatMessage[]): ChatMessage[] => {
  const have = new Set(messages.map((m) => m.id));
  return [...earlier.filter((m) => !have.has(m.id)), ...messages];
};

const same = (a: ChatMessage, b: ChatMessage) => a.role === b.role && a.content.trim() === b.content.trim();

/** The conversation as shown: what the hub kept, then what arrived live,
 *  without the live messages the hub's copy already has. Those can only be
 *  ones that existed when the history was read (`loadedAt`), or answers the
 *  socket repeats before you've said anything; they're the start of the
 *  live list and the end of the history. */
export const withHistory = (history: ChatMessage[], all: ChatMessage[], loadedAt: string | null): ChatMessage[] => {
  if (history.length === 0) return all;
  // A message the hub sent live by its id (the overseer's) is the kept one.
  const kept = new Set(history.map((m) => m.id));
  const live = all.some((m) => kept.has(m.id)) ? all.filter((m) => !kept.has(m.id)) : all;
  let candidates = 0;
  while (candidates < live.length) {
    const m = live[candidates]!;
    const known = loadedAt !== null && m.at <= loadedAt && m.status === "complete";
    const echo = m.role === "assistant" && m.status === "complete" && !live.slice(0, candidates).some((x) => x.role === "user");
    if (!known && !echo) break;
    candidates++;
  }
  for (let k = Math.min(candidates, history.length); k > 0; k--) {
    const tail = history.slice(-k);
    if (tail.every((m, i) => same(m, live[i]!))) return [...history, ...live.slice(k)];
  }
  return [...history, ...live];
};

/** How far back in what the hub kept a live message is looked for. */
const LOOK_BACK = 50;

/** How much earlier than a live message the hub's copy of it may say it
 *  was (the hub's clock and this computer's need not agree). */
const SKEW_MS = 2 * 60_000;

/** Whether the hub's `k` could be the live `m`: it says the same, and isn't
 *  from well before `m` was. */
const copyOf = (k: ChatMessage, m: ChatMessage): boolean => {
  if (!same(k, m)) return false;
  const kt = Date.parse(k.at);
  const mt = Date.parse(m.at);
  return Number.isNaN(kt) || Number.isNaN(mt) || kt >= mt - SKEW_MS;
};

/** The live messages, finished by `before`, that `kept` (the hub's latest
 *  page, oldest first) now shows: matched in order from the end, so a reply
 *  the hub hasn't kept yet stays live, and an older one that says the same
 *  thing doesn't stand in for it. On a hub that streams answers by id
 *  (`streamed`), an answer is known by its id alone; what you said, which
 *  the hub keeps under an id of its own, is still matched by its text. */
export const covered = (kept: ChatMessage[], all: ChatMessage[], before: string, streamed = false): Set<string> => {
  // Those the hub sent live by their id are known by it; on a hub that
  // streams its answers by id, every answer is.
  const keptIds = new Set(kept.map((m) => m.id));
  const ids = new Set(all.filter((m) => keptIds.has(m.id)).map((m) => m.id));
  const live = all.filter((m) => !ids.has(m.id) && !(streamed && m.role === "assistant"));
  let j = kept.length - 1;
  for (let i = live.length - 1; i >= 0 && j >= 0; i--) {
    const m = live[i]!;
    if (m.status !== "complete" || m.at > before || m.role === "system") continue;
    for (let k = j; k >= Math.max(0, j - LOOK_BACK); k--) {
      if (copyOf(kept[k]!, m)) {
        ids.add(m.id);
        j = k - 1;
        break;
      }
    }
  }
  return ids;
};
