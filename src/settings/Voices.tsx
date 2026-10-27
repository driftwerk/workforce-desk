import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import { useSettings } from "./store";
import {
  describeVoice,
  providerById,
  sampleLine,
  tryVoice,
  voicesOf,
  VOICE_PROVIDERS,
  type VoiceChoice,
  type VoiceProvider,
} from "./voiceCatalog";

const LIVE = new Set(["gpt-live", "gemini-live"]);

/** Every voice provider: its key, recommended models and voices to try and
 *  use. Agents use the default voice unless they have their own. */
export function Voices() {
  const { hub, fail } = useDesk();
  const { defaultVoice, set } = useSettings();
  const [selected, setSelected] = useState(defaultVoice.provider);
  const [have, setHave] = useState<string[]>([]);
  const provider = providerById(selected) ?? VOICE_PROVIDERS[0]!;

  useEffect(() => {
    hub?.vaultPaths().then(setHave).catch(fail);
  }, [hub, fail]);

  return (
    <div className="voices">
      <nav className="voices-providers" aria-label="Voice providers">
        {VOICE_PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`side-row ${p.id === selected ? "on" : ""}`}
            onClick={() => setSelected(p.id)}
          >
            <span className="side-name">{p.name}</span>
            <span className="faint small">
              {p.id === defaultVoice.provider
                ? "default"
                : !p.keyPath
                  ? "this Mac"
                  : have.includes(p.keyPath)
                    ? "key saved"
                    : ""}
            </span>
          </button>
        ))}
      </nav>
      <ProviderDetail
        key={provider.id}
        provider={provider}
        hasKey={!provider.keyPath || have.includes(provider.keyPath)}
        onKeySaved={() => hub?.vaultPaths().then(setHave).catch(fail)}
        isLive={LIVE.has(provider.id)}
        defaultVoiceLabel={describeVoice(defaultVoice)}
        onUse={(voice, model) => set({ defaultVoice: { provider: provider.id, model, voice } })}
        currentDefault={defaultVoice.provider === provider.id ? defaultVoice.voice : undefined}
      />
    </div>
  );
}

function ProviderDetail({
  provider,
  hasKey,
  onKeySaved,
  isLive,
  defaultVoiceLabel,
  onUse,
  currentDefault,
}: {
  provider: VoiceProvider;
  hasKey: boolean;
  onKeySaved: () => void;
  isLive: boolean;
  defaultVoiceLabel: string;
  onUse: (voice: string, model: string | undefined) => void;
  currentDefault: string | undefined;
}) {
  const { hub, fail } = useDesk();
  const [voices, setVoices] = useState<VoiceChoice[]>([]);
  const [model, setModel] = useState(provider.models[0]?.id);
  const [key, setKey] = useState("");
  const [trying, setTrying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    voicesOf(provider)
      .then(setVoices)
      .catch((e: unknown) => setProblem(String(e)));
  }, [provider]);

  const saveKey = async () => {
    if (!hub || !provider.keyPath || !key.trim()) return;
    try {
      await hub.saveVault(provider.keyPath, key.trim());
      setKey("");
      onKeySaved();
    } catch (e) {
      fail(e);
    }
  };

  const tryIt = async (v: VoiceChoice) => {
    setTrying(v.id);
    setProblem(await tryVoice({ provider: provider.id, model, voice: v.id }, sampleLine(v.name)));
    setTrying(null);
  };

  return (
    <section className="settings-pane voices-detail" aria-label={provider.name}>
      <h1 className="display-lg">{provider.name}</h1>
      <p className="muted">{provider.blurb}</p>
      <p className="faint small">Your default voice: {defaultVoiceLabel}</p>

      {provider.keyPath && (
        <div className="field">
          <span>API key {hasKey && <span className="state-done">· saved</span>}</span>
          <span className="field-row">
            <input
              type="password"
              value={key}
              autoComplete="off"
              placeholder={hasKey ? "Replace the saved key" : "Paste your key"}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="button" className="btn btn-signal" disabled={!key.trim()} onClick={() => void saveKey()}>
              Save
            </button>
          </span>
        </div>
      )}

      {provider.models.length > 1 && (
        <div className="field">
          <span>Model</span>
          <div className="seg" role="radiogroup" aria-label="Model">
            {provider.models.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={model === m.id} title={m.note} onClick={() => setModel(m.id)}>
                {m.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="voice-list">
        {voices.map((v) => (
          <div key={v.id} className="hub-row voice-row">
            <span className="hub-name">
              <b className="display">{v.name}</b>
              <span className="small muted">{v.description}</span>
            </span>
            <button type="button" className="btn" disabled={trying !== null} onClick={() => void tryIt(v)}>
              {trying === v.id ? "Playing…" : "▶ Try"}
            </button>
            {isLive ? null : currentDefault === v.id ? (
              <span className="chip">default</span>
            ) : (
              <button type="button" className="btn btn-signal" onClick={() => onUse(v.id, model)}>
                Use
              </button>
            )}
          </div>
        ))}
      </div>
      {isLive && <p className="faint small">Give an agent one of these voices in its settings; it’s used when {provider.name} is your voice engine.</p>}
      {problem && <p className="state-blocked small">{problem}</p>}
    </section>
  );
}
