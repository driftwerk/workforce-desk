import { agentItem, sessionItem, type ItemKey } from "../groups/model";
import type { Who } from "../hub/types";

/** An agent or session on a hub, and whether that hub is this computer's. */
export interface OnHub {
  hubId: string;
  local: boolean;
  who: Pick<Who, "kind" | "id">;
}

/** The sidebar item a hub's agent or session is: `session:<id>` for one of
 *  this computer's sessions (another hub's is keyed by its hub, and has no
 *  row), `agent:<hub>/<agent>` for an agent. */
export const itemKeyOf = ({ hubId, local, who }: OnHub): ItemKey =>
  who.kind === "session" ? sessionItem(local ? who.id : `${hubId}/${who.id}`) : agentItem({ hubId, id: who.id });

/** What an agent or session is called here: one of this computer's
 *  sessions by the name the person gave it (`names`, by id). */
export const nameOf = ({ who, local }: { who: Who; local: boolean }, names: Readonly<Record<string, string>>): string =>
  (who.kind === "session" && local ? names[who.id] : undefined) ?? who.name;

/** How many needs wait on each item: the one count every badge shows. */
export const countsByItem = (needs: readonly OnHub[]): Map<ItemKey, number> =>
  needs.reduce((counts, n) => {
    const key = itemKeyOf(n);
    return counts.set(key, (counts.get(key) ?? 0) + 1);
  }, new Map<ItemKey, number>());
