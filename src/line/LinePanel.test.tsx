import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, useDesk } from "../hub/store";
import type { LineMessage, Session } from "../hub/types";
import { LinePanel } from "./LinePanel";
import { PANEL_HEIGHT, useLinePanel } from "./panel";
import { useLine } from "./store";
import { DESK, lined, msg, S1, YOU } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

let thread: LineMessage[] = [];
const hub = {
  lineThread: vi.fn(() => Promise.resolve(thread)),
  dismissLine: vi.fn((id: string) => Promise.resolve({ ...thread.find((m) => m.id === id)!, asked: "dismissed" as const })),
  draftLine: vi.fn(() => Promise.resolve(lined())),
  // Sent now, the hub reads it back as waiting for the next tool call; the
  // row it answers with says no more than that (a line event's row).
  sendLineNow: vi.fn((id: string) => {
    thread = thread.map((m) => (m.id === id ? { ...m, waiting: "next_call" as const, actions: ["withdraw" as const] } : m));
    return Promise.resolve({ ...thread.find((m) => m.id === id)!, actions: undefined });
  }),
  takeBackLine: vi.fn(() => Promise.resolve()),
  editLine: vi.fn(() => Promise.resolve()),
};

const went = (id: string, text: string, chose: string | null = null) =>
  msg({ id, from: S1, to: YOU, text, asked: "lapsed", chose, at: "2026-11-03T03:37:00Z" });

/** A question asked in parts, gone ahead with its default. */
const asked = () =>
  msg({
    id: "w7",
    from: S1,
    to: YOU,
    asked: "lapsed",
    at: "2026-11-03T07:19:00Z",
    text: "Should PR 2 include the stub service?",
    about: "W7 · PR 2",
    why: "The design lists it; the brief doesn't.",
    chose: "include it, as the design says",
    details: "The design's table lists:\n\n- the stub service\n- its `api_url` in the dev config",
    question: { headline: "Should PR 2 include the stub service?", details: "The design's table lists:\n\n- the stub service\n- its `api_url` in the dev config" },
  });

const show = async (more: Partial<Session> = {}) => {
  const session = lined(more);
  useDesk.setState({ hub: hub as never, sessions: { s1: session } });
  const view = render(
    <div className="gpane-body">
      <LinePanel session={session} />
    </div>,
  );
  await act(async () => {});
  return view;
};

