import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Lane, Session } from "../hub/types";
import { useFloor } from "./store";
import { NOW, agent, at, hub, need, ready, session, view } from "./testing";
import { clock } from "./time";
import { Today } from "./Today";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));

const DAY = new Date(NOW);
DAY.setHours(0, 0, 0, 0);

const show = (lanes: Lane[], needs = view().needs) => {
  useChat.setState({ hubs: [hub("local")] });
  useFloor.setState({ day: DAY.getTime(), hubs: { local: ready(view({ lanes, needs })) } });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  useDesk.setState({ sessions: {}, restore: [] });
  useChat.setState({ roster: [] });
  vi.useRealTimers();
});

describe("Today", () => {
  it("draws a lane each, with what each stretch was and when, waiting on you first", () => {
    show(
      [
        { who: agent("ledger", "Ledger"), spans: [{ kind: "working", from: at(120), to: at(60) }] },
        {
          who: session("s-1", "acme-web"),
          spans: [
            { kind: "working", from: at(40), to: at(12) },
            { kind: "waiting", from: at(12), to: null },
          ],
        },
        { who: session("s-2", "repo"), spans: [{ kind: "background", from: at(6), to: null }] },
      ],
      [need("q", session("s-1", "acme-web"))],
    );
    render(<Today now={NOW} />);
    const lanes = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(lanes).toEqual(["acme-web", "repo", "Ledger"]);
    expect(screen.getByRole("img", { name: `working ${clock(at(120))}–${clock(at(60))}` })).toBeTruthy();
    expect(screen.getByRole("img", { name: `waited on you ${clock(at(12))}–now` }).getAttribute("title")).toBe(`waited on you ${clock(at(12))}–now`);
    expect(screen.getByRole("img", { name: `background work ${clock(at(6))}–now` }).className).toContain("span-background");
    expect(screen.getByText(`now ${clock(NOW)}`)).toBeTruthy();
    const waiting = screen.getByRole("img", { name: `waited on you ${clock(at(12))}–now` }) as HTMLElement;
    expect(parseFloat(waiting.style.left) + parseFloat(waiting.style.width)).toBeCloseTo(100);
  });

  it("shows eight lanes until asked for the rest", () => {
    show(Array.from({ length: 20 }, (_, i) => ({ who: agent(`a${i}`), spans: [{ kind: "working" as const, from: at(100 - i), to: at(50 - i) }] })));
    render(<Today now={NOW} />);
    expect(screen.getAllByRole("group")).toHaveLength(8);
    const more = screen.getByRole("button", { name: "Show 12 more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(screen.getAllByRole("group")).toHaveLength(20);
    expect(screen.getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
    act(() => useFloor.setState({ day: DAY.getTime() + 86_400_000 }));
    expect(screen.queryAllByRole("group").length).toBeLessThanOrEqual(8);
  });

  describe("an agent's turn that Desk took in as a session of its own", () => {
    // What `claude agents --json` calls the Claude Code session an agent's
    // turn ran on its subscription: the folder's name and two characters.
    const turn = session("6f1c2a9e-3b7d-4c55-9a0e-1d2b3c4d5e6f", "at-dm-d4774cbb6c89-2e");
    const folder = "/Users/me/Library/Application Support/Desk/hub/data/agents/scout/projects/_agent-turn/work/session/at-dm-d4774cbb6c89";
    const ranIn = (cwd: string) =>
      useDesk.setState({ sessions: { [turn.id]: { id: turn.id, engine: "claude", name: turn.name, cwd, origin: "external" } as Session } });

    it("is in its agent's lane, by the agent's name", () => {
      ranIn(folder);
      show([
        { who: agent("scout", "Scout"), spans: [{ kind: "working", from: at(30), to: at(10) }] },
        { who: turn, spans: [{ kind: "working", from: at(29), to: at(11) }] },
      ]);
      render(<Today now={NOW} />);
      expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Scout"]);
      expect(screen.getAllByRole("img").map((s) => s.getAttribute("aria-label"))).toEqual([`working ${clock(at(30))}–${clock(at(10))}`]);
    });

    it("is its agent's lane, by the name its hub lists it by, when the agent has none of its own today", () => {
      ranIn(folder);
      useChat.setState({ roster: [{ hubId: "local", id: "scout", name: "Scout", model: null, provider: "claude-code", isDefault: false }] });
      show([{ who: turn, spans: [{ kind: "working", from: at(29), to: null }] }]);
      render(<Today now={NOW} />);
      expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Scout"]);
    });

    it("has no lane when Desk can't tell whose it is: its folder says no agent, or Desk knows no folder for it", () => {
      ranIn("/somewhere/else/at-dm-d4774cbb6c89");
      show([
        { who: turn, spans: [{ kind: "working", from: at(29), to: null }] },
        { who: session("s-gone", "at-dm-0a1b2c3d4e5f-2e"), spans: [{ kind: "working", from: at(25), to: at(5) }] },
        { who: session("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", ""), spans: [{ kind: "working", from: at(20), to: null }] },
      ]);
      render(<Today now={NOW} />);
      const names = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
      expect(names).toEqual(["Claude Code session"]);
      expect(document.body.textContent).not.toMatch(/Agent turn|at-dm-|7a0b1c2d/);
    });
  });

  it("says when nothing has run yet", () => {
    show([]);
    render(<Today now={NOW} />);
    expect(screen.getByText("Nothing has run yet today.")).toBeTruthy();
  });
});
