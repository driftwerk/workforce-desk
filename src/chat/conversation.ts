import { authorOf, LOCAL_ID } from "./history";
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
import { pairedHub } from "../hub/net";
import { backoff, detach, keepAlive, OPEN } from "../hub/socket";
import type { DeskSocket } from "../hub/transport";
import { clip } from "../ui/graphemes";

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
  /** When its last frame came. */
  heardAt?: number;
  /** The client id of the message it was asked with. */
  clientId?: string;
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
  /** The ids of live messages given up for the hub's kept copy: a frame
   *  that comes for one later is for what the kept copy already shows. */
  settled?: ReadonlySet<string>;
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
  return detail ? `${name} — ${clip(detail, 80)}` : (name ?? raw);
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
const nextId = () => `${LOCAL_ID}${Date.now()}-${++counter}`;

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
  // A late frame of an answer the hub's kept copy already shows: what it
  // would write is there, and an answer made of it would show it twice.
  if (msg.id && s.settled?.has(msg.id) && INTO_ANSWER.has(msg.type)) return s;
  const now = Date.now();
  const folded = fold(s, msg, now);
  const next = {
    ...folded,
    messages: msg.turn_ref ? ofTurn(asked(s.messages, folded.messages, s.turns[msg.turn_ref]?.clientId), msg.turn_ref, msg) : folded.messages,
    turns: msg.turn_ref ? foldTurn(folded.turns, msg.turn_ref, msg, now) : folded.turns,
    prompts: foldPrompts(folded.prompts, msg),
  };
  // A turn that starts while nothing was sent isn't the person's, and its
  // prompt is only kept, unless the hub sends it on live.
  const unprompted = !next.working || msg.type === USER_MESSAGE ? false : s.working ? s.unprompted : true;
  return next.unprompted === unprompted ? next : { ...next, unprompted };
};

/** `after`'s messages with the ones a turn's frame made (an answer, a
 *  tool's bubble, an error) said to be in reply to the message the turn was
 *  asked with, `clientId`: what the hub keeps of the turn names it, and
 *  they give way to that. */
const asked = (before: ChatMessage[], after: ChatMessage[], clientId: string | undefined): ChatMessage[] => {
  if (!clientId || after === before) return after;
  const had = new Set(before.map((m) => m.id));
  return after.map((m) => (m.role !== "user" && !m.replyTo && !had.has(m.id) ? { ...m, replyTo: clientId } : m));
};

/** The frames that write into an answer. */
const INTO_ANSWER: ReadonlySet<string> = new Set([
  "stream_start",
  "stream_delta",
  "stream_end",
  "stream_discard",
  "turn_snapshot",
  "message",
  "image",
  "tool_start",
  "tool_end",
]);

/** `messages` with the answer of turn `ref` known as its: the message a frame
 *  of it names by id says which turn it answers; and at the turn's end, the id
 *  it was kept under is the answer's, or, kept under none the hub said, it is
 *  known by its words. */
const ofTurn = (messages: ChatMessage[], ref: string, msg: ServerMessage): ChatMessage[] => {
  if (msg.type !== "turn_end")
    return msg.id && messages.some((m) => m.id === msg.id && m.role === "assistant" && m.turnRef !== ref)
      ? update(messages, msg.id, (m) => ({ ...m, turnRef: ref }))
      : messages;
  const answers = messages.filter((m) => m.turnRef === ref && m.role === "assistant");
  if (answers.length === 0) return messages;
  const keptId = msg.id;
  if (keptId) {
    // Kept under an id other than the one it streamed with: it's that one.
    if (answers.length !== 1 || answers[0]!.id === keptId || messages.some((m) => m.id === keptId)) return messages;
    return update(messages, answers[0]!.id, (m) => ({ ...m, id: keptId }));
  }
  return messages.map((m) => (m.turnRef === ref && m.role === "assistant" && !m.byWords ? { ...m, byWords: true } : m));
};

/** The frame a message of the DM you didn't type here comes as: the
 *  overseer's nudge or task, or a suggestion of its you said yes to. */
export const USER_MESSAGE = "user_message";

/** The frame a hub sends for a follow-up it took in too late for its turn
 *  to read: Desk asks it again, from the queue, once the turn ends. */
export const REQUEUED = "requeued";

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
  heardAt: now,
});

