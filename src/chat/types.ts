import type { DeskExtras, Step } from "../hub/types";
import type { Picture } from "../pictures/pictures";

/** A hub Desk talks to: the local one, or a remote hub paired as a device. */
export interface HubAccount {
  id: string;
  label: string;
  url: string;
  local: boolean;
  /** Paired-device token: chat and the roster. */
  token: string;
}

export interface Agent {
  hubId: string;
  id: string;
  name: string;
  model: string | null;
  /** What it runs on, as the hub names it: `claude-code`, `chatgpt`, … */
  provider: string | null;
  /** Its hub's default agent. */
  isDefault: boolean;
  /** Its picture, where its hub keeps one. */
  picture?: Picture | null;
}

/** You, as a hub knows you: your account there, your name and picture. */
export interface Me {
  id: string;
  name: string | null;
  picture: Picture | null;
}

const PROVIDERS: Record<string, string> = {
  "claude-code": "Claude plan",
  chatgpt: "ChatGPT plan",
  codex: "ChatGPT plan (Codex)",
  anthropic: "Anthropic API",
  bedrock: "AWS Bedrock",
  "vertex-anthropic": "Google Vertex",
  openrouter: "OpenRouter",
  gemini: "Gemini API",
  grok: "Grok API",
  ollama: "Ollama",
  vllm: "Self-hosted",
  cerebras: "Cerebras",
  zai: "Z.ai",
};

export const providerLabel = (p: string | null): string | null => (p ? (PROVIDERS[p] ?? p) : null);

/** "Local · Claude plan · claude-sonnet-5-5" */
export const describeAgent = (a: Agent, hubLabel: string): string =>
  [hubLabel, providerLabel(a.provider), a.model].filter(Boolean).join(" · ");

export const agentKey = (a: Pick<Agent, "hubId" | "id">): string => `${a.hubId}/${a.id}`;

export interface ToolCall {
  name: string;
  done: boolean;
  /** When its start and end frames came (ms, this computer's clock). */
  startedAt?: number;
  endedAt?: number;
}

/** Who said a DM message, as a hub that says so tells it: you (typed, or
 *  a suggestion you said yes to), the overseer (a nudge or task it sent
 *  on), or the agent. */
export interface Author {
  kind: "you" | "overseer" | "agent";
  id: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at: string;
  status: "complete" | "streaming" | "error";
  tools: ToolCall[];
  /** What an overseer's message mentions to act on in place. */
  desk?: DeskExtras;
  /** Who said it, where the hub says. */
  author?: Author;
  /** A message of yours you didn't type here: sent on by the overseer,
   *  as the hub delivered it live. */
  sentOn?: boolean;
  /** Why the hub delivered it outside a turn: a reminder, a job's answer, … */
  delivery?: DeliveryKind;
  /** The routed approval it asks you to decide. */
  requestId?: string;
  /** Its files. */
  attachments?: Attachment[];
}

// ── Desk as a surface of the hub (mirrors the hub's `workforce_core::desk`) ──

/** The channel of your DM with an agent; each room is `desk:<id>`. */
export const DESK_DM = "desk";

/** What a hub offers Desk, as its `connected` or hub link's `hello` says. */
export const FEATURES = {
  /** Structured turns: a place, a speaker and thread lines. */
  place: "desk.place",
  /** Turn refs, reply ids, snapshots and `turn_end`. */
  stream: "desk.stream",
  /** The hub link and draining conversations by cursor. */
  deliveries: "desk.deliveries",
  /** The hub link says when the person's floor changes. */
  floor: "desk.floor",
  /** The hub link says when the person's plan usage changes. */
  usage: "desk.usage",
} as const;

export type DeliveryKind = "reminder" | "job" | "workflow" | "check_in" | "approval" | "file" | "resumed" | "notice" | "other";

export type DeskPlace =
  | { kind: "dm" }
  | { kind: "room"; room: string; name: string; thread?: string }
  | { kind: "call" }
  | { kind: "legacy_room"; slug: string };

export type DeskSpeaker = { kind: "person" } | { kind: "agent"; name: string };

export interface DeskLine {
  from: string;
  text: string;
}

/** One turn as Desk sends it. */
export interface DeskTurn {
  place: DeskPlace;
  speaker: DeskSpeaker;
  hop: number;
  context: DeskLine[];
  /** The room message it answers. */
  message?: string;
  /** Spoken rather than typed. */
  spoken: boolean;
}

/** What a saved message is in a Desk conversation, beyond its text. */
export interface DeskMark {
  room?: string;
  thread?: string;
  speaker?: DeskSpeaker;
  delivery?: DeliveryKind;
  request_id?: string;
  /** The room message the turn was asked with, which this answers. */
  in_reply_to?: string;
  /** The tools the turn ran. */
  steps?: Step[];
}

/** What a live turn is doing, as a snapshot says. */
export type TurnPhase = "thinking" | "writing" | "working" | "tidying" | "waiting";

/** A file in a conversation, as the hub describes it. Its bytes are on the
 *  hub, in the store of the agent whose conversation it is in, or of the
 *  `hub` and `agent` a room message's file names. */
export interface Attachment {
  artifact_id: string;
  media_type: string;
  filename: string;
  size: number;
  width?: number;
  height?: number;
  /** Seconds, for audio and video. */
  duration?: number;
  /** A small picture of it (a PDF's first page), on the same hub. */
  thumbnail_url?: string | null;
  hub?: string;
  agent?: string;
}

/** A file on a live `image` frame. */
export interface FrameAttachment {
  filename: string;
  mime_type: string;
  artifact_id?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

/** The buttons a permission prompt offers. */
export interface PromptOptions {
  allow_once: boolean;
  deny_once: boolean;
  allow_always: boolean;
  deny_always: boolean;
}

export type PermissionChoice = "allow_once" | "deny_once" | "allow_always" | "deny_always";

/** What the hub's `/ws` and hub link send (the subset Desk renders). */
export interface ServerMessage {
  type: string;
  content?: string;
  error?: string;
  session_id?: string;
  desk?: DeskExtras;
  /** A `user_message`'s id, as the DM's history gives it; on a Desk
   *  connection, the id a turn's answer is saved under. */
  id?: string;
  /** Who said a `user_message`. */
  author?: Author;
  speakable?: boolean;
  /** On `connected` and `hello`: what the hub offers. */
  features?: string[];
  /** The client's own id for the turn a frame belongs to. */
  turn_ref?: string;
  /** On `turn_snapshot`. */
  status?: TurnPhase;
  since?: string;
  text?: string;
  /** On `image`. */
  attachments?: FrameAttachment[];
  /** On `permission_prompt`. */
  request_id?: string;
  tool_name?: string;
  prompt_options?: PromptOptions;
  /** On the hub link's `desk_delivered`. */
  agent_id?: string;
  channel?: string;
  message_id?: string;
  kind?: DeliveryKind;
  place?: DeskPlace;
  spoken?: boolean;
}
