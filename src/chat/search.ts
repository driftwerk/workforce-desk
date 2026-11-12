import { refusal } from "../hub/client";
import { pairedHub } from "../hub/net";
import { fromHub, type HubMessage } from "./history";
import type { ChatMessage, HubAccount } from "./types";

// Searching a DM's whole history, on a hub with `desk.search`: the matches,
// newest first, and the conversation around one, read from the hub so a
// match not loaded yet (or said on another device) is found too.

/** One message that matches, as the results list shows it. */
export interface Match {
  id: string;
  from: "user" | "agent";
  at: string;
  excerpt: string;
}

/** A page of matches, newest first; `more` when older ones remain. */
export interface Matches {
  matches: Match[];
  more: boolean;
}

const base = (agentId: string) => `/api/desk/conversations/${encodeURIComponent(agentId)}`;

/** Your DM with `agentId` searched for `q`: the newest matches, or those
 *  before match `before`. */
export async function searchDm(hub: HubAccount, agentId: string, q: string, before?: string): Promise<Matches> {
  const params = new URLSearchParams({ q, limit: "50" });
  if (before) params.set("before", before);
  const res = await pairedHub(hub).fetch("GET", `${base(agentId)}/search?${params}`);
  if (!res.ok) throw await refusal(res);
  const body = (await res.json()) as { matches?: unknown; more?: boolean };
  const matches = Array.isArray(body.matches)
    ? body.matches.filter(
        (m): m is Match => !!m && typeof (m as Match).id === "string" && typeof (m as Match).excerpt === "string" && typeof (m as Match).at === "string",
      )
    : [];
  return { matches, more: !!body.more };
}

/** The conversation around message `id`, oldest first: whether there's more
 *  before and after it. */
export interface Around {
  around: string;
  messages: ChatMessage[];
  more: boolean;
  moreAfter: boolean;
}

/** Your DM with `agentId` around message `id`. */
export async function readAround(hub: HubAccount, agentId: string, id: string): Promise<Around> {
  const params = new URLSearchParams({ around: id, limit: "100" });
  const res = await pairedHub(hub).fetch("GET", `${base(agentId)}?${params}`);
  if (!res.ok) throw await refusal(res);
  const body = (await res.json()) as { messages?: HubMessage[]; more?: boolean; more_after?: boolean };
  const messages = (body.messages ?? []).filter((m) => m && typeof m.id === "string").map(fromHub);
  return { around: id, messages, more: !!body.more, moreAfter: !!body.more_after };
}

/** The words of `q` to find and mark, lower-cased, longest first. */
export const termsOf = (q: string): string[] =>
  [...new Set(q.toLowerCase().split(/\s+/).filter((w) => w.length > 1))].sort((a, b) => b.length - a.length);
