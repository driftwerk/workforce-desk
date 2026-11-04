import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropped, emptyConversation, reduce, toShow, type ConversationState } from "./conversation";
import { settle, withHistory } from "./history";
import { FEATURES, type ChatMessage, type ServerMessage } from "./types";

// A DM on a hub that streams turns by ref and id, as Desk shows it: the live
// conversation folded from frames, given up for the hub's kept copy at each
// read, and the two put together.

const T1 = "2026-11-04T15:36:00.000Z";
const T1_KEPT = "2026-11-04T15:38:00.000Z";
const T2 = "2026-11-04T15:40:00.000Z";

const ANSWER = "Found it. The evidence:\n\n```text\nservice/src/lib.rs - handlers\n```";
const LATER = "That sounds like a sensible pace.";

const kept = (id: string, role: ChatMessage["role"], content: string, at: string): ChatMessage => ({
  id,
  role,
  content,
  at,
  status: "complete",
  tools: [],
});

/** What you typed, as Desk shows it on sending. */
const said = (s: ConversationState, id: string, content: string): ConversationState => ({
  ...s,
  messages: [...s.messages, { ...kept(id, "user", content, new Date().toISOString()) }],
});

const fold = (s: ConversationState, frames: ServerMessage[]) => frames.reduce(reduce, s);

/** A turn `ref` that runs tools, then streams its answer, its frames all
 *  naming `id` (none: a hub that doesn't), and ends saying `keptId`. */
const turn = (ref: string, id: string | undefined, text: string, keptId: string | null): ServerMessage[] => {
  const of = { turn_ref: ref, ...(id ? { id } : {}) };
  return [
    { type: "tool_start", content: "repo.list: service", ...of },
    { type: "tool_end", content: "repo.list (12ms, ok)", ...of },
    { type: "tool_start", content: "advisor: thinking (round 1)", ...of },
    { type: "tool_end", content: "advisor (900ms, ok)", ...of },
    { type: "stream_start", ...of },
    { type: "stream_delta", content: text, ...of },
    { type: "stream_end", ...of },
    { type: "turn_end", turn_ref: ref, ...(keptId ? { id: keptId } : {}) },
  ];
};

/** Reads the hub's kept page now, as the store does once a turn ends:
 *  the live messages it shows are given up for it. */
const read = (s: ConversationState, page: ChatMessage[], seen: ChatMessage[]) => {
  const now = new Date().toISOString();
  const { ids } = settle(page, s.messages, now, true, { began: now, seen: new Set(seen.map((m) => m.id)) });
  return { state: dropped(s, ids), loadedAt: now };
};

const shown = (page: ChatMessage[], s: ConversationState, loadedAt: string) => withHistory(page, toShow(s.messages), loadedAt);

describe("an answer read back after a later exchange", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const cases: { name: string; id: string | undefined; keptId: string | null; keptAs: string }[] = [
    { name: "kept under the id it streamed with", id: "r1", keptId: "r1", keptAs: "r1" },
    { name: "kept under another id than it streamed with", id: "r1", keptId: null, keptAs: "k1" },
    { name: "streamed with no id at all", id: undefined, keptId: null, keptAs: "k1" },
  ];

  for (const c of cases) {
    it(`shows once, in its place, whatever comes for it late: ${c.name}`, () => {
      let s: ConversationState = { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream]) };

      // T1: you ask; the answer runs tools and streams; the turn ends.
      vi.setSystemTime(new Date(T1));
      s = said(s, "m-ask", "Is it in the new repo?");
      s = fold(s, turn("t1", c.id, ANSWER, c.keptId));
      vi.setSystemTime(new Date("2026-11-04T15:38:05.000Z"));
      const first = [kept("h-ask", "user", "Is it in the new repo?", T1), kept(c.keptAs, "assistant", ANSWER, T1_KEPT)];
      let r = read(s, first, []);
      s = r.state;
      expect(shown(first, s, r.loadedAt).map((m) => m.id)).toEqual(["h-ask", c.keptAs]);

      // T2: you say more; it answers; the turn ends.
      vi.setSystemTime(new Date(T2));
      s = said(s, "m-more", "We're moving it over the next month.");
      s = fold(s, turn("t2", "r2", LATER, "r2"));
      vi.setSystemTime(new Date("2026-11-04T15:40:30.000Z"));
      const second = [
        ...first,
        kept("h-more", "user", "We're moving it over the next month.", T2),
        kept("r2", "assistant", LATER, "2026-11-04T15:40:10.000Z"),
      ];
      r = read(s, second, first);
      s = r.state;
      const after = ["h-ask", c.keptAs, "h-more", "r2"];
      expect(shown(second, s, r.loadedAt).map((m) => m.id)).toEqual(after);

      // Then frames of T1's answer, named by its id, come late: the
      // in-flight tool line, a snapshot, the answer whole. (A frame without
      // an id can't be told from something new.)
      if (!c.id) return;
      vi.setSystemTime(new Date("2026-11-04T15:41:00.000Z"));
      const of = { turn_ref: "t1", id: c.id };
      s = fold(s, [
        { type: "tool_start", content: "advisor: thinking (round 4)", ...of },
        { type: "turn_snapshot", text: ANSWER, ...of },
        { type: "message", content: ANSWER, ...of },
        { type: "stream_end", ...of },
      ]);
      expect(shown(second, s, r.loadedAt).map((m) => m.id)).toEqual(after);
    });
  }

  it("goes by its own time when the hub kept no copy of it", () => {
    vi.setSystemTime(new Date(T1));
    let s: ConversationState = { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream]) };
    s = fold(s, turn("t1", "r1", ANSWER, null));
    vi.setSystemTime(new Date("2026-11-04T15:40:30.000Z"));
    const page = [kept("h-more", "user", "We're moving it over.", T2), kept("r2", "assistant", LATER, "2026-11-04T15:40:10.000Z")];
    const r = read(s, page, []);
    expect(shown(page, r.state, r.loadedAt).map((m) => m.content)).toEqual([ANSWER, "We're moving it over.", LATER]);
  });
});