beforeEach(() => {
  thread = [];
  useLine.setState({ threads: {}, problems: {}, asked: {} });
  useLinePanel.setState({ shown: {}, heights: {} });
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("under a terminal session", () => {
  it("is nothing at all while nothing on its line is open", async () => {
    thread = [
      msg({ id: "a", to: YOU, asked: "answered", text: "Which port?" }),
      msg({ id: "d", to: YOU, asked: "dismissed", text: "Ship it?" }),
      msg({ id: "t", from: DESK, to: S1, kind: "tell", asked: null, delivery: "delivered", text: "go on" }),
      msg({ id: "n", from: DESK, to: S1, kind: "tell", asked: null, delivery: "noted", text: "noted" }),
    ];
    const { container } = await show();
    expect(container.querySelector(".gpane-body")!.childElementCount).toBe(0);
    expect(screen.queryByText("Which port?")).toBeNull();
    // Even a panel left shown last time doesn't come up for nothing.
    act(() => useLinePanel.getState().show("s1"));
    expect(container.querySelector(".gpane-body")!.childElementCount).toBe(0);
    // ...and goes down, so the next question comes as the slim bar.
    expect(useLinePanel.getState().shown.s1).toBeUndefined();
  });

  it("is a slim bar by default, and shown lists the questions with what it chose, with no composer", async () => {
    thread = [
      went("q1", "Global assignments too, or only Agency/Self?", "keep it to Agency/Self only."),
      went("q2", "Retire the two legacy routes?", "keep both routes for now."),
    ];
    await show({ state: "working" });
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("It asked you 2 questions · went ahead with its defaults");
    expect(screen.queryByText("Global assignments too, or only Agency/Self?")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: /^Show/ }));
    const panel = screen.getByRole("region", { name: "Questions from this session" });
    expect((panel as HTMLElement).style.height).toBe(`${PANEL_HEIGHT}px`);
    expect(within(panel).getByText("Global assignments too, or only Agency/Self?")).toBeTruthy();
    expect(within(panel).getByText("It chose: keep it to Agency/Self only.")).toBeTruthy();
    expect(within(panel).getAllByText(/^Went ahead · \S.*\d(\s?[AP]M)?$/)).toHaveLength(2);
    for (const name of ["Discuss in terminal", "Copy all", "Dismiss all", "Hide"]) expect(within(panel).getByRole("button", { name })).toBeTruthy();
    // You talk to it in its terminal: no composer, no answer box.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/Send when done|Send now/)).toBeNull();
    // Shown stays shown for this session.
    expect(JSON.parse(localStorage.getItem("desk.linePanel")!).shown).toEqual({ s1: "questions" });
    fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("status").textContent).toContain("It asked you 2 questions");
  });

  it("heads a card with its work item and one line, says what it chose, and folds its details away", async () => {
    thread = [asked()];
    useLinePanel.setState({ shown: { s1: "questions" } });
    const { container } = await show();
    const card = container.querySelector(".line-question") as HTMLElement;
    const status = card.querySelector(".line-question-status")!;
    expect(status.querySelector(".mono")!.textContent).toBe("W7 · PR 2 · ");
    expect(status.textContent).toMatch(/^W7 · PR 2 · went ahead · \S.*\d(\s?[AP]M)?$/);
    expect(within(card).getByText("Should PR 2 include the stub service?").className).toBe("line-question-text");
    expect(within(card).getByText("It chose: include it, as the design says")).toBeTruthy();
    // The details are there, as markdown, but folded until opened.
    const details = card.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Details");
    expect(within(details).getByText("Why: The design lists it; the brief doesn't.")).toBeTruthy();
    expect(details.querySelectorAll("li")).toHaveLength(2);
    expect(details.querySelector("code")!.textContent).toBe("api_url");
    // Nothing of the details is in the card's own text.
    expect(card.querySelector(".line-question-text")!.textContent).not.toContain("table");
    fireEvent.click(within(card).getByRole("button", { name: "Dismiss “Should PR 2 include the stub service?”" }));
    await act(async () => {});
    expect(hub.dismissLine).toHaveBeenCalledWith("w7");
  });

  it("puts all of a question in the prompt and on the clipboard, details too", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    thread = [asked()];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Discuss in terminal" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await act(async () => {});
    const [, text] = hub.draftLine.mock.calls[0] as unknown as [string, string];
    for (const part of [
      "W7 · PR 2",
      "“Should PR 2 include the stub service?”",
      "Why: The design lists it; the brief doesn't.",
      "You went ahead with: include it, as the design says",
      "- the stub service",
      "- its `api_url` in the dev config",
    ])
      expect(text).toContain(part);
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("dismisses a question, and the panel goes once nothing is open", async () => {
    thread = [went("q1", "Keep the old table?", "keep it")];
    useLinePanel.setState({ shown: { s1: "questions" } });
    const { container } = await show();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss “Keep the old table?”" }));
    await act(async () => {});
    expect(hub.dismissLine).toHaveBeenCalledWith("q1");
    expect(container.querySelector(".gpane-body")!.childElementCount).toBe(0);
    expect(useLine.getState().asked.q1).toBe("dismissed");
  });

  it("goes when the question is dismissed elsewhere (the Floor), as the hub says", async () => {
    thread = [went("q1", "Keep the old table?")];
    const { container } = await show();
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => {
      announce({ type: "line", message: { ...thread[0]!, asked: "dismissed" } });
    });
    expect(container.querySelector(".gpane-body")!.childElementCount).toBe(0);
  });

  it("dismisses them all at once", async () => {
    thread = [went("q1", "One?"), went("q2", "Two?")];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    await act(async () => {});
    expect(hub.dismissLine.mock.calls.map((c) => c[0])).toEqual(["q1", "q2"]);
    expect(screen.queryByText("One?")).toBeNull();
  });

  it("puts the questions in its prompt unsent, and not while it shows a dialog", async () => {
    thread = [went("q1", "Retire the legacy routes?", "keep both"), msg({ id: "q2", to: YOU, asked: "open", text: "Ship it?" })];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Discuss in terminal" }));
    await act(async () => {});
    const [id, text] = hub.draftLine.mock.calls[0] as unknown as [string, string];
    expect(id).toBe("s1");
    expect(text).toContain("- “Retire the legacy routes?” You went ahead with: keep both");
    expect(text).toContain("- “Ship it?” You're still waiting on my answer.");
    expect(text).not.toMatch(/\r/);
    cleanup();
    await show({ state: "blocked" });
    const discuss = screen.getByRole("button", { name: "Discuss in terminal" });
    expect((discuss as HTMLButtonElement).disabled).toBe(true);
    expect(discuss.title).toBe("It's showing a dialog in its terminal; answer that first.");
  });

  it("is dragged taller and remembered for the session; a stored height that can't be read is ignored", async () => {
    thread = [went("q1", "One?")];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show();
    const handle = screen.getByRole("separator", { name: "Resize this panel" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(useLinePanel.getState().heights.s1).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem("desk.linePanel")!).heights.s1).toBe(useLinePanel.getState().heights.s1);
  });

  it("shows the whole line, read only, from Messages with Desk…, with nothing open too", async () => {
    thread = [msg({ id: "a", to: YOU, asked: "answered", text: "Which port?" })];
    await show();
    act(() => useLinePanel.getState().show("s1", "history"));
    const panel = screen.getByRole("region", { name: "Messages with Desk" });
    expect(within(panel).getByText("Which port?")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Messages with Desk" })).toBeNull();
  });
});

