import type { VoiceStatus } from "./api";

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

/** What the voice pill says for the engine's state. */
export const pillView = (
  s: VoiceStatus,
  thinking: boolean,
  heardBy: string | null,
  transcript: string,
  hold: HoldToTalk,
): PillView => {
  const quoted = transcript ? `“${transcript}”` : "";
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
