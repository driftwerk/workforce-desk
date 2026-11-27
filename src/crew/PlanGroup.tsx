import { useState } from "react";
import { bossOfGroup, isSealed } from "../groups/bosses";
import { GroupDot } from "../groups/GroupChip";
import { UNGROUPED } from "../groups/model";
import { useLayout } from "../groups/store";
import type { BossPlan } from "../hub/types";
import { useOverview } from "../overview/store";
import { GroupChoice } from "../session/GroupChoice";
import { usePlans } from "./planStore";

/** The group a plan's sessions start in. An open plan in the main boss's
 *  part of Desk moves to Ungrouped or any group with no boss of its own,
 *  its running sessions with it; a refusal shows on its card. */
export function PlanGroup({ plan }: { plan: BossPlan }) {
  const { groups } = useLayout();
  const manager = useOverview((s) => s.manager);
  const [choosing, setChoosing] = useState(false);
  const [moving, setMoving] = useState(false);
  const open = (id: string) => !bossOfGroup(manager, id) && !isSealed(manager, id);
  const group = groups.find((g) => g.id === plan.group);
  const name = plan.group === null ? "Ungrouped" : (group?.name ?? plan.groupName ?? null);
  const here = plan.group ?? UNGROUPED;
  const movable = plan.boss === manager?.agentId && plan.state !== "done" && plan.state !== "dropped" && (plan.group === null || open(plan.group));
  const pick = async (to: string) => {
    if (to === here) return setChoosing(false);
    setMoving(true);
    await usePlans
      .getState()
      .regroup(plan.id, to === UNGROUPED ? null : to)
      .then(() => setChoosing(false))
      .catch(() => undefined);
    setMoving(false);
  };
  return (
    <>
      {name && (
        <span className="chip chip-group" title={`Its sessions start in ${name}`}>
          {group && <GroupDot id={group.id} />}
          {name}
        </span>
      )}
      {movable &&
        (choosing ? (
          <GroupChoice group={here} groups={groups.filter((g) => open(g.id))} onPick={(id) => !moving && void pick(id)} />
        ) : (
          <button type="button" className="link small pc-group-change" onClick={() => setChoosing(true)}>
            Change group
          </button>
        ))}
    </>
  );
}
