// A boss's plan, end to end against a fake hub: Desk's own client over a
// transport that answers the plan, board and engine routes as the hub does
// and announces on its events socket what changed, and the Floor read over
// `fetch` from the same hub. Sarah's plan is approved from her DM, or from
// the Floor; either way it runs (its first wave's sessions start, and both
// say so). A revision Sarah made meanwhile is shown, and asked again.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "../board/BoardView";
import { useBoard } from "../board/store";
import { useChat } from "../chat/store";
import { RightNow } from "../floor/RightNow";
import { useFloor, watchFloor } from "../floor/store";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskEvent } from "../hub/types";
import { DeskActions } from "../overview/DeskActions";
import { useOverview } from "../overview/store";
import { FakeViewport, PLAN, PlanHub, ticket, webFor } from "./planTesting";
import { usePlans } from "./planStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

class Socket implements DeskSocket {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  say(e: DeskEvent) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent);
  }
}

/** This computer's hub: Desk's routes over its transport, the Floor's over
 *  `fetch`, one set of plans behind both. */
class FakeHub implements DeskTransport {
  plans = new PlanHub();
  events: Socket | null = null;
  /** Each Floor decide's body. */
  decided: unknown[] = [];

  constructor() {
    this.plans.say = (e) => this.events?.say(e);
  }

  fetch = async (method: string, path: string, body?: { data: string | Blob }): Promise<Response> =>
    this.plans.route(method, path, body ? JSON.parse(String(body.data)) : undefined) ?? new Response("Not Found", { status: 404 });

  socket = (path: string): DeskSocket => {
    const s = new Socket();
    if (path === "/api/desk/events") this.events = s;
    return s;
  };

  /** `fetch`, as paired hubs are reached (the Floor's reads and decides,
   *  and the card's approve). */
  web = vi.fn(webFor(this.plans, this.decided));
}

let hub: FakeHub;
let viewport: FakeViewport;
let disconnect: () => void;
let stop: () => void;

const card = () => screen.getByRole("article", { name: /^Plan: / });
const floor = () => within(screen.getByRole("region", { name: "Right now" }));

const connect = async () => {
  disconnect = useDesk.getState().connect(hub);
  await act(async () => {
    await Promise.resolve();
    hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [] } as DeskEvent);
  });
  render(
    <>
      <DeskActions extras={{ plan: { id: PLAN, revision: 1 } }} text="Sarah proposes a plan." />
      <RightNow brief={null} />
    </>,
  );
  await waitFor(() => expect(within(card()).getByText("Draft — review")).toBeTruthy());
  await waitFor(() => expect(floor().getByRole("button", { name: /^Approve and run/ })).toBeTruthy());
};

/** The run started: the plan runs, its first wave's two sessions started,
 *  the DM's card says so, and nothing about it waits on the Floor. */
const runs = async () => {
  await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
  expect(hub.plans.plan.state).toBe("running");
  expect(hub.plans.plan.tickets.filter((t) => t.state === "doing").map((t) => t.key)).toEqual(["ACM-20", "ACM-21"]);
  await waitFor(() => expect(within(card()).getByText("0 of 4 done · 2 running")).toBeTruthy());
  await waitFor(() => expect(floor().getByText("Nothing is waiting on you.")).toBeTruthy());
  expect(floor().queryByRole("button", { name: /^Approve/ })).toBeNull();
};

beforeEach(() => {
  hub = new FakeHub();
  viewport = new FakeViewport();
  vi.stubGlobal("fetch", hub.web);
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false }],
  });
  useOverview.setState({ manager: null, managerSupport: "unknown", overviewSupport: "no", suggestions: {}, suggestionsLoaded: true });
  usePlans.setState({ supported: null, plans: {}, details: {}, unread: {}, refusals: {}, cards: {}, seen: {}, looking: {} });
  useBoard.setState({ boards: {}, tickets: {}, plan: null, shown: null });
  useFloor.setState({ hubs: {}, deciding: {}, problems: {}, answered: {} });
  stop = watchFloor();
});
afterEach(() => {
  stop();
  disconnect?.();
  cleanup();
  vi.unstubAllGlobals();
});

