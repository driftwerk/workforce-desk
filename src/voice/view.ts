import type { ChatMessage } from "../chat/types";
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

/** A DM has the microphone: its agent's name, whether voice by name is on
 *  (and so paused until it's given back), and whether it's a spoken
 *  conversation, which the title bar's pill shows instead. */
export interface MicHeld {
  name: string;
  byName: boolean;
  talk: boolean;
}

const OFF: PillView = { agent: null, title: "Voice is off", detail: "Turn it on to talk to agents by name", step: null, progress: null };

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
  if (mic?.talk)
    return mic.byName ? { agent: null, title: "Voice by name is paused", detail: `While you talk with ${mic.name}`, step: null, progress: null } : OFF;
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
      return OFF;
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
  if (mic.talk === key && mic.muted && !(mic.hold === key && mic.pressed)) return view("You’re muted", "Unmute to talk again");
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

/** What the title bar's pill says of the spoken conversation. */
export interface TalkView {
  agent: string;
  tone: "live" | "busy" | "muted" | "problem";
  line: string;
  /** How long it has been going belongs after the line. */
  elapsed: boolean;
  /** The agent's answer is being read aloud: it can be stopped. */
  speaking: boolean;
}

/** The pill for the spoken conversation, or for why the microphone couldn't
 *  be had for one (`blocked`: the system keeps it from Desk); null with
 *  neither. */
export const talkView = (mic: MicState, status: VoiceStatus, waiting: boolean, speakingFor: string | null, blocked: boolean): TalkView | null => {
  if (mic.problem) return { agent: mic.problem.agent, tone: "problem", line: blocked ? "Microphone blocked — fix" : "Microphone problem — fix", elapsed: false, speaking: false };
  const agent = mic.talk;
  if (!agent) return null;
  const view = (tone: TalkView["tone"], line: string, extra: Partial<TalkView> = {}): TalkView => ({ agent, tone, line, elapsed: false, speaking: false, ...extra });
  if (status.state === "downloading") return view("busy", `Getting voice ready · ${Math.round(status.progress * 100)}%`);
  if (status.state === "off") return view("busy", "Starting…");
  if (status.state === "speaking" && speakingFor === agent) return view("live", "Speaking", { speaking: true });
  if (mic.hold === agent && mic.pressed) return view("live", "Listening — let go to send");
  if (waiting) return view("busy", "Thinking…");
  if (status.state === "transcribing" || mic.hold === agent) return view("busy", "Transcribing…");
  if (mic.muted) return view("muted", "Muted — tap to talk");
  if (mic.hold) return view("muted", "Paused");
  return view("live", "Listening", { elapsed: true });
};

/** A duration as a clock: `m:ss`, hours in the minutes. */
export const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The last thing you said in a conversation since `since` (ms), and what
 *  the agent answered after it. */
export const lastExchange = (messages: readonly ChatMessage[], since: number): { you: string | null; agent: string | null } => {
  const recent = messages.filter((m) => m.status !== "error" && Date.parse(m.at) >= since && m.content.trim());
  const at = recent.findLastIndex((m) => m.role === "user");
  const reply = recent.slice(at + 1).findLast((m) => m.role === "assistant");
  return { you: at >= 0 ? recent[at]!.content : null, agent: reply?.content ?? null };
};
