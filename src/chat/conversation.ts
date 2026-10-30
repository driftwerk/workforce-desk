import { authorOf } from "./history";
import {
  FEATURES,
  type Attachment,
  type ChatMessage,
  type DeskTurn,
  type FrameAttachment,
  type HubAccount,
  type PermissionChoice,
  type PromptOptions,
  type ServerMessage,
  type ToolCall,
  type TurnPhase,
} from "./types";

/** What a turn is doing: sending, waiting on the model, writing, running a
 *  tool, tidying its context, or held by a rate limit or a model switch. */
export type Phase = "sending" | TurnPhase;

/** A turn in progress: from the moment you send until the answer is in. */
export interface Working {
  since: number;
  phase: Phase;
  /** What the agent is doing right now, in plain words. */
  step: string;
  /** When it started doing it. */
  at: number;
  /** Seconds it is waiting, for a rate limit. */
  wait?: number;
}

/** A turn of a Desk connection, by the ref Desk gave it: what it has said so
 *  far and what it is doing, until the hub says it ended. `stalled` while
 *  the socket is down, until a snapshot says it is still going. */
export interface Turn {
  ref: string;
  /** The id its answer is saved under, once the hub says. */
  replyId: string | null;
  text: string;
  working: Working | null;
  tools: ToolCall[];
  attachments: Attachment[];
  state: "live" | "stalled" | "ended" | "failed";
  error?: string;
  /** The hub has sent a frame of it: it is a turn of its own, not one
   *  taken into a live turn. */
  acked: boolean;
}

/** A tool call waiting for you to allow or deny it. */
export interface Prompt {
  requestId: string;
  /** What it would do, in the hub's words. */
  content: string;
  tool: string;
  options: PromptOptions;
  /** The turn asking, on a Desk connection. */
  turnRef: string | null;
}

export interface ConversationState {
  connected: boolean;
  sessionId: string | null;
  /** What the hub offers this connection; null until it says. */
  features: ReadonlySet<string> | null;
  messages: ChatMessage[];
  typing: boolean;
  streaming: boolean;
  working: Working | null;
  /** A turn the person didn't start (a schedule's, or one the overseer
   *  asked for on a hub that doesn't send it live) is running; its prompt
   *  isn't sent live, only kept. */
  unprompted: boolean;
  /** The turns Desk asked for, by ref, on a hub that streams them. */
  turns: Record<string, Turn>;
  prompts: Prompt[];
  /** Messages the hub has taken into a live turn instead of starting one. */
  absorbed: number;
}

export const emptyConversation = (): ConversationState => ({
  connected: false,
  sessionId: null,
  features: null,
  messages: [],
  typing: false,
  streaming: false,
  working: null,
  unprompted: false,
  turns: {},
  prompts: [],
  absorbed: 0,
});

/** `memory.recall: token refresh` → `memory.recall — token refresh`. */
export const toolStep = (raw: string): string => {
  const [name, ...rest] = raw.split(": ");
  const detail = rest.join(": ").trim();
  return detail ? `${name} — ${detail.length > 80 ? `${detail.slice(0, 80)}…` : detail}` : (name ?? raw);
};

const STEPS: Record<TurnPhase, string> = {
  thinking: "Thinking",
  writing: "Writing",
  working: "Working",
  tidying: "Tidying its context",
  waiting: "Waiting",
};

/** `pacing under provider rate limit, ~30s wait` / `rate-limited, retry #2 in 30s` → 30. */
const waitOf = (line: string): number | undefined => {
  const s = /(\d+)s\b/.exec(line)?.[1];
  return s === undefined ? undefined : Number(s);
};

/** `gpt-x produced nothing for 45s — switching model` → `gpt-x`. */
const silentModel = (line: string): string => line.split(" produced nothing")[0]?.trim() || "the model";

/** What `msg` says the turn is doing now, if it says. */
const doing = (msg: ServerMessage): Pick<Working, "phase" | "step" | "wait"> | null => {
  switch (msg.type) {
    case "typing":
      return { phase: "thinking", step: STEPS.thinking };
    case "tool_start":
      return { phase: "working", step: toolStep(msg.content ?? "tool") };
    case "tool_end":
    case "compact_end":
      return { phase: "thinking", step: STEPS.thinking };
    case "compact_start":
      return { phase: "tidying", step: STEPS.tidying };
    case "stream_start":
      return { phase: "writing", step: STEPS.writing };
    case "rate_limited":
      return { phase: "waiting", step: "Retrying (rate limited)", wait: waitOf(msg.content ?? "") };
    case "slow_model_failover":
      return { phase: "waiting", step: `Switching model (${silentModel(msg.content ?? "")} was silent)` };
    default:
      return null;
  }
};

