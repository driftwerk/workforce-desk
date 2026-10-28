import { describe, expect, it } from "vitest";
import { emptyConversation, finishedAnswers, reduce, wsUrl, type ConversationState } from "./conversation";
import type { ServerMessage } from "./types";

const run = (msgs: ServerMessage[], from: ConversationState = emptyConversation()) => msgs.reduce(reduce, from);

describe("conversation", () => {
  it("assembles a streamed answer and closes it", () => {
    const s = run([
      { type: "connected", session_id: "s1" },
      { type: "typing" },
      { type: "stream_start" },
      { type: "stream_delta", content: "Three items " },
      { type: "stream_delta", content: "are open." },
      { type: "stream_end" },
    ]);
    expect(s.sessionId).toBe("s1");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "assistant", content: "Three items are open.", status: "complete" });
    expect(s.streaming).toBe(false);
  });

  it("does not repeat a streamed answer the hub also sends whole", () => {
    const s = run([{ type: "stream_start" }, { type: "stream_delta", content: "Done." }, { type: "stream_end" }, { type: "message", content: "Done." }]);
    expect(s.messages).toHaveLength(1);
  });

  it("drops a discarded stream and tracks tools on the answer", () => {
    const s = run([
      { type: "stream_start" },
      { type: "stream_delta", content: "wrong" },
      { type: "stream_discard" },
      { type: "tool_start", content: "memory.recall" },
      { type: "tool_end" },
      { type: "message", content: "Right." },
    ]);
    expect(s.messages.map((m) => m.content)).toEqual(["Right."]);
    expect(s.messages[0]!.tools).toEqual([{ name: "memory.recall", done: true }]);
  });

  it("says what the agent is doing until the answer is in", () => {
    const steps = [
      { type: "typing" },
      { type: "tool_start", content: "memory.recall: token refresh" },
      { type: "tool_end" },
      { type: "stream_start" },
    ].reduce<ConversationState[]>((acc, m) => [...acc, reduce(acc.at(-1)!, m)], [emptyConversation()]);
    expect(steps.slice(1).map((s) => s.working?.step)).toEqual(["Thinking", "memory.recall — token refresh", "Thinking", "Writing"]);
    const since = steps[1]!.working!.since;
    expect(steps.slice(1).every((s) => s.working?.since === since)).toBe(true);
    expect(reduce(steps.at(-1)!, { type: "stream_end" }).working).toBeNull();
    expect(reduce(steps[1]!, { type: "error", error: "x" }).working).toBeNull();
  });

  it("streams an answer into the message its tools ran in", () => {
    const s = run([
      { type: "tool_start", content: "memory: releases" },
      { type: "tool_end" },
      { type: "stream_start" },
      { type: "stream_delta", content: "Nothing saved." },
      { type: "stream_end" },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ content: "Nothing saved.", status: "complete", tools: [{ name: "memory: releases", done: true }] });
  });

  it("shows errors as system messages", () => {
    const s = run([{ type: "error", error: "Unknown agent: x" }]);
    expect(s.messages[0]).toMatchObject({ role: "system", status: "error", content: "Unknown agent: x" });
  });

  it("reports an answer once, when it completes", () => {
    const streaming = run([{ type: "stream_start" }, { type: "stream_delta", content: "Done." }]);
    expect(finishedAnswers(emptyConversation(), streaming)).toEqual([]);
    const done = reduce(streaming, { type: "stream_end" });
    expect(finishedAnswers(streaming, done).map((m) => m.content)).toEqual(["Done."]);
    expect(finishedAnswers(done, reduce(done, { type: "message", content: "Done." }))).toEqual([]);
  });

  it("connects on the desk channel", () => {
    const url = new URL(wsUrl({ id: "local", label: "Local", url: "http://127.0.0.1:9", local: true, token: "t" }, "allan"));
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("channel")).toBe("desk");
    expect(url.searchParams.get("agent_id")).toBe("allan");
    expect(url.searchParams.get("rich")).toBe("tables,charts,forms,maps,diagrams,images");
    const room = new URL(wsUrl({ id: "local", label: "Local", url: "http://127.0.0.1:9", local: true, token: "t" }, "allan", "desk:release"));
    expect(room.searchParams.get("channel")).toBe("desk:release");
  });

  it("keeps what an overseer's answer offers to act on, whichever copy of the answer carries it", () => {
    const desk = { approvals: [{ sessionId: "s1", approvalId: "a1", summary: "Run npm install?" }] };
    const whole = run([{ type: "message", content: "It wants to install.", desk }]);
    expect(whole.messages[0]!.desk).toEqual(desk);
    const repeated = run([{ type: "stream_start" }, { type: "stream_delta", content: "Done." }, { type: "stream_end" }, { type: "message", content: "Done.", desk }]);
    expect(repeated.messages).toHaveLength(1);
    expect(repeated.messages[0]!.desk).toEqual(desk);
    const onEnd = run([{ type: "stream_start" }, { type: "stream_delta", content: "Done." }, { type: "stream_end", desk }]);
    expect(onEnd.messages[0]!.desk).toEqual(desk);
    expect(run([{ type: "message", content: "Plain." }]).messages[0]!.desk).toBeUndefined();
  });

  it("knows a turn you didn't start from one you did", () => {
    const theirs = run([{ type: "typing" }]);
    expect(theirs.unprompted).toBe(true);
    expect(run([{ type: "stream_start" }, { type: "stream_delta", content: "Green." }], theirs).unprompted).toBe(true);
    expect(run([{ type: "message", content: "Green." }], theirs)).toMatchObject({ unprompted: false, working: null });
    const yours = run([{ type: "typing" }], { ...emptyConversation(), working: { since: 0, step: "Sending" } });
    expect(yours.unprompted).toBe(false);
    expect(run([{ type: "message", content: "An answer the socket repeats" }]).unprompted).toBe(false);
  });

  it("shows a message the overseer sent on as it arrives, before its answer, once", () => {
    const author = { kind: "overseer" as const, id: "atlas", name: "Atlas" };
    const frame: ServerMessage = { type: "user_message", content: "Atlas asks: How is staging?", session_id: "s1", speakable: false, id: "h7", author };
    const s = run([{ type: "typing" }, frame, frame, { type: "stream_start" }, { type: "stream_delta", content: "Green." }, { type: "stream_end" }]);
    expect(s.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ["h7", "user", "Atlas asks: How is staging?"],
      [s.messages[1]!.id, "assistant", "Green."],
    ]);
    expect(s.messages[0]).toMatchObject({ author, sentOn: true, status: "complete" });
    expect(finishedAnswers(emptyConversation(), s).map((m) => m.content)).toEqual(["Green."]);
  });

  it("knows a turn whose prompt came live isn't one only the hub's copy shows", () => {
    const frame: ServerMessage = { type: "user_message", content: "Sam asks: Restart it.", id: "h8", author: { kind: "you", id: "you", name: "You" } };
    const told = run([{ type: "typing" }, frame]);
    expect(told).toMatchObject({ unprompted: false, working: { step: "Thinking" } });
    expect(run([{ type: "stream_start" }], told).unprompted).toBe(false);
    // Before the turn is said to start, it starts it.
    const early = run([frame, { type: "typing" }]);
    expect(early.unprompted).toBe(false);
    expect(early.working).not.toBeNull();
  });

  it("puts a message sent on before an answer that started without it, and ignores one with nothing to say", () => {
    const s = run([{ type: "stream_start" }, { type: "stream_delta", content: "On it" }, { type: "user_message", content: "Atlas asks: go", id: "h9" }]);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[1]).toMatchObject({ status: "streaming", content: "On it" });
    expect(run([{ type: "user_message", content: "  ", id: "h1" }]).messages).toEqual([]);
    // A hub that sends no id or author still shows it.
    expect(run([{ type: "user_message", content: "Atlas asks: go" }]).messages[0]).toMatchObject({ role: "user", sentOn: true });
  });
});
