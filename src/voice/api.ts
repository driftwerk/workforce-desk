import { invoke, listen } from "../platform";

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

export const setVoiceNames = (names: string[]): Promise<void> => invoke("voice_set_names", { names });

export const pushToTalk = (pressed: boolean): Promise<void> => invoke("voice_push_to_talk", { pressed });

/** `more`: an acknowledgement, with the answer still to come. */
export const speak = (text: string, more = false): Promise<void> => invoke("voice_speak", { text, more });

export const stopSpeaking = (): Promise<void> => invoke("voice_stop_speaking");

/** An agent's answer to what a cloud voice model asked it. */
export const toolResult = (callId: string, text: string): Promise<void> => invoke("voice_tool_result", { callId, text });

export const voiceStatus = (): Promise<VoiceStatus> => invoke("voice_status");

export const onVoiceState = (f: (s: VoiceStatus) => void): Promise<() => void> =>
  listen<VoiceStatus>("voice-state", (e) => f(e.payload));

export const onUtterance = (f: (u: Utterance) => void): Promise<() => void> =>
  listen<Utterance>("voice-utterance", (e) => f(e.payload));

export const onVoiceError = (f: (message: string) => void): Promise<() => void> =>
  listen<string>("voice-error", (e) => f(e.payload));
