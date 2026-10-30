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

const gist = (now: string, purpose: string | null, min: number) => ({ purpose, now, at: at(min) });

describe("Right now", () => {
  it("lists what needs you, then one entry per agent or session, working, waiting, then done", () => {
    render(<RightNow brief={null} />);
    const needs = screen.getByRole("group", { name: "Needs you · 2" });
    const [first, second] = within(needs).getAllByRole("button");
    expect(first!.textContent).toContain("Scout");
    expect(first!.textContent).toContain(`waiting 30m · since ${dayClock(at(30), NOW)}`);
    expect(first!.textContent).toContain("Main or release? · in Launch");
    expect(second!.textContent).toContain("Run npm test?");
    const list = screen.getByRole("group", { name: "What’s happening" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.querySelector("b")!.textContent)).toEqual(["Ledger", "repo", "Ops", "Herald"]);
    expect(within(list).getByText(`waiting on 2 background tasks · updated ${clock(at(1))}`)).toBeTruthy();
    expect(rows[1]!.querySelector(".dot-background")).toBeTruthy();
    expect(rows[2]!.querySelector(".dot-failed")).toBeTruthy();
    expect(within(list).getByText(`working · updated ${clock(at(0))}`)).toBeTruthy();
  });

  it("says each entry's purpose and what it is doing, in the hub's words, when it was written", () => {
    useFloor.setState({
      hubs: {
        local: ready(
          view({
            working: [
              work(session("s-2", "repo"), {
                since: at(20),
                gist: gist("Right now it is moving the Windows support onto the released code.", "Getting Desk ready for its first release.", 3),
              }),
              work(session("s-2", "repo"), { since: at(40), gist: gist("An older turn.", null, 30) }),
            ],
            done: [
              work(session("s-2", "repo"), { what: "Merged #5.", endedAt: at(50), outcome: "finished" }),
              work(agent("herald", "Herald"), { what: "Done.", endedAt: at(150), outcome: "finished" }),
            ],
          }),
        ),
      },
    });
    render(<RightNow brief={null} />);
    const rows = within(screen.getByRole("group", { name: "What’s happening" })).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain(
      "Getting Desk ready for its first release. Right now it is moving the Windows support onto the released code.",
    );
    expect(rows[0]!.textContent).toContain(`working · updated ${clock(at(3))}`);
    expect(screen.queryByText(/Herald/)).toBeNull();
  });

  it("says plainly what a hub without gists sent, its identifiers dropped", () => {
    useFloor.setState({
      hubs: {
        local: ready(
          view({
            working: [work(agent("scout", "Scout"), { what: "Look at #12 and land it", heardAt: at(4) })],
            done: [
              work(agent("lens", "Lens"), { what: "#123", endedAt: at(9), outcome: "finished" }),
              work(agent("ops", "Ops"), { what: "Merged PR #5 into main.", endedAt: at(8), outcome: "finished" }),
            ],
          }),
        ),
      },
    });
    render(<RightNow brief={null} />);
    const list = screen.getByRole("group", { name: "What’s happening" });
    expect(within(list).getByText("Now working on: Look at and land it.")).toBeTruthy();
    expect(within(list).getByText(`working · updated ${clock(at(4))}`)).toBeTruthy();
    expect(within(list).getByText("Finished: Merged into main.")).toBeTruthy();
    expect(within(list).getByText("Finished what it was asked.")).toBeTruthy();
  });

  it("keeps a long list in one place of its own, which scrolls", () => {
    useFloor.setState({
      hubs: {
        local: ready(
          view({
            done: Array.from({ length: 30 }, (_, i) =>
              work(agent(`a${i}`, `Agent ${i}`), { what: `Finished ${i}.`, endedAt: at(i), outcome: "finished" }),
            ),
          }),
        ),
      },
    });
    const { container } = render(<RightNow brief={null} />);
    const group = screen.getByRole("group", { name: "What’s happening" });
    const list = group.querySelector(".right-now-list")!;
    expect(within(list as HTMLElement).getAllByRole("button")).toHaveLength(30);
    expect(within(group).getByRole("heading").closest(".right-now-list")).toBeNull();
    expect(container.querySelectorAll(".right-now-list")).toHaveLength(1);
  });

  it("says so with nothing in either list", () => {
    useFloor.setState({ hubs: { local: ready(view()) } });
    render(<RightNow brief={null} />);
    expect(within(screen.getByRole("group", { name: "Needs you · 0" })).getByText("Nothing is waiting on you.")).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "What’s happening" })).getByText(
        "Nothing is running, and nothing has finished in the last two hours.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Nothing is running right now. Nothing needs you.")).toBeTruthy();
  });

  it("marks what an unreachable hub said last, and says since when", () => {
    render(<RightNow brief={null} />);
    const scout = within(screen.getByRole("group", { name: "Needs you · 2" })).getAllByRole("button")[0]!;
    expect(scout.className).toContain("floor-stale");
    expect(scout.title).toBe(`Hub b unreachable since ${clock(at(20))}`);
  });

  it("is summed up by the overseer's brief, else the hubs' paragraph, else Desk's", () => {
    render(<RightNow brief={<p>Overseer’s word.</p>} />);
    expect(screen.getByText("Overseer’s word.")).toBeTruthy();
    expect(screen.queryByText(/^updated /)).toBeNull();
    cleanup();
    render(<RightNow brief={null} />);
    expect(screen.getByText("Ledger and repo are under way. Ops and Herald finished lately. Two things need you.")).toBeTruthy();
    cleanup();
    useFloor.setState((s) => ({
      hubs: { ...s.hubs, b: { ...s.hubs.b!, floor: { ...s.hubs.b!.floor!, summary: { text: "The release shipped.", at: at(7) } } } },
    }));
    render(<RightNow brief={null} />);
    expect(screen.getByText("The release shipped. Two things need you.")).toBeTruthy();
    expect(screen.getByText(`updated ${clock(at(7))}`)).toBeTruthy();
  });

  it("opens each row where it is", () => {
    render(<RightNow brief={null} />);
    const click = (group: string, i: number) => fireEvent.click(within(screen.getByRole("group", { name: group })).getAllByRole("button")[i]!);
    click("Needs you · 2", 0);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "room", roomId: "r1", threadId: "m-1" });
    click("Needs you · 2", 1);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "session", sessionId: "s-1" });
    click("What’s happening", 0);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "agent", key: "b/ledger" });
    click("What’s happening", 1);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "session", sessionId: "s-2" });
    click("What’s happening", 2);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "slack", url: "https://slack.com/app_redirect?channel=C1" });
  });
});
