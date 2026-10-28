import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import type { VoiceSpec } from "../platform";
import { providerById, sampleLine, tryVoice, voicesOf, VOICE_PROVIDERS, type VoiceChoice } from "../settings/voiceCatalog";
import { CloseButton, Dialog, radioKeys } from "../ui/Dialog";

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    <path d="M3 2l9 5-9 5z" />
  </svg>
);

/** The voices `provider` offers, loaded from the voice engine where it
 *  keeps them. */
export function useVoices(provider: string): { voices: VoiceChoice[]; problem: string | null } {
  const fixed = (id: string): VoiceChoice[] => {
    const v = providerById(id)?.voices;
    return Array.isArray(v) ? v : [];
  };
  const [state, setState] = useState<{ of: string; voices: VoiceChoice[]; problem: string | null }>({
    of: provider,
    voices: fixed(provider),
    problem: null,
  });
  useEffect(() => {
    const p = providerById(provider);
    if (!p) return;
    let live = true;
    setState({ of: provider, voices: fixed(provider), problem: null });
    voicesOf(p).then(
      (voices) => live && setState({ of: provider, voices, problem: null }),
      () => live && setState({ of: provider, voices: [], problem: `Desk couldn’t list ${p.name}’s voices.` }),
    );
    return () => {
      live = false;
    };
  }, [provider]);
  // Never another provider's voices: picking one would save it under this one.
  return state.of === provider ? { voices: state.voices, problem: state.problem } : { voices: fixed(provider), problem: null };
}

const sameVoice = (a: VoiceSpec, b: VoiceSpec): boolean =>
  a.provider === b.provider && a.voice === b.voice && (a.model ?? null) === (b.model ?? providerById(b.provider)?.models[0]?.id ?? null);

/** Plays a voice saying hello as `who`; resolves with a problem or null. */
export const playSample = (spec: VoiceSpec, who: string): Promise<string | null> => tryVoice(spec, sampleLine(who));

/** The ▶ button that plays a voice. */
export function PlayButton({ spec, who, onProblem }: { spec: VoiceSpec; who: string; onProblem: (p: string | null) => void }) {
  const [playing, setPlaying] = useState(false);
  return (
    <button
      type="button"
      className="card-icon"
      aria-label={playing ? "Playing" : "Play a sample"}
      disabled={playing}
      onClick={() => {
        setPlaying(true);
        void playSample(spec, who).then((p) => {
          setPlaying(false);
          onProblem(p);
        });
      }}
    >
      <PlayIcon />
    </button>
  );
}

/** "How they sound": the voice, a sample, and Change. */
export function VoiceCard({
  who,
  spec,
  isDefault,
  onChange,
  withModel = false,
}: {
  who: string;
  spec: VoiceSpec;
  isDefault: boolean;
  onChange: () => void;
  /** Name the voice model too, even where the provider has only one. */
  withModel?: boolean;
}) {
  const { voices } = useVoices(spec.provider);
  const [problem, setProblem] = useState<string | null>(null);
  const p = providerById(spec.provider);
  const v = voices.find((x) => x.id === spec.voice);
  const model =
    p && (withModel || p.models.length > 1) ? (p.models.find((m) => m.id === spec.model) ?? p.models[0])?.name : undefined;
  return (
    <div className="field-stack">
      <div className="setting-card">
        <PlayButton spec={spec} who={who} onProblem={setProblem} />
        <span className="card-text">
          <b>
            {v?.name ?? spec.voice ?? p?.name ?? spec.provider}{" "}
            <span>· {[p?.name ?? spec.provider, model].filter(Boolean).join(" · ")}</span>
          </b>
          <span>{v?.description ?? p?.blurb ?? ""}</span>
        </span>
        {isDefault && <span className="chip chip-default">Default</span>}
        <button type="button" className="btn" onClick={onChange}>
          Change
        </button>
      </div>
      {problem && <p className="small state-blocked">{problem}</p>}
    </div>
  );
}

/** Choosing a voice: a provider, then one of its voices, each one playable
 *  first. `onUse(null)` goes back to the default voice. */
