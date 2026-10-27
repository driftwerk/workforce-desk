import { useEffect, useState } from "react";
import { planOf, setAgentModel, setAgentVoice, type Plan } from "../crew/local";
import { useDesk } from "../hub/store";
import type { VoiceSpec } from "../platform";
import { useSettings } from "../settings/store";
import { providerById, sampleLine, tryVoice, voicesOf, VOICE_PROVIDERS, type VoiceChoice } from "../settings/voiceCatalog";
import { useChat } from "./store";
import { agentKey, providerLabel, type Agent, type HubAccount } from "./types";

const TIER: Record<string, string> = { powerful: "Most capable", standard: "Balanced", cheap: "Fast" };
const PLAN_PROVIDER: Record<Plan, string> = { claude: "claude-code", chatgpt: "chatgpt" };

/** An agent's settings: where it lives, and — for agents on this Mac — its
 *  plan and model; for every agent, the voice Desk speaks it with. */
export function AgentAbout({ agent, hub, onClose }: { agent: Agent; hub: HubAccount | undefined; onClose: () => void }) {
  const local = hub?.local ?? false;
  return (
    <div className="about" role="dialog" aria-label={`${agent.name} settings`}>
      <header className="about-head">
        <b className="display">{agent.name}</b>
        {agent.isDefault && <span className="chip">default</span>}
        <button type="button" className="link small" onClick={onClose}>
          Close
        </button>
      </header>
      <dl className="about-rows">
        <div>
          <dt className="faint small">Lives on</dt>
          <dd>{!hub ? agent.hubId : local ? "This Mac" : `${hub.label} — ${hub.url.replace(/^https?:\/\//, "")}`}</dd>
        </div>
        {!local && (
          <div>
            <dt className="faint small">Runs on</dt>
            <dd>{[providerLabel(agent.provider), agent.model].filter(Boolean).join(" · ") || "Unknown"}</dd>
          </div>
        )}
      </dl>
      {local && <ModelPicker agent={agent} />}
      <VoicePicker agent={agent} local={local} />
    </div>
  );
}

function ModelPicker({ agent }: { agent: Agent }) {
  const { hub, fail } = useDesk();
  const refreshRoster = useChat((s) => s.refreshRoster);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [offered, setOffered] = useState<Record<string, { tier: string; model: string }[]>>({});

  useEffect(() => {
    if (!hub) return;
    hub.agentConfig(agent.id).then((cfg) => {
      const current = planOf(cfg);
      setPlan(current.plan ?? (agent.provider === "chatgpt" ? "chatgpt" : "claude"));
      setModel(current.model ?? agent.model);
    }, fail);
    hub.models().then((m) => setOffered(Object.fromEntries(m.providers.map((p) => [p.id, p.models]))), fail);
  }, [hub, agent.id, agent.provider, agent.model, fail]);

  const save = async (nextPlan: Plan, nextModel: string) => {
    if (!hub) return;
    setPlan(nextPlan);
    setModel(nextModel);
    try {
      await setAgentModel(hub, agent.id, nextPlan, nextModel);
      await refreshRoster();
    } catch (e) {
      fail(e);
    }
  };

  const models = plan ? (offered[PLAN_PROVIDER[plan]] ?? []) : [];
  return (
    <div className="about-section">
      <span className="faint small">Runs on</span>
      <div className="seg" role="radiogroup" aria-label="Plan">
        {(["claude", "chatgpt"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={plan === p}
            onClick={() => void save(p, offered[PLAN_PROVIDER[p]]?.find((m) => m.tier === "standard")?.model ?? "standard")}
          >
            {p === "claude" ? "Claude plan" : "ChatGPT plan"}
          </button>
        ))}
      </div>
      <div className="model-list">
        {models.map((m) => (
          <button
            key={m.model}
            type="button"
            className={`side-row ${model === m.model || model === m.tier ? "on" : ""}`}
            onClick={() => plan && void save(plan, m.model)}
          >
            <span className="side-name">{TIER[m.tier] ?? m.tier}</span>
            <span className="faint small mono">{m.model}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function VoicePicker({ agent, local }: { agent: Agent; local: boolean }) {
  const { hub, fail } = useDesk();
  const { agentVoices, defaultVoice, set } = useSettings();
  const key = agentKey(agent);
  const own = agentVoices[key];
  const current: VoiceSpec = own ?? defaultVoice;
  const [provider, setProvider] = useState(current.provider);
  const [voices, setVoices] = useState<VoiceChoice[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const p = providerById(provider);
    if (!p) return;
    voicesOf(p).then(setVoices, (e: unknown) => setProblem(String(e)));
  }, [provider]);

  const choose = async (spec: VoiceSpec | null) => {
    const { [key]: _was, ...others } = agentVoices;
    set({ agentVoices: spec ? { ...others, [key]: spec } : others });
    if (local && hub) await setAgentVoice(hub, agent.id, spec ?? defaultVoice).catch(fail);
  };

  const p = providerById(provider);
  return (
    <div className="about-section">
      <span className="faint small">
        Voice {own ? "" : "· using your default"}
        {own && (
          <>
            {" · "}
            <button type="button" className="link small" onClick={() => void choose(null)}>
              use the default
            </button>
          </>
        )}
      </span>
      <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Voice provider">
        {VOICE_PROVIDERS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <div className="model-list">
        {voices.map((v) => (
          <div key={v.id} className={`side-row ${current.provider === provider && current.voice === v.id ? "on" : ""}`}>
            <button
              type="button"
              className="link side-name voice-pick"
              onClick={() => void choose({ provider, model: p?.models[0]?.id, voice: v.id })}
              title={v.description}
            >
              {v.name}
            </button>
            <button
              type="button"
              className="link small"
              onClick={() =>
                void tryVoice({ provider, model: p?.models[0]?.id, voice: v.id }, sampleLine(agent.name)).then(setProblem)
              }
            >
              ▶ Try
            </button>
          </div>
        ))}
      </div>
      {problem && <p className="state-blocked small">{problem}</p>}
    </div>
  );
}
