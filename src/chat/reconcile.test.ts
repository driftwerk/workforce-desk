import { afterEach, describe, expect, it, vi } from "vitest";
import { dropped, emptyConversation, reduce, toShow, type ConversationState, type Turn } from "./conversation";
import { fromHub, type HubMessage } from "./history";
import { withHistory } from "./legacy";
import { keptOf, onceEach, shownWith } from "./reconcile";
import { FEATURES, type ChatMessage, type ServerMessage } from "./types";

const Q = "what was that research called again?";
const W = "we talked about it previously";
const ERR = "Agent error: llm first-token timeout: no first token after 45s (model gpt-6.1-sol)";

const fold = (s: ConversationState, frames: ServerMessage[]) => frames.reduce(reduce, s);

/** What `send` leaves for a message you sent under client id `clientId`,
 *  asking turn `ref`. */
const sent = (s: ConversationState, clientId: string, content: string, ref: string): ConversationState => {
  const turn: Turn = { ref, replyId: null, text: "", working: null, tools: [], attachments: [], state: "live", acked: false, clientId };
  const said: ChatMessage = { id: `m-${clientId}`, role: "user", content, at: new Date().toISOString(), status: "complete", tools: [], clientId };
  return { ...s, messages: [...s.messages, said], turns: { ...s.turns, [ref]: turn } };
};

const row = (m: Partial<HubMessage> & Pick<HubMessage, "id" | "from">): ChatMessage => fromHub({ at: "2026-11-06T06:46:00Z", ...m });

const base = [
  row({ id: "h-m", from: "user", text: "Morning", client_id: "c-m", seq: 1 }),
  row({ id: "h-r", from: "agent", text: "Morning, Kings", seq: 2, mark: { in_reply_to: "c-m" } }),
];
const asked = row({ id: "h-q", from: "user", text: Q, client_id: "q", seq: 3 });
const steered = row({ id: "h-w", from: "user", text: W, client_id: "w", seq: 4 });
const failure = row({ id: "h-e", from: "agent", text: ERR, seq: 5, mark: { in_reply_to: "q", failed: true, steps: [{ tool: "web.search", ok: true, ms: 900 }] } });

/** The live conversation after `page` was read: what it showed gives way. */
const refreshed = (s: ConversationState, page: ChatMessage[]) => dropped(s, keptOf(page, s.messages));

const label = (m: ChatMessage) => `${m.role}${m.status === "error" ? (m.superseded ? ":folded" : ":error") : ""} ${m.content.slice(0, 12)}`;

