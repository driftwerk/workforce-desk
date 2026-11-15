import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { ActivityEvent, Session } from "../hub/types";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { deliver, startGrids, useGrids } from "./store";
import { bossClosed, onFinishedEvent } from "./finished";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const session = (id: string, state: Session["state"]): Session => ({
  id,
  engine: "claude",
  name: id,
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state,
  live: false,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "2026-11-15T08:00:00Z",
  updatedAt: "2026-11-15T08:00:00Z",
});

const stopped = (id: string, by: "manager" | "you" = "manager"): ActivityEvent => ({
  id: `e-${id}`,
  at: "2026-11-15T09:00:00Z",
  kind: "stopped",
  actor: { kind: by, id: "kev", name: "Kev" },
  subject: { kind: "session", id, name: id },
  text: `ended ${id}`,
});

const shown = () =>
  useGrids
    .getState()
    .grids[MAIN_GRID]!.panes.filter((p) => p.content?.kind === "session")
    .map((p) => (p.content as { sessionId: string }).sessionId)
    .sort();

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  for (const id of ["web", "api", "docs"]) deliver(MAIN_GRID, { kind: "session", sessionId: id });
  useDesk.setState({ sessions: { web: session("web", "closed"), api: session("api", "stopped"), docs: session("docs", "closed") } });
});

describe("a session its boss closed as finished", () => {
  it("leaves the grid; one it only stopped, or one you ended, keeps its pane", () => {
    expect(shown()).toEqual(["api", "docs", "web"]);
    onFinishedEvent({ type: "activity", event: stopped("web") });
    expect(shown()).toEqual(["api", "docs"]);
    // Stopped, not closed: still on the grid.
    onFinishedEvent({ type: "activity", event: stopped("api") });
    // You ended it yourself: its pane says it's closed, with Resume.
    onFinishedEvent({ type: "activity", event: stopped("docs", "you") });
    expect(shown()).toEqual(["api", "docs"]);
  });

  it("is told apart only from a manager's stop of a session no longer open", () => {
    const open = (k: string) => k === "api";
    expect(bossClosed(stopped("web"), open)).toBe("web");
    expect(bossClosed(stopped("api"), open)).toBeNull();
    expect(bossClosed({ ...stopped("web"), kind: "finished" }, open)).toBeNull();
    expect(bossClosed({ ...stopped("web"), subject: { kind: "agent", id: "scout", name: "Scout" } }, open)).toBeNull();
  });
});
