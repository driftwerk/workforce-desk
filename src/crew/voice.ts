import { parse, stringify } from "smol-toml";

type Doc = Record<string, unknown>;

/** Voice providers the hub speaks with too (voice notes, clips). */
const HUB_SPEECH = new Set(["fish_audio", "elevenlabs", "openai"]);

/** An agent's config speaking with `voice` wherever the hub speaks for it;
 *  a voice the hub can't use (Kokoro, the live engines) leaves it on the
 *  hub's default. */
export const withVoice = (source: string, voice: { provider: string; model?: string; voice?: string }): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const llm = { ...((doc.llm ?? {}) as Doc) };
  if (HUB_SPEECH.has(voice.provider)) {
    llm.speech = Object.fromEntries(
      Object.entries({ provider: voice.provider, model: voice.model, voice: voice.voice }).filter(([, v]) => v !== undefined),
    );
  } else delete llm.speech;
  doc.llm = llm;
  return stringify(doc) + "\n";
};
