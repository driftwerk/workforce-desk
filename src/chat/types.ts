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
}

export const agentKey = (a: Pick<Agent, "hubId" | "id">): string => `${a.hubId}/${a.id}`;

export interface ToolCall {
  name: string;
  done: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at: string;
  status: "complete" | "streaming" | "error";
  tools: ToolCall[];
}

/** What the hub's `/ws` sends (the subset Desk renders). */
export interface ServerMessage {
  type: string;
  content?: string;
  error?: string;
  session_id?: string;
}