describe("a DM on a hub with client ids", () => {
  it("shows a failed turn's question, what was sent now and the failure in order, once each, folded once answered", () => {
    let s: ConversationState = { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream, FEATURES.clientIds]) };
    s = sent(s, "q", Q, "r1");
    s = fold(s, [
      { type: "turn_snapshot", turn_ref: "r1", text: "", status: "thinking" },
      { type: "tool_start", turn_ref: "r1", content: "web.search: a" },
      { type: "tool_end", turn_ref: "r1" },
    ]);
    // Send now: its own copy, absorbed into the running turn.
    s = sent(s, "w", W, "r1-w");
    s = fold(s, [{ type: "injected", content: "absorbed" }]);
    s = fold(s, [{ type: "error", turn_ref: "r1", content: ERR }, { type: "turn_end", turn_ref: "r1" }]);
    expect(s.messages.filter((m) => m.role !== "user").every((m) => m.replyTo === "q")).toBe(true);

    // The read on the turn's failure: the hub kept the question, the
    // follow-up and where it failed.
    let history = [...base, asked, steered, failure];
    s = refreshed(s, history);
    expect(s.messages).toEqual([]);
    expect(shownWith(history, toShow(s.messages)).map(label)).toEqual([
      "user Morning",
      "assistant Morning, Kin",
      `user ${Q.slice(0, 12)}`,
      `user ${W.slice(0, 12)}`,
      `system:error ${ERR.slice(0, 12)}`,
    ]);

    // Sent again, and answered by a new turn.
    s = sent(s, "w2", W, "r2");
    s = fold(s, [
      { type: "turn_snapshot", turn_ref: "r2", text: "", status: "thinking" },
      { type: "stream_start", turn_ref: "r2", id: "A" },
      { type: "stream_delta", turn_ref: "r2", id: "A", content: "Next-Concept Modeling" },
      { type: "stream_end", turn_ref: "r2", id: "A" },
      { type: "turn_end", turn_ref: "r2", id: "A" },
    ]);
    // Before the read: the live copies follow the last kept row.
    const before = shownWith(history, toShow(s.messages));
    expect(before.slice(-2).map(label)).toEqual([`user ${W.slice(0, 12)}`, "assistant Next-Concept"]);
    expect(before.find((m) => m.id === "h-e")?.superseded).toBe(true);

    history = [
      ...history,
      row({ id: "h-w2", from: "user", text: W, client_id: "w2", seq: 6 }),
      row({ id: "A", from: "agent", text: "Next-Concept Modeling", seq: 7, mark: { in_reply_to: "w2" } }),
    ];
    s = refreshed(s, history);
    const shown = shownWith(history, toShow(s.messages));
    expect(shown.map(label)).toEqual([
      "user Morning",
      "assistant Morning, Kin",
      `user ${Q.slice(0, 12)}`,
      `user ${W.slice(0, 12)}`,
      `system:folded ${ERR.slice(0, 12)}`,
      `user ${W.slice(0, 12)}`,
      "assistant Next-Concept",
    ]);
    expect(new Set(shown.map((m) => m.id)).size).toBe(shown.length);
  });

  it("keeps the question and what was sent now into a failed turn after a reload", () => {
    // A restart: nothing live, only what the hub kept.
    const shown = shownWith([...base, asked, steered, failure], []);
    expect(shown.map((m) => m.content)).toEqual(["Morning", "Morning, Kings", Q, W, ERR]);
    expect(shown.at(-1)).toMatchObject({ role: "system", status: "error", replyTo: "q", steps: [{ tool: "web.search", ok: true, ms: 900 }] });
  });

  it("knows a live message's kept copy by its client id alone, never by its words", () => {
    const live: ChatMessage[] = [
      { id: "m-1", role: "user", content: W, at: "2026-11-06T06:48:30Z", status: "complete", tools: [], clientId: "w2" },
      { id: "m-2", role: "user", content: "my key is s3cret", at: "2026-11-06T06:49:00Z", status: "complete", tools: [], clientId: "k" },
    ];
    // An older message saying the same words is another message; a copy the
    // hub redacted is still this one.
    const kept = [steered, row({ id: "h-k", from: "user", text: "my key is [secret]", client_id: "k", seq: 9 })];
    expect([...keptOf(kept, live)]).toEqual(["m-2"]);
  });

  it("orders kept rows by the hub's numbering, then what isn't kept yet in the order it was said", () => {
    const live: ChatMessage[] = [
      { id: "m-b", role: "user", content: "second", at: "2026-11-06T07:00:02Z", status: "complete", tools: [], clientId: "b" },
      { id: "m-a", role: "user", content: "third", at: "2026-11-06T07:00:01Z", status: "complete", tools: [], clientId: "a" },
    ];
    const shown = shownWith([steered, asked, failure], live);
    expect(shown.map((m) => m.id)).toEqual(["h-q", "h-w", "h-e", "m-b", "m-a"]);
  });

  it("gives every message one key, whatever the hub or the live copies repeat", () => {
    const answer: ChatMessage = { id: "A", role: "assistant", content: "Next", at: "", status: "complete", tools: [] };
    const repeated = [asked, steered, asked, row({ id: "A", from: "agent", text: "Next", seq: 7 })];
    const shown = shownWith(repeated, [answer, { ...answer }]);
    expect(shown.map((m) => m.id)).toEqual(["h-q", "h-w", "A"]);
    expect(onceEach([asked, asked, steered]).map((m) => m.id)).toEqual(["h-q", "h-w"]);
  });

  it("folds a failure away only once a later turn answers, not for a reminder", () => {
    const reminder = row({ id: "h-rm", from: "agent", text: "Standup in 5", seq: 6, mark: { delivery: "reminder" } });
    expect(shownWith([asked, failure, reminder], []).find((m) => m.id === "h-e")?.superseded).toBeUndefined();
    const answer = row({ id: "h-a", from: "agent", text: "NCM", seq: 7, mark: { in_reply_to: "w2" } });
    expect(shownWith([asked, failure, reminder, answer], []).find((m) => m.id === "h-e")?.superseded).toBe(true);
  });

  it("keeps a file that is a message of its own beside the message the hub put it after", () => {
    const file = row({ id: "file:art1", from: "agent", text: "", attachments: [{ artifact_id: "art1", media_type: "image/png", filename: "a.png", size: 1 }] });
    const shown = shownWith([steered, file, asked], []);
    expect(shown.map((m) => m.id)).toEqual(["h-q", "h-w", "file:art1"]);
  });

  it("gives every message one key on an older hub too, whose page repeats one", () => {
    const answer = row({ id: "A", from: "agent", text: "Next" });
    const page = [row({ id: "h-q", from: "user", text: Q }), answer, answer];
    const shown = onceEach(withHistory(page, [{ ...answer, tools: [] }], null));
    expect(shown.map((m) => m.id)).toEqual(["h-q", "A"]);
  });

  it("shows a turn's tools under it until its answer, which keeps them, is read", () => {
    let s: ConversationState = { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream, FEATURES.clientIds]) };
    s = sent(s, "q", Q, "r1");
    s = fold(s, [
      { type: "tool_start", turn_ref: "r1", content: "web.search: a" },
      { type: "tool_end", turn_ref: "r1" },
      { type: "stream_start", turn_ref: "r1", id: "A" },
      { type: "stream_delta", turn_ref: "r1", id: "A", content: "found it" },
      { type: "stream_end", turn_ref: "r1", id: "A" },
      { type: "turn_end", turn_ref: "r1", id: "A" },
    ]);
    const live = shownWith([], toShow(s.messages));
    expect(live.map((m) => [m.role, m.tools.length])).toEqual([
      ["user", 0],
      ["assistant", 1],
    ]);
    const kept = [asked, row({ id: "A", from: "agent", text: "found it", seq: 4, mark: { in_reply_to: "q", steps: [{ tool: "web.search", ok: true, ms: 5 }] } })];
    s = refreshed(s, kept);
    const shown = shownWith(kept, toShow(s.messages));
    expect(shown.map((m) => m.id)).toEqual(["h-q", "A"]);
    expect(shown[1]!.steps).toEqual([{ tool: "web.search", ok: true, ms: 5 }]);
  });
});