describe("a boss's plan, against the hub", () => {
  it("approved in the DM, runs", async () => {
    await connect();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start" })));
    // As the person's device, through the Floor's decide: the hub's own
    // plan route takes no approval from Desk's token.
    expect(hub.decided).toEqual([{ at: { kind: "plan", plan: PLAN, revision: 1 }, choice: "allow" }]);
    await runs();
  });

  it("approved on the Floor, runs, its cap said there first", async () => {
    hub.plans.plan.budget = { amount: 25, unit: "usd", period: "total", warnAt: 0.8, onExceed: "pause" };
    await connect();
    await waitFor(() => expect(floor().getByText("Capped at $25 for the whole plan, warns at 80%, pauses new starts when over.")).toBeTruthy());
    expect(floor().getByRole("button", { name: "Open in chat: Sarah's plan" })).toBeTruthy();
    await act(async () => fireEvent.click(floor().getByRole("button", { name: /^Approve and run/ })));
    expect(hub.decided).toEqual([{ at: { kind: "plan", plan: PLAN, revision: 1 }, choice: "allow" }]);
    await runs();
    expect(hub.plans.requests.filter((r) => r.route.endsWith("/approve"))).toEqual([]);
  });

  it("changed by its boss before the Floor's approve reached the hub, is asked again at its newest revision", async () => {
    await connect();
    hub.plans.bossAdds("Fix the flaky payment test");
    await act(async () => fireEvent.click(floor().getByRole("button", { name: /^Approve and run/ })));
    await waitFor(() => expect(floor().getByRole("alert").textContent).toBe("The plan changed since you read it. This is its newest revision: look at it again."));
    expect(hub.plans.plan.state).toBe("proposed");
    // The Floor reads it again: its need is now for revision 2.
    await waitFor(() => expect(hub.web.mock.calls.filter(([u]) => String(u).includes("/api/desk/floor")).length).toBeGreaterThan(1));
    await act(async () => fireEvent.click(floor().getByRole("button", { name: /^Approve and run/ })));
    expect(hub.decided).toEqual([
      { at: { kind: "plan", plan: PLAN, revision: 1 }, choice: "allow" },
      { at: { kind: "plan", plan: PLAN, revision: 2 }, choice: "allow" },
    ]);
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
    await waitFor(() => expect(within(card()).getByText("rev 2")).toBeTruthy());
    expect(within(card()).getByText("Fix the flaky payment test")).toBeTruthy();
  });

  it("changed by its boss before the DM's approve reached the hub, shows the newer revision and asks again", async () => {
    await connect();
    hub.plans.bossAdds("Fix the flaky payment test");
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start" })));
    expect(within(card()).getByRole("alert").textContent).toContain("This is revision 2: look at it, then ask again.");
    expect(within(card()).getByText("Fix the flaky payment test")).toBeTruthy();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start" })));
    expect(hub.decided).toEqual([
      { at: { kind: "plan", plan: PLAN, revision: 1 }, choice: "allow" },
      { at: { kind: "plan", plan: PLAN, revision: 2 }, choice: "allow" },
    ]);
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
  });

  it("waiting on a change of scope, is approved on the Floor as a change, or looked at in the DM", async () => {
    hub.plans.approve(1);
    hub.plans.bossAdds("Fix the flaky payment test");
    disconnect = useDesk.getState().connect(hub);
    await act(async () => {
      await Promise.resolve();
      hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [] } as DeskEvent);
    });
    render(<RightNow brief={null} />);
    // Not seen yet: the Floor only offers to look at it.
    await waitFor(() => expect(floor().getByRole("button", { name: "Look: Sarah's plan" })).toBeTruthy());
    expect(floor().queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(floor().queryByRole("button", { name: /^Turn down/ })).toBeNull();
    // Seen whole on its card, it is approved there or here.
    render(<DeskActions extras={{ plan: { id: PLAN, revision: 2 } }} />);
    await waitFor(() => expect(floor().getByRole("button", { name: /^Approve “Plan change/ })).toBeTruthy());
    expect(floor().getByRole("button", { name: "Look: Sarah's plan" })).toBeTruthy();
    expect(floor().getByRole("button", { name: /^Turn down “Plan change/ })).toBeTruthy();
    expect(floor().queryByRole("button", { name: /Approve and run/ })).toBeNull();
    await act(async () => fireEvent.click(floor().getByRole("button", { name: /^Approve “Plan change/ })));
    expect(hub.decided).toEqual([{ at: { kind: "plan", plan: PLAN, revision: 2 }, choice: "allow" }]);
    expect(hub.plans.plan.approvedRevision).toBe(2);
  });
});

