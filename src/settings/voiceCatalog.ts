import { invoke, type CustomVoice, type VoiceSpec } from "../platform";

export interface VoiceChoice {
  id: string;
  name: string;
  description: string;
  /** Added by its id, not one of Desk's recommendations. */
  custom?: boolean;
}

export interface ModelChoice {
  id: string;
  name: string;
  note: string;
}

export interface VoiceProvider {
  id: string;
  name: string;
  blurb: string;
  /** Where its key lives, for providers that need one. */
  keyPath?: string;
  models: ModelChoice[];
  /** Fixed recommendations, or loaded from the voice engine. */
  voices: VoiceChoice[] | "engine";
  /** Takes any voice by its id (a cloned or community voice): where to
   *  find one. */
  customIds?: string;
}

export const VOICE_PROVIDERS: VoiceProvider[] = [
  {
    id: "fish_audio",
    name: "Fish Audio",
    blurb: "Natural cloud voices at a fraction of ElevenLabs’ price.",
    keyPath: "speech/fish_audio/api_key",
    customIds: "The id in a voice’s address on fish.audio — yours, or any public voice.",
    models: [{ id: "s1", name: "S1", note: "Fish Audio’s current model" }],
    voices: [
      { id: "802e3bc2b27e49c2995d23ef70e6ac89", name: "Energetic Male", description: "Clear, professional American accent" },
      { id: "933563129e564b19a115bedd57b7406a", name: "Sarah", description: "Soft, conversational female voice" },
      { id: "bf322df2096a46f18c579d0baa36f41d", name: "Adrian", description: "Deep, measured male narrator" },
      { id: "536d3a5e000945adb7038665781a4aca", name: "Ethan", description: "Calm, authoritative male explainer" },
      { id: "b347db033a6549378b48d00acb0d06cd", name: "Selene", description: "Soft, gentle female voice" },
      { id: "8ef4a238714b45718ce04243307c57a7", name: "E-girl", description: "Warm, soothing female voice" },
      { id: "f772ea09ebe04f66bd3e4a2be1e17329", name: "Alex", description: "Expressive male narrator" },
      { id: "5e79e8f5d2b345f98baa8c83c947532d", name: "Paddington", description: "Deep, resonant British narrator" },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    blurb: "Premium cloud voices.",
    keyPath: "speech/elevenlabs/api_key",
    customIds: "The Voice ID from My Voices on elevenlabs.io — a clone of yours, or one added from the Voice Library.",
    models: [
      { id: "eleven_multilingual_v2", name: "Multilingual v2", note: "Best quality" },
      { id: "eleven_flash_v2_5", name: "Flash v2.5", note: "Fastest, cheapest" },
    ],
    voices: [
      { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "Warm, friendly female voice" },
      { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "Clear, professional female voice" },
      { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", description: "Strong, confident female voice" },
      { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", description: "Natural, casual male voice" },
      { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", description: "Young, energetic male voice" },
      { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", description: "Deep, authoritative male voice" },
      { id: "ThT5KcBeYPX3keUQqHPh", name: "Dorothy", description: "Warm, soothing female voice" },
      { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", description: "Strong, confident male voice" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    blurb: "OpenAI’s text-to-speech voices.",
    keyPath: "speech/openai/api_key",
    models: [{ id: "gpt-4o-mini-tts", name: "GPT-4o mini TTS", note: "Steerable, low latency" }],
    voices: [
      { id: "alloy", name: "Alloy", description: "Neutral and balanced" },
      { id: "ash", name: "Ash", description: "Clear and direct" },
      { id: "coral", name: "Coral", description: "Warm and friendly" },
      { id: "echo", name: "Echo", description: "Calm male voice" },
      { id: "fable", name: "Fable", description: "Expressive British storyteller" },
      { id: "nova", name: "Nova", description: "Bright female voice" },
      { id: "onyx", name: "Onyx", description: "Deep male voice" },
      { id: "sage", name: "Sage", description: "Soft and thoughtful" },
      { id: "shimmer", name: "Shimmer", description: "Light and upbeat" },
    ],
  },
  {
    id: "kokoro",
    name: "Kokoro",
    blurb: "Runs on this computer — free and private, no key needed.",
    models: [{ id: "kokoro-v1_0", name: "Kokoro v1.0", note: "On this computer" }],
    voices: "engine",
  },
  {
    id: "gpt-live",
    name: "GPT-Live",
    blurb: "OpenAI’s live conversation engine, with its own voices. Uses the OpenAI key.",
    keyPath: "speech/openai/api_key",
    models: [{ id: "gpt-live-1", name: "GPT-Live", note: "Talks back as you speak" }],
    voices: "engine",
  },
  {
    id: "gemini-live",
    name: "Gemini Live",
    blurb: "Google’s live conversation engine, with its own voices.",
    keyPath: "speech/gemini/api_key",
    models: [{ id: "gemini-live", name: "Gemini Live", note: "Talks back as you speak" }],
    voices: "engine",
  },
];

export const providerById = (id: string): VoiceProvider | undefined => VOICE_PROVIDERS.find((p) => p.id === id);

/** Voices the voice engine itself knows (Kokoro's speakers, the live
 *  engines' voices). */
export const engineVoices = (provider: string): Promise<VoiceChoice[]> =>
  provider === "kokoro" ? invoke("voice_kokoro_voices") : invoke("voice_engine_voices", { engine: provider });

export const voicesOf = async (p: VoiceProvider): Promise<VoiceChoice[]> =>
  p.voices === "engine" ? engineVoices(p.id) : p.voices;

/** A provider's voices with the ones added by id after Desk's own (once
 *  each). */
export const withCustom = (voices: VoiceChoice[], custom: CustomVoice[] | undefined): VoiceChoice[] => [
  ...voices,
  ...(custom ?? [])
    .filter((c) => !voices.some((v) => v.id === c.id))
    .map((c) => ({ id: c.id, name: c.name, description: c.description ?? "Added by its id", custom: true })),
];

/** What a provider said about a voice id (see `voice_lookup`). */
export type VoiceLookup =
  | { state: "found"; name: string; description?: string }
  | { state: "not-found" }
  | { state: "no-key" }
  | { state: "key-refused"; message: string }
  | { state: "failed"; message: string };

/** Asks the provider for voice `id`, with the key Desk keeps for it; the key
 *  itself never leaves the app's native side. */
export const lookupVoice = async (provider: string, id: string): Promise<VoiceLookup> => {
  try {
    const found = await invoke<VoiceLookup | undefined>("voice_lookup", { provider, voice: id.trim() });
    return found ?? { state: "failed", message: "Looking a voice up needs the Desk app." };
  } catch (e) {
    return { state: "failed", message: String(e) };
  }
};

/** A lookup in plain words, for anything but a found voice. */
export const lookupProblem = (l: VoiceLookup, provider: VoiceProvider): string | null => {
  switch (l.state) {
    case "found":
      return null;
    case "not-found":
      return `${provider.name} has no voice with that id. Check it, and that it’s shared with your account if it’s private.`;
    case "no-key":
      return `Add your ${provider.name} key first: Desk uses it to find the voice.`;
    case "key-refused":
      return `Your ${provider.name} key can’t read that voice: ${l.message}`;
    case "failed":
      return l.message;
  }
};

/** "Fish Audio · Sarah" */
export const describeVoice = (spec: VoiceSpec, voices: VoiceChoice[] = []): string => {
  const p = providerById(spec.provider);
  const v = voices.find((x) => x.id === spec.voice) ?? (Array.isArray(p?.voices) ? p.voices.find((x) => x.id === spec.voice) : undefined);
  return [p?.name ?? spec.provider, v?.name ?? spec.voice].filter(Boolean).join(" · ");
};

/** Plays a voice saying `text`; resolves with an error message, or null. */
export const tryVoice = (voice: VoiceSpec, text: string): Promise<string | null> =>
  invoke<void>("voice_try", { voice, text }).then(
    () => null,
    (e: unknown) => String(e),
  );

export const sampleLine = (agentName: string): string => `Hi, I’m ${agentName}. This is how I sound.`;
