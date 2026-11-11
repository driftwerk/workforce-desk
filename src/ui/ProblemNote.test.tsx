import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useOverview } from "../overview/store";
import { askText } from "./askDesk";
import type { Problem } from "./problem";
import { ProblemNote } from "./ProblemNote";

const send = vi.fn(() => true);
const openDm = vi.fn();

beforeEach(() => {
  send.mockClear();
  openDm.mockClear();
  useOverview.setState({ manager: null });
  useChat.setState({ send, openDm, hubs: [{ id: "h1", local: true }] } as never);
});
afterEach(cleanup);

const problem: Problem = {
  plain: "Claude sign-in didn’t finish.",
  fix: { label: "Sign in again", run: vi.fn() },
  details: "Claude sign-in ended without a token. browser closed",
  what: "signing in to Claude",
};

describe("ProblemNote", () => {
  it("shows the headline and keeps the raw text folded under Details", () => {
    const { container } = render(<ProblemNote problem={problem} />);
    expect(screen.getByText("Claude sign-in didn’t finish.")).toBeTruthy();
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText("Details")).toBeTruthy();
    expect(details.textContent).toContain("ended without a token");
    // Outside Details, the raw text is not on show.
    expect(container.querySelector(".problem-plain")!.textContent).not.toContain("token");
  });

  it("runs the fix, then reports done", () => {
    const done = vi.fn();
    render(<ProblemNote problem={problem} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(problem.fix!.run).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it("dismisses", () => {
    const done = vi.fn();
    render(<ProblemNote problem={problem} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("offers Ask Desk beside the fix once Desk's agent is there, and sends it the error with its context", () => {
    useOverview.setState({ manager: { agentId: "desk", level: "suggest" } } as never);
    render(<ProblemNote problem={problem} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Desk" }));
    expect(send).toHaveBeenCalledTimes(1);
    const [key, text] = send.mock.calls[0] as unknown as [string, string];
    expect(key).toBe("h1/desk");
    expect(text).toContain("Claude sign-in didn’t finish.");
    expect(text).toContain("signing in to Claude");
    expect(text).toContain("ended without a token");
  });

  it("has no Ask Desk when there is no Desk agent, and no dead button for an ask-fix", () => {
    render(<ProblemNote problem={{ plain: "Desk wasn’t allowed to do that.", fix: { label: "Ask Desk to fix it", ask: true } }} />);
    expect(screen.queryByRole("button", { name: /Ask Desk/ })).toBeNull();
  });

  it("makes the ask-fix the main button when Desk's agent is there", () => {
    useOverview.setState({ manager: { agentId: "desk", level: "suggest" } } as never);
    const done = vi.fn();
    render(<ProblemNote problem={{ plain: "Desk wasn’t allowed to do that.", fix: { label: "Ask Desk to fix it", ask: true }, details: "forbidden" }} onDone={done} />);
    expect(screen.getAllByRole("button", { name: /Ask Desk/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ask Desk to fix it" }));
    expect(send).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it("has nothing to show under Details when there is no raw text", () => {
    const { container } = render(<ProblemNote problem={{ plain: "Desk is busy." }} />);
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("askText", () => {
  it("tells the agent what was seen, what was being done and the raw error", () => {
    const t = askText(problem);
    expect(t).toMatch(/What I saw: Claude sign-in didn’t finish\./);
    expect(t).toMatch(/What I was doing: signing in to Claude/);
    expect(t).toMatch(/The raw error:\nClaude sign-in ended/);
  });
});

describe("no Desk agent", () => {
  it("an ask-fix gives way to its real next step", () => {
    const run = vi.fn();
    render(<ProblemNote problem={{ plain: "Desk wasn’t allowed to do that.", fix: { label: "Ask Desk to fix it", ask: true, alt: { label: "Open settings", run } } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(run).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Ask Desk/ })).toBeNull();
  });

  it("secrets are out of what Desk's agent is sent", () => {
    expect(askText({ plain: "x", what: ["using tok", "en=", "Hunter2-Hunter2-Hunter2"].join(""), details: ["Authoriz", "ation: Bea", "rer q1w2e3r4t5y6 ", "gh", "p_", "aB3xK9aB3xK9aB3xK9aB"].join("") })).not.toMatch(/Hunter2-Hunter2|q1w2e3|aB3xK9aB3xK9/);
  });
});
