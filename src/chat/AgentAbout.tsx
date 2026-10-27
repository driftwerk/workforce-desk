import { providerLabel, type Agent, type HubAccount } from "./types";

/** Where an agent lives and what it runs on, as its hub reports it. */
export function AgentAbout({ agent, hub, onClose }: { agent: Agent; hub: HubAccount | undefined; onClose: () => void }) {
  const rows: [string, string][] = [
    ["Lives on", hub ? `${hub.label} — ${hub.url.replace(/^https?:\/\//, "")}` : agent.hubId],
    ["Runs on", providerLabel(agent.provider) ?? "Not reported by its hub"],
    ["Model", agent.model ?? "Not reported by its hub"],
  ];
  return (
    <div className="about" role="dialog" aria-label={`About ${agent.name}`}>
      <header className="about-head">
        <b className="display">{agent.name}</b>
        {agent.isDefault && <span className="chip">default</span>}
        <button type="button" className="link small" onClick={onClose}>
          Close
        </button>
      </header>
      <dl className="about-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="faint small">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
