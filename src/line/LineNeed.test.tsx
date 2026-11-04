import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { NeedRow } from "../floor/NeedRow";
import { useFloor } from "../floor/store";
import { hub as account, need, session as who } from "../floor/testing";
import { WentAheadRow } from "../floor/WentAheadRow";
import { useDesk } from "../hub/store";
import { openTarget } from "../shell/navigate";
import { useLinePanel } from "./panel";
import { useLine } from "./store";
import { lined, msg, YOU } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("../shell/navigate", () => ({ openTarget: vi.fn() }));

const hub = { dismissLine: vi.fn((id: string) => Promise.resolve(msg({ id, to: YOU, asked: "dismissed" }))) };

beforeEach(() => {
  vi.clearAllMocks();
  useChat.setState({ hubs: [account("local")] });
  useFloor.setState({ deciding: {}, problems: {} });
  useDesk.setState({ hub: hub as never, sessions: { s1: lined() } });
  useLine.setState({ threads: {}, problems: {}, asked: {} });
  useLinePanel.setState({ shown: {}, heights: {} });
});
afterEach(cleanup);

const tagged = { hubId: "local", local: true, stale: false };

describe("a session's question on the Floor", () => {
  it("offers Go to session and Dismiss, not an answer", async () => {
    const n = { ...need("line:q1", who("s1", "acme-web"), { ask: "May I push to main?" }), ...tagged, key: "local/line:q1" };
    render(<NeedRow need={n} now={Date.now()} actions />);
    expect(screen.getByText(/it’s paused until you answer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reply/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open acme-web" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to acme-web" }));
    // Beside the Floor, never in a grid, with its questions shown.
    expect(openTarget).toHaveBeenCalledWith({ kind: "session", sessionId: "s1" }, { beside: true });
    expect(useLinePanel.getState().shown.s1).toBe("questions");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss “May I push to main?” from acme-web" }));
    await act(async () => {});
    expect(hub.dismissLine).toHaveBeenCalledWith("q1");
    expect(useLine.getState().asked.q1).toBe("dismissed");
  });

  it("one it went ahead without says when, what it chose, and offers the same", async () => {
    const item = {
      id: "line:q2",
      who: who("s1", "acme-web"),
      ask: "Retire the legacy routes?",
      chose: "keep both routes for now.",
      askedAt: "2026-11-03T04:32:00Z",
      wentAheadAt: "2026-11-03T04:42:00Z",
      ...tagged,
      key: "local/line:q2",
    };
    render(<WentAheadRow item={item} now={Date.parse("2026-11-03T09:00:00Z")} />);
    expect(screen.getByText(/^asked .* · no answer by /)).toBeTruthy();
    expect(screen.getByText(/It chose: keep both routes for now\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to acme-web" }));
    expect(openTarget).toHaveBeenCalledWith({ kind: "session", sessionId: "s1" }, { beside: true });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss “Retire the legacy routes?” from acme-web" }));
    await act(async () => {});
    expect(hub.dismissLine).toHaveBeenCalledWith("q2");
  });
});
