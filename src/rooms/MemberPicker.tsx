import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { AgentMark } from "../ui/Mark";

/** Crew to pick from, each with a checkbox, and with `lead` a round
 *  button for who answers what @-mentions no one. Those in `leaveOut`
 *  aren't offered. */
export function MemberPicker({
  picked,
  onToggle,
  lead,
  leaveOut = [],
}: {
  picked: readonly string[];
  onToggle: (key: string) => void;
  lead?: { key: string | null; onPick: (key: string) => void };
  leaveOut?: readonly string[];
}) {
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const offered = roster.filter((a: Agent) => !leaveOut.includes(agentKey(a)));
  if (!offered.length) return <p className="faint small">Everyone in your crew is in it.</p>;
  return (
    <div className="quick-list">
      {offered.map((a) => {
        const k = agentKey(a);
        return (
          <label key={k} className="side-row">
            <input type="checkbox" checked={picked.includes(k)} onChange={() => onToggle(k)} />
            <AgentMark agent={k} name={a.name} size="sm" />
            <span className="display crew-name">{a.name}</span>
            <span className="faint small">{hubs.find((h) => h.id === a.hubId)?.label}</span>
            {lead && (
              <input
                type="radio"
                name="lead"
                aria-label={`Unaddressed messages go to ${a.name}`}
                title="Unaddressed messages go to this member"
                disabled={!picked.includes(k)}
                checked={lead.key === k}
                onChange={() => lead.onPick(k)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
