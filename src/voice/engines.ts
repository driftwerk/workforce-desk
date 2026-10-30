/** The voice engines Desk can run. The setting is a plain string, so one a
 *  newer Desk adds reads here as the default. */
export interface VoiceEngineInfo {
  id: string;
  label: string;
  /** Where speech goes, said plainly where the person turns voice on. */
  privacy: string;
  /** Answers go back to the model as tool results instead of being spoken. */
  cloud: boolean;
}

export const VOICE_ENGINES: readonly VoiceEngineInfo[] = [
  {
    id: "cascade",
    label: "On this computer",
    privacy: "Speech is recognised and spoken on this computer; the first time, Desk downloads about 240 MB of speech models.",
    cloud: false,
  },
  {
    id: "gpt-live",
    label: "OpenAI GPT-Live",
    privacy:
      "Names are heard on this computer (an 18 MB download); from the name, or while you hold the key, your voice goes to OpenAI until you say “thanks” or go quiet. Uses the OpenAI key under Plans.",
    cloud: true,
  },
  {
    id: "gemini-live",
    label: "Gemini Live",
    privacy:
      "Names are heard on this computer (an 18 MB download); from the name, or while you hold the key, your voice goes to Google until you say “thanks” or go quiet. Uses the Gemini key under Plans.",
    cloud: true,
  },
];

export const voiceEngine = (id: string | undefined): VoiceEngineInfo =>
  VOICE_ENGINES.find((e) => e.id === id) ?? VOICE_ENGINES[0]!;