describe("the Floor's approve", () => {
  it("waits until the revision is looked at, and again for a newer one", async () => {
    viewport.visible = false;
    disconnect = useDesk.getState().connect(hub);
    await act(async () => {
      await Promise.resolve();
      hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [] } as DeskEvent);
    });
    render(
      <>
        <DeskActions extras={{ plan: { id: PLAN, revision: 1 } }} />
        <RightNow brief={null} />
      </>,
    );
    await waitFor(() => expect(within(card()).getByText("Draft — review")).toBeTruthy());
    // The card is mounted, but scrolled away: not seen.
    await waitFor(() => expect(floor().getByText("Look at it first")).toBeTruthy());
    expect(floor().queryByRole("button", { name: /^Approve/ })).toBeNull();
    // Look brings it into view: now it is approved here too.
    fireEvent.click(floor().getByRole("button", { name: "Open in chat: Sarah's plan" }));
    await waitFor(() => expect(floor().getByRole("button", { name: /^Approve and run/ })).toBeTruthy());
    expect(floor().queryByText("Look at it first")).toBeNull();
    // Sarah changes it: the Floor asks about revision 2, which no one has seen.
    hub.plans.bossAdds("Fix the flaky payment test");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(floor().getByText("Look at it first")).toBeTruthy());
    expect(floor().queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(hub.decided).toEqual([]);
  });
});

describe("the board's plan filter", () => {
  it("shows only the plan's tickets, each with the plan's chip", async () => {
    hub.plans.others = [{ ...ticket(7, "Tidy the README"), createdBy: { kind: "you" as const, id: "you", name: "You" } }].map(({ engine: _e, folder: _f, view: _v, starting: _s, ...t }) => t);
    disconnect = useDesk.getState().connect(hub);
    await act(async () => {
      await Promise.resolve();
      hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [] } as DeskEvent);
    });
    render(<Board />);
    await waitFor(() => expect(screen.getByRole("button", { name: "ACM-7: Tidy the README" })).toBeTruthy());
    const goal = hub.plans.plan.goal;
    await waitFor(() => expect(within(screen.getByRole("button", { name: "ACM-20: Refunds endpoint over Stripe refunds" })).getByText(goal)).toBeTruthy());
    expect(within(screen.getByRole("button", { name: "ACM-7: Tidy the README" })).queryByText(goal)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Plan" }), { target: { value: PLAN } });
    expect(screen.queryByRole("button", { name: "ACM-7: Tidy the README" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^ACM-2\d: / })).toHaveLength(4);
    fireEvent.change(screen.getByRole("combobox", { name: "Plan" }), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "ACM-7: Tidy the README" })).toBeTruthy();
  });
});

