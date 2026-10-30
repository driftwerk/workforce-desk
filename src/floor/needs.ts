import { agentItem, sessionItem, type ItemKey } from "../groups/model";
import type { Engine, Who } from "../hub/types";

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

/** The agent whose turn ran in folder `cwd`. A hub runs an agent's turn on
 *  its Claude Code subscription in a folder of the agent's own:
 *  `…/agents/<id>/projects/_agent-turn/work/session/at-…`, or
 *  `<worktree root>/work/<id>/_agent-turn/session/at-…`. Desk takes in every
 *  Claude Code session on the computer, that one too, as a session named
 *  after the folder (`at-dm-d4774cbb6c89-2e`). */
export const turnAgentOf = (cwd: string): string | null => {
  const parts = cwd.split(/[\\/]/);
  const at = parts.lastIndexOf("_agent-turn");
  if (parts[at - 1] === "projects" && parts[at - 3] === "agents") return parts[at - 2] || null;
  if (parts[at - 2] === "work") return parts[at - 1] || null;
  return null;
};

/** A name that is no one's to read: an agent's turn's folder, a bare id. */
const UNNAMED = /^at-(?:dm|ses|wf)-|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENGINE_SESSION: Record<Engine, string> = { claude: "Claude Code session", codex: "Codex session" };

/** What the hub calls an agent or session, or what it is when the hub sent
 *  no name to read. */
export const readableName = (who: Who): string => {
  const name = who.name.trim();
  if (name && !UNNAMED.test(name)) return name;
  if (who.kind === "agent") return "Agent";
  return name.startsWith("at-") ? "Agent turn" : who.engine ? ENGINE_SESSION[who.engine] : "Session";
};

/** What an agent or session is called here: one of this computer's
 *  sessions by the name the person gave it (`names`, by id). */
export const nameOf = ({ who, local }: { who: Who; local: boolean }, names: Readonly<Record<string, string>>): string =>
  (who.kind === "session" && local ? names[who.id] : undefined) ?? readableName(who);

/** How many needs wait on each item: the one count every badge shows. */
export const countsByItem = (needs: readonly OnHub[]): Map<ItemKey, number> =>
  needs.reduce((counts, n) => {
    const key = itemKeyOf(n);
    return counts.set(key, (counts.get(key) ?? 0) + 1);
  }, new Map<ItemKey, number>());
