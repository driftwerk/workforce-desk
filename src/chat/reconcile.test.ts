import { describe, expect, it } from "vitest";
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
