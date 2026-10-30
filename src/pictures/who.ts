import { useChat } from "../chat/store";
import { agentKey, type HubAccount, type Me } from "../chat/types";
import { agentPicturePath, MY_PICTURE, useImage, type ImageRef } from "./pictures";

/** You as Desk shows you on `hubId`'s places (its DMs and chats with its
 *  agents): that hub's account. Desk's own places, and anything on the hub
 *  on this computer (`hubId` null or the local one), show the local
 *  account's picture, or until it has one, the first connected hub's that
 *  has one. */
export const youOn = (hubs: readonly HubAccount[], me: Readonly<Record<string, Me>>, hubId: string | null): { hub: HubAccount; me: Me } | null => {
  const named = hubId ? hubs.find((h) => h.id === hubId) : undefined;
  if (named && !named.local) {
    const there = me[named.id];
    return there ? { hub: named, me: there } : null;
  }
  const local = hubs.find((h) => h.local);
  const mine = local ? me[local.id] : undefined;
  if (local && mine?.picture) return { hub: local, me: mine };
  const other = hubs.find((h) => me[h.id]?.picture);
  if (other) return { hub: other, me: { ...me[other.id]!, name: mine?.name ?? me[other.id]!.name } };
  return local && mine ? { hub: local, me: mine } : null;
};

const refOf = (hub: HubAccount, path: string, version: string | undefined): ImageRef | null =>
  version ? { hubId: hub.id, conn: hub, path, version } : null;

/** Agent `key`'s picture, once read. */
export function useAgentImage(key: string | undefined): string | null {
  const agent = useChat((s) => (key ? s.roster.find((a) => agentKey(a) === key) : undefined));
  const hub = useChat((s) => (agent ? s.hubs.find((h) => h.id === agent.hubId) : undefined));
  return useImage(hub && agent ? refOf(hub, agentPicturePath(agent.id), agent.picture?.version) : null);
}

/** You as shown on `hubId`'s places (see `youOn`): your name and picture. */
export function useYou(hubId: string | null): { name: string | null; src: string | null } {
  const hubs = useChat((s) => s.hubs);
  const me = useChat((s) => s.me);
  const you = youOn(hubs, me, hubId);
  const src = useImage(you ? refOf(you.hub, MY_PICTURE, you.me.picture?.version) : null);
  return { name: you?.me.name ?? null, src };
}
