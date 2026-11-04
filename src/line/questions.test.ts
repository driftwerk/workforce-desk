import { describe, expect, it } from "vitest";
import { anyOpen, barText, discussText, openOf, statusOf } from "./questions";
import { DESK, msg, S1, S2, YOU } from "./testing";

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
    expect(barText({ questions: [lapsed("a", "x", "keep"), lapsed("b", "y")], waiting: [] })).toBe("It asked you 2 questions · went ahead with its defaults");
    expect(barText({ questions: [lapsed("a", "x")], waiting: [] })).toBe("It asked you 1 question · went ahead without an answer");
    expect(barText({ questions: [lapsed("a", "x", "keep"), msg({ to: YOU, asked: "open" })], waiting: [] })).toBe("It asked you 2 questions · waiting on you");
    expect(barText({ questions: [], waiting: [msg({ kind: "tell", to: S1 })] })).toBe("1 message waiting to go in");
  });
});

describe("a question's card", () => {
  it("says whether it is paused on you or went ahead, and when it asked", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(statusOf(lapsed("a", "x", "keep"), now)).toMatch(/^Went ahead with its default · asked /);
    expect(statusOf(lapsed("a", "x"), now)).toMatch(/^Went ahead without an answer · asked /);
    expect(statusOf(msg({ to: YOU, asked: "open" }), now)).toMatch(/^Paused until you answer · asked /);
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
