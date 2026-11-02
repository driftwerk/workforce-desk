import { invoke, listen, type VoiceSpec } from "../platform";

/** What the voice engine is doing (`voice-state`). */
export type VoiceStatus =
  | { state: "off" }
  | { state: "downloading"; model: string; progress: number }
  | { state: "listening"; conversation: string | null }
  | { state: "heard-name"; agent: string }
  | { state: "transcribing" }
  | { state: "speaking" }
  /** A cloud session is open; `agent` is the name that opened it. */
  | { state: "live"; agent: string | null };

/** Something said to an agent (`voice-utterance`). `agent` is the roster
 *  name it was addressed to, or null to continue the conversation. */
export interface Utterance {
  agent: string | null;
  text: string;
  /** Set when a cloud voice model asked: answer with `toolResult`, not `speak`. */
  callId?: string;
}

export const enableVoice = (engine: string): Promise<void> => invoke("voice_enable", { engine });

export const disableVoice = (): Promise<void> => invoke("voice_disable");

/** Someone to wake on, and the voice a live engine opens their session in. */
export interface RosterMember {
  name: string;
  voice?: VoiceSpec;
}

export const setVoiceRoster = (roster: RosterMember[]): Promise<void> => invoke("voice_set_roster", { roster });

export const pushToTalk = (pressed: boolean): Promise<void> => invoke("voice_push_to_talk", { pressed });

/** `voice`: the agent's own; the engine's default without one. */
export const speak = (text: string, voice?: VoiceSpec): Promise<void> => invoke("voice_speak", { text, voice });

/** A DM takes the microphone: `"open"`, everything said is for it;
 *  `"held"`, only push-to-talk. `null` gives it back to voice by name. */
export const claimVoice = (mode: "open" | "held" | null): Promise<void> => invoke("voice_claim", { mode });

export const stopSpeaking = (): Promise<void> => invoke("voice_stop_speaking");

/** An agent's answer to what a cloud voice model asked it. */
export const toolResult = (callId: string, text: string): Promise<void> => invoke("voice_tool_result", { callId, text });

export const voiceStatus = (): Promise<VoiceStatus> => invoke("voice_status");

export const onVoiceState = (f: (s: VoiceStatus) => void): Promise<() => void> =>
  listen<VoiceStatus>("voice-state", (e) => f(e.payload));

export const onUtterance = (f: (u: Utterance) => void): Promise<() => void> =>
  listen<Utterance>("voice-utterance", (e) => f(e.payload));

/** Push-to-talk was let go and nothing was said. */
export const onUnheard = (f: () => void): Promise<() => void> => listen("voice-unheard", () => f());

/** What was being read out was stopped (barge-in, push-to-talk, Stop): no more
 *  of that answer is wanted. */
export const onSpeechStopped = (f: () => void): Promise<() => void> => listen("voice-stopped", () => f());

export const onVoiceError = (f: (message: string) => void): Promise<() => void> =>
  listen<string>("voice-error", (e) => f(e.payload));

/** One voice to choose from. */
export interface VoiceOption {
  id: string;
  name: string;
  description: string;
}

/** Plays `text` in `voice`, even with voice off; resolves with what went
 *  wrong (e.g. the hub has no key for that provider), or null. */
export const tryVoice = (voice: VoiceSpec, text: string): Promise<string | null> =>
  invoke<void>("voice_try", { voice, text }).then(
    () => null,
    (e: unknown) => String(e),
  );

export const kokoroVoices = (): Promise<VoiceOption[]> => invoke("voice_kokoro_voices");

/** The voices "kokoro", "gpt-live" or "gemini-live" offer. */
export const engineVoices = (engine: string): Promise<VoiceOption[]> => invoke("voice_engine_voices", { engine });
