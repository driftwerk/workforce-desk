import { absent } from "../chat/history";
import type { HubAccount, PermissionChoice } from "../chat/types";
import { refusal } from "../hub/client";
import { jsonBody, pairedHub } from "../hub/net";

/** The Desk surface's routes on a paired hub: which conversations changed,
 *  closing a deleted room's, deciding a routed approval, and a device
 *  unpairing itself. */

const call = (hub: HubAccount, method: string, path: string, body?: unknown): Promise<Response> =>
  pairedHub(hub).fetch(method, path, jsonBody(body));

/** How far you've read a conversation, as its hub keeps it. */
export interface ConversationRead {
  at: string;
  message_id: string | null;
}

/** What's unread in a DM, from its read point (or your floor on its hub). */
export interface ConversationUnread {
  count: number;
  for_you: number;
  first: string | null;
  /** The newest agent message: Mark read moves to it. */
  last: ConversationRead | null;
  /** The count stopped at the hub's limit. */
  capped: boolean;
}

/** A conversation of yours on a hub that changed, or has something unread. */
export interface Active {
  agent_id: string;
  channel: string;
  updated_at: string;
  /** For a DM, on a hub that keeps read points. */
  read?: ConversationRead | null;
  unread?: ConversationUnread | null;
}

/** Your Desk conversations on `hub` that changed after `since`, least
 *  recently first; null where the hub has no such route. */
export const activeConversations = async (hub: HubAccount, since: string | null): Promise<Active[] | null> => {
  const path = since ? `/api/desk/conversations?since=${encodeURIComponent(since)}` : "/api/desk/conversations";
  const res = await call(hub, "GET", path);
  if (absent(res)) return null;
  if (!res.ok) throw await refusal(res);
  return ((await res.json()) as { conversations?: Active[] }).conversations ?? [];
};

/** Moves your read point in a conversation with `agent` on `hub`. */
export const putConversationRead = async (
  hub: HubAccount,
  agent: string,
  read: { channel: string; at: string; message: string | null; mark: "advance" | "set" },
): Promise<void> => {
  const res = await call(hub, "PUT", `/api/desk/conversations/${encodeURIComponent(agent)}/read`, read);
  if (!res.ok) throw await refusal(res);
};

/** Tells `hub` that a room you deleted is gone: what its agent sets up
 *  there goes to your DM from now on, and so do `undelivered`, the
 *  messages Desk found for the room after it went. */
export const closeConversation = async (hub: HubAccount, agent: string, channel: string, undelivered: string[] = []): Promise<void> => {
  const res = await call(hub, "POST", `/api/desk/conversations/${encodeURIComponent(agent)}/close`, { channel, undelivered });
  if (!res.ok) throw await refusal(res);
};

/** What became of a routed approval you decided. */
export type Decided = "approved" | "denied" | "already_resolved";

export const decideApproval = async (hub: HubAccount, requestId: string, choice: PermissionChoice): Promise<Decided> => {
  const res = await call(hub, "POST", `/api/approvals/${encodeURIComponent(requestId)}/decision`, { choice });
  if (!res.ok) throw await refusal(res);
  return ((await res.json()) as { status: Decided }).status;
};

/** Unpairs this device from `hub`, so what it set up for rooms on this computer
 *  goes to your DM instead. A hub too old to have the route, or one that
 *  can't be reached, is left as it is. */
export const revokeSelf = async (hub: HubAccount): Promise<void> => {
  try {
    const res = await call(hub, "POST", "/api/pair/device/revoke-self");
    if (!res.ok && !absent(res)) console.warn(`${hub.label} didn't unpair this computer: ${(await refusal(res)).message}`);
  } catch (e) {
    console.warn(`couldn't reach ${hub.label} to unpair this computer:`, e);
  }
};
