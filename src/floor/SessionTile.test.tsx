import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../hub/types";
import { Tile } from "./SessionTile";

const session = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "claude",
  name: "api-e7",
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state: "working",
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "2026-10-29T08:00:00Z",
  updatedAt: "2026-10-29T08:00:00Z",
  ...more,
});

afterEach(cleanup);

const stateLine = () => document.querySelector(".tile-state")?.textContent;

it("says the model a session was given beside its state, and nothing for its engine's default", () => {
  const { unmount } = render(<Tile session={session()} now={Date.now()} />);
  expect(stateLine()).toBe("working · local");
  unmount();
  render(<Tile session={session({ model: "sonnet" })} now={Date.now()} />);
  expect(stateLine()).toBe("working · local · Sonnet");
  cleanup();
  render(<Tile session={session({ engine: "codex", model: "gpt-6.1-sol" })} now={Date.now()} />);
  expect(stateLine()).toBe("working · local · gpt-6.1-sol");
});

const logLine = () => document.querySelector(".tile-log")?.textContent;

describe("a tile's log line", () => {
  const since = () => new Date(Date.now() - 3 * 60_000).toISOString();
  const waits = () => ({ words: "waiting for a build slot", since: since() });

  it("says what a working session with a tool waits on and for how long", () => {
    render(<Tile session={session({ currentTool: "Bash", waits: waits() })} now={Date.now()} />);
    expect(logLine()).toBe("● Bash · waiting for a build slot, 3m");
  });

  it("says it without a tool", () => {
    render(<Tile session={session({ waits: waits() })} now={Date.now()} />);
    expect(logLine()).toBe("● waiting for a build slot, 3m");
  });

  it("joins a done session's background work with what it waits on, said once when they began together", () => {
    const { unmount } = render(<Tile session={session({ state: "done", background: { count: 1, since: since() }, waits: waits() })} now={Date.now()} />);
    expect(logLine()).toBe("Waiting on 1 background task · 3m · waiting for a build slot");
    unmount();
    const earlier = new Date(Date.now() - 13 * 60_000).toISOString();
    render(<Tile session={session({ state: "done", background: { count: 1, since: earlier }, waits: waits() })} now={Date.now()} />);
    expect(logLine()).toBe("Waiting on 1 background task · 13m · waiting for a build slot, 3m");
  });

  it("is the background work alone, or the current tool alone, without waits", () => {
    const { unmount } = render(<Tile session={session({ state: "done", background: { count: 2, since: since() } })} now={Date.now()} />);
    expect(logLine()).toBe("Waiting on 2 background tasks · 3m");
    unmount();
    render(<Tile session={session({ currentTool: "Bash" })} now={Date.now()} />);
    expect(logLine()).toBe("● Bash");
  });
});
