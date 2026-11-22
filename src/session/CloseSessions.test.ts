import { describe, expect, it, vi } from "vitest";
import type { Session } from "../hub/types";
import { leftBehind, notEndable } from "./CloseSessions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const session = (more: Partial<Session> = {}): Session =>
  ({ id: "s1", engine: "claude", name: "api", cwd: "/w", origin: "desk", state: "idle", live: true, ...more }) as Session;

describe("closing picked sessions", () => {
  it("says what each would leave, in the order the single close weighs it", () => {
    expect(leftBehind({ folder: "/w", work: null, changes: null, pulls: [], tickets: [] })).toEqual([]);
    expect(leftBehind({ folder: "/w", work: "it's waiting on you", changes: "1 commit not pushed", pulls: [4, 9], tickets: ["MAN-1", "MAN-2"] })).toEqual([
      "it's waiting on you",
      "1 commit not pushed",
      "PR #4 still open",
      "PR #9 still open",
      "MAN-1, MAN-2 still open",
    ]);
  });

  it("refuses up front what End session isn't offered for, saying where it ends", () => {
    expect(notEndable(session())).toBeNull();
    expect(notEndable(session({ state: "stopped", live: false }))).toBeNull();
    expect(notEndable(session({ terminalId: "t1" }))).toBe("It runs in one of Desk's terminals: end it there.");
    expect(notEndable(session({ origin: "external" }))).toBe("It runs in another terminal: end it there.");
  });
});
