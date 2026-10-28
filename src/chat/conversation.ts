import type { ChatMessage, HubAccount, ServerMessage } from "./types";

/** A turn in progress: from the moment you send until the answer is in. */
export interface Working {
  since: number;
  /** What the agent is doing right now, in plain words. */
  step: string;
}

export interface ConversationState {
  connected: boolean;
  sessionId: string | null;
  messages: ChatMessage[];
  typing: boolean;
  streaming: boolean;
  working: Working | null;
  /** A turn the person didn't start (one the overseer asked for, a
   *  schedule's) is running; its prompt isn't sent live, only kept. */
  unprompted: boolean;
}

export const emptyConversation = (): ConversationState => ({
  connected: false,
  sessionId: null,
  messages: [],
  typing: false,
  streaming: false,
  working: null,
  unprompted: false,
});

/** `memory.recall: token refresh` → `memory.recall — token refresh`. */
export const toolStep = (raw: string): string => {
  const [name, ...rest] = raw.split(": ");
  const detail = rest.join(": ").trim();
  return detail ? `${name} — ${detail.length > 80 ? `${detail.slice(0, 80)}…` : detail}` : (name ?? raw);
};

const step = (s: ConversationState, text: string): Working | null =>
  s.working ? { ...s.working, step: text } : { since: Date.now(), step: text };

let counter = 0;
const nextId = () => `m-${Date.now()}-${++counter}`;

const message = (role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "complete"): ChatMessage => ({
  id: nextId(),
  role,
  content,
  at: new Date().toISOString(),
  status,
  tools: [],
});

const closeStreaming = (msgs: ChatMessage[]): ChatMessage[] =>
  msgs.map((m) => (m.status === "streaming" ? { ...m, status: "complete" } : m));

const updateLast = (msgs: ChatMessage[], f: (m: ChatMessage) => ChatMessage): ChatMessage[] => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant") return [...msgs.slice(0, i), f(m), ...msgs.slice(i + 1)];
  }
  return msgs;
};

/** Folds one server message into the conversation. Pure, so it is tested
 *  without a socket. */
export const reduce = (s: ConversationState, msg: ServerMessage): ConversationState => {
  const next = fold(s, msg);
  // A turn that starts while nothing was sent isn't the person's.
  const unprompted = next.working ? (s.working ? s.unprompted : true) : false;
  return next.unprompted === unprompted ? next : { ...next, unprompted };
};

const fold = (s: ConversationState, msg: ServerMessage): ConversationState => {
  const sessionId = msg.session_id ?? s.sessionId;
  switch (msg.type) {
    case "connected":
      return { ...s, sessionId };
    case "typing":
      return { ...s, typing: true, working: step(s, "Thinking") };
    case "compact_start":
      return { ...s, working: step(s, "Tidying up its context") };
    case "compact_end":
      return { ...s, working: s.working && step(s, "Thinking") };
    case "stream_start": {
      const last = s.messages.at(-1);
      // Tools ran ahead of the answer: it streams into that same message.
      const toolsOnly = last?.role === "assistant" && last.status === "streaming" && last.content === "";
      return {
        ...s,
        sessionId,
        typing: false,
        streaming: true,
        working: step(s, "Writing"),
        messages: toolsOnly ? s.messages : [...closeStreaming(s.messages), message("assistant", "", "streaming")],
      };
    }
    case "stream_delta": {
      const last = s.messages.at(-1);
      if (!last || last.status !== "streaming") return s;
      return { ...s, messages: [...s.messages.slice(0, -1), { ...last, content: last.content + (msg.content ?? "") }] };
    }
    case "stream_discard":
      return { ...s, streaming: false, typing: true, messages: s.messages.filter((m) => m.status !== "streaming") };
    case "stream_end": {
      const messages = closeStreaming(s.messages);
      return { ...s, streaming: false, working: null, messages: msg.desk ? updateLast(messages, (m) => ({ ...m, desk: msg.desk })) : messages };
    }
    case "message": {
      const content = msg.content ?? "";
      const last = s.messages.at(-1);
      const desk = msg.desk ? { desk: msg.desk } : {};
      // A non-streamed answer that repeats what just streamed is the same
      // answer (what it mentions to act on may come only with this copy).
      if (last?.role === "assistant" && last.content === content)
        return {
          ...s,
          typing: false,
          streaming: false,
          working: null,
          messages: msg.desk ? [...s.messages.slice(0, -1), { ...last, ...desk }] : s.messages,
        };
      // Tools ran ahead of the answer: the answer belongs to that message.
      if (last?.role === "assistant" && last.status === "streaming" && last.content === "")
        return {
          ...s,
          sessionId,
          typing: false,
          streaming: false,
          working: null,
          messages: [...s.messages.slice(0, -1), { ...last, content, status: "complete", ...desk }],
        };
      return {
        ...s,
        sessionId,
        typing: false,
        streaming: false,
        working: null,
        messages: [...closeStreaming(s.messages), { ...message("assistant", content), ...desk }],
      };
    }
    case "tool_start": {
      const tool = { name: msg.content ?? "tool", done: false };
      const hasAnswer = s.messages.at(-1)?.role === "assistant";
      const messages = hasAnswer
        ? updateLast(s.messages, (m) => ({ ...m, tools: [...m.tools, tool] }))
        : [...s.messages, { ...message("assistant", "", "streaming"), tools: [tool] }];
      return { ...s, messages, working: step(s, toolStep(msg.content ?? "tool")) };
    }
    case "tool_end":
      return {
        ...s,
        working: s.working && step(s, "Thinking"),
        messages: updateLast(s.messages, (m) => {
          const i = m.tools.findIndex((t) => !t.done);
          return i < 0 ? m : { ...m, tools: m.tools.map((t, j) => (j === i ? { ...t, done: true } : t)) };
        }),
      };
    case "error":
      return {
        ...s,
        typing: false,
        streaming: false,
        working: null,
        messages: [...closeStreaming(s.messages), message("system", msg.error ?? msg.content ?? "Something went wrong", "error")],
      };
    default:
      return s;
  }
};

