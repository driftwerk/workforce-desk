import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { Approval } from "./Approval";

const session = (over: Partial<Session> = {}): Session => ({
  id: "s-1",
  engine: "devin",
  name: "acme-web",
  goal: "",
  cwd: "/Users/you/acme-web",
  branch: null,
  origin: "desk",
  state: "blocked",
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: { id: "ap-1", tool: "Edit", detail: "/Users/you/acme-web/src/a.ts", since: new Date().toISOString(), answerable: true },
  approvals: "desk",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const decide = vi.fn(() => Promise.resolve({}));

beforeEach(() => {
  decide.mockClear();
  useDesk.setState({ hub: { decide } as unknown as DeskHub, sessions: {}, openId: null });
});
afterEach(cleanup);

const buttons = () => screen.getAllByRole("button").map((b) => b.textContent);

describe("a Devin session's request", () => {
  it("offers Devin's own answers, in its order", () => {
    render(<Approval session={session()} />);
    expect(buttons()).toEqual(["Allow", "Accept edits mode", "Bypass mode", "Deny"]);
  });

  it("allows once and denies through its hook", async () => {
    render(<Approval session={session()} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow" })));
    expect(decide).toHaveBeenLastCalledWith("s-1", "ap-1", "allow");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deny" })));
    expect(decide).toHaveBeenLastCalledWith("s-1", "ap-1", "deny");
  });

  it("leaves a mode to Devin's own prompt, and opens it there", async () => {
    const s = session();
    render(<Approval session={s} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Bypass mode" })));
    expect(decide).toHaveBeenLastCalledWith("s-1", "ap-1", "terminal");
    expect(useDesk.getState().openId).not.toBeNull();
    expect(decide).not.toHaveBeenCalledWith("s-1", "ap-1", "allow");
  });

  it("offers only Allow and Deny when compact", () => {
    render(<Approval session={session()} compact />);
    expect(buttons()).toEqual(["Allow", "Deny"]);
  });

  it("keeps Claude Code's answers for Claude Code", () => {
    render(<Approval session={session({ engine: "claude" })} />);
    expect(buttons()).toEqual(["Deny", "Ask in terminal", "Allow once"]);
  });
});
