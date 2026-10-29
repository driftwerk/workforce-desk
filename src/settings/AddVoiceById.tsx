import { useState } from "react";
import type { CustomVoice } from "../platform";
import { lookupProblem, lookupVoice, sampleLine, tryVoice, type VoiceLookup, type VoiceProvider } from "./voiceCatalog";

/** "Use a voice ID": a voice from `provider` by its id (a cloned or
 *  community one), looked up with the provider so it's named as it is
 *  there, playable first, then added (`onAdd`). */
export function AddVoiceById({
  provider,
  model,
  onAdd,
  onCancel,
}: {
  provider: VoiceProvider;
  /** The model a preview speaks with. */
  model: string | undefined;
  onAdd: (voice: CustomVoice) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [checking, setChecking] = useState(false);
  /** What the provider said, and about which id. */
  const [result, setResult] = useState<{ id: string; lookup: VoiceLookup } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playProblem, setPlayProblem] = useState<string | null>(null);

  const trimmed = id.trim();
  const said = result && result.id === trimmed ? result.lookup : null;
  const found = said?.state === "found" ? said : null;
  const problem = said ? lookupProblem(said, provider) : null;

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!trimmed) return;
    setChecking(true);
    setPlayProblem(null);
    const lookup = await lookupVoice(provider.id, trimmed);
    setResult({ id: trimmed, lookup });
    setChecking(false);
  };

  const preview = async () => {
    if (!found) return;
    setPlaying(true);
    setPlayProblem(await tryVoice({ provider: provider.id, model, voice: trimmed }, sampleLine(name.trim() || found.name)));
    setPlaying(false);
  };

  const add = () => {
    const given = name.trim();
    if (found) onAdd({ id: trimmed, name: given || found.name, ...(found.description ? { description: found.description } : {}) });
    else if (said?.state === "key-refused" && given) onAdd({ id: trimmed, name: given });
  };

  return (
    <form className="field-stack add-voice" aria-label="Use a voice ID" onSubmit={(e) => void check(e)}>
      <span className="field-label">Use a voice ID</span>
      {provider.customIds && <p className="small muted">{provider.customIds}</p>}
      <label className="field-stack">
        <span className="small">Voice ID</span>
        <input
          className="mono"
          value={id}
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.id === "fish_audio" ? "802e3bc2b27e49c2995d23ef70e6ac89" : "21m00Tcm4TlvDq8ikWAM"}
          onChange={(e) => setId(e.target.value)}
          autoFocus
        />
      </label>
      <label className="field-stack">
        <span className="small">Name (optional)</span>
        <input value={name} placeholder={found?.name ?? "What to call it in Desk"} onChange={(e) => setName(e.target.value)} />
      </label>
      {found && (
        <div className="setting-card" aria-live="polite">
          <span className="card-text">
            <b>{found.name}</b>
            <span>{found.description ?? `Found on ${provider.name}`}</span>
          </span>
          <button type="button" className="btn" disabled={playing} onClick={() => void preview()}>
            {playing ? "Playing…" : "Preview"}
          </button>
        </div>
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {said?.state === "key-refused" && (
        <p className="small muted">You can still add it with a name if you’re sure of the id; Desk will speak with it as it is.</p>
      )}
      {playProblem && <p className="small state-blocked">{playProblem}</p>}
      <span className="field-row add-voice-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        {found || said?.state === "key-refused" ? (
          <button type="button" className="btn btn-signal" disabled={!found && !name.trim()} onClick={add}>
            {found ? "Add voice" : "Add without checking"}
          </button>
        ) : (
          <button type="submit" className="btn btn-signal" disabled={!trimmed || checking}>
            {checking ? "Looking it up…" : "Look it up"}
          </button>
        )}
      </span>
    </form>
  );
}