/** `w` moved on to `next`, timed from now unless it is still doing the same. */
const moved = (w: Working | null, next: Pick<Working, "phase" | "step" | "wait">, now: number): Working =>
  w && w.step === next.step && w.phase === next.phase
    ? { ...w, wait: next.wait }
    : { since: w?.since ?? now, at: now, ...next };

/** A snapshot's view of what the turn is doing, since `since`. */
const snapshotWorking = (msg: ServerMessage, now: number): Working => {
  const since = Date.parse(msg.since ?? "");
  const start = Number.isNaN(since) ? now : since;
  const phase = msg.status ?? "thinking";
  return { since: start, at: start, phase, step: STEPS[phase] };
};

const elapsed = (s: number): string => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

/** How long before a step's time is worth showing. */
const SHOW_TIMER_AFTER_S = 3;

/** The status line of `w` at `now`: "Thinking · 12s", a tool's line, a
 *  rate limit's countdown. */
export const statusOf = (w: Working, now: number): string => {
  const secs = Math.max(0, Math.floor((now - w.at) / 1000));
  if (w.wait !== undefined) return `${w.step} · ${Math.max(0, w.wait - secs)}s`;
  const timed = w.phase === "thinking" || w.phase === "working" || w.phase === "sending";
  return timed && secs >= SHOW_TIMER_AFTER_S ? `${w.step} · ${elapsed(secs)}` : w.step;
};

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

/** A live frame's file as a conversation's message carries it. */
export const fromFrame = (a: FrameAttachment): Attachment | null =>
  a.artifact_id
    ? {
        artifact_id: a.artifact_id,
        media_type: a.mime_type,
        filename: a.filename,
        size: a.size ?? 0,
        ...(a.width !== undefined ? { width: a.width } : {}),
        ...(a.height !== undefined ? { height: a.height } : {}),
        ...(a.duration !== undefined ? { duration: a.duration } : {}),
      }
    : null;

const framed = (msg: ServerMessage): Attachment[] => (msg.attachments ?? []).flatMap((a) => fromFrame(a) ?? []);

/** `files` added to `have`, each once. */
const withFiles = (have: Attachment[] | undefined, files: Attachment[]): Attachment[] => [
  ...(have ?? []),
  ...files.filter((f) => !have?.some((h) => h.artifact_id === f.artifact_id)),
];

const closeStreaming = (msgs: ChatMessage[]): ChatMessage[] =>
  msgs.map((m) => (m.status === "streaming" ? { ...m, status: "complete" } : m));

const updateLast = (msgs: ChatMessage[], f: (m: ChatMessage) => ChatMessage): ChatMessage[] => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant") return [...msgs.slice(0, i), f(m), ...msgs.slice(i + 1)];
  }
  return msgs;
};

const update = (msgs: ChatMessage[], id: string, f: (m: ChatMessage) => ChatMessage): ChatMessage[] =>
  msgs.map((m) => (m.id === id ? f(m) : m));

/** Whether the hub streams this connection's turns by ref and id. */
const streams = (s: ConversationState): boolean => !!s.features?.has(FEATURES.stream);

/** Folds one server message into the conversation. Pure, so it is tested
 *  without a socket. */
export const reduce = (s: ConversationState, msg: ServerMessage): ConversationState => {
  const now = Date.now();
  const folded = fold(s, msg, now);
  const next = {
    ...folded,
    turns: msg.turn_ref ? foldTurn(folded.turns, msg.turn_ref, msg, now) : folded.turns,
    prompts: foldPrompts(folded.prompts, msg),
  };
  // A turn that starts while nothing was sent isn't the person's, and its
  // prompt is only kept, unless the hub sends it on live.
  const unprompted = !next.working || msg.type === USER_MESSAGE ? false : s.working ? s.unprompted : true;
  return next.unprompted === unprompted ? next : { ...next, unprompted };
};

/** The frame a message of the DM you didn't type here comes as: the
 *  overseer's nudge or task, or a suggestion of its you said yes to. */
export const USER_MESSAGE = "user_message";

/** What the hub refuses a turn with when one is running elsewhere in Desk. */
export const BUSY = "busy";

