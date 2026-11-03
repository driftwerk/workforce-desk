import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { NeedRow } from "../floor/NeedRow";
import { useFloor } from "../floor/store";
import { hub as account, need, session as who } from "../floor/testing";
import { useDesk } from "../hub/store";
import { openTarget } from "../shell/navigate";
import { useFocus } from "../shell/focus";
import { lined } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("../shell/navigate", () => ({ openTarget: vi.fn() }));

afterEach(cleanup);

describe("a session's question on the Floor", () => {
  it("opens the session with its answer field in focus on Reply…", () => {
    useChat.setState({ hubs: [account("local")] });
    useFloor.setState({ deciding: {}, problems: {} });
    useDesk.setState({ sessions: { s1: lined() } });
    const n = { ...need("line:q1", who("s1", "acme-web"), { ask: "May I push to main?" }), hubId: "local", local: true, key: "local/line:q1", stale: false };
    render(<NeedRow need={n} now={Date.now()} actions />);
    expect(screen.getByText("May I push to main?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reply to acme-web…" }));
    expect(openTarget).toHaveBeenCalledWith({ kind: "session", sessionId: "s1" }, { beside: true, reply: true });
    expect(useFocus.getState().where).toBe("line:s1");
  });
});