describe("a plan's lasting place on its board", () => {
  const onBoard = async () => {
    disconnect = useDesk.getState().connect(hub);
    await act(async () => {
      await Promise.resolve();
      hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [] } as DeskEvent);
    });
  };
  const line = () => within(screen.getByRole("group", { name: `Plan: ${hub.plans.plan.goal}` }));
  const whole = () => screen.queryByRole("article", { name: `Plan: ${hub.plans.plan.goal}` });

  it("shows a line for the plan, which opens to its whole card, and closes", async () => {
    await onBoard();
    render(<Board />);
    await waitFor(() => expect(line().getByText("Draft — review")).toBeTruthy());
    expect(line().getByText("0 of 4 done")).toBeTruthy();
    expect(whole()).toBeNull();
    fireEvent.click(line().getByRole("button", { name: hub.plans.plan.goal }));
    // The whole card, with what the DM's has, and the board shows its tickets alone.
    await waitFor(() => expect(within(whole()!).getByRole("button", { name: "Approve and start" })).toBeTruthy());
    expect(within(whole()!).queryByRole("button", { name: "Open on board" })).toBeNull();
    expect((screen.getByRole("combobox", { name: "Plan" }) as HTMLSelectElement).value).toBe(PLAN);
    fireEvent.click(line().getByRole("button", { name: hub.plans.plan.goal, expanded: true }));
    expect(whole()).toBeNull();
    expect((screen.getByRole("combobox", { name: "Plan" }) as HTMLSelectElement).value).toBe("");
  });

  it("shows the plan's card from the Plan select, and from a ticket's plan chip", async () => {
    await onBoard();
    render(<Board />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Plan" })).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "Plan" }), { target: { value: PLAN } });
    await waitFor(() => expect(whole()).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "Plan" }), { target: { value: "" } });
    expect(whole()).toBeNull();
    const ticket20 = await screen.findByRole("button", { name: "ACM-20: Refunds endpoint over Stripe refunds" });
    fireEvent.click(await within(ticket20).findByText(hub.plans.plan.goal));
    await waitFor(() => expect(whole()).toBeTruthy());
    // The chip shows the plan; the ticket's panel isn't opened.
    expect(useBoard.getState().open).toBeNull();
  });

  it("pauses and resumes from its line", async () => {
    hub.plans.approve(1);
    await onBoard();
    render(<Board />);
    await waitFor(() => expect(line().getByText("Running")).toBeTruthy());
    await act(async () => fireEvent.click(line().getByRole("button", { name: "Pause" })));
    await waitFor(() => expect(line().getByText("Paused")).toBeTruthy());
    expect(hub.plans.plan.state).toBe("paused");
    await act(async () => fireEvent.click(line().getByRole("button", { name: "Resume" })));
    await waitFor(() => expect(line().getByText("Running")).toBeTruthy());
  });

  it("opens from the DM's card, which stays whole beside the board's", async () => {
    await onBoard();
    render(<DeskActions extras={{ plan: { id: PLAN, revision: 1 } }} text="Sarah proposes a plan." />);
    await waitFor(() => expect(within(card()).getByText("Draft — review")).toBeTruthy());
    fireEvent.click(within(card()).getByRole("button", { name: "Open on board" }));
    expect(useDesk.getState().view).toBe("board");
    expect(useBoard.getState().plan).toBe(PLAN);
    render(<Board />);
    await waitFor(() => expect(screen.getAllByRole("article", { name: /^Plan: / })).toHaveLength(2));
    // The DM's card is still the plan's whole card, not an older revision's notice.
    for (const c of screen.getAllByRole("article", { name: /^Plan: / })) expect(within(c).getByRole("button", { name: /^Approve and start/ })).toBeTruthy();
  });
});

describe("a plan whose sessions keep failing to start", () => {
  it("goes on from the Floor's Continue", async () => {
    hub.plans.approve(1);
    Object.assign(hub.plans.plan, { state: "paused", paused: "start_failing", pausedWhy: "ACM-21 failed to start 3 times" });
    disconnect = useDesk.getState().connect(hub);
    await act(async () => {
      await Promise.resolve();
      hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [] } as DeskEvent);
    });
    render(<RightNow brief={null} />);
    await waitFor(() => expect(floor().getByRole("button", { name: /^Continue “/ })).toBeTruthy());
    expect(floor().queryByRole("button", { name: /^Turn down/ })).toBeNull();
    await act(async () => fireEvent.click(floor().getByRole("button", { name: /^Continue “/ })));
    expect(hub.decided).toEqual([{ at: { kind: "plan", plan: PLAN, revision: 1 }, choice: "allow" }]);
    expect(hub.plans.plan.state).toBe("running");
  });
});