/** Every block @workforce/rich renders; the hub teaches an agent only the
 *  ones it has enabled. */
export const RICH_KINDS = ["tables", "charts", "forms", "maps", "diagrams", "images"] as const;

export const wsUrl = (hub: HubAccount, agentId: string, channel = "desk"): string => {
  const u = new URL("/ws", hub.url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", hub.token);
  u.searchParams.set("agent_id", agentId);
  u.searchParams.set("channel", channel);
  u.searchParams.set("rich", RICH_KINDS.join(","));
  return u.toString();
};

/** Answers that finished in this step: assistant messages that became
 *  complete with something to say. */
export const finishedAnswers = (before: ConversationState, after: ConversationState): ChatMessage[] => {
  const was = new Map(before.messages.map((m) => [m.id, m.status]));
  return after.messages.filter(
    (m) => m.role === "assistant" && m.status === "complete" && m.content.trim() !== "" && was.get(m.id) !== "complete",
  );
};

/** One DM: a `/ws` connection to an agent, reconnecting until closed. */
export class Conversation {
  private ws: WebSocket | null = null;
  private state: ConversationState = emptyConversation();
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly hub: HubAccount,
    private readonly agentId: string,
    private readonly onChange: (s: ConversationState) => void,
    private readonly channel = "desk",
    private readonly onAnswer?: (content: string) => void,
  ) {
    this.open();
  }

  private set(s: ConversationState) {
    const before = this.state;
    this.state = s;
    this.onChange(s);
    if (this.onAnswer) for (const m of finishedAnswers(before, s)) this.onAnswer(m.content);
  }

  get connected(): boolean {
    return this.state.connected;
  }

  private open() {
    const ws = new WebSocket(wsUrl(this.hub, this.agentId, this.channel));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ ...this.state, connected: true });
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 30_000);
    };
    ws.onmessage = (e) => {
      try {
        this.set(reduce(this.state, JSON.parse(e.data as string) as ServerMessage));
      } catch {
        /* not a message Desk renders */
      }
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      this.set({ ...this.state, connected: false, typing: false, streaming: false, working: null, unprompted: false });
      if (!this.closed) this.timer = setTimeout(() => this.open(), Math.min(30_000, 1000 * 2 ** this.retry++));
    };
  }

  send(content: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !content.trim()) return false;
    this.ws.send(
      JSON.stringify({ type: "chat", content, session_id: this.state.sessionId, channel: this.channel, agent_id: this.agentId }),
    );
    this.set({
      ...this.state,
      messages: [...this.state.messages, message("user", content)],
      working: { since: Date.now(), step: "Sending" },
    });
    return true;
  }

  cancel() {
    if (this.ws?.readyState === WebSocket.OPEN && this.state.sessionId)
      this.ws.send(JSON.stringify({ type: "cancel", session_id: this.state.sessionId }));
    this.set({
      ...this.state,
      typing: false,
      streaming: false,
      working: null,
      unprompted: false,
      messages: closeStreaming(this.state.messages),
    });
  }

  /** Forgets live messages the hub's kept copy now shows. */
  drop(ids: ReadonlySet<string>) {
    if (ids.size === 0) return;
    this.set({ ...this.state, messages: this.state.messages.filter((m) => !ids.has(m.id)) });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.ws?.close();
  }
}