export function VoiceDialog({
  title,
  who,
  current,
  defaultVoice,
  onUse,
  onClose,
}: {
  /** "How Ledger sounds" */
  title: string;
  /** Who the footer says it's for, and who the samples introduce. */
  who: string;
  /** Their own voice, or null on the default. */
  current: VoiceSpec | null;
  defaultVoice: VoiceSpec;
  onUse: (spec: VoiceSpec | null) => Promise<void> | void;
  onClose: () => void;
}) {
  const hub = useDesk((s) => s.hub);
  const start = current ?? defaultVoice;
  const [provider, setProvider] = useState(start.provider);
  const [choice, setChoice] = useState<VoiceSpec>(start);
  const [have, setHave] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { voices, problem: listProblem } = useVoices(provider);
  const p = providerById(provider);

  useEffect(() => {
    hub?.vaultPaths().then(setHave, () => setHave(null));
  }, [hub]);

  const model = (id: string) => (choice.provider === id ? choice.model : undefined) ?? providerById(id)?.models[0]?.id;
  const specFor = (v: VoiceChoice): VoiceSpec => ({ provider, model: model(provider), voice: v.id });
  const chosenIndex = voices.findIndex((v) => choice.provider === provider && choice.voice === v.id);
  const needsKey = !!p?.keyPath && have !== null && !have.includes(p.keyPath);
  const chosenName = (() => {
    const cp = providerById(choice.provider);
    const v = choice.provider === provider ? voices.find((x) => x.id === choice.voice) : undefined;
    return [v?.name ?? (cp && Array.isArray(cp.voices) ? cp.voices.find((x) => x.id === choice.voice)?.name : undefined), cp?.name]
      .filter(Boolean)
      .join(" · ");
  })();

  const use = async (spec: VoiceSpec | null) => {
    try {
      await onUse(spec);
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      wide
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head dialog-head-rule">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {title}
            </h1>
            <p>Pick a voice provider, then a voice. Play any of them first.</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-body">
        <nav className="brain-nav" aria-label="Voice providers">
          <div className="brain-group">
            {VOICE_PROVIDERS.map((vp) => (
              <button
                key={vp.id}
                type="button"
                className="provider-row"
                aria-current={vp.id === provider ? "true" : undefined}
                data-autofocus={vp.id === provider ? true : undefined}
                onClick={() => setProvider(vp.id)}
              >
                <span className="provider-text">
                  <b>{vp.name}</b>
                  <span>{vp.keyPath ? "Cloud voices" : "On this Mac"}</span>
                </span>
                {vp.id === start.provider && <span className="provider-status on">In use</span>}
              </button>
            ))}
          </div>
        </nav>
        <div className="brain-pane">
          {p && <p className="muted">{p.blurb}</p>}
          {needsKey && <p className="small state-blocked">Add a {p?.name} key under Settings → Voices to hear these.</p>}
          {p && p.models.length > 1 && (
            <div className="field-stack">
              <span className="field-label" id="voice-model">
                Model
              </span>
              <div className="effort-seg" role="radiogroup" aria-labelledby="voice-model">
                {p.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={model(provider) === m.id}
                    title={m.note}
                    onClick={() => setChoice((c) => ({ provider, model: m.id, voice: c.provider === provider ? c.voice : undefined }))}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field-stack">
            <span className="field-label" id="voice-list">
              Voice
            </span>
            {listProblem && <p className="small state-blocked">{listProblem}</p>}
            <div className="pick-list" role="radiogroup" aria-labelledby="voice-list">
              {voices.map((v, i) => (
                <div key={v.id} className="setting-card voice-option">
                  <PlayButton spec={specFor(v)} who={who} onProblem={setProblem} />
                  <button
                    type="button"
                    role="radio"
                    className="pick"
                    aria-checked={i === chosenIndex}
                    tabIndex={i === Math.max(chosenIndex, 0) ? 0 : -1}
                    onClick={() => setChoice(specFor(v))}
                    onKeyDown={(e) => radioKeys(e, voices, chosenIndex, (next) => setChoice(specFor(next)))}
                  >
                    <span className="radio-ring" aria-hidden="true" />
                    <span className="pick-text">
                      <b>{v.name}</b>
                      <span>{v.description}</span>
                    </span>
                    {defaultVoice.provider === provider && defaultVoice.voice === v.id && (
                      <span className="chip chip-default">Default</span>
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <footer className="dialog-foot">
        <span className={`dialog-foot-note ${problem ? "state-blocked" : ""}`} aria-live="polite">
          {problem ?? (chosenName ? `${who} will sound like ${chosenName}` : "")}
        </span>
        {current && (
          <button type="button" className="btn btn-ghost" onClick={() => void use(null)}>
            Use the default voice
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-signal"
          disabled={!choice.voice}
          onClick={() => void use(!current && sameVoice(choice, defaultVoice) ? null : choice)}
        >
          Use this
        </button>
      </footer>
    </Dialog>
  );
}
