import { refusal } from "../hub/client";
import { jsonBody, pairedHub } from "../hub/net";
import type { ChatMessage, DeskLine, HubAccount } from "./types";

// A thread in a DM, on a hub with `desk.dm_threads`: a conversation of its
// own on a message, kept under the agent's key and the parent's id, so it has
// its own history and queue and its turns run beside the DM's.

/** The key of the thread on DM message `parent` of agent `agent`. */
export const threadKey = (agent: string, parent: string): string => `${agent}#${parent}`;

/** The agent's key, and the parent of the thread when the key is one. */
export const splitKey = (key: string): { agent: string; parent?: string } => {
  const at = key.indexOf("#");
  return at < 0 ? { agent: key } : { agent: key.slice(0, at), parent: key.slice(at + 1) };
};

/** The Desk channel of the thread on `parent`. */
export const threadChannel = (parent: string): string => `desk:thread:${parent}`;

/** One thread of the DM, as the hub lists it. */
export interface ThreadSummary {
  parent: string;
  replies: number;
  lastAt: string;
  authors: ("user" | "agent")[];
  working: boolean;
}

const base = (agentId: string) => `/api/desk/conversations/${encodeURIComponent(agentId)}`;

/** The threads of your DM with `agentId`, the one with the newest reply first. */
export async function fetchThreads(hub: HubAccount, agentId: string): Promise<ThreadSummary[]> {
  const res = await pairedHub(hub).fetch("GET", `${base(agentId)}/threads`);
  if (!res.ok) throw await refusal(res);
  const body = (await res.json()) as { threads?: unknown };
  if (!Array.isArray(body.threads)) return [];
  return body.threads.flatMap((t: Record<string, unknown>) =>
    t && typeof t.parent === "string" && typeof t.replies === "number"
      ? [
          {
            parent: t.parent,
            replies: t.replies,
            lastAt: typeof t.last_at === "string" ? t.last_at : "",
            authors: Array.isArray(t.authors) ? t.authors.filter((a): a is "user" | "agent" => a === "user" || a === "agent") : [],
            working: t.working === true,
          },
        ]
      : [],
  );
}

/** Your reply in a thread, also sent to the DM: the hub appends it there,
 *  marked as the thread's, and starts no turn. The id it has in the DM. */
export async function copyToChat(hub: HubAccount, agentId: string, parent: string, text: string): Promise<string> {
  const res = await pairedHub(hub).fetch("POST", `${base(agentId)}/messages`, jsonBody({ text, thread_of: parent }));
  if (!res.ok) throw await refusal(res);
  const body = (await res.json()) as { id?: string };
  return typeof body.id === "string" ? body.id : "";
}

/** The most lines of the chat before a thread's parent a turn carries. */
export const CONTEXT_LINES = 20;

/** The lines a thread turn carries: the chat up to and including the parent
 *  message, newest kept. `you` and `agent` name who said them. */
export function contextBefore(messages: readonly ChatMessage[], parent: string, you: string, agent: string): DeskLine[] {
  const at = messages.findIndex((m) => m.id === parent);
  if (at < 0) return [];
  return messages
    .slice(Math.max(0, at + 1 - CONTEXT_LINES), at + 1)
    .filter((m) => m.content.trim() !== "")
    .map((m) => ({ from: m.role === "user" ? you : agent, text: m.content }));
}
