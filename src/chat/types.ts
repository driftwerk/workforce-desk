import type { DeskExtras } from "../hub/types";
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
}

/** What the hub's `/ws` sends (the subset Desk renders). */
export interface ServerMessage {
  type: string;
  content?: string;
  error?: string;
  session_id?: string;
  desk?: DeskExtras;
  /** A `user_message`'s id, as the DM's history gives it. */
  id?: string;
  /** Who said a `user_message`. */
  author?: Author;
  speakable?: boolean;
}
