import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useFloor } from "../floor/store";
import { agent, approval, at, fakeFetch, fakeHub, hub, need, ready, session, view, type FakeHub } from "../floor/testing";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { ActivityEvent } from "../hub/types";
import { openTarget } from "../shell/navigate";
import { ActivityRail } from "./ActivityRail";
import { useOverview } from "./store";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../shell/navigate", () => ({ openTarget: vi.fn() }));

const WEB = { kind: "session" as const, id: "s-1", name: "acme-web" };
const ev = (id: string, min: number, kind: ActivityEvent["kind"], over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  at: at(min),
  kind,
  actor: WEB,
  subject: WEB,
  text: kind,
  ...over,
});

const events: ActivityEvent[] = [
  ev("e5", 1, "needs_you", { approvalId: "ap-2", text: "wants to run npm test" }),
  ev("e4", 5, "approved", { approvalId: "ap-1", actor: { kind: "you", id: "you", name: "You" }, text: "allowed npm install" }),
  ev("e3", 8, "needs_you", { approvalId: "ap-1", text: "wants to run npm install" }),
  ev("e2", 20, "question", { text: "asked “Which one?”" }),
  ev("e1", 30, "finished", { text: "finished" }),
];

let hubs: Record<string, FakeHub>;

const floors = () => {
  hubs = {
    local: fakeHub({ floor: view({ needs: [approval("wait:t1:ap-2", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm test?" })] }) }),
    b: fakeHub({ floor: view({ needs: [need("question:t9", agent("scout", "Scout"), { ask: "Main or release?" })] }) }),
  };
  vi.stubGlobal("fetch", fakeFetch(hubs));
  useFloor.setState({
    deciding: {},
    problems: {},
    answered: {},
    hubs: { local: ready(structuredClone(hubs.local!.floor!)), b: ready(structuredClone(hubs.b!.floor!)) },
  });
};

beforeEach(() => {
  vi.mocked(openTarget).mockClear();
  useChat.setState({ hubs: [hub("local"), hub("b")] });
  useOverview.setState({ feeds: {}, activitySupport: "unknown" });
  useDesk.setState({ hub: { activity: vi.fn(() => Promise.resolve({ events, more: false })) } as unknown as DeskHub, rooms: {} });
  floors();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "Activity" });

describe("Activity with the floor", () => {
  it("shows only what's still waiting on you, on every hub, counted on its tab", async () => {
    render(<ActivityRail managerName={null} />);
    const tab = within(rail()).getByRole("radio", { name: /Needs you/ });
    expect(within(tab).getByText("2")).toBeTruthy();
    fireEvent.click(tab);
    const open = within(rail()).getByRole("list", { name: "Still waiting on you" });
    expect(
      within(open)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual([expect.stringContaining("Run npm test?"), expect.stringContaining("Main or release?")]);
    expect(within(rail()).getByText("Only what’s still waiting on you. Answered or expired items leave this list.")).toBeTruthy();
  });

  it("allows in place, and drops what was answered on the next read", async () => {
    hubs.local!.decide = () => {
      hubs.local!.floor = view();
      return 204;
    };
    render(<ActivityRail managerName={null} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: "Allow" })));
    expect(hubs.local!.decided).toEqual([{ at: { kind: "session", sessionId: "s-1", approvalId: "wait:t1:ap-2" }, choice: "allow" }]);
    await act(() => useFloor.getState().load("local"));
    expect(within(rail()).queryByText("Run npm test?")).toBeNull();
    expect(within(within(rail()).getByRole("radio", { name: /Needs you/ })).getByText("1")).toBeTruthy();
  });

  it("says when another device answered first", async () => {
    hubs.local!.decide = () => 409;
    render(<ActivityRail managerName={null} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: "Allow" })));
    expect(within(rail()).getByText("Already answered")).toBeTruthy();
    expect(within(rail()).queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("replies where the question was asked, its composer focused", () => {
    render(<ActivityRail managerName={null} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    fireEvent.click(within(rail()).getByRole("button", { name: "Reply" }));
    expect(openTarget).toHaveBeenCalledWith({ kind: "agent", key: "b/scout" }, { reply: true });
  });

  it("puts what's open above everything that happened, each past request marked with what became of it", async () => {
    useFloor.setState((s) => ({
      hubs: {
        ...s.hubs,
        local: ready(
          view({
            needs: [
              { ...approval("wait:t1:ap-2", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm test?" }) },
              need("question:t2", session("s-1", "acme-web"), { ask: "Which one?" }),
            ],
          }),
        ),
      },
    }));
    render(<ActivityRail managerName={null} />);
    const list = await within(rail()).findByRole("list", { name: "Activity: All" });
    const open = within(rail()).getByRole("list", { name: "Still waiting on you" });
    expect(open.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = (text: string) => within(list).getByText(text).closest("li")!;
    expect(row("wants to run npm test").textContent).toContain("Still waiting on you");
    expect(row("wants to run npm install").textContent).toMatch(/Resolved · allowed by you \d\d:\d\d/);
    expect(row("asked “Which one?”").textContent).toContain("Still waiting on you");
    expect(row("finished").textContent).not.toContain("Resolved");
  });
});
