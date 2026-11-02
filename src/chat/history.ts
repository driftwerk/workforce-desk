import type { DeskExtras } from "../hub/types";
import { preview } from "../preview";
import type { Attachment, Author, ChatMessage, DeskMark, HubAccount } from "./types";
import { refusal } from "../hub/client";
import { pairedHub } from "../hub/net";

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
    ...(m.attachments?.length ? { attachments: m.attachments.map(({ hub: _hub, agent: _agent, ...file }) => file) } : {}),
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
  const res = await pairedHub(hub).fetch("GET", `${url.pathname}${url.search}`);
  if (absent(res)) return null;
  if (!res.ok) throw await refusal(res);
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

const filesOf = (m: ChatMessage): readonly Attachment[] => m.attachments ?? [];

/** Whether the hub's `k` is the live `m`. A file's id says so whatever the
 *  words (the hub may redact them), and a copy without `m`'s files is not
 *  one: showing it would lose them. A person's message without files isn't
 *  one that has them. Anything else is known by who said what. */
const same = (k: ChatMessage, m: ChatMessage): boolean => {
  if (k.role !== m.role) return false;
  const files = filesOf(m);
  if (files.length > 0) return files.every((f) => filesOf(k).some((h) => h.artifact_id === f.artifact_id));
  if (m.role === "user" && filesOf(k).length > 0) return false;
  return k.content.trim() === m.content.trim();
};

/** How far back in what the hub kept a live message is looked for. */
const LOOK_BACK = 50;

/** How much earlier than a live message the hub's copy of it may say it
 *  was (the hub's clock and this computer's need not agree). */
const SKEW_MS = 2 * 60_000;

/** Whether `k` isn't from well before `m` was. */
const notEarlier = (k: ChatMessage, m: ChatMessage): boolean => {
  const kt = Date.parse(k.at);
  const mt = Date.parse(m.at);
  return Number.isNaN(kt) || Number.isNaN(mt) || kt >= mt - SKEW_MS;
};

/** Whether the hub's `k` could be the live `m`: `m`'s files say so, or it
 *  says the same and isn't from well before `m` was. */
const copyOf = (k: ChatMessage, m: ChatMessage): boolean =>
  same(k, m) && (filesOf(m).length > 0 || notEarlier(k, m));

/** Whether the hub's `k` is the live `m` as a hub that doesn't return a
 *  person's files keeps it: the same words, without the files. */
const twinOf = (k: ChatMessage, m: ChatMessage): boolean =>
  k.role === m.role &&
  filesOf(m).length > 0 &&
  filesOf(k).length === 0 &&
  m.content.trim() !== "" &&
  k.content.trim() === m.content.trim() &&
  notEarlier(k, m);

/** What the hub's latest page says of the live messages. */
export interface Settled {
  /** Those it now shows, to drop. */
  ids: Set<string>;
  /** Those it will never show but has passed: each by the kept message it
   *  goes before, known only now, while what came after it is still live. */
  anchors: Map<string, string>;
}

/** The live messages, finished by `before`, that `kept` (the hub's latest
 *  page, oldest first) now shows: matched in order from the end, so a reply
 *  the hub hasn't kept yet stays live, and an older one that says the same
 *  thing doesn't stand in for it. On a hub that streams answers by id
 *  (`streamed`), an answer is known by its id alone; what you said, which
 *  the hub keeps under an id of its own, is still matched by its files or
 *  its text. One whose files the hub didn't return stays live, so they aren't
 *  lost. */
