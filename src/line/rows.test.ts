import { describe, expect, it } from "vitest";
import { askedText, deliveryText, editable, headOf, lineOf, merged, onThread, steerOf, waitsOnYou } from "./rows";
import { DESK, lined, msg, S1, S2, YOU } from "./testing";

const NOW = new Date("2026-11-03T12:00:00Z").getTime();

describe("a line's rows", () => {
  it("say who wrote to whom, from the session's side", () => {
    expect(headOf(msg(), "s1")).toBe("It asks Sarah");
    expect(headOf(msg({ from: DESK, to: S1, kind: "answer" }), "s1")).toBe("Sarah answers");
    expect(headOf(msg({ from: YOU, to: S1, kind: "tell" }), "s1")).toBe("You say");
    expect(headOf(msg({ from: S2, to: S1, kind: "tell" }), "s1")).toBe("acme-api says");
    expect(headOf(msg({ to: YOU }), "s1")).toBe("It asks you");
  });

  it("say why a message hasn't gone in, and when it did", () => {
    const to = (m: Parameters<typeof msg>[0]) => deliveryText(msg({ from: YOU, to: S1, kind: "tell", ...m }), NOW);
    expect(to({ delivery: "queued", waiting: "working" })).toBe("Waiting for it to finish its turn");
    expect(to({ delivery: "queued", waiting: "typing" })).toBe("Waiting: you're typing in its terminal");
    expect(to({ delivery: "held" })).toBe("Held: it gets this when it runs again");
    expect(to({ delivery: "handed" })).toBe("On its way");
    expect(to({ delivery: "delivered" })).toMatch(/^Delivered /);
    expect(deliveryText(msg(), NOW)).toBeNull();
  });

  it("say where a question stands and whether it waits on you", () => {
    expect(askedText(msg())).toBe("Waiting on Sarah");
    expect(waitsOnYou(msg())).toBe(false);
    expect(askedText(msg({ to: YOU }))).toBe("Waiting on you");
    expect(waitsOnYou(msg({ to: YOU }))).toBe(true);
    expect(waitsOnYou(msg({ asked: "escalated" }))).toBe(true);
    expect(askedText(msg({ asked: "answered" }))).toBe("Answered");
    expect(waitsOnYou(msg({ asked: "answered", to: YOU }))).toBe(false);
    expect(askedText(msg({ kind: "tell", asked: null }))).toBeNull();
  });

  it("let you change only your own messages, until they go", () => {
    expect(editable(msg({ from: YOU, to: S1, delivery: "queued" }))).toBe(true);
    expect(editable(msg({ from: YOU, to: S1, delivery: "held" }))).toBe(true);
    expect(editable(msg({ from: YOU, to: S1, delivery: "handed" }))).toBe(false);
    expect(editable(msg({ from: DESK, to: S1, delivery: "queued" }))).toBe(false);
  });

  it("say when a session has no line, and when Send now goes into its turn", () => {
    expect(lineOf(lined())).toEqual({ on: true });
    expect(lineOf(lined({ origin: "external" }))).toEqual({ on: false, why: "Not on Desk's line: it runs in another terminal." });
    const old = lined({ caps: { ...lined().caps!, line: "none", notes: ["Update Claude Code to 2.1.287 or later to message this session."] } });
    expect(lineOf(old)).toEqual({ on: false, why: "Update Claude Code to 2.1.287 or later to message this session." });
    expect(steerOf(lined())).toBeNull();
    expect(steerOf(lined({ state: "working" }))).toEqual({ label: "Send now" });
    expect(steerOf(lined({ state: "working", caps: { ...lined().caps!, steer: "none" } }))).toBeNull();
  });

  it("keep a thread in time order, a change in place, a removal gone", () => {
    const a = msg({ id: "a", at: "2026-11-03T10:00:00Z" });
    const b = msg({ id: "b", at: "2026-11-03T10:01:00Z" });
    expect(merged([b], a).map((m) => m.id)).toEqual(["a", "b"]);
    expect(merged([a, b], { ...a, asked: "answered" })[0]!.asked).toBe("answered");
    expect(merged([a, b], a, true).map((m) => m.id)).toEqual(["b"]);
    expect(onThread(msg({ from: S2, to: S1 }), "s1")).toBe(true);
    expect(onThread(msg({ from: S2, to: DESK }), "s1")).toBe(false);
  });
});
