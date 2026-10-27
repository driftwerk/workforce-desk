import { describe, expect, it } from "vitest";
import type { Session } from "../hub/types";
import { notificationFor } from "./notify";

const s = (state: Session["state"], extra: Partial<Session> = {}): Session => ({
  id: "1",
  engine: "claude",
  name: "auth-fix",
  goal: "fix the race",
  cwd: "/r",
  branch: null,
  origin: "desk",
  state,
  live: true,
  cliSessionId: "c",
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "",
  updatedAt: "",
  ...extra,
});

describe("notificationFor", () => {
  it("tells you when a session needs you or finishes", () => {
    expect(notificationFor("working", s("blocked"))?.title).toBe("auth-fix needs you");
    expect(notificationFor("working", s("done", { lastReply: "Tests pass.\nmore" }))).toEqual({
      title: "auth-fix is done",
      body: "Tests pass.",
    });
  });

  it("stays quiet otherwise", () => {
    expect(notificationFor(undefined, s("blocked"))).toBeNull();
    expect(notificationFor("blocked", s("blocked"))).toBeNull();
    expect(notificationFor("idle", s("done"))).toBeNull();
    expect(notificationFor("blocked", s("working"))).toBeNull();
  });
});
