import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropped, emptyConversation, reduce, toShow, type ConversationState } from "./conversation";
import { readableError } from "./agentError";
import { settle, withHistory } from "./history";
import { FEATURES, type ChatMessage, type ServerMessage } from "./types";

// An error a turn ended with, in a DM on a hub that streams turns by ref and
// id: where it shows once the hub's kept copy is read, and what it says.

const T1 = "2026-11-05T08:45:00.000Z";
const T2 = "2026-11-05T08:56:00.000Z";

const ID = "4650a957-80b5-472d-98b7-a1ee48e8e29d";
const LIMIT =
  `Agent error: no route could serve this turn: claude-code:opus — subscription unavailable: no Claude login for ${ID}: ` +
  "agent_user none stored; global_user none stored; agent_shared none stored; system_shared at its usage limit until 2026-11-06 16:00:00 UTC";

const kept = (id: string, role: ChatMessage["role"], content: string, at: string): ChatMessage => ({
  id,
  role,
  content,
  at,
  status: "complete",
  tools: [],
});

const said = (s: ConversationState, id: string, content: string): ConversationState => ({
  ...s,
  messages: [...s.messages, kept(id, "user", content, new Date().toISOString())],
});

const fold = (s: ConversationState, frames: ServerMessage[]) => frames.reduce(reduce, s);

const answered = (ref: string, id: string, text: string): ServerMessage[] => [
  { type: "stream_start", turn_ref: ref, id },
  { type: "stream_delta", content: text, turn_ref: ref, id },
  { type: "stream_end", turn_ref: ref, id },
  { type: "turn_end", turn_ref: ref, id },
];

const read = (s: ConversationState, page: ChatMessage[]) => {
  const now = new Date().toISOString();
  const { ids } = settle(page, s.messages, now, true, { began: now, seen: new Set() });
  return { state: dropped(s, ids), loadedAt: now };
};

const shown = (page: ChatMessage[], s: ConversationState, loadedAt: string) => withHistory(page, toShow(s.messages), loadedAt);

describe("an error a turn ended with, read back after a later exchange", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const exchange = () => {
    let s: ConversationState = { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream]) };
    // T1: you ask; the turn fails.
    vi.setSystemTime(new Date(T1));
    s = said(s, "m-ask", "status?");
    s = fold(s, [{ type: "error", turn_ref: "t1", content: LIMIT }]);
    // T2: you ask again; it answers.
    vi.setSystemTime(new Date(T2));
    s = said(s, "m-again", "all ok?");
    s = fold(s, answered("t2", "r2", "Yes, all ok."));
    vi.setSystemTime(new Date("2026-11-05T08:57:00.000Z"));
    return s;
  };

  it("stays at its own time, between what came before and after, not last", () => {
    const page = [kept("h-ask", "user", "status?", T1), kept("h-again", "user", "all ok?", T2), kept("r2", "assistant", "Yes, all ok.", T2)];
    const r = read(exchange(), page);
    const out = shown(page, r.state, r.loadedAt);
    expect(out.map((m) => m.id.startsWith("m-") ? m.status : m.id)).toEqual(["h-ask", "error", "h-again", "r2"]);
  });

  it("shows once where the hub kept it too", () => {
    const page = [
      kept("h-ask", "user", "status?", T1),
      kept("h-err", "assistant", LIMIT, "2026-11-05T08:45:01.000Z"),
      kept("h-again", "user", "all ok?", T2),
      kept("r2", "assistant", "Yes, all ok.", T2),
    ];
    const r = read(exchange(), page);
    expect(shown(page, r.state, r.loadedAt).map((m) => m.id)).toEqual(["h-ask", "h-err", "h-again", "r2"]);
  });
});

describe("an error a turn ended with, in plain words", () => {
  const NOW = Date.parse("2026-11-05T08:59:00.000Z");

  it("says a plan at its usage limit is, until when, with no ids, and offers to sign in", () => {
    const e = readableError(LIMIT, NOW);
    expect(e.text).toMatch(/^Couldn’t answer: the Claude plan Desk uses is at its usage limit until .+16:00\. Sign in another Claude account, or wait\.$/);
    expect(e.text).not.toContain(ID);
    expect(e.text).not.toMatch(/agent_user|system_shared|UTC|claude-code/);
    expect(e.signIn).toBe("claude");
    expect(e.details).toBe(LIMIT);
  });

  it("says no login is signed in, and offers to sign in", () => {
    const raw = `Agent error: subscription unavailable: no Claude login for ${ID}: agent_user none stored; system_shared none stored`;
    const e = readableError(raw, NOW);
    expect(e.text).toBe("Couldn’t answer: no Claude account is signed in for this agent. Sign in to Claude to go on.");
    expect(e.signIn).toBe("claude");
    expect(e.details).toBe(raw);
  });

  it("knows a ChatGPT plan's limit", () => {
    const e = readableError("Agent error: subscription unavailable: no ChatGPT login for you: system_shared at its usage limit until 2026-11-05 10:30:00 UTC", NOW);
    expect(e.text).toContain("the ChatGPT plan Desk uses is at its usage limit until");
    expect(e.signIn).toBe("chatgpt");
  });

  it("shows anything else by its first line, without ids, the rest folded away", () => {
    const raw = `Agent error: tool loop for ${ID} gave up\nstack: frame 1\nframe 2`;
    const e = readableError(raw, NOW);
    expect(e).toEqual({ text: "Couldn’t answer: tool loop for gave up", signIn: null, details: raw });
  });

  it("leaves Desk's own plain words as they are", () => {
    expect(readableError("Server is shutting down — please reconnect", NOW)).toEqual({
      text: "Server is shutting down — please reconnect",
      signIn: null,
      details: null,
    });
  });
});
