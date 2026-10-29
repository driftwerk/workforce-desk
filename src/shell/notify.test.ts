import { describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import type { Session } from "../hub/types";
import { notificationFor } from "./notify";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

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

describe("a session you've named in Desk", () => {
  it("is notified by that name", () => {
    useSettings.setState({ sessionNames: { "1": "race fix" } });
    expect(notificationFor("working", s("blocked"))?.title).toBe("race fix needs you");
    useSettings.setState({ sessionNames: {} });
  });
});
