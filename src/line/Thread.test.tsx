import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import { deskListeners } from "../hub/store";
import type { LineMessage } from "../hub/types";
import { DeskActions } from "../overview/DeskActions";
import { requestFocus } from "../shell/focus";
import { useLine } from "./store";
import { DESK, lined, msg, S1, S2, YOU } from "./testing";
import { Thread } from "./Thread";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

let thread: LineMessage[] = [];
const hub = {
  lineThread: vi.fn(() => Promise.resolve(thread)),
  postLine: vi.fn((_id: string, text: string, when: "queue" | "now") =>
    Promise.resolve(msg({ id: `posted-${when}`, from: YOU, to: S1, kind: "tell", text, asked: null, delivery: when === "now" ? "delivered" : "queued" })),
  ),
  editLine: vi.fn(() => Promise.resolve()),
  takeBackLine: vi.fn(() => Promise.resolve()),
  answerLine: vi.fn((id: string, text: string) => Promise.resolve(msg({ id: `answer-${id}`, from: YOU, to: S1, kind: "answer", text, asked: null, inReplyTo: id }))),
};

const show = async (more: Parameters<typeof lined>[0] = {}) => {
  const session = lined(more);
  useDesk.setState({ hub: hub as never, sessions: { s1: session } });
  render(<Thread session={session} />);
  await act(async () => {});
};

const rowOf = (text: string) => screen.getByText(text).closest("li")!;

