import { describe, expect, it } from "vitest";
import type { LineMessage } from "../hub/types";
import { anyOpen, barText, detailsOf, discussText, headlineOf, openOf, statusOf } from "./questions";
import { DESK, msg, S1, S2, YOU } from "./testing";

/** A question asked in parts, as the hub sends it. */
const shaped = (more: Partial<LineMessage> = {}) =>
  msg({
    id: "w7",
    to: YOU,
    asked: "lapsed",
    text: "Should PR 2 include the stub service?",
    about: "W7 · PR 2",
    why: "The design lists it; the brief doesn't.",
    chose: "include it, as the design says",
    details: "The design's table lists:\n\n- the stub service\n- its `api_url` in the dev config",
    question: { headline: "Should PR 2 include the stub service?", details: "The design's table lists:\n\n- the stub service\n- its `api_url` in the dev config" },
    ...more,
  });

const lapsed = (id: string, text: string, chose?: string) => msg({ id, to: YOU, text, asked: "lapsed", chose: chose ?? null });

describe("what is open on a session's line", () => {
  it("is its questions to you, waiting or gone ahead without, and what waits to go in", () => {
    const thread = [
      msg({ id: "open", to: YOU, asked: "open" }),
      msg({ id: "given", to: DESK, asked: "escalated" }),
      lapsed("went", "Keep the old table?", "keep it"),
      msg({ id: "answered", to: YOU, asked: "answered" }),
      msg({ id: "dismissed", to: YOU, asked: "dismissed" }),
      msg({ id: "withdrawn", to: YOU, asked: "withdrawn" }),
      msg({ id: "to-desk", to: DESK, asked: "open" }),
      msg({ id: "other", from: S2, to: YOU, asked: "open" }),
      msg({ id: "queued", from: DESK, to: S1, kind: "tell", asked: null, delivery: "queued" }),
      msg({ id: "delivered", from: DESK, to: S1, kind: "tell", asked: null, delivery: "delivered" }),
      msg({ id: "noted", from: DESK, to: S1, kind: "tell", asked: null, delivery: "noted" }),
    ];
    const o = openOf(thread, "s1");
    expect(o.questions.map((m) => m.id)).toEqual(["open", "given", "went"]);
    expect(o.waiting.map((m) => m.id)).toEqual(["queued"]);
  });

  it("is nothing once every question is answered or dismissed and every message went in", () => {
    const o = openOf(
      [
        msg({ id: "a", to: YOU, asked: "answered" }),
        msg({ id: "d", to: YOU, asked: "dismissed" }),
        msg({ id: "t", from: DESK, to: S1, kind: "tell", asked: null, delivery: "delivered" }),
        msg({ id: "w", from: DESK, to: S1, kind: "tell", asked: null, delivery: "withdrawn" }),
      ],
      "s1",
    );
    expect(anyOpen(o)).toBe(false);
  });
});

describe("the slim bar's words", () => {
  it("says what it asked and where that stands", () => {
    expect(barText({ questions: [lapsed("a", "x", "keep"), lapsed("b", "y")], waiting: [] }, "s1")).toBe("It asked you 2 questions · went ahead with its defaults");
    expect(barText({ questions: [lapsed("a", "x")], waiting: [] }, "s1")).toBe("x · went ahead without an answer");
    expect(barText({ questions: [lapsed("a", "x", "keep"), msg({ to: YOU, asked: "open" })], waiting: [] }, "s1")).toBe("It asked you 2 questions · waiting on you");
  });

  it("says what waits to go in: how many, from whom, why, and the first one's first line", () => {
    const tell = (more: Parameters<typeof msg>[0]) => msg({ from: DESK, to: S1, kind: "tell", asked: null, delivery: "queued", deliveredAt: null, ...more });
    const desk = { kind: "manager" as const, id: "boss", name: "Desk" };
    const working = tell({ from: desk, waiting: "working", text: "Check the ledger totals before the cut-over.\n\nThen tell me what moved." });
    expect(barText({ questions: [], waiting: [working] }, "s1")).toBe("1 message from Desk waits for this turn to end · “Check the ledger totals before the cut-over.”");
    // A long first line is cut short; more than one says how many.
    const long = tell({ waiting: "working", text: "a".repeat(80) });
    expect(barText({ questions: [], waiting: [long, tell({ id: "m2", waiting: "working" })] }, "s1")).toBe(`2 messages from Sarah wait for this turn to end · “${"a".repeat(59)}…”`);
    // From more than one sender: no name.
    expect(barText({ questions: [], waiting: [working, tell({ id: "m2", from: YOU })] }, "s1")).toMatch(/^2 messages wait for this turn to end · /);
    expect(barText({ questions: [], waiting: [tell({ from: YOU, text: "and the refunds" })] }, "s1")).toBe("1 message from you waits to go in · “and the refunds”");
    expect(barText({ questions: [], waiting: [tell({ waiting: "next_call", text: "x" })] }, "s1")).toBe("1 message from Sarah goes in with its next tool call · “x”");
    expect(barText({ questions: [], waiting: [tell({ delivery: "held", text: "x" })] }, "s1")).toBe("1 message from Sarah waits for it to run again · “x”");
    expect(barText({ questions: [], waiting: [tell({ delivery: "handed", text: "x" })] }, "s1")).toBe("1 message from Sarah is on its way in · “x”");
    expect(barText({ questions: [], waiting: [tell({ waiting: "person_driving", text: "x" })] }, "s1")).toBe("1 message from Sarah waits until you hand it back · “x”");
    expect(barText({ questions: [], waiting: [tell({ waiting: "dialog", text: "x" })] }, "s1")).toBe("1 message from Sarah waits for the dialog in its terminal · “x”");
    // Its questions come first.
    expect(barText({ questions: [lapsed("a", "x")], waiting: [working] }, "s1")).toBe("x · went ahead without an answer");
  });

  it("names one question by its work item and headline, never its details", () => {
    expect(barText({ questions: [shaped()], waiting: [] }, "s1")).toBe("W7 · PR 2 · Should PR 2 include the stub service? · went ahead");
    expect(barText({ questions: [msg({ to: YOU, asked: "open", text: "Ship it?" })], waiting: [] }, "s1")).toBe("Ship it? · waiting on you");
  });
});

