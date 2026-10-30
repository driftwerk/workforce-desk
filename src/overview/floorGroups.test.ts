import { describe, expect, it, vi } from "vitest";
import type { Overview, Session } from "../hub/types";
import { floorGroups } from "./CrewFloor";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({ RichMarkdown: () => null }));

const s = (id: string, state: Session["state"], more: Partial<Session> = {}): Session =>
  ({ id, name: id, state, live: true, origin: "desk", pending: null, updatedAt: "", ...more }) as Session;

const overview: Overview = {
  brief: null,
  counts: { working: 0, needsYou: 0, doneToday: 0 },
  items: [
    { kind: "agent", id: "scout", name: "Scout", state: "needs_you" },
    { kind: "agent", id: "ledger", name: "Ledger", state: "working" },
    { kind: "agent", id: "herald", name: "Herald", state: "done" },
  ],
};

const titles = (groups: ReturnType<typeof floorGroups>) =>
  Object.fromEntries(groups.map((g) => [g.title, [...g.agents.map((a) => a.id), ...g.sessions.map((x) => x.id)]]));

describe("the Floor's tiles", () => {
  const sessions = [s("blocked", "blocked"), s("asked", "done"), s("busy", "working"), s("bg", "done", { background: { count: 1, since: "" } })];

  it("group as they always have without a floor", () => {
    expect(titles(floorGroups(overview, sessions))).toEqual({
      "Needs you": ["scout", "blocked"],
      Working: ["ledger", "busy", "bg"],
      "Done today": ["herald"],
      "Recently done and idle": ["asked"],
    });
  });

  it("need you exactly when the needs index says so", () => {
    const needs = new Map([
      ["session:asked", 1],
      ["agent:local/ledger", 2],
    ]);
    expect(titles(floorGroups(overview, sessions, needs, "local"))).toEqual({
      "Needs you": ["ledger", "asked"],
      Working: ["blocked", "busy", "bg"],
      "Done today": ["herald"],
      "Recently done and idle": ["scout"],
    });
  });
});