describe("what waits to go in, under a terminal session", () => {
  const BOSS = { kind: "manager" as const, id: "boss", name: "Desk" };
  const LONG = "Check the ledger totals before the cut-over.\n\nThen tell me which accounts moved, and hold the migration if any of them is off by more than a cent.";
  /** Desk's message, held for the turn running, as a newer hub reads it. */
  const held = (more: Partial<LineMessage> = {}) =>
    msg({
      id: "t1",
      at: new Date(Date.now() - 12 * 60_000).toISOString(),
      from: BOSS,
      to: S1,
      kind: "tell",
      asked: null,
      delivery: "queued",
      deliveredAt: null,
      waiting: "working",
      text: LONG,
      actions: ["send_now", "withdraw"],
      ...more,
    });

  it("is a bar saying who it is from, why it waits and its first line; Show has the message itself", async () => {
    thread = [held()];
    await show({ state: "working", displayName: "Cufflink Migration" });
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("1 message from Desk waits for this turn to end · “Check the ledger totals before the cut-over.”");
    fireEvent.click(within(bar).getByRole("button", { name: /^Show/ }));
    const panel = screen.getByRole("region", { name: "Waiting to go in" });
    expect(screen.queryByRole("region", { name: "Questions from this session" })).toBeNull();
    // Who, when, all of it, and why, in its words.
    const card = panel.querySelector(".line-row-waiting") as HTMLElement;
    expect(card.querySelector(".line-row-head")!.textContent).toMatch(/^Desk says · \S/);
    expect(card.querySelector(".line-waiting-text")!.textContent).toBe(LONG);
    expect(within(card).getByText("Cufflink Migration is in the middle of a turn: this goes in when that turn ends. It has waited 12 min.")).toBeTruthy();
    expect(within(panel).queryByText(/in its menu shows them/)).toBeNull();
    // Only what the hub can do: a boss's words aren't yours to change.
    expect(within(card).getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
    // Questions' actions are the questions' alone.
    expect(within(panel).queryByRole("button", { name: "Discuss in terminal" })).toBeNull();
  });

  it("sends it into the running turn now, and then says it goes in with the next tool call", async () => {
    thread = [held()];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show({ state: "working" });
    const panel = screen.getByRole("region", { name: "Waiting to go in" });
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Send now" })));
    expect(hub.sendLineNow).toHaveBeenCalledWith("t1");
    expect(within(panel).getByText(/^Sent now: acme-web reads this with its next tool call's result/)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Send now" })).toBeNull();
    // Read back from the hub: Withdraw still there.
    expect(within(panel).getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(hub.lineThread).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reads the line again when a message waiting comes in, for why it waits and what can be done", async () => {
    await show({ state: "working" });
    expect(screen.queryByRole("status")).toBeNull();
    // A line event's row says neither why it waits nor what can be done.
    thread = [held()];
    await act(async () => useLine.getState().heard({ ...held(), waiting: undefined, actions: undefined }));
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("1 message from Desk waits for this turn to end");
    fireEvent.click(within(bar).getByRole("button", { name: /^Show/ }));
    const panel = screen.getByRole("region", { name: "Waiting to go in" });
    expect(within(panel).getByText(/is in the middle of a turn/)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Withdraw" })).toBeTruthy();
  });

  it("withdraws it, and says why when the hub can't", async () => {
    thread = [held()];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show({ state: "working" });
    const panel = screen.getByRole("region", { name: "Waiting to go in" });
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Withdraw" })));
    expect(hub.takeBackLine).toHaveBeenCalledWith("t1");
    hub.takeBackLine.mockImplementationOnce(() => Promise.reject(new Error("It's already on its way.")));
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Withdraw" })));
    expect(within(panel).getByRole("alert").textContent).toContain("already on its way");
  });

  it("edits your own words in place, and offers no Send now from an older hub that doesn't say it can", async () => {
    thread = [held({ from: YOU, text: "and the refunds", actions: undefined })];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show({ state: "working" });
    const panel = screen.getByRole("region", { name: "Waiting to go in" });
    expect(within(panel).queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Edit" }));
    const box = within(panel).getByRole("textbox", { name: "Edit your message" });
    fireEvent.change(box, { target: { value: "and the refunds, both months" } });
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Save" })));
    expect(hub.editLine).toHaveBeenCalledWith("t1", "and the refunds, both months");
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Withdraw" })).toBeTruthy();
  });

  it("says a hand-off is in its terminal's hands, with nothing to do here", async () => {
    thread = [held({ delivery: "handed", waiting: undefined, actions: undefined })];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show({ state: "working" });
    const panel = screen.getByRole("region", { name: "Waiting to go in" });
    expect(within(panel).getByText(/^Handed to its terminal: it goes in as soon as acme-web takes it\./)).toBeTruthy();
    expect(within(panel).queryAllByRole("button").map((b) => b.textContent)).toEqual(["Hide"]);
  });

  it("gives questions and what waits each a section, under a title for both", async () => {
    thread = [went("q1", "Retire the two legacy routes?", "keep both"), held()];
    useLinePanel.setState({ shown: { s1: "questions" } });
    await show({ state: "working" });
    const panel = screen.getByRole("region", { name: "Questions and messages waiting to go in" });
    const questions = within(panel).getByRole("region", { name: "Its questions to you" });
    const waiting = within(panel).getByRole("region", { name: "Waiting to go in" });
    expect(within(questions).getByText("Retire the two legacy routes?")).toBeTruthy();
    expect(waiting.querySelector(".line-waiting-text")!.textContent).toBe(LONG);
    expect(within(waiting).queryByText("Retire the two legacy routes?")).toBeNull();
  });
});

describe("Desk's own view of a session", () => {
  it("keeps the thread with its composer", async () => {
    await show({ view: "desk" });
    expect(screen.getByRole("textbox", { name: "Message acme-web" })).toBeTruthy();
  });
});