const foldPrompts = (prompts: Prompt[], msg: ServerMessage): Prompt[] => {
  if (msg.type === "permission_prompt" && msg.request_id && !prompts.some((p) => p.requestId === msg.request_id))
    return [
      ...prompts,
      {
        requestId: msg.request_id,
        content: msg.content ?? "",
        tool: msg.tool_name ?? "",
        options: msg.prompt_options ?? { allow_once: true, deny_once: true, allow_always: false, deny_always: false },
        turnRef: msg.turn_ref ?? null,
      },
    ];
  if ((msg.type === "turn_end" || msg.type === "error") && msg.turn_ref) return prompts.filter((p) => p.turnRef !== msg.turn_ref);
  return prompts;
};

const newTurn = (ref: string, now: number): Turn => ({
  ref,
  replyId: null,
  text: "",
  working: { since: now, at: now, phase: "sending", step: "Sending" },
  tools: [],
  attachments: [],
  state: "live",
  acked: false,
});

/** One frame of turn `ref` folded into its draft. */
const foldTurn = (turns: Record<string, Turn>, ref: string, msg: ServerMessage, now: number): Record<string, Turn> => {
  const t = turns[ref] ?? newTurn(ref, now);
  const replyId = msg.id ?? t.replyId;
  const step = doing(msg);
  const working = step ? moved(t.working, step, now) : t.working;
  const next = ((): Turn => {
    switch (msg.type) {
      case "tool_start":
        return { ...t, working, tools: [...t.tools, { name: msg.content ?? "tool", done: false }] };
      case "tool_end": {
        const i = t.tools.findIndex((x) => !x.done);
        return { ...t, working, tools: t.tools.map((x, j) => (j === i ? { ...x, done: true } : x)) };
      }
      case "stream_start":
        return { ...t, working, replyId };
      case "stream_delta":
        return { ...t, text: t.text + (msg.content ?? "") };
      case "stream_discard":
        return { ...t, text: "", working: moved(t.working, doing({ type: "typing" })!, now) };
      case "stream_end":
        return { ...t, replyId, working: null };
      case "message":
        return { ...t, replyId, text: msg.content ?? t.text, working: null };
      case "image":
        return { ...t, replyId, attachments: withFiles(t.attachments, framed(msg)) };
      case "turn_snapshot":
        return { ...t, replyId, text: msg.text ?? "", working: snapshotWorking(msg, now), state: "live" };
      case "turn_end":
        return { ...t, replyId: msg.id ?? null, working: null, state: "ended" };
      case "error":
        return { ...t, working: null, state: "failed", error: msg.error ?? msg.content ?? "Something went wrong" };
      default:
        return step ? { ...t, working } : t;
    }
  })();
  return { ...turns, [ref]: { ...next, acked: true } };
};

const step = (s: ConversationState, msg: ServerMessage, now: number): Working | null => {
  const next = doing(msg);
  return next ? moved(s.working, next, now) : s.working;
};