beforeEach(() => {
  thread = [];
  useLine.setState({ threads: {}, problems: {} });
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("a session's line", () => {
  it("shows what waits for it, why, and what went in", async () => {
    thread = [
      msg({ id: "a", from: YOU, to: S1, kind: "tell", text: "then run the linter", asked: null, delivery: "queued", waiting: "working", deliveredAt: null }),
      msg({ id: "b", from: YOU, to: S1, kind: "tell", text: "and the docs", asked: null, delivery: "queued", waiting: "typing", deliveredAt: null }),
      msg({ id: "c", from: S2, to: S1, kind: "tell", text: "the API moved to /v2", asked: null, delivery: "held", hop: 2, deliveredAt: null }),
      msg({ id: "d", from: DESK, to: S1, kind: "answer", text: "5433", asked: null, inReplyTo: "q" }),
    ];
    await show({ state: "working" });
    expect(within(rowOf("then run the linter")).getByText(/Waiting for it to finish its turn/)).toBeTruthy();
    expect(within(rowOf("and the docs")).getByText(/you're typing in its terminal/)).toBeTruthy();
    expect(within(rowOf("the API moved to /v2")).getByText(/hop 2 · Held: it gets this when it runs again/)).toBeTruthy();
    expect(within(rowOf("5433")).getByText(/Sarah answers/)).toBeTruthy();
    expect(within(rowOf("5433")).getByText(/Delivered/)).toBeTruthy();
    expect(rowOf("then run the linter").className).toContain("line-row-waiting");
    expect(rowOf("5433").className).not.toContain("line-row-waiting");
  });

  it("answers a question Desk gave you with its draft, an option or your own words, once", async () => {
    thread = [
      msg({
        id: "q",
        asked: "escalated",
        text: "May I push to main?",
        escalation: { why: "Pushing to the default branch is yours to decide.", options: ["Yes", "Not yet"], draft: "Yes, once CI is green." },
      }),
    ];
    await show();
    const card = screen.getByRole("group", { name: "Answer acme-web" });
    expect(within(card).getByText("Pushing to the default branch is yours to decide.")).toBeTruthy();
    expect(within(card).getByText("Desk would say: “Yes, once CI is green.”")).toBeTruthy();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Send Desk’s answer" })));
    expect(hub.answerLine).toHaveBeenCalledWith("q", "Yes, once CI is green.");
    expect(screen.getByRole("status").textContent).toBe("You answered: “Yes, once CI is green.”");
  });

  it("says when the question was already answered elsewhere", async () => {
    thread = [msg({ id: "q", to: YOU, text: "Ship it?" })];
    hub.answerLine.mockImplementationOnce(() => Promise.reject(new Error("That question was already answered.")));
    await show();
    const card = screen.getByRole("group", { name: "Answer acme-web" });
    fireEvent.change(within(card).getByRole("textbox"), { target: { value: "Yes" } });
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Answer" })));
    expect(screen.getByRole("alert").textContent).toContain("already answered");
    // The hub's word that it was answered takes the card away.
    act(() => {
      for (const f of deskListeners) f({ type: "line", message: msg({ id: "q", to: YOU, text: "Ship it?", asked: "answered" }) });
    });
    expect(screen.queryByRole("group", { name: "Answer acme-web" })).toBeNull();
    expect(within(rowOf("Ship it?")).getByText(/Answered/)).toBeTruthy();
  });

  it("lets you change or take back your message until it goes", async () => {
    thread = [msg({ id: "mine", from: YOU, to: S1, kind: "tell", text: "run the tests", asked: null, delivery: "queued", waiting: "working", deliveredAt: null })];
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Edit your message" }));
    const field = screen.getByRole("textbox", { name: "Edit your message" });
    fireEvent.change(field, { target: { value: "run the e2e tests" } });
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    expect(hub.editLine).toHaveBeenCalledWith("mine", "run the e2e tests");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Take back your message" })));
    expect(hub.takeBackLine).toHaveBeenCalledWith("mine");
    act(() => {
      for (const f of deskListeners) f({ type: "line", message: msg({ id: "mine", from: YOU, to: S1, kind: "tell", text: "run the tests" }), removed: true });
    });
    expect(screen.queryByText("run the tests")).toBeNull();
  });

  it("sends at the turn's end, or into it with Send now where the engine can", async () => {
    await show({ state: "working" });
    const box = screen.getByRole("textbox", { name: "Message acme-web" });
    fireEvent.change(box, { target: { value: "use the staging DB" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send now" })));
    expect(hub.postLine).toHaveBeenCalledWith("s1", "use the staging DB", "now");
    fireEvent.change(box, { target: { value: "then the docs" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send when done" })));
    expect(hub.postLine).toHaveBeenLastCalledWith("s1", "then the docs", "queue");
    expect(screen.getByText("then the docs")).toBeTruthy();
  });

  it("offers only Send where the engine can't take a message mid-turn", async () => {
    await show({ state: "working", engine: "codex", terminalId: "t1", caps: { ...lined().caps!, line: "paste", steer: "none" } });
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send when done" })).toBeTruthy();
  });

  it("says why a session has no line", async () => {
    await show({ origin: "external" });
    expect(screen.queryByRole("textbox", { name: "Message acme-web" })).toBeNull();
    expect(screen.getByText("Not on Desk's line: it runs in another terminal.")).toBeTruthy();
  });

  it("takes focus in the answer when Reply… on the Floor asks for it", async () => {
    thread = [msg({ id: "q", to: YOU, text: "Ship it?" })];
    await show();
    act(() => requestFocus("line:s1"));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Your answer to acme-web" }));
  });
});

describe("a session's question in the overseer's DM", () => {
  const extras = {
    questions: [{ messageId: "q", sessionId: "s1", session: "acme-web", ask: "May I push to main?", why: "Pushing is yours.", options: ["Yes"], draft: null }],
  };

  it("is answered in place", async () => {
    thread = [msg({ id: "q", asked: "escalated", text: "May I push to main?" })];
    useDesk.setState({ hub: hub as never, sessions: { s1: lined() } });
    render(<DeskActions extras={extras} />);
    await act(async () => {});
    const card = screen.getByRole("group", { name: "acme-web's question" });
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Yes" })));
    expect(hub.answerLine).toHaveBeenCalledWith("q", "Yes");
  });

  it("says when it was answered elsewhere", async () => {
    thread = [msg({ id: "q", asked: "answered", text: "May I push to main?" })];
    useDesk.setState({ hub: hub as never, sessions: { s1: lined() } });
    render(<DeskActions extras={extras} />);
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Already answered.");
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });
});
