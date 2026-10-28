import type { DeskExtras } from "../hub/types";
import { preview } from "../preview";
import type { ChatMessage, HubAccount } from "./types";

/** One message of a DM as the hub keeps it. */
interface HubMessage {
  id: string;
  from: string;
  text?: string;
  /** What the live channel calls the text, should a hub send it so. */
  content?: string;
  at?: string;
  /** What an overseer's message mentions to act on in place. */
  desk?: DeskExtras;
}

export interface HistoryPage {
  /** Oldest first. */
  messages: ChatMessage[];
  /** Whether there is more before the first of them. */
  more: boolean;
}

export const PAGE = 200;

const fromHub = (m: HubMessage): ChatMessage => ({
  id: m.id,
  role: m.from === "user" ? "user" : "assistant",
  content: m.text ?? m.content ?? "",
  at: m.at ?? "",
  status: "complete",
  tools: [],
  ...(m.desk && m.from !== "user" ? { desk: m.desk } : {}),
});

const actionable = (m: ChatMessage): boolean => !!(m.desk?.approvals?.length || m.desk?.suggestions?.length);

/** A page of your conversation with an agent, from before message `before`
 *  (the latest when not given). Null where the hub doesn't keep DMs for
 *  Desk: the conversation starts empty there, as it always has. Anything
 *  else that goes wrong throws. */
export async function fetchHistory(hub: HubAccount, agentId: string, before?: string): Promise<HistoryPage | null> {
  const url = new URL(`/api/desk/conversations/${encodeURIComponent(agentId)}`, hub.url);
  url.searchParams.set("limit", String(PAGE));
  if (before) url.searchParams.set("before", before);
  const res = await fetch(url, { headers: { authorization: `Bearer ${hub.token}` } });
  // Not on this hub (an older one, or one that won't share it with this device).
  const absent =
    [401, 403, 404, 405].includes(res.status) ||
    // An older hub answers a route it doesn't have with its web page.
    (res.ok && !(res.headers.get("content-type") ?? "").includes("json"));
  if (!absent && !res.ok) throw new Error(`history: ${res.status}`);
  const body = absent ? null : ((await res.json()) as { messages?: HubMessage[]; more?: boolean });
  const page = body && {
    messages: (body.messages ?? [])
      .filter((m) => m && typeof m.id === "string")
      .map(fromHub)
      .filter((m) => m.content.trim() !== "" || actionable(m)),
    more: body.more ?? false,
  };
  if (!preview || before) return page;
  // The browser preview shows the overseer's DM of the design.
  const { devConversation } = await import("../devBridge");
  const extra = devConversation(agentId).map(fromHub);
  return extra.length ? { messages: [...(page?.messages ?? []), ...extra], more: page?.more ?? false } : page;
}

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
export const withHistory = (history: ChatMessage[], live: ChatMessage[], loadedAt: string | null): ChatMessage[] => {
  if (history.length === 0) return live;
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