describe("an answer Desk heard after it restarted mid-turn", () => {
  afterEach(() => vi.useRealTimers());

  const VOTE = "You're right, Kings. My vote: two lost lights.";
  const story = row({ id: "h-s", from: "user", text: "what about the story?", client_id: "s", seq: 10, at: "2026-11-08T07:46:30Z" });
  const later = [
    row({ id: "h-ok", from: "user", text: "ok its all good - I like it", client_id: "ok", seq: 13, at: "2026-11-08T08:22:00Z" }),
    row({ id: "h-br", from: "agent", text: "Brilliant, Kings", seq: 14, at: "2026-11-08T08:22:30Z", mark: { in_reply_to: "ok" } }),
  ];
  /** The hub's copy of the answer, kept under an id of its own. */
  const vote = row({ id: "h-v", from: "agent", text: VOTE, seq: 11, at: "2026-11-08T07:49:10Z", mark: { in_reply_to: "s", steps: [{ tool: "notes", ok: true, ms: 40 }] } });

  /** A Desk that started at 07:47 hears the rest of a turn it never asked:
   *  it knows neither the question's client id nor, here, an id the answer
   *  was kept under. */
  const restarted = (frames: ServerMessage[]): ConversationState => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T07:47:20Z"));
    let s: ConversationState = { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream, FEATURES.clientIds]) };
    s = fold(s, frames.slice(0, 2));
    vi.setSystemTime(new Date("2026-11-08T07:49:05Z"));
    s = fold(s, frames.slice(2));
    vi.useRealTimers();
    return s;
  };

  const stamped: ServerMessage[] = [
    { type: "turn_snapshot", turn_ref: "r0", id: "R", text: "", status: "working" },
    { type: "tool_start", turn_ref: "r0", id: "R", content: "notes: Spores video: user approved the test" },
    { type: "tool_end", turn_ref: "r0", id: "R" },
    { type: "stream_start", turn_ref: "r0", id: "R" },
    { type: "stream_delta", turn_ref: "r0", id: "R", content: VOTE },
    { type: "stream_end", turn_ref: "r0", id: "R" },
    // Not kept under the id it streamed with.
    { type: "turn_end", turn_ref: "r0" },
  ];
  const unstamped: ServerMessage[] = [
    { type: "tool_start", content: "notes: Spores video: user approved the test" },
    { type: "tool_end" },
    { type: "stream_start" },
    { type: "stream_delta", content: VOTE },
    { type: "stream_end" },
  ];

  it.each([
    ["its turn's end said it wasn't kept under its id", stamped],
    ["its frames named no id", unstamped],
  ])("is its kept copy, once, in its place, when %s", (_why, frames) => {
    let s = restarted(frames);
    const answer = s.messages.find((m) => m.role === "assistant")!;
    expect(answer.tools.length).toBe(1);
    expect(answer.replyTo).toBeUndefined();

    const history = [...base, story, vote, ...later];
    s = refreshed(s, history);
    expect(s.messages).toEqual([]);
    const shown = shownWith(history, toShow(s.messages));
    expect(shown.map((m) => m.id)).toEqual(["h-m", "h-r", "h-s", "h-v", "h-ok", "h-br"]);
  });

  it("goes by its own time, never below what was said after it, where the hub kept no copy that says the same", () => {
    const s = restarted(unstamped);
    const history = [...base, story, ...later];
    const shown = shownWith(history, toShow(s.messages));
    expect(shown.map((m) => (m.id.startsWith("m-") ? "live" : m.id))).toEqual(["h-m", "h-r", "h-s", "live", "h-ok", "h-br"]);
  });

  it("never takes a kept answer from well before it, or one another live answer is by its id", () => {
    const s = restarted(unstamped);
    const answer = s.messages.find((m) => m.role === "assistant")!;
    const older = row({ id: "h-old", from: "agent", text: VOTE, seq: 3, at: "2026-11-08T06:00:00Z" });
    expect(keptOf([older, ...later], s.messages).size).toBe(0);
    const mine: ChatMessage = { ...answer, id: "h-v", byWords: false };
    expect([...keptOf([vote], [mine, answer])]).toEqual(["h-v"]);
  });

  it("leaves an answer the hub named after what was said during its turn until a read has it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T09:00:00Z"));
    let s: ConversationState = { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream, FEATURES.clientIds]) };
    s = sent(s, "q9", Q, "r9");
    s = fold(s, [{ type: "tool_start", turn_ref: "r9", content: "web.search: a" }]);
    vi.setSystemTime(new Date("2026-11-08T09:10:00Z"));
    s = fold(s, [
      { type: "stream_start", turn_ref: "r9", id: "A9" },
      { type: "stream_delta", turn_ref: "r9", id: "A9", content: "found it" },
      { type: "stream_end", turn_ref: "r9", id: "A9" },
    ]);
    vi.useRealTimers();
    const history = [
      row({ id: "h-q9", from: "user", text: Q, client_id: "q9", seq: 20, at: "2026-11-08T09:00:00Z" }),
      row({ id: "h-w9", from: "user", text: W, client_id: "w9", seq: 21, at: "2026-11-08T09:05:00Z" }),
    ];
    expect(shownWith(history, toShow(s.messages)).map((m) => m.id)).toEqual(["h-q9", "h-w9", "A9"]);
  });

  it("stays last while it is still being written", () => {
    const s = restarted(unstamped.slice(0, 4));
    const shown = shownWith([...base, story, ...later], toShow(s.messages));
    expect(shown.at(-1)?.status).toBe("streaming");
  });

  /** A live message Desk made itself, said at `at`. */
  const live = (m: Partial<ChatMessage> & Pick<ChatMessage, "content" | "at">): ChatMessage => ({
    id: `m-${m.at}`,
    role: "assistant",
    status: "complete",
    tools: [],
    ...m,
  });

  it("is the kept answer nearest its time, of two that say the same in successive turns", () => {
    const first = row({ id: "h-d1", from: "agent", text: "Done.", seq: 21, at: "2026-11-08T10:00:00Z", mark: { in_reply_to: "a1" } });
    const second = row({ id: "h-d2", from: "agent", text: "Done.", seq: 23, at: "2026-11-08T10:01:30Z", mark: { in_reply_to: "a2" } });
    const one = row({ id: "h-a1", from: "user", text: "do one", client_id: "a1", seq: 20, at: "2026-11-08T09:59:50Z" });
    const two = row({ id: "h-a2", from: "user", text: "do two", client_id: "a2", seq: 22, at: "2026-11-08T10:01:00Z" });
    // The second turn's answer, live, before the hub has kept it: the first
    // turn's "Done." is another answer.
    const answer = live({ content: "Done.", at: "2026-11-08T10:01:20Z", replyTo: "a2" });
    expect(keptOf([one, first, two], [answer]).size).toBe(0);
    expect(shownWith([one, first, two], [answer]).map((m) => m.id)).toEqual(["h-a1", "h-d1", "h-a2", answer.id]);
    expect([...keptOf([one, first, two, second], [answer])]).toEqual([answer.id]);
    // Not knowing its question, it is the nearer of the two; the other is
    // the earlier one's.
    const unasked = live({ content: "Done.", at: "2026-11-08T10:01:20Z" });
    const earlier = live({ content: "Done.", at: "2026-11-08T10:00:05Z" });
    expect(keptOf([one, first, two, second], [unasked, earlier])).toEqual(new Set([unasked.id, earlier.id]));
    expect([...keptOf([one, second], [unasked])]).toEqual([unasked.id]);
  });

  it("is no copy of the same words said by another in a room, nor of one kept far after it", () => {
    const allan = { kind: "agent" as const, id: "allan", name: "Allan" };
    const sarah = row({ id: "h-sa", from: "agent", text: "Done.", seq: 30, at: "2026-11-08T10:01:30Z", author: { kind: "agent", id: "sarah", name: "Sarah" } });
    const answer = live({ content: "Done.", at: "2026-11-08T10:01:20Z", author: allan });
    expect(keptOf([sarah], [answer]).size).toBe(0);
    expect([...keptOf([{ ...sarah, author: allan }], [answer])]).toEqual([answer.id]);
    const muchLater = row({ id: "h-late", from: "agent", text: "Done.", seq: 31, at: "2026-11-08T12:00:00Z" });
    expect(keptOf([muchLater], [answer]).size).toBe(0);
  });

  it("places a failure the hub didn't keep by its time, never before the question it answers", () => {
    const failed = live({ role: "system", status: "error", content: ERR, at: "2026-11-08T07:49:00Z", replyTo: "s" });
    expect(shownWith([...base, story, ...later], [failed]).map((m) => m.id)).toEqual(["h-m", "h-r", "h-s", failed.id, "h-ok", "h-br"]);
  });

  it("keeps an answer after its question, and finds its copy, on a hub whose clock is minutes ahead", () => {
    const ahead = (m: ChatMessage, min = 5) => ({ ...m, at: new Date(Date.parse(m.at) + min * 60_000).toISOString() });
    const answer = live({ content: VOTE, at: "2026-11-08T07:49:05Z", replyTo: "s", byWords: true, id: "R" });
    // The question, kept at 07:51:30 by the hub's clock, was asked before it.
    const kept = [...base, ahead(story), ...later.map((m) => ahead(m))];
    expect(shownWith(kept, [answer]).map((m) => m.id)).toEqual(["h-m", "h-r", "h-s", "R", "h-ok", "h-br"]);
    const withCopy = [...base, ahead(story), ahead(vote), ...later.map((m) => ahead(m))];
    expect([...keptOf(withCopy, [answer])]).toEqual(["R"]);
    expect(shownWith(withCopy, [answer]).map((m) => m.id)).toEqual(["h-m", "h-r", "h-s", "h-v", "h-ok", "h-br"]);
  });
});