const fold = (s: ConversationState, msg: ServerMessage, now: number): ConversationState => {
  const sessionId = msg.session_id ?? s.sessionId;
  // On a hub that streams by ref, a frame of none is no turn's: a delivery
  // pushed to the conversation, which leaves a live turn as it is.
  const outOfBand = streams(s) && !msg.turn_ref;
  switch (msg.type) {
    case USER_MESSAGE: {
      const content = msg.content ?? "";
      // Its answer follows: the turn is under way.
      const working = s.working ?? { since: now, at: now, phase: "thinking", step: STEPS.thinking };
      if (!content.trim() || (msg.id && s.messages.some((m) => m.id === msg.id))) return { ...s, working };
      const author = authorOf(msg.author);
      const said: ChatMessage = {
        ...message("user", content),
        ...(msg.id ? { id: msg.id } : {}),
        ...(author ? { author } : {}),
        sentOn: true,
      };
      // Before an answer that started without it.
      const last = s.messages.at(-1);
      const messages =
        last?.role === "assistant" && last.status === "streaming"
          ? [...s.messages.slice(0, -1), said, last]
          : [...s.messages, said];
      return { ...s, working, messages };
    }
    case "connected":
      return { ...s, sessionId, features: new Set(msg.features ?? []) };
    case "injected":
      return { ...s, absorbed: s.absorbed + 1 };
    case "typing":
      return { ...s, typing: true, working: step(s, msg, now) };
    case "compact_start":
    case "compact_end":
    case "rate_limited":
    case "slow_model_failover":
      return { ...s, working: s.working && step(s, msg, now) };
    case "stream_start": {
      const last = s.messages.at(-1);
      if (msg.id && s.messages.some((m) => m.id === msg.id))
        return { ...s, sessionId, typing: false, streaming: true, working: step(s, msg, now) };
      // Tools ran ahead of the answer: it streams into that same message.
      const toolsOnly = last?.role === "assistant" && last.status === "streaming" && last.content === "";
      const answer = { ...message("assistant", "", "streaming"), ...(msg.id ? { id: msg.id } : {}) };
      return {
        ...s,
        sessionId,
        typing: false,
        streaming: true,
        working: step(s, msg, now),
        messages: toolsOnly
          ? msg.id
            ? [...s.messages.slice(0, -1), { ...last, id: msg.id }]
            : s.messages
          : [...closeStreaming(s.messages), answer],
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
    case "turn_snapshot": {
      const id = msg.id ?? nextId();
      const answer = { ...message("assistant", msg.text ?? "", "streaming"), id };
      return {
        ...s,
        sessionId,
        streaming: true,
        working: snapshotWorking(msg, now),
        messages: s.messages.some((m) => m.id === id)
          ? update(s.messages, id, (m) => ({ ...m, content: msg.text ?? "", status: "streaming" }))
          : [...s.messages, answer],
      };
    }
    case "turn_end":
      return { ...s, typing: false, streaming: false, working: null, messages: closeStreaming(s.messages) };
    case "image": {
      const files = framed(msg);
      if (!files.length) return s;
      const caption = msg.content ?? "";
      if (msg.id && s.messages.some((m) => m.id === msg.id))
        return { ...s, messages: update(s.messages, msg.id, (m) => ({ ...m, attachments: withFiles(m.attachments, files) })) };
      const last = s.messages.at(-1);
      // The turn's answer is under way (its tools ran): the files are its.
      if (msg.turn_ref && last?.role === "assistant" && last.status === "streaming")
        return {
          ...s,
          messages: [...s.messages.slice(0, -1), { ...last, id: msg.id ?? last.id, attachments: withFiles(last.attachments, files) }],
        };
      if (msg.id && msg.turn_ref) {
        // Before its turn's answer: the answer streams into it.
        const pending = { ...message("assistant", "", "streaming"), id: msg.id, attachments: files };
        return { ...s, messages: [...s.messages, pending] };
      }
      return { ...s, messages: [...s.messages, { ...message("assistant", caption), attachments: files }] };
    }
    case "message": {
      const content = msg.content ?? "";
      const desk = msg.desk ? { desk: msg.desk } : {};
      if (msg.id && s.messages.some((m) => m.id === msg.id)) {
        const merged = update(s.messages, msg.id, (m) => ({ ...m, content: content || m.content, status: "complete", ...desk }));
        return outOfBand ? { ...s, messages: merged } : { ...s, typing: false, streaming: false, working: null, messages: merged };
      }
      if (outOfBand) return { ...s, messages: [...s.messages, { ...message("assistant", content), ...(msg.id ? { id: msg.id } : {}) }] };
      const last = s.messages.at(-1);
      // On a hub without ids: a non-streamed answer that repeats what just
      // streamed is the same answer (what it mentions to act on may come
      // only with this copy).
      if (!msg.id && last?.role === "assistant" && last.content === content)
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
          messages: [...s.messages.slice(0, -1), { ...last, ...(msg.id ? { id: msg.id } : {}), content, status: "complete", ...desk }],
        };
      return {
        ...s,
        sessionId,
        typing: false,
        streaming: false,
        working: null,
        messages: [...closeStreaming(s.messages), { ...message("assistant", content), ...(msg.id ? { id: msg.id } : {}), ...desk }],
      };
    }
    case "tool_start": {
      const tool = { name: msg.content ?? "tool", done: false };
      const hasAnswer = s.messages.at(-1)?.role === "assistant";
      const messages = hasAnswer
        ? updateLast(s.messages, (m) => ({ ...m, tools: [...m.tools, tool] }))
        : [...s.messages, { ...message("assistant", "", "streaming"), tools: [tool] }];
      return { ...s, messages, working: step(s, msg, now) };
    }
    case "tool_end":
      return {
        ...s,
        working: s.working && step(s, msg, now),
        messages: updateLast(s.messages, (m) => {
          const i = m.tools.findIndex((t) => !t.done);
          return i < 0 ? m : { ...m, tools: m.tools.map((t, j) => (j === i ? { ...t, done: true } : t)) };
        }),
      };
    case "error": {
      const said = msg.error ?? msg.content ?? "Something went wrong";
      const text = said === BUSY ? "It’s still answering something else here. Send this again once that’s done." : said;
      return {
        ...s,
        typing: false,
        streaming: false,
        working: null,
        messages: [...closeStreaming(s.messages), message("system", text, "error")],
      };
    }
    default:
      return s;
  }
};

/** The conversation once its socket has dropped: nothing is running that
 *  Desk can see, and its turns wait to hear whether they still are. */
export const disconnected = (s: ConversationState): ConversationState => ({
  ...s,
  connected: false,
  typing: false,
  streaming: false,
  working: null,
  unprompted: false,
  turns: Object.fromEntries(
    Object.entries(s.turns).map(([ref, t]) => [ref, t.state === "live" ? { ...t, state: "stalled" as const } : t]),
  ),
});

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
  u.searchParams.set("desk", "1");
  u.searchParams.set("accept", "*/*");
  return u.toString();
};

