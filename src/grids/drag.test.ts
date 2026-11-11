import { describe, expect, it, vi } from "vitest";
import { contentOfItem } from "./drag";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

describe("a sidebar row dragged onto a pane", () => {
  it("is what the pane will hold: a session, an agent, a room, a board, or a Floor", () => {
    expect(contentOfItem("session:s1")).toEqual({ kind: "session", sessionId: "s1" });
    expect(contentOfItem("session:devbox/m1")).toEqual({ kind: "session", sessionId: "m1", machine: "devbox" });
    expect(contentOfItem("agent:local/atlas")).toEqual({ kind: "agent", agent: "local/atlas" });
    expect(contentOfItem("room:r1")).toEqual({ kind: "room", room: "r1" });
    expect(contentOfItem("board:b1")).toEqual({ kind: "board", board: "b1" });
    expect(contentOfItem("floor:")).toEqual({ kind: "floor" });
    expect(contentOfItem("floor:g-platform")).toEqual({ kind: "floor", group: "g-platform" });
    expect(contentOfItem("room:")).toBeNull();
    expect(contentOfItem("group:g1")).toBeNull();
  });
});
