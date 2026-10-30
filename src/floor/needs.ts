import { agentItem, sessionItem, type ItemKey } from "../groups/model";
import type { Who } from "../hub/types";

/** The sidebar item a hub's agent or session is: `session:<id>` for a Desk
 *  session, `agent:<hub>/<agent>` for an agent. */
export const itemKeyOf = (hubId: string, who: Pick<Who, "kind" | "id">): ItemKey =>
  who.kind === "session" ? sessionItem(who.id) : agentItem({ hubId, id: who.id });

/** How many needs wait on each item: the one count every badge shows. */
export const countsByItem = (needs: readonly { hubId: string; who: Pick<Who, "kind" | "id"> }[]): Map<ItemKey, number> =>
  needs.reduce((counts, n) => {
    const key = itemKeyOf(n.hubId, n.who);
    return counts.set(key, (counts.get(key) ?? 0) + 1);
  }, new Map<ItemKey, number>());