/** Answers that finished in this step: assistant messages that became
 *  complete with something to say, by id. */
export const finishedAnswers = (before: ConversationState, after: ConversationState): ChatMessage[] => {
  const was = new Map(before.messages.map((m) => [m.id, m.status]));
  return after.messages.filter(
    (m) => m.role === "assistant" && m.status === "complete" && m.content.trim() !== "" && was.get(m.id) !== "complete",
  );
};

/** What Desk sends with a message: where it was asked (on a hub that takes
 *  structured turns), what to say instead to a hub that doesn't, and its
 *  files, uploaded already. */
export interface Ask {
  turn?: DeskTurn;
  legacy?: string;
  attachments?: Attachment[];
}

/** One conversation with an agent: a `/ws` connection on a Desk channel,
 *  reconnecting until closed. */
export class Conversation {
  private ws: WebSocket | null = null;
  private state: ConversationState = emptyConversation();
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly hub: HubAccount,
    private readonly agentId: string,
    private readonly onChange: (s: ConversationState) => void,
    readonly channel = "desk",
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

  get current(): ConversationState {
    return this.state;
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
      this.set(disconnected(this.state));
      if (!this.closed) this.timer = setTimeout(() => this.open(), Math.min(30_000, 1000 * 2 ** this.retry++));
    };
  }

  /** Sends `content`, as a structured turn where the hub takes them; the
   *  ref its frames will carry, or null for a hub that sends none. False
   *  until the hub has said what it offers. */
  send(content: string, ask: Ask = {}): { turnRef: string | null } | false {
    const files = ask.attachments ?? [];
    const features = this.state.features;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !features || (!content.trim() && !files.length)) return false;
    const structured = !!ask.turn && features.has(FEATURES.place);
    const turnRef = structured ? crypto.randomUUID() : null;
    this.ws.send(
      JSON.stringify({
        type: "chat",
        content: structured ? content : (ask.legacy ?? content),
        session_id: this.state.sessionId,
        channel: this.channel,
        agent_id: this.agentId,
        ...(structured ? { desk: ask.turn, turn_ref: turnRef, answers_approvals: true } : {}),
        ...(files.length
          ? { attachments: files.map((f) => ({ filename: f.filename, mime_type: f.media_type, artifact_id: f.artifact_id })) }
          : {}),
      }),
    );
    const now = Date.now();
    const said = { ...message("user", content), ...(files.length ? { attachments: files } : {}) };
    this.set({
      ...this.state,
      messages: [...this.state.messages, said],
      working: { since: now, at: now, phase: "sending", step: "Sending" },
      turns: turnRef ? { ...this.state.turns, [turnRef]: newTurn(turnRef, now) } : this.state.turns,
    });
    return { turnRef };
  }

  /** Answers a permission prompt. */
  answer(requestId: string, choice: PermissionChoice): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "permission_response", request_id: requestId, choice }));
    this.set({ ...this.state, prompts: this.state.prompts.filter((p) => p.requestId !== requestId) });
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

  /** Forgets a turn Desk has settled. */
  forget(turnRef: string) {
    if (!(turnRef in this.state.turns)) return;
    const { [turnRef]: _gone, ...turns } = this.state.turns;
    this.set({ ...this.state, turns, prompts: this.state.prompts.filter((p) => p.turnRef !== turnRef) });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.ws?.close();
  }
}