export const settle = (kept: ChatMessage[], all: ChatMessage[], before: string, streamed = false): Settled => {
  // Those the hub sent live by their id are known by it; on a hub that
  // streams its answers by id, every answer is.
  const keptIds = new Set(kept.map((m) => m.id));
  const ids = new Set<string>();
  const anchors = new Map<string, string>();
  let next: string | undefined;
  let j = kept.length - 1;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    if (keptIds.has(m.id)) {
      ids.add(m.id);
      next = m.id;
      continue;
    }
    if ((streamed && m.role === "assistant") || m.status !== "complete" || m.at > before || m.role === "system") continue;
    let found = false;
    for (let k = j; k >= Math.max(0, j - LOOK_BACK); k--) {
      const copy = copyOf(kept[k]!, m);
      if (copy || twinOf(kept[k]!, m)) {
        if (copy) ids.add(m.id);
        next = kept[k]!.id;
        j = k - 1;
        found = true;
        break;
      }
    }
    // Later refreshes no longer know what followed it: its place stands.
    if (!found && next && !m.placedBefore) anchors.set(m.id, next);
  }
  return { ids, anchors };
};

/** The live messages {@link settle} says the hub now shows. */
export const covered = (kept: ChatMessage[], all: ChatMessage[], before: string, streamed = false): Set<string> =>
  settle(kept, all, before, streamed).ids;

/** The conversation as shown: what the hub kept, then what arrived live,
 *  without the live messages the hub's copy already has. Those can only be
 *  ones that existed when the history was read (`loadedAt`), or answers the
 *  socket repeats before you've said anything; they're the start of the
 *  live list and the end of the history.
 *
 *  A live message whose files the hub's copy lacks is never given up for it.
 *  Where the hub kept its words, its files show on the kept copy. Where it
 *  kept nothing, it goes where {@link settle} placed it, or, when nothing of
 *  yours came after it, before what the hub says is later by more than the
 *  clocks can differ; else it is the latest, and stays last. */
export const withHistory = (history: ChatMessage[], all: ChatMessage[], loadedAt: string | null): ChatMessage[] => {
  if (history.length === 0) return all;
  // A message the hub sent live by its id (the overseer's) is the kept one.
  const kept = new Set(history.map((m) => m.id));
  const live = all.some((m) => kept.has(m.id)) ? all.filter((m) => !kept.has(m.id)) : all;
  const held = new Set(live.filter((m) => (filesOf(m).length > 0 && !history.some((h) => same(h, m))) || m.placedBefore));
  const gone = new Set<ChatMessage>();

  const shownFiles = new Map<number, Attachment[]>();
  let j = history.length - 1;
  for (const m of [...held].reverse()) {
    // One sent since that read can't be in it: an earlier message that says
    // the same is another message.
    if (loadedAt === null || m.at > loadedAt) continue;
    for (let k = j; k >= Math.max(0, j - LOOK_BACK); k--) {
      if (twinOf(history[k]!, m)) {
        shownFiles.set(k, filesOf(m) as Attachment[]);
        gone.add(m);
        j = k - 1;
        break;
      }
    }
  }

  const placed = new Map<number, ChatMessage[]>();
  for (const m of held) {
    if (gone.has(m)) continue;
    let at = m.placedBefore ? history.findIndex((h) => h.id === m.placedBefore) : -1;
    if (at < 0) {
      const t = Date.parse(m.at);
      at = Number.isNaN(t) ? -1 : history.findIndex((h) => Date.parse(h.at) > t + SKEW_MS);
    }
    if (at < 0) continue;
    placed.set(at, [...(placed.get(at) ?? []), m]);
    gone.add(m);
  }

  const rest = live.filter((m) => !held.has(m));
  let candidates = 0;
  while (candidates < rest.length) {
    const m = rest[candidates]!;
    const known = loadedAt !== null && m.at <= loadedAt && m.status === "complete";
    const echo = m.role === "assistant" && m.status === "complete" && !rest.slice(0, candidates).some((x) => x.role === "user");
    if (!known && !echo) break;
    candidates++;
  }
  for (let k = Math.min(candidates, history.length); k > 0; k--) {
    const tail = history.slice(-k);
    if (tail.every((m, i) => same(m, rest[i]!))) {
      rest.slice(0, k).forEach((m) => gone.add(m));
      break;
    }
  }

  const merged = history.flatMap((h, i) => {
    const files = shownFiles.get(i);
    return [...(placed.get(i) ?? []), files ? { ...h, attachments: files } : h];
  });
  return [...merged, ...live.filter((m) => !gone.has(m))];
};
