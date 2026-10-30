import { absent } from "../chat/history";
import type { HubAccount, PermissionChoice } from "../chat/types";
import { refusal } from "../hub/client";
import { hubFetch } from "../hub/net";

/** The Desk surface's routes on a paired hub: which conversations changed,
 *  closing a deleted room's, deciding a routed approval, and a device
 *  unpairing itself. */

const call = (hub: HubAccount, method: string, path: string, body?: unknown): Promise<Response> =>
  hubFetch(new URL(path, hub.url), {
    method,
    headers: {
      authorization: `Bearer ${hub.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A conversation of yours on a hub that changed. */
export interface Active {
  agent_id: string;
  channel: string;
  updated_at: string;
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

/** Unpairs this device from `hub`, so what it set up for rooms on this Mac
 *  goes to your DM instead. A hub too old to have the route, or one that
 *  can't be reached, is left as it is. */
export const revokeSelf = async (hub: HubAccount): Promise<void> => {
  try {
    const res = await call(hub, "POST", "/api/pair/device/revoke-self");
    if (!res.ok && !absent(res)) console.warn(`${hub.label} didn't unpair this Mac: ${(await refusal(res)).message}`);
  } catch (e) {
    console.warn(`couldn't reach ${hub.label} to unpair this Mac:`, e);
  }
};
