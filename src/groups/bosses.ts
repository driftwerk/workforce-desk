// A sidebar group's boss: an agent of this computer's hub that oversees only
// that group (its `[oversight] group`). It is made one from its row's menu
// ("Oversee this group") and taken off from there ("Stop overseeing"); the
// hub keeps one boss per group and says who they are on its manager route.
// Two things ask first, and nothing else: a group the main overseer saw
// getting a boss of its own, and deleting a group that has a boss.

import { agentKey, type Agent } from "../chat/types";
import type { DeskHub } from "../hub/client";
import type { GroupBoss, Manager } from "../hub/types";
import { useAgentConfigs } from "../crew/agentBrain";
import { setAgentOversight } from "../crew/oversight";
import { useOverview } from "../overview/store";
import { UNGROUPED } from "./model";

/** Whether the hub says who each group's boss is (an older one doesn't, and
 *  Desk then offers no boss of a group). */
export const saysBosses = (manager: Manager | null): boolean => !!manager?.bosses;

/** The boss of group `group`, if it has one. */
export const bossOfGroup = (manager: Manager | null, group: string): GroupBoss | null =>
  manager?.bosses?.find((b) => b.group === group) ?? null;

/** What the person calls boss `id`, an agent of this computer's hub (the
 *  main boss when none is said): its name in the roster now, which a rename
 *  changes at once, else as the hub last listed it; "Desk" when there is no
 *  boss. */
export const bossNameOf = (
  roster: readonly Agent[],
  localHub: string | null | undefined,
  manager: Manager | null,
  id?: string | null,
): string => {
  const who = id ?? manager?.agentId ?? null;
  if (!who) return "Desk";
  return (
    roster.find((a) => a.id === who && a.hubId === localHub)?.name ??
    manager?.bosses?.find((b) => b.agentId === who)?.name ??
    (who === manager?.agentId ? "the main boss" : "its boss")
  );
};

/** The group the agent `agentId` is the boss of, if it is one. */
export const groupOfBoss = (manager: Manager | null, agentId: string): string | null =>
  manager?.bosses?.find((b) => b.agentId === agentId)?.group ?? null;

/** The agent a group's grant names as its boss on another hub: by its
 *  hub's id and its own, never its name. */
export interface GrantNamed {
  hub: string;
  agent: string;
}

/** What an agent's row says it is the boss of: the main boss, or the boss
 *  of the group it sits in (one of this computer's, or one on another hub
 *  that a group's grant names). A group's boss sitting in another group is
 *  tagged there no more than any other agent. */
export type BossTag = { kind: "main" } | { kind: "group"; group: string; remote: boolean } | null;

export const bossTagOf = (
  agent: { hubId: string; id: string },
  local: boolean,
  /** The group its row sits in. */
  sitsIn: string,
  manager: Manager | null,
  /** Each group's grant-named boss on another hub. */
  named: Record<string, GrantNamed | null>,
): BossTag => {
  if (local) {
    if (manager?.agentId === agent.id) return { kind: "main" };
    const g = groupOfBoss(manager, agent.id);
    return g && g === sitsIn ? { kind: "group", group: g, remote: false } : null;
  }
  if (sitsIn === UNGROUPED) return null;
  const n = named[sitsIn];
  return n && n.hub === agent.hubId && n.agent === agent.id ? { kind: "group", group: sitsIn, remote: true } : null;
};

/** The groups an agent on another hub is the grant-named boss of. */
export const grantGroupsOf = (agent: { hubId: string; id: string }, named: Record<string, GrantNamed | null>): string[] =>
  Object.entries(named)
    .filter(([g, n]) => g !== UNGROUPED && n?.hub === agent.hubId && n.agent === agent.id)
    .map(([g]) => g);

/** The words a boss tag carries, as its tooltip and the row's description:
 *  "Main boss", "Boss of Acme", "Boss of Patchwork (on Patchwork hub)". */
export const bossTagSays = (tag: BossTag, groupName: (id: string) => string, hubLabel: string): string | null =>
  !tag ? null : tag.kind === "main" ? "Main boss" : `Boss of ${groupName(tag.group)}` + (tag.remote ? ` (on ${hubLabel} hub)` : "");

