import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { NeedRow } from "../floor/NeedRow";
import { useFloor } from "../floor/store";
import { hub as account, need, session as who } from "../floor/testing";
import { useDesk } from "../hub/store";
import type { Asked, Session } from "../hub/types";
import { notificationFor } from "../shell/notify";
import { sessionActions } from "./actions";
import { allowLabel } from "./Approval";
import { SessionCard } from "./SessionCard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../shell/navigate", () => ({ openTarget: vi.fn() }));

const session = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "claude",
  name: "keychain-check",
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state: "idle",
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "terminal",
  createdAt: "2026-10-29T08:00:00Z",
  updatedAt: "2026-10-29T08:00:00Z",
  ...more,
});

const denied: Asked = {
  ask: "Stopped: Bash was not allowed",
  why: "auto mode refused Bash ([Credential Exploration])",
  options: null,
  denied: { tool: "Bash(security find-generic-password -s probe -w)", detail: "security find-generic-password -s probe -w", reason: "[Credential Exploration]", allowable: true },
};

const question: Asked = { ask: "Should I deploy main or release/4.2?", why: "asked you to choose between 2 options", options: ["main", "release/4.2"], denied: null };

const hub = {
  interrupt: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
  resume: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  allowAsked: vi.fn(() => Promise.resolve()),
  dismissAsked: vi.fn(() => Promise.resolve()),
};

const shown = (s: Session) => {
  useDesk.setState({ sessions: { [s.id]: s }, hub: hub as never });
  return s;
};

beforeEach(() => {
  Object.values(hub).forEach((f) => f.mockClear());
  useDesk.setState({ rooms: {}, sessions: {}, hub: hub as never });
});
afterEach(cleanup);

describe("a session's actions", () => {
  const labels = (s: Partial<Session>) => sessionActions(session(s)).map((a) => a.label);

  it("offer Interrupt while it works, and Stop only for one Desk started", () => {
    expect(labels({ state: "working" })).toEqual(["Interrupt", "Stop"]);
    expect(labels({ state: "working", terminalId: "t1" })).toEqual(["Interrupt"]);
    expect(labels({ state: "done" })).toEqual(["Stop"]);
    expect(labels({ state: "asking", terminalId: "t1" })).toEqual([]);
    expect(labels({ live: false, state: "stopped" })).toEqual(["Resume"]);
  });

  it("interrupt a tracked session through the hub, leaving its terminal be", () => {
    sessionActions(session({ state: "working", terminalId: "t1" }))[0]!.run();
    expect(hub.interrupt).toHaveBeenCalledWith("s1");
    expect(hub.stop).not.toHaveBeenCalled();
  });
});

describe("a session that stopped to ask", () => {
  it("offers to allow the refused tool for the session and carry on, to reply, or to dismiss", async () => {
    const s = shown(session({ state: "asking", asked: denied }));
    render(<SessionCard session={s} />);
    const asked = screen.getByRole("group", { name: "keychain-check asked" });
    expect(asked.textContent).toContain("Needs you · asked");
    expect(asked.textContent).toContain("Stopped: Bash was not allowed");
    expect(asked.textContent).toContain("[Credential Exploration]");
    fireEvent.click(within(asked).getByRole("button", { name: "Allow this command for this session and continue" }));
    expect(hub.allowAsked).toHaveBeenCalledWith("s1");
    await act(() => Promise.resolve());
    fireEvent.click(within(asked).getByRole("button", { name: "Dismiss" }));
    expect(hub.dismissAsked).toHaveBeenCalledWith("s1");
    expect(within(asked).getByRole("button", { name: "Reply…" })).toBeTruthy();
  });

  it("offers no allow for a question, or a refusal only the person can get past", () => {
    const s = shown(session({ state: "asking", asked: question }));
    const { rerender } = render(<SessionCard session={s} />);
    expect(screen.getByText("Should I deploy main or release/4.2?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
    const safety = { ...denied, denied: { ...denied.denied!, allowable: false } };
    rerender(<SessionCard session={shown(session({ state: "asking", asked: safety }))} />);
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
  });

  it("shows nothing asked once it is done", () => {
    const s = shown(session({ state: "done", asked: null }));
    render(<SessionCard session={s} />);
    expect(screen.queryByText("Needs you · asked")).toBeNull();
  });

  it("is answered from its need on the Floor: allowed and continued, or dismissed", async () => {
    useChat.setState({ hubs: [account("local")] });
    useFloor.setState({ deciding: {}, problems: {} });
    shown(session({ state: "asking", asked: denied }));
    const n = { ...need("question:t1", who("s1", "keychain-check"), { ask: denied.ask }), hubId: "local", local: true, key: "local/question:t1", stale: false };
    render(<NeedRow need={n} now={Date.now()} actions />);
    expect(screen.getByText(/auto mode refused Bash/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow this command for this session and continue" }));
    expect(hub.allowAsked).toHaveBeenCalledWith("s1");
    await act(() => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(hub.dismissAsked).toHaveBeenCalledWith("s1");
  });

  it("names what an allow allows: the one call where the tool has one, else the tool", () => {
    expect(allowLabel(denied.denied!)).toBe("Allow this command for this session and continue");
    expect(allowLabel({ ...denied.denied!, tool: "Edit(src/a.rs)", detail: "src/a.rs" })).toBe("Allow this file for this session and continue");
    expect(allowLabel({ ...denied.denied!, tool: "workforce · memory_recall", detail: "" })).toBe("Allow workforce · memory_recall for this session and continue");
  });

  it("notifies as needing you", () => {
    expect(notificationFor("working", session({ state: "asking", asked: question }))).toEqual({
      title: "keychain-check needs you",
      body: "Should I deploy main or release/4.2?",
    });
    expect(notificationFor("asking", session({ state: "done" }))?.title).toBe("keychain-check is done");
  });
});

describe("answering a tracked session's approvals in Desk", () => {
  it("is a switch on its card, off by default", () => {
    const s = shown(session({ state: "working", terminalId: "t1" }));
    render(<SessionCard session={s} />);
    const toggle = screen.getByRole("checkbox", { name: /Answer approvals in Desk/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(hub.update).toHaveBeenCalledWith("s1", { approvals: "desk" });
  });

  it("is only for a session started by hand in a Desk terminal", () => {
    render(<SessionCard session={shown(session({ state: "working" }))} />);
    expect(screen.queryByRole("checkbox", { name: /Answer approvals in Desk/ })).toBeNull();
  });
});
