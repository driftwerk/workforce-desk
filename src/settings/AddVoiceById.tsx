import { useState } from "react";
import type { CustomVoice } from "../platform";
import { lookupProblem, lookupVoice, sampleLine, tryVoice, type VoiceLookup, type VoiceProvider } from "./voiceCatalog";

/** How each provider writes a voice's ID. */
const ID_SHAPE: Record<string, RegExp> = {
  fish_audio: /^[0-9a-f]{32}$/i,
  elevenlabs: /^[A-Za-z0-9]{20}$/,
};

/** The voice ID in what was pasted: the ID itself, or a link to the voice
 *  on its provider's site (Fish Audio's `/m/<id>`, an ElevenLabs link with
 *  `voiceId=<id>` or the ID in its path). Null when there's none. */
export const voiceIdFrom = (pasted: string, provider: string): string | null => {
  const t = pasted.trim();
  const shape = ID_SHAPE[provider];
  if (!t) return null;
  if (shape?.test(t)) return t;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  const query = url.searchParams.get("voiceId") ?? url.searchParams.get("voice_id");
  if (query && (!shape || shape.test(query))) return query;
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.reverse().find((p) => (shape ? shape.test(p) : false)) ?? null;
};

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

  // A link to the voice, or its ID, as pasted.
  const trimmed = voiceIdFrom(id, provider.id) ?? id.trim();
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
        <span className="small">The voice’s link, or its ID</span>
        <input
          value={id}
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.id === "fish_audio" ? "https://fish.audio/m/…" : "https://elevenlabs.io/app/voice-library?voiceId=…"}
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
