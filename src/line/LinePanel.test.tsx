import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deskListeners, useDesk } from "../hub/store";
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
};

const went = (id: string, text: string, chose: string | null = null) =>
  msg({ id, from: S1, to: YOU, text, asked: "lapsed", chose, at: "2026-11-03T03:37:00Z" });

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
    expect(within(panel).getAllByText(/^Went ahead with its default · asked /)).toHaveLength(2);
    for (const name of ["Discuss in terminal", "Copy all", "Dismiss all", "Hide"]) expect(within(panel).getByRole("button", { name })).toBeTruthy();
    // You talk to it in its terminal: no composer, no answer box.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/Send when done|Send now/)).toBeNull();
    // Shown stays shown for this session.
    expect(JSON.parse(localStorage.getItem("desk.linePanel")!).shown).toEqual({ s1: "questions" });
    fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("status").textContent).toContain("It asked you 2 questions");
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
      for (const l of deskListeners) l({ type: "line", message: { ...thread[0]!, asked: "dismissed" } });
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

describe("Desk's own view of a session", () => {
  it("keeps the thread with its composer", async () => {
    await show({ view: "desk" });
    expect(screen.getByRole("textbox", { name: "Message acme-web" })).toBeTruthy();
  });
});
