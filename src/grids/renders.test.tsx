import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useChat } from "../chat/store";
import { emptyConversation } from "../chat/conversation";
import type { ChatMessage } from "../chat/types";
import { GridsMain } from "./Grids";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { deliver, layOut, startGrids, useGrids } from "./store";
import { useTerminals } from "./terminals";

const counts = { dm: 0 };
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("../session/Terminal", () => ({ Terminal: () => null }));
vi.mock("../rooms/Rooms", async (orig) => {
  const m = await orig<typeof import("../rooms/Rooms")>();
  return { ...m, DirectMessage: (p: { agent?: string }) => { counts.dm++; return <m.DirectMessage {...p} />; } };
});

const session = (id: string, name: string, more: Partial<Session> = {}): Session => ({
  id, engine: "claude", name, goal: "", cwd: "/tmp", branch: null, origin: "desk", state: "working", live: true, cliSessionId: null,
  lastPrompt: null, lastReply: null, currentTool: null, pending: null, approvals: "desk",
  createdAt: "2026-10-29T08:00:00Z", updatedAt: "2026-10-29T08:00:00Z", ...more,
});
const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};
const msg = (i: number): ChatMessage => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: `message ${i} with **bold** and \`code\` and a [link](https://x.y)`, at: new Date(Date.UTC(2026, 9, 29, 8, 0, i)).toISOString(), status: "complete", tools: [] });

beforeEach(() => {
  vi.stubGlobal("WebSocket", class { readyState = 0; send() {} close() {} addEventListener() {} });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  const sessions: Record<string, Session> = {};
  for (let i = 0; i < 6; i++) sessions[`s${i}`] = session(`s${i}`, `task-${i}`);
  useDesk.setState({ sessions, hub: { closeTerminal: vi.fn() } as never, openId: null });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
  useChat.setState({
    roster: [{ hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// A grid with an agent's conversation and sessions in it draws its
// panes' bodies again only for what they show: a long conversation drawn
// again for every session event and every word another agent streamed
// made typing in Desk lag.
it("leaves a pane's conversation alone when another session changes or another agent streams", () => {
  layOut(MAIN_GRID, "quarters");
  deliver(MAIN_GRID, { kind: "agent", agent: "local/allan" });
  deliver(MAIN_GRID, { kind: "session", sessionId: "s0" });
  deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
  const messages = Array.from({ length: 50 }, (_, i) => msg(i));
  act(() => useChat.setState((s) => ({ conversations: { ...s.conversations, "local/allan": { ...emptyConversation(), connected: true, messages } } })));
  render(<GridsMain />);
  expect(screen.getByRole("region", { name: "Allan" }).querySelector('[aria-label="Conversation with Allan"]')).toBeTruthy();
  counts.dm = 0;
  let n = 0;
  for (let i = 0; i < 5; i++) {
    act(() => useDesk.setState((s) => ({ sessions: { ...s.sessions, s5: { ...s.sessions.s5!, updatedAt: new Date(Date.UTC(2026, 9, 29, 9, 0, n++)).toISOString() } } })));
    act(() => useDesk.setState((s) => ({ sessions: { ...s.sessions, s0: { ...s.sessions.s0!, updatedAt: new Date(Date.UTC(2026, 9, 29, 9, 0, n++)).toISOString() } } })));
    act(() => useChat.setState((s) => ({ conversations: { ...s.conversations, "local/other": { ...emptyConversation(), messages: [{ ...msg(1), content: "x".repeat(n++) }] } } })));
  }
  expect(counts.dm).toBe(0);
});
