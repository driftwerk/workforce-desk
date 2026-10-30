import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../hub/types";
import { needStates } from "./activity";

describe("what became of each request", () => {
  const who = { kind: "session" as const, id: "s-1", name: "acme-web" };
  const you = { kind: "you" as const, id: "you", name: "You" };
  const e = (id: string, at: string, kind: ActivityEvent["kind"], over: Partial<ActivityEvent> = {}): ActivityEvent => ({
    id,
    at,
    kind,
    actor: who,
    subject: who,
    text: kind,
    ...over,
  });
  const needs = [
    { id: "wait:t1:ap-3", kind: "approval" as const, who: { kind: "session" as const, id: "s-1", name: "acme-web", engine: null } },
    { id: "question:t2", kind: "question" as const, who: { kind: "session" as const, id: "s-1", name: "acme-web", engine: null } },
  ];

  it("keeps what's open open, and says when and how the rest were answered", () => {
    const events = [
      e("q2", "2026-10-29T10:09:00Z", "question"),
      e("a3", "2026-10-29T10:08:00Z", "needs_you", { approvalId: "ap-3" }),
      e("d2", "2026-10-29T10:07:00Z", "denied", { approvalId: "ap-2", actor: { kind: "manager", id: "desk", name: "Desk" } }),
      e("t1", "2026-10-29T10:06:00Z", "answered", { approvalId: "ap-1" }),
      e("a2", "2026-10-29T10:05:00Z", "needs_you", { approvalId: "ap-2" }),
      e("a1", "2026-10-29T10:04:00Z", "needs_you", { approvalId: "ap-1" }),
      e("a0", "2026-10-29T10:03:00Z", "needs_you", { approvalId: "ap-0" }),
      e("q1", "2026-10-29T10:02:00Z", "question"),
      e("ok", "2026-10-29T10:01:00Z", "approved", { approvalId: "ap-9", actor: you }),
    ];
    const states = needStates(events, needs);
    expect(Object.fromEntries(states)).toEqual({
      q2: { open: true },
      a3: { open: true },
      a2: { open: false, at: "2026-10-29T10:07:00Z", how: "denied by Desk" },
      a1: { open: false, at: "2026-10-29T10:06:00Z", how: "answered in its terminal" },
      a0: { open: false, at: null, how: "no longer waiting" },
      q1: { open: false, at: null, how: "no longer waiting" },
    });
    expect(needStates(events, []).get("a3")).toEqual({ open: false, at: null, how: "no longer waiting" });
  });
});
