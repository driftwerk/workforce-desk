import type { DeskExtras, Step } from "../hub/types";
import type { Picture } from "../pictures/pictures";

/** A hub Desk talks to: the local one, or a remote hub paired as a device. */
export interface HubAccount {
  id: string;
  label: string;
  url: string;
  local: boolean;
  /** The machine whose engine this is (see hub/machines.ts), reached with
   *  its device token for chat, the Floor and its link; none for every
   *  other hub. Only its boss is shown of its agents. */
  machine?: string;
  /** Changes whenever Desk's token for the hub does (paired again, or
   *  renewed): an opaque value, never the token, which only Desk's native
   *  side holds. */
  revision: string;
}

const onlyWorkspaces = new WeakMap<readonly HubAccount[], readonly HubAccount[]>();

/** The hubs that are workspaces (this computer's among them): every hub
 *  account but a machine's engine, whose boss alone Desk shows, by its own
 *  path. The same list for the same hubs, so it is safe in a selector. */
export const workspaces = (hubs: readonly HubAccount[]): readonly HubAccount[] => {
  let out = onlyWorkspaces.get(hubs);
  if (!out) {
    out = hubs.some((h) => h.machine) ? hubs.filter((h) => !h.machine) : hubs;
    onlyWorkspaces.set(hubs, out);
  }
  return out;
};

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
  /** How a spoken answer is said, voice directions and all, where that differs
   *  from `content`, which never has them. Only for the voice: nothing shows,
   *  copies or searches it. */
  speech?: string;
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
  /** The kept message it goes before: a live message the hub has passed
   *  without keeping it as it is (an older hub keeps no image of its own). */
  placedBefore?: string;
  /** The kept message that says its words without its files: a live message
   *  whose files show on that one (an older hub keeps no person's files). */
  keptAs?: string;
  /** The Desk turn it answers, where the hub said. */
  turnRef?: string;
  /** An answer the hub's turn end said it didn't keep under the id it
   *  streamed with: its kept copy is known by what it says, as on a hub
   *  that doesn't stream by id. */
  byWords?: boolean;
  /** Desk's own id for a message you sent, which the hub keeps it under: on
   *  a hub with client ids, the kept copy is known by it alone. */
  clientId?: string;
  /** Changed after it was sent: a newer version replaced it, and the turn
   *  that answered the old one was set aside. */
  edited?: boolean;
  /** An answer to a message you deleted since. */
  answeredDeleted?: boolean;
  /** Where a kept message is in the hub's archive: higher was kept later. */
  seq?: number;
  /** The client id of the message whose turn said this: an answer, the
   *  tools it ran, or what it failed with. */
  replyTo?: string;
  /** The tools the turn that said it ran, as the hub kept them. */
  steps?: Step[];
  /** A turn's failure that a later answer has replaced: shown folded away. */
  superseded?: boolean;
  /** A command the hub answered itself (`/status`, `cmd: help`, an unknown
   *  `/word`), or its answer: shown as a command, kept nowhere, and so
   *  shown only here, settled. */
  command?: boolean;
  /** A live message whose turn is over and that the hub kept no copy of (a
   *  command, a refusal): it goes by its place among what was kept, never
   *  waiting on a copy that won't come. */
  unkept?: boolean;
  /** A message you sent that the hub never said it had: not confirmed in
   *  time, or lost with the connection. Offered again or taken away. */
  undelivered?: boolean;
  /** The client id of the next message sent from here after it: a live
   *  message no read will name goes before that one once it is kept,
   *  whatever the clocks say. */
  before?: string;
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
  /** A message may be sent to wait for the running turn: refused as busy
   *  while it works, rather than steering it. */
  queue: "desk.queue",
  /** The DM's read names Desk's own id for each message sent under one, and
   *  each kept row's place in the archive: a live message is known by its
   *  id alone. A hub without it is matched by words (./legacy.ts). */
  clientIds: "desk.client_ids",
  /** A DM turn may replace your latest message (`edit`): the hub sets the
   *  old one and everything after it aside, and tells the agent what the
   *  set-aside reply did. */
  edit: "desk.edit",
  /** Your own DM messages can be deleted, with the memories saved from
   *  them (./remove.ts); the replies to one are marked `answered_deleted`. */
  delete: "desk.delete",
  /** A DM's whole history can be searched on the hub, and read around a
   *  match (./search.ts). */
  search: "desk.search",
  /** A room turn may name the room's members (`members`), which the hub
   *  tells the agent in its own words. A hub without it is told them as a
   *  line of the room's, from Desk. */
  roster: "desk.roster",
} as const;

export type DeliveryKind = "reminder" | "job" | "workflow" | "check_in" | "approval" | "file" | "resumed" | "notice" | "plan" | "other";

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
  /** Its answer is heard. Kept in step with `voice` for hubs that predate it. */
  spoken: boolean;
  /** Said rather than typed: how the answer comes back, and the voice that
   *  reads it when it's heard. The hub turns this into how the agent talks. */
  voice?: DeskVoice;
  /** Who is in the room, for a hub that takes them (`desk.roster`). */
  members?: DeskMember[];
  /** In a DM, on a hub with `desk.edit`: this replaces your latest message,
   *  `replaces` (the id the hub keeps it under). */
  edit?: { replaces: string };
}

/** A room's member, as a room turn names them. */
export interface DeskMember {
  name: string;
  /** The workspace it is on, by the name Desk shows. */
  hub: string;
  /** The room's lead: who answers what names no one. */
  lead: boolean;
  /** Asked the same message, answering alongside: its answer to it isn't
   *  there to read yet. */
  asked?: boolean;
}

/** How a spoken turn is answered: aloud, in `speech` (the voice Desk will
 *  read it in, so the agent can use what that voice performs), or in
 *  writing (dictation). */
export interface DeskVoice {
  reply: "spoken" | "written";
  speech?: { provider: string; model?: string };
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
  /** What the turn asked with `in_reply_to` failed with, said instead of an
   *  answer. */
  failed?: boolean;
  /** A newer version of the message, which replaced it. */
  edited?: boolean;
  /** An answer to a message the person deleted since. */
  answered_deleted?: boolean;
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

/** What a call on this computer would do, as the hub resolved it: the card
 *  shows these, never the agent's own summary. */
export interface ComputerFacts {
  /** read | write | delete | exec | session | connector | unknown */
  effect: string;
  /** Real paths, as you read them (`~/…`). */
  paths?: string[];
  command?: string;
  cwd?: string;
  connector?: string;
  /** Why it asks: "Outside its folder", "Can't be undone", … */
  why: string;
}

/** The buttons a permission prompt offers. A hub before Desk's grants sends
 *  only the first four, and its card offers Allow once and Deny. */
export interface PromptOptions {
  allow_once: boolean;
  deny_once: boolean;
  allow_always: boolean;
  deny_always: boolean;
  /** "Allow for this session" (a call on this computer). */
  allow_session?: boolean;
  /** "Always allow in …": the folder as you read it, or the connector. */
  allow_in_folder?: string | null;
  /** On a call on this computer: what it would do. */
  facts?: ComputerFacts | null;
}

export type PermissionChoice = "allow_once" | "deny_once" | "allow_always" | "deny_always" | "allow_session" | "allow_in_folder";

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
  /** On a spoken turn's `stream_delta` and `message`: what to say for this
   *  frame, where that differs from `content`. */
  speech?: string;
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
  /** On `turn_end`: the turn was a command the hub answered itself, and
   *  neither its message nor its answer is kept. */
  command?: boolean;
}
