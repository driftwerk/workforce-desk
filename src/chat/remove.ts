import { refusal } from "../hub/client";
import { jsonBody, pairedHub } from "../hub/net";
import type { HubAccount } from "./types";

// Deleting a message of yours from a DM, on a hub with `desk.delete`: what
// the agent saved to memory from it, and taking it (and, if you say, those
// memories) away. The hub refuses while a turn is running in the DM.

/** A memory the agent saved from a message. */
export interface SavedMemory {
  id: string;
  text: string;
}

const path = (agentId: string, messageId: string) =>
  `/api/desk/conversations/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}`;

/** The memories `agentId` saved from your message `messageId`. */
export async function memoriesFrom(hub: HubAccount, agentId: string, messageId: string): Promise<SavedMemory[]> {
  const res = await pairedHub(hub).fetch("GET", `${path(agentId, messageId)}/memories`);
  if (!res.ok) throw await refusal(res);
  const body = (await res.json()) as { memories?: unknown };
  return Array.isArray(body.memories)
    ? body.memories.filter((m): m is SavedMemory => !!m && typeof (m as SavedMemory).id === "string" && typeof (m as SavedMemory).text === "string")
    : [];
}

/** Deletes your message `messageId` from the DM with `agentId`, and forgets
 *  the memories `forget` saved from it. */
export async function deleteMessage(hub: HubAccount, agentId: string, messageId: string, forget: string[]): Promise<void> {
  const res = await pairedHub(hub).fetch("DELETE", path(agentId, messageId), jsonBody({ forget }));
  // Not found: gone already (deleted from another window), as asked.
  if (res.status === 404) return;
  if (!res.ok) throw await refusal(res);
}
