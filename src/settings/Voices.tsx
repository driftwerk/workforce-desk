import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import { explain, type Problem } from "../ui/problem";
import { ProblemNote } from "../ui/ProblemNote";
import { AddVoiceById } from "./AddVoiceById";
import { Calls } from "./Calls";
import { addCustomVoice, removeCustomVoice, useSettings } from "./store";
import {
  describeVoice,
  keyName,
  providerById,
  sampleLine,
  tryVoice,
  voicesOf,
  VOICE_PROVIDERS,
  type VoiceChoice,
  type VoiceProvider,
  withCustom,
} from "./voiceCatalog";

const LIVE = new Set(["gpt-live", "gemini-live"]);

/** The first page of Voice: talking to agents (by name, push to talk,
 *  Tuple); the providers after it are how they sound. */
const TALK = "talk";

/** Where the Gemini key agents think with also talks: Gemini Live uses it
 *  when Voices has none of its own. */
const GEMINI_KEY = "speech/gemini/api_key";

/** Every voice provider: its key, recommended models and voices to try and
 *  use. Agents use the default voice unless they have their own. */
export function Voices() {
  const { hub, fail } = useDesk();
  const { defaultVoice, customVoices, set } = useSettings();
  // Voice (talking to agents) first; then each provider, for how they sound.
  const [selected, setSelected] = useState<string>(TALK);
  const [have, setHave] = useState<string[]>([]);
  const [geminiProvider, setGeminiProvider] = useState(false);
  const provider = providerById(selected) ?? VOICE_PROVIDERS[0]!;

  useEffect(() => {
    hub?.vaultPaths().then(setHave).catch(fail);
    hub
      ?.providers()
      .then((ps) => setGeminiProvider(ps.some((p) => p.id === "gemini" && p.connected)))
      .catch(() => setGeminiProvider(false));
  }, [hub, fail]);
  /** Where a provider's key comes from: Voices' own, the Gemini provider's,
   *  or none yet. */
  const keyOf = (p: VoiceProvider): KeyFrom =>
    !p.keyPath ? "none-needed" : have.includes(p.keyPath) ? "own" : p.keyPath === GEMINI_KEY && geminiProvider ? "provider" : null;

  return (
    <div className="voices">
      <nav className="voices-providers" aria-label="Voice">
        <button type="button" className={`side-row ${selected === TALK ? "on" : ""}`} onClick={() => setSelected(TALK)}>
          <span className="side-name">Voice</span>
        </button>
        <span className="voices-nav-label faint small">How agents sound</span>
        {VOICE_PROVIDERS.map((p) => (
          <button key={p.id} type="button" className={`side-row ${p.id === selected ? "on" : ""}`} onClick={() => setSelected(p.id)}>
            <span className="side-name">{p.name}</span>
            <span className="faint small">
              {p.id === defaultVoice.provider ? "default" : !p.keyPath ? "this computer" : keyOf(p) ? "connected" : ""}
            </span>
          </button>
        ))}
      </nav>
      {selected === TALK ? (
        <Calls />
      ) : (
        <ProviderDetail
          key={provider.id}
          provider={provider}
          keyFrom={keyOf(provider)}
          onKeySaved={() => hub?.vaultPaths().then(setHave).catch(fail)}
          isLive={LIVE.has(provider.id)}
          defaultVoiceLabel={describeVoice(defaultVoice, withCustom([], customVoices[defaultVoice.provider]))}
          onUse={(voice, model) => set({ defaultVoice: { provider: provider.id, model, voice } })}
          currentDefault={defaultVoice.provider === provider.id ? defaultVoice.voice : undefined}
        />
      )}
    </div>
  );
}

/** Where a voice provider's key comes from. */
type KeyFrom = "own" | "provider" | "none-needed" | null;

function ProviderDetail({
  provider,
  keyFrom,
  onKeySaved,
  isLive,
  defaultVoiceLabel,
  onUse,
  currentDefault,
}: {
  provider: VoiceProvider;
  keyFrom: KeyFrom;
  onKeySaved: () => void;
  isLive: boolean;
  defaultVoiceLabel: string;
  onUse: (voice: string, model: string | undefined) => void;
  currentDefault: string | undefined;
}) {
  const hub = useDesk((s) => s.hub);
  const [voices, setVoices] = useState<VoiceChoice[]>([]);
  const [model, setModel] = useState(provider.models[0]?.id);
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [keyProblem, setKeyProblem] = useState<Problem | null>(null);
  const [trying, setTrying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const custom = useSettings((s) => s.customVoices[provider.id]);
  const shown = withCustom(voices, custom);

  useEffect(() => {
    voicesOf(provider)
      .then(setVoices)
      .catch((e: unknown) => setProblem(String(e)));
  }, [provider]);

  // Tried by the provider before it's kept: "connected" means it answered.
  const saveKey = async () => {
    if (!hub || !provider.keyPath || !key.trim()) return;
    setChecking(true);
    setKeyProblem(null);
    try {
      await hub.saveVoiceKey(keyName(provider.keyPath), key.trim());
      setKey("");
      onKeySaved();
    } catch (e) {
      // The provider's reason and its fix, as the hub put them.
      setKeyProblem(explain(e, { what: `saving the ${provider.name} key` }));
    } finally {
      setChecking(false);
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
          <span>
            API key {keyFrom === "own" && <span className="state-done">· connected</span>}
            {keyFrom === "provider" && <span className="state-done">· connected with your Gemini key from Providers</span>}
          </span>
          <span className="field-row">
            <input
              type="password"
              value={key}
              autoComplete="off"
              aria-label={`${provider.name} API key`}
              placeholder={keyFrom === "own" ? "Replace the key" : keyFrom === "provider" ? "Or paste another key" : "Paste your key"}
              onChange={(e) => {
                setKey(e.target.value);
                setKeyProblem(null);
              }}
            />
            <button type="button" className="btn btn-signal" disabled={!key.trim() || checking} onClick={() => void saveKey()}>
              {checking ? "Checking…" : "Save"}
            </button>
          </span>
          {keyProblem && (
            <div role="alert">
              <ProblemNote problem={keyProblem} />
            </div>
          )}
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
        {shown.map((v) => (
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
            {v.custom && (
              <button type="button" className="btn btn-ghost" aria-label={`Remove ${v.name}`} onClick={() => removeCustomVoice(provider.id, v.id)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {provider.customIds &&
        (adding ? (
          <AddVoiceById
            provider={provider}
            model={model}
            onCancel={() => setAdding(false)}
            onAdd={(v) => {
              addCustomVoice(provider.id, v);
              setAdding(false);
            }}
          />
        ) : (
          <button type="button" className="btn add-voice-open" onClick={() => setAdding(true)}>
            Use a voice ID
          </button>
        ))}
      {isLive && (
        <p className="faint small">Give an agent one of these voices in its settings; it’s used when {provider.name} is your voice engine.</p>
      )}
      {problem && <p className="state-blocked small">{problem}</p>}
    </section>
  );
}
