import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
  const { unmount } = render(<Tile session={session()} />);
  expect(stateLine()).toBe("working · local");
  unmount();
  render(<Tile session={session({ model: "sonnet" })} />);
  expect(stateLine()).toBe("working · local · Sonnet");
  cleanup();
  render(<Tile session={session({ engine: "codex", model: "gpt-6.1-sol" })} />);
  expect(stateLine()).toBe("working · local · gpt-6.1-sol");
});
