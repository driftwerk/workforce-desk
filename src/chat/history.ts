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
  /** Desk's own id for it, where it sent it under one. */
  client_id?: string | null;
  /** Its place in the hub's archive; an older hub doesn't say. */
  seq?: number | null;
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

export const fromHub = (m: HubMessage): ChatMessage => {
  const author = authorOf(m.author);
  const failed = !!m.mark?.failed && m.from !== "user";
  return {
    id: m.id,
    // A turn's failure is no one's message: shown as Desk's, as it was live.
    role: m.from === "user" ? "user" : failed ? "system" : "assistant",
    content: textOf(m),
    at: m.at ?? "",
    status: failed ? "error" : "complete",
    tools: [],
    ...(typeof m.client_id === "string" ? { clientId: m.client_id } : {}),
    ...(typeof m.seq === "number" ? { seq: m.seq } : {}),
    ...(m.mark?.in_reply_to ? { replyTo: m.mark.in_reply_to } : {}),
    ...(m.mark?.steps?.length ? { steps: m.mark.steps } : {}),
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

/** What the id of a message Desk made itself starts with: one the hub never
 *  named, so no kept message has it. */
export const LOCAL_ID = "m-";

/** A file the hub shows as a message of its own carries an id no
 *  transcript message has. */
export const FILE_PREFIX = "file:";

/** `earlier` put before `messages`, each message once. */
export const prepend = (earlier: ChatMessage[], messages: ChatMessage[]): ChatMessage[] => {
  const have = new Set(messages.map((m) => m.id));
  return [...earlier.filter((m) => !have.has(m.id)), ...messages];
};
