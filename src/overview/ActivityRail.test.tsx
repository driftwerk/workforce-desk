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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "Activity" });

describe("Activity with the floor", () => {
  it("shows only what's still waiting on you, on every hub, counted on its tab", async () => {
    render(<ActivityRail managerName={null} onClose={() => {}} />);
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

  it("allows in place, and drops what was answered on the read that follows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hubs.local!.decide = () => {
      hubs.local!.floor = view();
      return 204;
    };
    render(<ActivityRail managerName={null} onClose={() => {}} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: "Allow “Run npm test?” for acme-web" })));
    expect(hubs.local!.decided).toEqual([{ at: { kind: "session", sessionId: "s-1", approvalId: "wait:t1:ap-2" }, choice: "allow" }]);
    await act(() => vi.waitFor(() => expect(hubs.local!.days).toHaveLength(1)));
    await act(() => useFloor.getState().load("local"));
    expect(within(rail()).queryByText("Run npm test?")).toBeNull();
    expect(within(within(rail()).getByRole("radio", { name: /Needs you/ })).getByText("1")).toBeTruthy();
  });

  it("says when another device answered first", async () => {
    hubs.local!.decide = () => 409;
    render(<ActivityRail managerName={null} onClose={() => {}} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: "Allow “Run npm test?” for acme-web" })));
    expect(within(rail()).getByText("Already answered")).toBeTruthy();
    expect(within(rail()).queryByRole("button", { name: /^Allow/ })).toBeNull();
  });

  it("keeps the log's own Needs you while this computer's hub has no floor, whatever other hubs have", async () => {
    useFloor.setState((s) => ({ hubs: { ...s.hubs, local: { ...s.hubs.local!, state: "unsupported", floor: null } } }));
    render(<ActivityRail managerName={null} onClose={() => {}} />);
    const tab = within(rail()).getByRole("radio", { name: /Needs you/ });
    expect(within(tab).queryByText("1")).toBeNull();
    fireEvent.click(tab);
    expect(await within(rail()).findByRole("list", { name: "Activity: Needs you" })).toBeTruthy();
    expect(within(rail()).queryByRole("list", { name: "Still waiting on you" })).toBeNull();
  });

  it("keeps focus on Allow while it's answering, and answers once however often it's pressed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answer = (_: Response) => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) =>
        init?.method === "POST" ? new Promise<Response>((r) => (answer = r)) : fakeFetch(hubs)(input, init),
      ),
    );
    render(<ActivityRail managerName={null} onClose={() => {}} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    const allow = within(rail()).getByRole("button", { name: "Allow “Run npm test?” for acme-web" });
    allow.focus();
    await act(async () => fireEvent.click(allow));
    await act(async () => fireEvent.click(allow));
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(allow.textContent).toBe("Allowed…");
    expect(allow.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(allow);
    expect(within(rail()).getAllByRole("status").map((r) => r.textContent)).toContain("Allowed");
    await act(async () => answer(new Response(null, { status: 204 })));
    await act(() => vi.waitFor(() => expect(hubs.local!.days).toHaveLength(1)));
  });

  it("puts focus on the list when what it was on was answered elsewhere", async () => {
    hubs.local!.decide = () => 409;
    render(<ActivityRail managerName={null} onClose={() => {}} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    const allow = within(rail()).getByRole("button", { name: "Allow “Run npm test?” for acme-web" });
    allow.focus();
    await act(async () => fireEvent.click(allow));
    expect(document.activeElement).toBe(within(rail()).getByRole("list", { name: "Still waiting on you" }));
    expect(within(rail()).getByText("1 already answered elsewhere")).toBeTruthy();
  });

  it("replies where the question was asked, its composer focused", () => {
    render(<ActivityRail managerName={null} onClose={() => {}} />);
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    fireEvent.click(within(rail()).getByRole("button", { name: "Reply to Scout…" }));
    expect(openTarget).toHaveBeenCalledWith({ kind: "agent", key: "b/scout" }, { reply: true });
  });

  it("puts what's open above everything that happened, each past request marked with what became of it", async () => {
    hubs.local!.floor = view({
      needs: [
        approval("wait:t1:ap-2", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm test?" }),
        need("question:t2", session("s-1", "acme-web"), { ask: "Which one?" }),
      ],
    });
    useFloor.setState((s) => ({ hubs: { ...s.hubs, local: ready(structuredClone(hubs.local!.floor!)) } }));
    render(<ActivityRail managerName={null} onClose={() => {}} />);
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