describe("a question's card", () => {
  it("says whether it is paused on you or went ahead, and when it asked", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(statusOf(lapsed("a", "x", "keep"), now)).toMatch(/^Went ahead · \S.*\d(\s?[AP]M)?$/);
    expect(statusOf(lapsed("a", "x"), now)).toMatch(/^Went ahead without an answer · \S.*\d(\s?[AP]M)?$/);
    expect(statusOf(msg({ to: YOU, asked: "open" }), now)).toMatch(/^Paused until you answer · \S.*\d(\s?[AP]M)?$/);
    // After its work item, it reads on from it.
    expect(statusOf(shaped(), now)).toMatch(/^went ahead · \S.*\d(\s?[AP]M)?$/);
  });
});

describe("Discuss in terminal's text", () => {
  it("lists each question with what it chose, on lines of their own, with no carriage return", () => {
    const text = discussText([
      lapsed("a", "Global assignments too,\r\nor only Agency/Self?", "Agency/Self only."),
      lapsed("b", "Retire the legacy routes?"),
      msg({ id: "c", to: YOU, asked: "open", text: "Ship it?" }),
    ]);
    expect(text).toBe(
      "About the questions you asked me on Desk:\n" +
        "- “Global assignments too, or only Agency/Self?” You went ahead with: Agency/Self only.\n" +
        "- “Retire the legacy routes?” You went ahead without my answer.\n" +
        "- “Ship it?” You're still waiting on my answer.\n",
    );
    expect(text).not.toContain("\r");
    expect(discussText([lapsed("a", "x")])).toMatch(/^About the question you asked me on Desk:\n/);
  });
});

describe("all of a question, for the terminal and the clipboard", () => {
  it("has its work item, question, why, what it chose and every line of its details", () => {
    expect(discussText([shaped()])).toBe(
      "About the question you asked me on Desk:\n" +
        "- W7 · PR 2: “Should PR 2 include the stub service?” You went ahead with: include it, as the design says\n" +
        "  Why: The design lists it; the brief doesn't.\n" +
        "  Details:\n" +
        "    The design's table lists:\n" +
        "\n" +
        "    - the stub service\n" +
        "    - its `api_url` in the dev config\n",
    );
  });

  it("keeps the rest of a question asked in one block, as the hub split it", () => {
    const old = msg({
      to: YOU,
      asked: "lapsed",
      text: "Keep the old table? It still has rows from March.",
      question: { headline: "Keep the old table?", details: "It still has rows from March." },
    });
    expect(headlineOf(old)).toBe("Keep the old table?");
    expect(detailsOf(old)).toBe("It still has rows from March.");
    expect(discussText([old])).toContain("“Keep the old table?” You went ahead without my answer.\n  Details:\n    It still has rows from March.\n");
    // From an older hub: all it said is the headline.
    expect(headlineOf(msg({ text: "Ship it?" }))).toBe("Ship it?");
    expect(detailsOf(msg({ text: "Ship it?" }))).toBeNull();
  });
});
