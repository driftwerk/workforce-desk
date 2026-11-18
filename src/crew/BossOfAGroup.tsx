// An agent on a paired hub's way to boss one of the person's groups, from
// the agent's own settings: pick the group, and that group's Boss sheet
// opens with the agent picked (the sheet's own flow from there).

import { useEffect, useId, useRef, useState } from "react";
import type { Agent, HubAccount } from "../chat/types";
import { BossSheet } from "../groups/BossSheet";
import { below } from "../groups/rows";
import { newGroup, useLayout } from "../groups/store";
import { Menu, type MenuEntry } from "../ui/Menu";
import { useGrantBosses } from "./grantBoss";

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The groups `party` (`<hub>/<agent>`) is the boss of, as last read. */
export const groupsRunBy = (byGroup: Readonly<Record<string, { id: string } | null>>, groups: readonly { id: string; name: string }[], party: string) =>
  groups.filter((g) => byGroup[g.id]?.id === party);

export function BossOfAGroup({ agent, hub }: { agent: Agent; hub: HubAccount }) {
  const head = useId();
  const { groups } = useLayout();
  const byGroup = useGrantBosses((s) => s.byGroup);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Which groups they run already, read as the settings open.
  const ids = groups.map((g) => g.id).join(",");
  useEffect(() => {
    for (const g of groups) useGrantBosses.getState().ensure(g.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const party = `${agent.hubId}/${agent.id}`;
  const runs = groupsRunBy(byGroup, groups, party);
  /** A group of its own for them to run, when the person has none (or
   *  wants one): named for them, renamed in the sidebar. */
  const fresh = async () => {
    setProblem(null);
    const id = newId();
    if (await newGroup(id, `${agent.name}’s group`)) setSheet(id);
    else setProblem("Desk couldn’t make the group. Try again in a moment.");
  };
  const entries: MenuEntry[] = [
    ...groups.map((g): MenuEntry => ({ kind: "item", label: g.name, hint: runs.some((r) => r.id === g.id) ? "runs it" : undefined, onSelect: () => setSheet(g.id) })),
    ...(groups.length ? [{ kind: "separator" as const }] : []),
    { kind: "item", label: `New group for ${agent.name}`, onSelect: () => void fresh() },
  ];
  return (
    <section className="agent-section" aria-labelledby={head}>
      <h2 id={head}>Boss of a group</h2>
      <p className="small muted">
        {runs.length
          ? `${agent.name} runs ${runs.map((g) => g.name).join(", ")}, from ${hub.label}.`
          : `${agent.name} can run one of your groups’ sessions from ${hub.label}: you choose how much they may do and what they see.`}
      </p>
      <div className="agent-section-actions">
        <button
          ref={button}
          type="button"
          className="btn btn-sm"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(e) => setMenu(below(e.currentTarget))}
        >
          Make {agent.name} a group’s boss…
        </button>
      </div>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {menu && (
        <Menu
          label={`Which group ${agent.name} runs`}
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            if (refocus) button.current?.focus();
            setMenu(null);
          }}
        />
      )}
      {sheet && (
        <BossSheet
          group={sheet}
          preselect={agent}
          onClose={() => {
            setSheet(null);
            button.current?.focus();
          }}
        />
      )}
    </section>
  );
}
