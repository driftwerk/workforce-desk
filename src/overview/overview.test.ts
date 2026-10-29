import { describe, expect, it } from "vitest";
import type { OverviewItem, Session } from "../hub/types";
import { since } from "../floor/time";
import { group } from "./overview";

const item = (id: string, state: OverviewItem["state"], kind: OverviewItem["kind"] = "agent"): OverviewItem => ({
  kind,
  id,
  name: id,
  state,
});

const session = (id: string, state: Session["state"], over: Partial<Session> = {}): Session => ({
  id,
  engine: "claude",
  name: id,
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state,
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "2026-10-28T09:00:00Z",
  updatedAt: "2026-10-28T09:00:00Z",
  ...over,
});

const ids = (items: OverviewItem[]) => items.map((i) => i.id);

describe("grouping the overview for the Floor", () => {
  it("puts items in Needs you, Working (quiet ones too) and Done today, and leaves the rest off", () => {
    const g = group(
      [
        item("scout", "needs_you"),
        item("ledger", "working"),
        item("e7", "quiet", "session"),
        item("atlas", "idle"),
        item("read-shadow", "done", "session"),
        item("broken", "failed", "session"),
        item("old", "stopped", "session"),
        item("triage", "done"),
      ],
      {},
    );
    expect(ids(g.needsYou)).toEqual(["scout"]);
    expect(ids(g.working)).toEqual(["ledger", "e7"]);
    expect(ids(g.done)).toEqual(["read-shadow", "triage"]);
  });

  it("lets a session's live state move it before the overview is read again", () => {
    const g = group([item("web", "working", "session"), item("e7", "quiet", "session"), item("pr", "needs_you", "session")], {
      web: session("web", "blocked"),
      e7: session("e7", "working"),
      pr: session("pr", "done"),
    });
    expect(ids(g.needsYou)).toEqual(["web"]);
    expect(g.needsYou[0]!.state).toBe("needs_you");
    expect(ids(g.working)).toEqual(["e7"]);
    expect(g.working[0]!.state).toBe("quiet");
    expect(ids(g.done)).toEqual(["pr"]);
  });

  it("keeps the hub's word for done today when the session is simply idle now", () => {
    const g = group([item("pr", "done", "session")], { pr: session("pr", "idle") });
    expect(ids(g.done)).toEqual(["pr"]);
  });

  it("adds busy sessions the overview doesn't list yet, from what the socket said", () => {
    const g = group([], {
      fresh: session("fresh", "working", { goal: "Ship it", currentTool: "Bash" }),
      asking: session("asking", "blocked", {
        pending: { id: "a1", tool: "Bash", detail: "npm install", since: "2026-10-28T10:00:00Z", answerable: true },
      }),
      idle: session("idle", "idle"),
    });
    expect(ids(g.working)).toEqual(["fresh"]);
    expect(g.working[0]).toMatchObject({ task: "Ship it", detail: "● Bash" });
    expect(g.needsYou[0]).toMatchObject({ id: "asking", approval: { id: "a1", summary: "Bash npm install" } });
    expect(g.done).toEqual([]);
  });
});

describe("how long ago", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  it("says it briefly", () => {
    expect(since("2026-10-28T11:59:40Z", now)).toBe("just now");
    expect(since("2026-10-28T11:54:00Z", now)).toBe("6 min");
    expect(since("2026-10-28T10:48:00Z", now)).toBe("1h 12m");
    expect(since("2026-10-28T10:00:00Z", now)).toBe("2h");
    expect(since("2026-10-26T10:00:00Z", now)).toBe("2 days");
    expect(since(null, now)).toBe("");
  });
});
