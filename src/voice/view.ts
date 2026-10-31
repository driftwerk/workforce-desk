import type { VoiceStatus } from "./api";
import type { MicState } from "./mic";

export type Step = "heard" | "transcribing" | "thinking" | "speaking";

export const STEPS: { step: Step; label: string }[] = [
  { step: "heard", label: "Heard name" },
  { step: "transcribing", label: "Transcribing" },
  { step: "thinking", label: "Thinking" },
  { step: "speaking", label: "Speaking" },
];

export interface PillView {
  /** Who the pill is about: the agent being talked to, if any. */
  agent: string | null;
  title: string;
  detail: string;
  /** Where the turn is, or null outside one. */
  step: Step | null;
  progress: number | null;
}

/** Hold-to-talk as the pill mentions it: its keys, shown the system's way,
 *  and whether Desk got them. */
export interface HoldToTalk {
  label: string;
  available: boolean;
}

/** A DM has the microphone: its agent's name, and whether voice by name
 *  is on (and so paused until it's given back). */
export interface MicHeld {
  name: string;
  byName: boolean;
}

/** What the voice pill says for the engine's state. */
export const pillView = (
  s: VoiceStatus,
  thinking: boolean,
  heardBy: string | null,
  transcript: string,
  hold: HoldToTalk,
  mic: MicHeld | null = null,
): PillView => {
  const quoted = transcript ? `“${transcript}”` : "";
  if (mic && s.state !== "downloading")
    return {
      agent: mic.name,
      title: `${mic.name} has the mic`,
      detail: mic.byName ? "Voice by name is paused until you finish in the DM" : `Talking with ${mic.name} in the DM`,
      step: null,
      progress: null,
    };
  switch (s.state) {
    case "off":
      return { agent: null, title: "Voice is off", detail: "Turn it on to talk to agents by name", step: null, progress: null };
    case "downloading":
      return {
        agent: null,
        title: "Getting voice ready",
        detail: `${Math.round(s.progress * 100)}% · a one-time download, kept on this computer`,
        step: null,
        progress: s.progress,
      };
    case "heard-name":
      return { agent: s.agent, title: `${s.agent} is listening`, detail: "Heard its name · on-device", step: "heard", progress: null };
    case "transcribing":
      return { agent: heardBy, title: "Transcribing…", detail: quoted || "on-device", step: "transcribing", progress: null };
    case "speaking":
      return {
        agent: heardBy,
        title: heardBy ? `${heardBy} is answering` : "Speaking",
        detail: "Talk over it to interrupt",
        step: "speaking",
        progress: null,
      };
    case "live":
      if (thinking && heardBy)
        return { agent: heardBy, title: `${heardBy} is on it`, detail: quoted, step: "thinking", progress: null };
      return {
        agent: s.agent ?? heardBy,
        title: s.agent ? `Talking about ${s.agent}` : "Listening",
        detail: quoted || "Live · say “thanks” to finish",
        step: null,
        progress: null,
      };
    case "listening":
      if (thinking && heardBy)
        return { agent: heardBy, title: `${heardBy} is on it`, detail: quoted, step: "thinking", progress: null };
      if (s.conversation)
        return {
          agent: s.conversation,
          title: `${s.conversation} is listening`,
          detail: quoted || "Say “thanks” to finish",
          step: null,
          progress: null,
        };
      return {
        agent: null,
        title: "Listening for a name",
        detail: hold.available
          ? `Say an agent's name, or hold ${hold.label}`
          : `Say an agent's name · ${hold.label} is taken by another app, change it in Settings`,
        step: null,
        progress: null,
      };
  }
};

/** What a DM's voice bar says. */
export interface DmVoiceView {
  line: string;
  detail: string | null;
  /** The bar says what went wrong. */
  problem: boolean;
  /** Its answer is being read aloud: it can be stopped. */
  speaking: boolean;
  /** This DM has the microphone. */
  live: boolean;
}

/** The voice bar for agent `key` (`name`), or null when its DM has nothing
 *  to say about voice: it doesn't have the microphone, nothing said to it
 *  is waiting, and it isn't being read aloud. */
export const dmVoiceView = (
  key: string,
  name: string,
  mic: MicState,
  status: VoiceStatus,
  waiting: boolean,
  speakingFor: string | null,
  written: boolean,
): DmVoiceView | null => {
  if (mic.problem?.agent === key) return { line: mic.problem.message, detail: null, problem: true, speaking: false, live: false };
  const live = mic.hold === key || (mic.talk === key && !mic.hold);
  const speaking = status.state === "speaking" && speakingFor === key;
  const view = (line: string, detail: string | null = null): DmVoiceView => ({ line, detail, problem: false, speaking, live });
  const answers = written ? `${name} answers in writing` : `${name} answers aloud`;
  if (speaking) return view(`${name} is speaking`, "Talk over it, or stop it");
  if (live) {
    if (status.state === "downloading") return view("Getting voice ready", `${Math.round(status.progress * 100)}% · a one-time download, kept on this computer`);
    if (status.state === "off") return view("Starting the microphone…");
    if (mic.hold === key && mic.pressed) return view("Listening — let go to send", answers);
    if (status.state === "transcribing" || mic.hold === key) return view("Transcribing…", answers);
    if (waiting) return view(`${name} is thinking`, answers);
    return view(`${name} is listening`, answers);
  }
  if (waiting) return view(`${name} is thinking`);
  return null;
};