/** What an agent's row offers about overseeing, in the group `group` it sits
 *  in: to oversee that group, and to stop overseeing the one it oversees.
 *  Only this computer's agents can be bosses; the main overseer stays the
 *  main one (it is set in its own settings). */
export const overseeChoices = (
  manager: Manager | null,
  agent: { id: string; local: boolean },
  group: string,
): { oversee: boolean; stop: boolean } => {
  const none = { oversee: false, stop: false };
  if (!agent.local || !saysBosses(manager) || manager?.agentId === agent.id) return none;
  const bossOf = groupOfBoss(manager, agent.id);
  return { oversee: group !== UNGROUPED && bossOf !== group, stop: bossOf !== null };
};

/** Whether `group` is closed to everyone but the person: named for a boss
 *  that oversees nothing now. */
export const isSealed = (manager: Manager | null, group: string): boolean => !!manager?.sealed?.includes(group);

/** Whether making a boss of `group` asks first: the main overseer saw what is
 *  in it until now. A group that has a boss already only changes boss, and a
 *  sealed one the main overseer doesn't see. */
export const asksBeforeOverseeing = (manager: Manager | null, group: string): boolean =>
  !!manager?.agentId && !bossOfGroup(manager, group) && !isSealed(manager, group);

/** What is said once `agent` oversees `group`: and, when it left another
 *  group it oversaw (`left`), that the main overseer sees that one now. */
export const overseeSaid = (agent: string, group: string, left: string | null, main: boolean): string =>
  `${agent} oversees ${group}` + (left && main ? `; the main boss sees ${left} from now on` : "");

/** What is asked before `agent` oversees `group`, which the main overseer
 *  saw. */
export const overseeAsk = (agent: string, group: string) => ({
  title: `Oversee ${group} with ${agent}?`,
  body: "The main boss stops seeing " + group + " from now on; what it already remembers stays.",
  action: `Oversee ${group}`,
});

/** What is asked before deleting `group`, which `boss` oversees. */
export const deleteAsk = (boss: string, group: string) => ({
  title: `Delete ${group}?`,
  body: `${boss} stops overseeing; its sessions and agents become ungrouped, and the main boss runs its sessions from now on, with no handover note from ${boss}.`,
  action: `Delete ${group}`,
});

const NOT_CONNECTED = "Desk isn’t ready just now; try again in a moment.";

/** Reads again who oversees what, and the Floor, after a change. */
const heard = async (): Promise<void> => {
  const s = useOverview.getState();
  await s.loadManager();
  if (s.overviewSupport === "yes") void s.loadOverview();
};

const keep = (agent: Pick<Agent, "hubId" | "id"> | null, toml: string) => {
  if (agent) useAgentConfigs.getState().put(agentKey(agent), toml);
};

/** Makes the agent `id` the boss of `group`: its `[oversight]` on, naming the
 *  group, and the rest of how it oversees as it was. The hub takes the group
 *  off any boss it had. `agent` is its roster entry, kept current with what
 *  was written. */
export async function overseeGroup(hub: DeskHub | null, id: string, group: string, agent: Pick<Agent, "hubId" | "id"> | null): Promise<void> {
  if (!hub) throw new Error(NOT_CONNECTED);
  const toml = await setAgentOversight(hub, id, (o) => ({ ...o, enabled: true, group }));
  keep(agent, toml);
  await heard();
}

/** Takes the agent `id` off the group it oversees: its `[oversight]` off and
 *  naming no group, so the hub opens the group to the main overseer from now
 *  on (never its past). */
export async function stopOverseeing(hub: DeskHub | null, id: string, agent: Pick<Agent, "hubId" | "id"> | null): Promise<void> {
  if (!hub) throw new Error(NOT_CONNECTED);
  const toml = await setAgentOversight(hub, id, (o) => ({ ...o, enabled: false, group: null }));
  keep(agent, toml);
  await heard();
}

/** Group dots, in the theme's terminal colours that Desk tones for its own
 *  ground (so they hold up in Day and Night alike). */
const DOTS = ["--ansi-cyan", "--ansi-green", "--ansi-magenta"];

/** The colour of group `id`'s dot: from its id, so it keeps it wherever the
 *  group moves and whatever it is renamed. */
export const groupDot = (id: string): string => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return `var(${DOTS[h % DOTS.length]})`;
};
