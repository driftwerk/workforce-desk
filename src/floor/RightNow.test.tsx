import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";
import { openTarget } from "../shell/navigate";
import { RightNow } from "./RightNow";
import { useFloor } from "./store";
import { NOW, agent, approval, at, hub, need, ready, session, view, work } from "./testing";
import { clock, dayClock } from "./time";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../shell/navigate", () => ({ openTarget: vi.fn() }));

const room: Room = { id: "r1", slug: "launch", name: "Launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(openTarget).mockClear();
  useDesk.setState({ rooms: { r1: room } });
  useChat.setState({ hubs: [hub("local"), hub("b")] });
  useFloor.setState({
    day: Date.parse("2026-10-29T00:00:00Z"),
    deciding: {},
    problems: {},
    answered: {},
    hubs: {
      local: ready(
        view({
          needs: [approval("ap-1", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm test?", since: at(12) })],
          working: [work(session("s-2", "repo"), { since: at(38), heardAt: at(1), background: { count: 2, since: at(6) } })],
          done: [work(agent("herald", "Herald"), { what: "Labelled 3 issues.", since: at(98), endedAt: at(50), outcome: "finished" })],
        }),
      ),
      b: ready(
        view({
          needs: [
            need("q-1", agent("scout", "Scout"), { ask: "Main or release?", since: at(30), place: { kind: "room", room: "r1", thread: "m-1" } }),
          ],
          working: [work(agent("ledger", "Ledger"), { what: "● aws.cost_explorer", since: at(10), heardAt: at(0) })],
          done: [
            work(agent("ops", "Ops"), {
              what: "Deploy failed.",
              place: { kind: "slack", team: null, channel: "C1", thread: null },
              endedAt: at(20),
              outcome: "failed",
            }),
          ],
        }),
        { stale: true, at: at(20) },
      ),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Right now", () => {
  it("lists what needs you, what's running and what's done, each with its times", () => {
    render(<RightNow brief={null} />);
    const needs = screen.getByRole("group", { name: "Needs you · 2" });
    const [first, second] = within(needs).getAllByRole("button");
    expect(first!.textContent).toContain("Scout");
    expect(first!.textContent).toContain(`waiting 30m · since ${dayClock(at(30), NOW)}`);
    expect(first!.textContent).toContain("Main or release? · in Launch");
    expect(second!.textContent).toContain("Run npm test?");
    const working = screen.getByRole("group", { name: "Working · 2" });
    expect(within(working).getByText("Waiting on 2 background tasks · 6m")).toBeTruthy();
    expect(within(working).getByText("38m · 1 min ago")).toBeTruthy();
    expect(working.querySelector(".dot-background")).toBeTruthy();
    expect(within(working).getByText("10m · just now")).toBeTruthy();
    const done = screen.getByRole("group", { name: "Done · last 24 hours" });
    expect(within(done).getByText(`${clock(at(50))} · 48m`)).toBeTruthy();
    expect(done.querySelector(".dot-failed")).toBeTruthy();
  });

  it("marks what an unreachable hub said last, and says since when", () => {
    render(<RightNow brief={null} />);
    const scout = within(screen.getByRole("group", { name: "Needs you · 2" })).getAllByRole("button")[0]!;
    expect(scout.className).toContain("floor-stale");
    expect(scout.title).toBe(`Hub b unreachable since ${clock(at(20))}`);
  });

  it("is summed up by the overseer's brief when there is one, else by Desk", () => {
    render(<RightNow brief={<p>Overseer’s word.</p>} />);
    expect(screen.getByText("Overseer’s word.")).toBeTruthy();
    expect(screen.queryByText(/summary by Desk/)).toBeNull();
    cleanup();
    render(<RightNow brief={null} />);
    expect(screen.getByText(/^Two things are waiting on you: Scout asks “Main or release”; acme-web wants to run npm test\./)).toBeTruthy();
    expect(screen.getByText(/summary by Desk ·/)).toBeTruthy();
  });

  it("opens each row where it is", () => {
    render(<RightNow brief={null} />);
    const click = (group: string, i: number) => fireEvent.click(within(screen.getByRole("group", { name: group })).getAllByRole("button")[i]!);
    click("Needs you · 2", 0);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "room", roomId: "r1", threadId: "m-1" });
    click("Needs you · 2", 1);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "session", sessionId: "s-1" });
    click("Working · 2", 0);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "agent", key: "b/ledger" });
    click("Done · last 24 hours", 0);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "slack", url: "https://slack.com/app_redirect?channel=C1" });
  });
});
