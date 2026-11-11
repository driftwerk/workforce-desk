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

/** The group the agent `agentId` is the boss of, if it is one. */
export const groupOfBoss = (manager: Manager | null, agentId: string): string | null =>
  manager?.bosses?.find((b) => b.agentId === agentId)?.group ?? null;

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