/** One frame of turn `ref` folded into its draft. */
const foldTurn = (turns: Record<string, Turn>, ref: string, msg: ServerMessage, now: number): Record<string, Turn> => {
  const t = turns[ref] ?? newTurn(ref, now);
  const step = doing(msg);
  const working = step ? moved(t.working, step, now) : t.working;
  const next = ((): Turn => {
    switch (msg.type) {
      case "tool_start":
        return { ...t, working, tools: [...t.tools, { name: msg.content ?? "tool", done: false, startedAt: now }] };
      case "tool_end": {
        const i = t.tools.findIndex((x) => !x.done);
        return { ...t, working, tools: t.tools.map((x, j) => (j === i ? { ...x, done: true, endedAt: now } : x)) };
      }
      case "stream_start":
        return { ...t, working };
      case "stream_delta":
        return { ...t, text: t.text + (msg.content ?? "") };
      case "stream_discard":
        return { ...t, text: "", working: moved(t.working, doing({ type: "typing" })!, now) };
      case "stream_end":
        return { ...t, working: null };
      case "message":
        return { ...t, text: msg.content ?? t.text, working: null };
      case "image":
        return { ...t, attachments: withFiles(t.attachments, framed(msg)) };
      case "turn_snapshot":
        return { ...t, text: msg.text ?? "", working: snapshotWorking(msg, now), state: "live" };
      case "turn_end":
        return { ...t, working: null, state: "ended" };
      case "error":
        return { ...t, working: null, state: "failed", error: msg.error ?? msg.content ?? "Something went wrong" };
      default:
        return step ? { ...t, working } : t;
    }
  })();
  // A turn's end says what it saved, null for nothing; every other frame
  // may name the message its answer is.
  return { ...turns, [ref]: { ...next, replyId: msg.type === "turn_end" ? (msg.id ?? null) : (msg.id ?? t.replyId), acked: true, heardAt: now } };
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
    case REQUEUED:
      // Taken in too late for its turn to read: it isn't said yet, but
      // queued to be asked again.
      return msg.id ? { ...s, messages: s.messages.filter((m) => m.clientId !== msg.id) } : s;
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
      const speech =
        msg.speech === undefined && last.speech === undefined
          ? {}
          : { speech: (last.speech ?? last.content) + (msg.speech ?? msg.content ?? "") };
      return { ...s, messages: [...s.messages.slice(0, -1), { ...last, content: last.content + (msg.content ?? ""), ...speech }] };
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
      const desk = { ...(msg.desk ? { desk: msg.desk } : {}), ...(msg.speech ? { speech: msg.speech } : {}) };
      if (msg.id && s.messages.some((m) => m.id === msg.id)) {
        const merged = update(s.messages, msg.id, (m) => ({ ...m, content: content || m.content, status: "complete", ...desk }));
        return outOfBand ? { ...s, messages: merged } : { ...s, typing: false, streaming: false, working: null, messages: merged };
      }
      if (outOfBand) return { ...s, messages: [...s.messages, { ...message("assistant", content), ...(msg.id ? { id: msg.id } : {}), ...(msg.speech ? { speech: msg.speech } : {}) }] };
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
          messages: msg.desk || msg.speech ? [...s.messages.slice(0, -1), { ...last, ...desk }] : s.messages,
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

/** What Desk draws besides the blocks: a chart an agent's chart tool made,
 *  from its spec, in place of its picture. */
const DRAWN = ["chart_specs"] as const;

/** A conversation's socket on its hub, with what it asks for. It names no
 *  token: the native side puts the hub's in the handshake's header. */
export const wsPath = (agentId: string, channel = "desk"): string =>
  `/ws?${new URLSearchParams({
    agent_id: agentId,
    channel,
    rich: [...RICH_KINDS, ...DRAWN].join(","),
    desk: "1",
    accept: "*/*",
  })}`;

/** `s` without the live messages `ids`, which the hub's kept copy now shows:
 *  a frame of theirs that comes later changes nothing. */
/** How many settled ids a conversation remembers. */
const SETTLED_KEPT = 1000;

export const dropped = (s: ConversationState, ids: ReadonlySet<string>): ConversationState => ({
  ...s,
  messages: s.messages.filter((m) => !ids.has(m.id)),
  settled: new Set([...(s.settled ?? []), ...ids].slice(-SETTLED_KEPT)),
});

/** Answers that finished in this step: assistant messages that became
 *  complete with something to say, by id. */
export const finishedAnswers = (before: ConversationState, after: ConversationState): ChatMessage[] =>
  finished(before, after).filter((m) => m.content.trim() !== "");

/** Answers that finished in this step with something to say out loud, which may
 *  be nothing to read: a reply that was only `(laughing)`. */
export const finishedSpeech = (before: ConversationState, after: ConversationState): ChatMessage[] =>
  finished(before, after).filter((m) => (m.speech ?? m.content).trim() !== "");

const finished = (before: ConversationState, after: ConversationState): ChatMessage[] => {
  const was = new Map(before.messages.map((m) => [m.id, m.status]));
  return after.messages.filter((m) => m.role === "assistant" && m.status === "complete" && was.get(m.id) !== "complete");
};

/** `messages` as a conversation shows them: an answer with nothing to read, only
 *  to hear or nothing at all, leaves no empty bubble. */
export const toShow = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter(
    (m) => !(m.role === "assistant" && m.status === "complete" && !m.content.trim() && !m.tools.length && !m.attachments?.length && !m.desk),
  );

/** What Desk sends with a message: where it was asked (on a hub that takes
 *  structured turns), what to say instead to a hub that doesn't, and its
 *  files, uploaded already. */
export interface Ask {
  turn?: DeskTurn;
  legacy?: string;
  attachments?: Attachment[];
  /** Sent from the queue under this ticket (its turn's ref, on a hub that
   *  takes structured turns): it waits for a running turn rather than
   *  steering it, and what became of it is told to
   *  [`Conversation.onQueued`]. */
  queued?: string;
}

/** What became of a queued send: the hub took it, held it back because a
 *  turn is still running, or it didn't get there (refused, or the
 *  connection went before the hub said). */
export type QueuedOutcome = "taken" | "busy" | "lost";

/** Frames that say a turn is under way: on a hub that names no turns, the
 *  first after a queued send means the hub took it. */
const UNDER_WAY = new Set(["typing", "stream_start", "stream_delta", "message", "tool_start", USER_MESSAGE]);

/** One conversation with an agent: a `/ws` connection on a Desk channel,
 *  reconnecting until closed. */
export class Conversation {
  private ws: DeskSocket | null = null;
  private state: ConversationState = emptyConversation();
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alive: ReturnType<typeof keepAlive> | undefined;
  /** Queued sends the hub hasn't answered yet, by ticket: the ref their
   *  frames carry (none on a hub that names no turns), and the id of the
   *  message shown for each. */
  private waiting = new Map<string, { ref: string | null; shown: string }>();
  /** Told what became of each queued send, by its ticket. One that didn't
   *  get there is no longer shown as said. */
  onQueued?: (ticket: string, outcome: QueuedOutcome) => void;
  /** Told the words of a message the hub sent back to be asked again. */
  onRequeued?: (text: string) => void;

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
    const ws = pairedHub(this.hub).socket(wsPath(this.agentId, this.channel));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ ...this.state, connected: true });
      this.alive = keepAlive(ws);
    };
    ws.onmessage = (e) => {
      this.alive?.heard();
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (this.settleQueued(msg)) return;
        const back = msg.type === REQUEUED ? this.state.messages.find((m) => !!msg.id && m.clientId === msg.id) : undefined;
        this.set(reduce(this.state, msg));
        if (back) this.onRequeued?.(back.content);
      } catch {
        /* not a message Desk renders */
      }
    };
    ws.onclose = () => {
      this.alive?.stop();
      // Whether the hub took what was still on its way can't be known now:
      // it goes back to the queue rather than be lost.
      this.unsend([...this.waiting.keys()], "lost");
      this.set(disconnected(this.state));
      if (!this.closed) this.timer = setTimeout(() => this.open(), backoff(this.retry++));
    };
  }

  /** Sends `content`, as a structured turn where the hub takes them; the
   *  ref its frames will carry, or null for a hub that sends none. False
   *  until the hub has said what it offers. */
  send(content: string, ask: Ask = {}): { turnRef: string | null } | false {
    const files = ask.attachments ?? [];
    const features = this.state.features;
    if (!this.ws || this.ws.readyState !== OPEN || !features || (!content.trim() && !files.length)) return false;
    const structured = !!ask.turn && features.has(FEATURES.place);
    const turnRef = structured ? (ask.queued ?? crypto.randomUUID()) : null;
    // The id the hub keeps the message under, Send now included: a room's
    // turn names its room message, and anything else gets one of its own.
    const clientId = structured ? (ask.turn?.message ?? crypto.randomUUID()) : undefined;
    const queued = !!ask.queued && structured && features.has(FEATURES.queue);
    this.ws.send(
      JSON.stringify({
        type: "chat",
        content: structured ? content : (ask.legacy ?? content),
        session_id: this.state.sessionId,
        channel: this.channel,
        agent_id: this.agentId,
        ...(structured ? { desk: { ...ask.turn, message: clientId }, turn_ref: turnRef, answers_approvals: true } : {}),
        ...(queued ? { mode: "queue" } : {}),
        ...(files.length
          ? { attachments: files.map((f) => ({ filename: f.filename, mime_type: f.media_type, artifact_id: f.artifact_id })) }
          : {}),
      }),
    );
    const now = Date.now();
    const said = {
      ...message("user", content),
      ...(files.length ? { attachments: files } : {}),
      ...(clientId ? { clientId } : {}),
    };
    if (ask.queued) this.waiting.set(ask.queued, { ref: turnRef, shown: said.id });
    this.set({
      ...this.state,
      messages: [...this.state.messages, said],
      working: { since: now, at: now, phase: "sending", step: "Sending" },
      turns: turnRef ? { ...this.state.turns, [turnRef]: { ...newTurn(turnRef, now), ...(clientId ? { clientId } : {}) } } : this.state.turns,
    });
    return { turnRef };
  }

  /** Settles the queued sends `msg` answers: a frame of one's turn (or, on
   *  a hub that names no turns, the turn starting) means the hub took it;
   *  an error means it didn't, and it's taken back, as if never said. True
   *  when the frame is only the hub holding a send back as busy, which
   *  shows nothing. */
  private settleQueued(msg: ServerMessage): boolean {
    if (!this.waiting.size) return false;
    const error = msg.type === "error";
    const answered = [...this.waiting].filter(([, w]) =>
      msg.turn_ref ? w.ref === msg.turn_ref : error || (w.ref === null && UNDER_WAY.has(msg.type)),
    );
    if (!answered.length) return false;
    const tickets = answered.map(([ticket]) => ticket);
    if (!error) {
      for (const t of tickets) {
        this.waiting.delete(t);
        this.onQueued?.(t, "taken");
      }
      return false;
    }
    const busy = (msg.error ?? msg.content) === BUSY;
    this.unsend(tickets, busy ? "busy" : "lost");
    // Held back as busy, it says nothing; any other refusal says why.
    return busy;
  }

  /** Takes back queued sends that didn't get there: their messages aren't
   *  shown as said, nor their turns as under way. */
  private unsend(tickets: string[], outcome: QueuedOutcome) {
    const gone = tickets.flatMap((t) => {
      const w = this.waiting.get(t);
      this.waiting.delete(t);
      return w ? [{ ...w, ticket: t }] : [];
    });
    if (!gone.length) return;
    const shown = new Set(gone.map((w) => w.shown));
    const refs = new Set(gone.flatMap((w) => (w.ref ? [w.ref] : [])));
    const placeholder = this.state.working?.phase === "sending";
    this.set({
      ...this.state,
      messages: this.state.messages.filter((m) => !shown.has(m.id)),
      turns: Object.fromEntries(Object.entries(this.state.turns).filter(([ref]) => !refs.has(ref))),
      ...(placeholder ? { working: null } : {}),
    });
    for (const w of gone) this.onQueued?.(w.ticket, outcome);
  }

  /** Takes turn `ref` as ended: its answer finished and the hub never said
   *  the turn did. */
  lapse(ref: string) {
    const t = this.state.turns[ref];
    if (!t || t.state !== "live") return;
    this.set({ ...this.state, turns: { ...this.state.turns, [ref]: { ...t, working: null, state: "ended" } } });
  }

  /** Answers a permission prompt. */
  answer(requestId: string, choice: PermissionChoice): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify({ type: "permission_response", request_id: requestId, choice }));
    this.set({ ...this.state, prompts: this.state.prompts.filter((p) => p.requestId !== requestId) });
    return true;
  }

  cancel() {
    if (this.ws?.readyState === OPEN && this.state.sessionId)
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
    this.set(dropped(this.state, ids));
  }

  /** Says which kept message each of these live messages goes before, and
   *  which kept message says the words of each of these. */
  place(anchors: ReadonlyMap<string, string>, twins: ReadonlyMap<string, string>) {
    if (anchors.size === 0 && twins.size === 0) return;
    this.set({
      ...this.state,
      messages: this.state.messages.map((m) => {
        const placedBefore = anchors.get(m.id);
        const keptAs = twins.get(m.id);
        return placedBefore || keptAs ? { ...m, ...(placedBefore ? { placedBefore } : {}), ...(keptAs ? { keptAs } : {}) } : m;
      }),
    });
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
    this.alive?.stop();
    detach(this.ws);
  }
}
