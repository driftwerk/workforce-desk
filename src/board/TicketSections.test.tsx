import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Session } from "../hub/types";
import { SessionLine } from "./TicketSections";

const session = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "codex",
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

it("a ticket's session line says each state, drawn as needing the person when it fails or waits on them", () => {
  const shown = (s: Session) => {
    const { container } = render(<SessionLine session={s} className="ticket-row-faint" />);
    const line = container.firstElementChild!;
    const said = [line.textContent, line.classList.contains("ticket-session-needs")];
    cleanup();
    return said;
  };
  const pending = { id: "p1", tool: "Bash", detail: "rm -rf build", since: "2026-10-29T08:00:00Z", answerable: true };
  expect(shown(session())).toEqual(["working", false]);
  expect(shown(session({ state: "idle" }))).toEqual(["idle", false]);
  expect(shown(session({ state: "blocked", pending }))).toEqual(["needs you · Bash · rm -rf build", true]);
  expect(shown(session({ state: "blocked", pending, bossHas: "Desk" }))).toEqual(["Desk has it", false]);
  expect(shown(session({ state: "done", failed: "It stopped on its plan's usage limit" }))).toEqual(["It stopped on its plan's usage limit", true]);
});
