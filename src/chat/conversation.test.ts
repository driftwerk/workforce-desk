import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";
import {
  Conversation,
  disconnected,
  emptyConversation,
  finishedAnswers,
  reduce,
  statusOf,
  wsPath,
  type ConversationState,
} from "./conversation";
import type { DeskTurn, HubAccount, ServerMessage } from "./types";

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

  it("keeps what a spoken answer says beside what it shows", () => {
    const s = run([
      { type: "stream_start" },
      { type: "stream_delta", content: "", speech: "(excited) " },
      { type: "stream_delta", content: "Found it. ", speech: "Found it. " },
      { type: "stream_delta", content: "Well, " },
      { type: "stream_delta", content: "yes.", speech: "(sighing) yes." },
      { type: "stream_end" },
    ]);
    expect(s.messages[0]).toMatchObject({ content: "Found it. Well, yes.", speech: "(excited) Found it. Well, (sighing) yes." });
    const whole = run([{ type: "message", content: "Done.", speech: "(calm) Done." }]);
    expect(whole.messages[0]).toMatchObject({ content: "Done.", speech: "(calm) Done." });
  });

  it("has no speech for an answer that says what it shows", () => {
    const s = run([{ type: "stream_start" }, { type: "stream_delta", content: "Plain." }, { type: "stream_end" }]);
    expect(s.messages[0]).toMatchObject({ content: "Plain." });
    expect(s.messages[0]!.speech).toBeUndefined();
  });

  it("says what was shown before a reconnect, and what's spoken after it", () => {
    const s = run([
      { type: "turn_snapshot", id: "r", text: "Found it. " },
      { type: "stream_delta", content: "Well.", speech: "(sighing) Well." },
    ]);
    expect(s.messages[0]).toMatchObject({ content: "Found it. Well.", speech: "Found it. (sighing) Well." });
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

  it("connects on the desk channel, naming no token", () => {
    const url = new URL(wsPath("allan"), "ws://hub.invalid");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.has("token")).toBe(false);
    expect([...url.searchParams.keys()].sort()).toEqual(["accept", "agent_id", "channel", "desk", "rich"]);
    expect(url.searchParams.get("channel")).toBe("desk");
    expect(url.searchParams.get("agent_id")).toBe("allan");
    expect(url.searchParams.get("rich")).toBe("tables,charts,forms,maps,diagrams,images,chart_specs");
    const room = new URL(wsPath("allan", "desk:release"), "ws://hub.invalid");
    expect(room.searchParams.get("channel")).toBe("desk:release");
    expect(url.searchParams.get("desk")).toBe("1");
    expect(url.searchParams.get("accept")).toBe("*/*");
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
    const yours = run([{ type: "typing" }], { ...emptyConversation(), working: { since: 0, at: 0, phase: "sending", step: "Sending" } });
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

const declared: ServerMessage = { type: "connected", session_id: "s1", features: ["desk.place", "desk.stream", "desk.deliveries"] };
const stamp = (type: string, more: Partial<ServerMessage> = {}): ServerMessage => ({ type, turn_ref: "t1", id: "r1", ...more });

describe("a Desk connection's turns", () => {
  it("folds a streamed answer into the draft of its turn, by ref", () => {
    const s = run([declared, stamp("typing"), stamp("stream_start"), stamp("stream_delta", { content: "Two " }), stamp("stream_delta", { content: "left." })]);
    expect(s.turns.t1).toMatchObject({ ref: "t1", replyId: "r1", text: "Two left.", state: "live", acked: true });
    expect(s.turns.t1!.working).toMatchObject({ phase: "writing", step: "Writing" });
    const ended = run([stamp("stream_end"), stamp("turn_end")], s);
    expect(ended.turns.t1).toMatchObject({ state: "ended", replyId: "r1", working: null });
    expect(ended.working).toBeNull();
  });

  it("knows the message its answer will be from the first frame that names it, and a turn that saved nothing", () => {
    expect(run([declared, stamp("typing")]).turns.t1!.replyId).toBe("r1");
    expect(run([declared, stamp("tool_start", { content: "bash" })]).turns.t1!.replyId).toBe("r1");
    expect(run([declared, stamp("typing"), stamp("tool_end", { id: undefined })]).turns.t1!.replyId).toBe("r1");
    expect(run([declared, stamp("typing"), stamp("turn_end", { id: undefined })]).turns.t1!.replyId).toBeNull();
  });

  it("says what a turn waits on: thinking for so long, a tool, a rate limit counting down, a model switch", () => {
    const thinking = run([declared, stamp("typing")]).turns.t1!.working!;
    expect(statusOf(thinking, thinking.at + 1_000)).toBe("Thinking");
    expect(statusOf(thinking, thinking.at + 12_000)).toBe("Thinking · 12s");
    const tool = run([declared, stamp("tool_start", { content: "linear.search: open issues" })]).turns.t1!.working!;
    expect(statusOf(tool, tool.at)).toBe("linear.search — open issues");
    const limited = run([declared, stamp("typing"), stamp("rate_limited", { content: "rate-limited, retry #1 in 30s" })]).turns.t1!.working!;
    expect(statusOf(limited, limited.at + 4_000)).toBe("Retrying (rate limited) · 26s");
    const failover = run([declared, stamp("typing"), stamp("slow_model_failover", { content: "gpt-x produced nothing for 45s — switching model" })]);
    expect(failover.turns.t1!.working!.step).toBe("Switching model (gpt-x was silent)");
    expect(failover.working!.step).toBe("Switching model (gpt-x was silent)");
  });

  it("picks a turn up again from its snapshot after a reconnect, without repeating what streamed", () => {
    const before = run([declared, stamp("stream_start"), stamp("stream_delta", { content: "Part one. " })]);
    const dropped = disconnected(before);
    expect(dropped.turns.t1!.state).toBe("stalled");
    const back = run(
      [
        declared,
        stamp("turn_snapshot", { status: "writing", since: "2026-10-30T10:00:00Z", text: "Part one. Part two. " }),
        stamp("stream_delta", { content: "Part three." }),
      ],
      dropped,
    );
    expect(back.turns.t1).toMatchObject({ state: "live", text: "Part one. Part two. Part three." });
    expect(back.messages.filter((m) => m.role === "assistant").map((m) => [m.id, m.content])).toEqual([["r1", "Part one. Part two. Part three."]]);
  });

  it("keeps one answer when the hub sends it whole after streaming it, by its id", () => {
    const s = run([declared, stamp("stream_start"), stamp("stream_delta", { content: "Done." }), stamp("stream_end"), stamp("message", { content: "Done." }), stamp("turn_end")]);
    expect(s.messages.map((m) => [m.id, m.content, m.status])).toEqual([["r1", "Done.", "complete"]]);
  });

  it("shows a delivery pushed while a turn runs without ending the turn", () => {
    const live = run([declared, stamp("typing")]);
    const s = reduce(live, { type: "message", content: "🔔 Reminder: stand-up", id: "d1" });
    expect(s.working).not.toBeNull();
    expect(s.messages.at(-1)).toMatchObject({ id: "d1", content: "🔔 Reminder: stand-up", status: "complete" });
  });

  it("puts a turn's files on its answer and its draft", () => {
    const file = { filename: "chart.png", mime_type: "image/png", artifact_id: "art_1", size: 9, width: 2, height: 1 };
    const s = run([declared, stamp("typing"), stamp("image", { content: "the chart", attachments: [file] }), stamp("stream_start"), stamp("stream_delta", { content: "Here." })]);
    const shown = { artifact_id: "art_1", media_type: "image/png", filename: "chart.png", size: 9, width: 2, height: 1 };
    expect(s.turns.t1!.attachments).toEqual([shown]);
    expect(s.messages.filter((m) => m.role === "assistant")).toEqual([expect.objectContaining({ id: "r1", content: "Here.", attachments: [shown] })]);
  });

  it("holds a permission prompt until it is answered or its turn ends", () => {
    const prompt = stamp("permission_prompt", {
      request_id: "q1",
      tool_name: "slack.send",
      content: 'Posts outside Desk, to slack #ops: "deploy done"',
      prompt_options: { allow_once: true, deny_once: true, allow_always: true, deny_always: true },
    });
    const s = run([declared, stamp("typing"), prompt, prompt]);
    expect(s.prompts).toEqual([
      { requestId: "q1", tool: "slack.send", content: 'Posts outside Desk, to slack #ops: "deploy done"', options: prompt.prompt_options, turnRef: "t1" },
    ]);
    expect(reduce(s, stamp("turn_end")).prompts).toEqual([]);
  });

  it("counts a follow-up the hub took into the live turn, and says a busy refusal plainly", () => {
    expect(run([declared, { type: "injected", content: "Follow-up absorbed into active run" }]).absorbed).toBe(1);
    const busy = run([declared, stamp("error", { content: "busy" })]);
    expect(busy.turns.t1).toMatchObject({ state: "failed", error: "busy" });
    expect(busy.messages.at(-1)!.content).toMatch(/still answering/);
  });
});

describe("sending on a Desk connection", () => {
  afterEach(() => vi.unstubAllGlobals());
  const hub: HubAccount = { id: "local", label: "Local", url: "http://127.0.0.1:9", local: true, revision: "t" };
  const turn: DeskTurn = { place: { kind: "dm" }, speaker: { kind: "person" }, hop: 0, context: [], spoken: true };
  const open = async (connected: ServerMessage) => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const c = new Conversation(hub, "scout", () => {});
    const socket = FakeSocket.find("/ws", "scout")!;
    await new Promise((r) => setTimeout(r, 0));
    expect(c.send("too soon")).toBe(false);
    socket.receive(connected);
    return { c, socket };
  };

  it("sends the turn, a ref and that it answers approvals to a hub that takes them", async () => {
    const { c, socket } = await open(declared);
    const file = { artifact_id: "art_1", media_type: "application/pdf", filename: "q3.pdf", size: 9 };
    const sent = c.send("what's open?", { turn, legacy: "[old] what's open?", attachments: [file] });
    expect(sent && sent.turnRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(socket.chats[0]).toMatchObject({
      content: "what's open?",
      desk: turn,
      turn_ref: sent && sent.turnRef,
      answers_approvals: true,
      attachments: [{ filename: "q3.pdf", mime_type: "application/pdf", artifact_id: "art_1" }],
    });
    expect(c.current.messages.at(-1)).toMatchObject({ role: "user", attachments: [file] });
  });

  it("sends an older hub today's frame, in the words it understands", async () => {
    const { c, socket } = await open({ type: "connected", session_id: "s1" });
    expect(c.send("what's open?", { turn, legacy: "[old] what's open?" })).toEqual({ turnRef: null });
    expect(socket.chats[0]).toEqual({ type: "chat", content: "[old] what's open?", session_id: "s1", channel: "desk", agent_id: "scout" });
  });

  it("answers a prompt on the socket and stops showing it", async () => {
    const { c, socket } = await open(declared);
    socket.receive(stamp("permission_prompt", { request_id: "q1", content: "x" }));
    expect(c.answer("q1", "allow_always")).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: "permission_response", request_id: "q1", choice: "allow_always" });
    expect(c.current.prompts).toEqual([]);
  });
});
