import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoard } from "../board/store";
import { useChat } from "../chat/store";
import { invoke } from "@tauri-apps/api/core";
import { DeskHub } from "../hub/client";
import { useMachines } from "../hub/engines";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import { DeskActions } from "../overview/DeskActions";
import { FakeViewport, PLAN, PlanHub, ticket, webFor } from "./planTesting";
import { usePlans } from "./planStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

let plans: PlanHub;
let viewport: FakeViewport;
/** Each decide the card sent, as the Floor sends them. */
let decided: unknown[];
const allow = (revision: number) => ({ at: { kind: "plan", plan: PLAN, revision }, choice: "allow" });

const transport = (h: () => PlanHub | null): DeskTransport => ({
  fetch: async (method, path, body) => {
    const answer = h()?.route(method, path, body ? JSON.parse(String(body.data)) : undefined);
    return answer ?? new Response("Not Found", { status: 404 });
  },
  socket: () => ({}) as DeskSocket,
});

const card = () => screen.getByRole("article", { name: /^Plan: / });
const bodies = (route: string) => plans.requests.filter((r) => r.route === route).map((r) => r.body);

const show = async (revision = 1) => {
  render(<DeskActions extras={{ plan: { id: PLAN, revision } }} text="Sarah proposes a plan." />);
  await waitFor(() => expect(card()).toBeTruthy());
};

beforeEach(() => {
  plans = new PlanHub();
  viewport = new FakeViewport();
  decided = [];
  vi.stubGlobal("fetch", vi.fn(webFor(plans, decided)));
  plans.say = (e) => deskListeners.forEach((l) => l(e));
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false }],
  });
  useDesk.setState({ hub: new DeskHub(transport(() => plans)) });
  usePlans.setState({ supported: null, plans: {}, details: {}, unread: {}, refusals: {}, cards: {}, seen: {}, looking: {} });
  useBoard.setState({ boards: { "board-acme": { id: "board-acme", name: "Acme", group: "acme", prefix: "ACM", createdAt: "", updatedAt: "" } }, tickets: {} });
});
afterEach(() => {
  cleanup();
  useMachines.setState({ machines: [] });
  vi.mocked(invoke).mockImplementation(() => Promise.resolve());
  useDesk.setState({ hub: null });
  vi.unstubAllGlobals();
});

describe("a plan waiting for the person", () => {
  it("shows its goal, its waves with an engine and folder per ticket, and asks to approve it", async () => {
    await show();
    const c = card();
    expect(within(c).getByRole("heading", { name: "Refunds from the order page and from admin, covered by a test" })).toBeTruthy();
    expect(within(c).getByText("Draft — review")).toBeTruthy();
    expect(within(c).getByText("rev 1")).toBeTruthy();
    expect(within(c).getByText("Board: Acme · Sarah's plan")).toBeTruthy();
    expect([...c.querySelectorAll(".pc-wave .pc-wave-label")].map((l) => l.textContent)).toEqual(["Starts at once · 2 side by side", "Then · after ACM-20", "Last"]);
    const engine = within(c).getByRole("combobox", { name: "Engine for ACM-21" }) as HTMLSelectElement;
    expect(engine.value).toBe("codex");
    // An engine that can't run here is offered, and can't be chosen.
    expect((within(engine).getByRole("option", { name: "Devin (not installed)" }) as HTMLOptionElement).disabled).toBe(true);
    expect(within(c).getByText("~/code/acme-admin")).toBeTruthy();
    expect(within(c).getByText("· needs ACM-21, ACM-22")).toBeTruthy();
    expect(within(c).getByText("4 tickets")).toBeTruthy();
    expect(within(c).getAllByRole("button").map((b) => b.textContent)).toEqual(["Open on board", "Drop", "Edit", "Approve and start"]);
  });

  it("shows what each ticket starts with, folded away", async () => {
    plans.plan.tickets[0]!.body = "Add POST /refunds over Stripe's refunds API.";
    plans.plan.revisions[0]!.snapshot.tickets[0]!.body = plans.plan.tickets[0]!.body;
    await show();
    const body = within(card()).getByText("Add POST /refunds over Stripe's refunds API.");
    expect(body.closest("details")).toBeTruthy();
    expect(within(body.closest("details")!).getByText("What it starts with")).toBeTruthy();
  });

  it("runs once approved, and shows its progress as its sessions start", async () => {
    await show();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start" })));
    expect(decided).toEqual([allow(1)]);
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
    expect(within(card()).getByText("0 of 4 done · 2 running")).toBeTruthy();
    expect(within(card()).getByRole("img", { name: "2 doing, 2 waiting" })).toBeTruthy();
    expect(within(card()).getAllByText("· Doing")).toHaveLength(2);
    // Running, it can't be approved again, and its engines no longer change.
    expect(within(card()).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(within(card()).queryByRole("combobox")).toBeNull();
    expect(within(card()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Open on board", "Drop", "Edit", "Pause"]);
  });

  it("shows the newer revision when the boss changed it first, and asks again", async () => {
    await show();
    plans.bossAdds("Fix the flaky payment test");
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start" })));
    expect(within(card()).getByRole("alert").textContent).toContain("Sarah changed the plan since you read it. This is revision 2: look at it, then ask again.");
    expect(within(card()).getByText("rev 2")).toBeTruthy();
    expect(within(card()).getByText("Fix the flaky payment test")).toBeTruthy();
    expect(usePlans.getState().plans[PLAN]!.state).toBe("proposed");
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start" })));
    expect(decided).toEqual([allow(1), allow(2)]);
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
  });

  it("saves an edit as a revision: titles, engines, needs, and tickets added and taken out", async () => {
    await show();
    fireEvent.click(within(card()).getByRole("button", { name: "Edit" }));
    const form = within(card()).getByRole("form", { name: "Edit the plan" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Title of ticket 2" }), { target: { value: "Refund button in the admin" } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Engine of ticket 1" }), { target: { value: "codex" } });
    fireEvent.click(within(form).getByRole("button", { name: "Remove ticket 4" }));
    fireEvent.click(within(form).getByRole("button", { name: "Add a ticket" }));
    fireEvent.change(within(form).getByRole("textbox", { name: "Title of ticket 4" }), { target: { value: "Fix the flaky payment test" } });
    // It may need anything but what needs it.
    const needs = within(form).getByRole("group", { name: "What ticket 4 needs first" });
    fireEvent.click(within(needs).getByRole("button", { name: "Refund from the order page" }));
    const first = within(form).getByRole("group", { name: "What ticket 1 needs first" });
    expect((within(first).getByRole("button", { name: "Refund from the order page" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Save" })));
    expect(bodies(`PATCH /api/desk/plans/${PLAN}`)).toEqual([
      {
        revision: 1,
        tickets: [
          { id: "t20", title: "Refunds endpoint over Stripe refunds", body: "", engine: "codex", folder: "/Users/sam/code/acme-api", view: null, machine: null, model: null, needs: [] },
          { id: "t21", title: "Refund button in the admin", body: "", engine: "codex", folder: "/Users/sam/code/acme-admin", view: null, machine: null, model: null, needs: [] },
          { id: "t22", title: "Refund from the order page", body: "", engine: "claude", folder: "/Users/sam/code/acme-web", view: null, machine: null, model: null, needs: [0] },
          { title: "Fix the flaky payment test", engine: "codex", folder: "/Users/sam/code/acme-web", machine: null, model: null, needs: [2] },
        ],
      },
    ]);
    await waitFor(() => expect(within(card()).getByText("rev 2")).toBeTruthy());
    expect(within(card()).queryByRole("form")).toBeNull();
    expect(within(card()).getByText("Refund button in the admin")).toBeTruthy();
    expect(within(card()).queryByText("End-to-end refund test in CI")).toBeNull();
  });

  it("changes a ticket's engine from the card as a revision", async () => {
    await show();
    await act(async () => fireEvent.change(within(card()).getByRole("combobox", { name: "Engine for ACM-20" }), { target: { value: "codex" } }));
    const [edit] = bodies(`PATCH /api/desk/plans/${PLAN}`) as { revision: number; tickets: { engine: string }[] }[];
    expect(edit!.revision).toBe(1);
    expect(edit!.tickets.map((t) => t.engine)).toEqual(["codex", "codex", "claude", "claude"]);
    await waitFor(() => expect((within(card()).getByRole("combobox", { name: "Engine for ACM-20" }) as HTMLSelectElement).value).toBe("codex"));
  });

  it("drops with nothing running, its sessions stopped (there are none)", async () => {
    await show();
    fireEvent.click(within(card()).getByRole("button", { name: "Drop" }));
    expect(within(card()).queryByRole("radio")).toBeNull();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Drop the plan" })));
    expect(bodies(`POST /api/desk/plans/${PLAN}/drop`)).toEqual([{ sessions: "stop" }]);
    await waitFor(() => expect(within(card()).getByText("Dropped")).toBeTruthy());
    expect(within(card()).queryByRole("button")).toBeNull();
  });
});

describe("a plan's budget", () => {
  const cap = (amount: number) => ({ amount, unit: "usd" as const, period: "total" as const, warnAt: 0.8, onExceed: "pause" as const });

  it("is shown before approving, approved as proposed, raised, or taken off", async () => {
    plans.plan.budget = cap(25);
    await show();
    expect(within(card()).getByText("cap $25 for the whole plan, warns at 80%, pauses new starts when over")).toBeTruthy();
    const field = within(card()).getByRole("textbox", { name: "Cap the plan's spend, in dollars" }) as HTMLInputElement;
    expect(field.value).toBe("25");
    expect(within(card()).getByRole("button", { name: "Approve and start, capped at $25" })).toBeTruthy();
    fireEvent.change(field, { target: { value: "40" } });
    expect(within(card()).getByRole("button", { name: "Approve and start, capped at $40" })).toBeTruthy();
    fireEvent.change(field, { target: { value: "" } });
    expect(within(card()).getByRole("button", { name: "Approve and start" })).toBeTruthy();
    fireEvent.change(field, { target: { value: "lots" } });
    expect(within(card()).getByRole("alert").textContent).toBe("Say the cap in dollars, like 40.");
    fireEvent.click(within(card()).getByRole("button", { name: /^Approve and start/ }));
    expect(decided).toEqual([]);
    fireEvent.change(field, { target: { value: "40" } });
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start, capped at $40" })));
    expect(decided).toEqual([{ ...allow(1), budget: cap(40) }]);
  });

  it("says all of it: a warn-only proposal and a later warning each read as they are, and can be chosen", async () => {
    plans.plan.budget = { ...cap(25), warnAt: 0.9, onExceed: "warn" };
    await show();
    expect(within(card()).getByText("cap $25 for the whole plan, warns at 90%, only tells you when over")).toBeTruthy();
    // Kept as proposed: nothing sent.
    const over = within(card()).getByRole("combobox", { name: "When it's over" }) as HTMLSelectElement;
    expect(over.value).toBe("warn");
    // The person makes it pause new starts, warning earlier.
    fireEvent.change(over, { target: { value: "pause" } });
    fireEvent.change(within(card()).getByRole("combobox", { name: "When it warns" }), { target: { value: "0.5" } });
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start, capped at $25" })));
    expect(decided).toEqual([{ ...allow(1), budget: { ...cap(25), warnAt: 0.5, onExceed: "pause" } }]);
  });

  it("changed only in when it warns or what it does when over, says so in a change", async () => {
    plans.approve(1);
    plans.plan.budget = cap(25);
    plans.plan.revisions[0]!.snapshot.budget = cap(25);
    plans.bossProposes("Made the budget warn later and only warn", (ts) => ts, undefined, { ...cap(25), warnAt: 0.95, onExceed: "warn" });
    await show(2);
    const shown = within(card()).getByRole("list", { name: "What approving it changes" });
    expect(within(shown).getByText("Budget: $25 for the whole plan, warns at 80%, pauses new starts when over → $25 for the whole plan, warns at 95%, only tells you when over")).toBeTruthy();
  });

  it("as proposed, is approved without saying it again; taken off, is sent as none", async () => {
    plans.plan.budget = cap(25);
    await show();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start, capped at $25" })));
    expect(decided).toEqual([allow(1)]);
    cleanup();
    Object.assign(plans.plan, { state: "proposed", approvedRevision: null });
    usePlans.setState({ details: {}, plans: {}, cards: {} });
    decided.length = 0;
    await show();
    fireEvent.change(within(card()).getByRole("textbox", { name: "Cap the plan's spend, in dollars" }), { target: { value: "" } });
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and start" })));
    expect(decided).toEqual([{ ...allow(1), budget: null }]);
  });

  it("says what is spent, shared by its sessions, what holds its starts, and that Continue past a total runs it uncapped", async () => {
    plans.approve(1);
    plans.plan.budget = cap(40);
    plans.plan.held = "Refunds is over its budget for the whole plan";
    plans.plan.tickets[0]!.held = "over the plan's budget";
    plans.plan.spend = { budget: "b1", period: "total", unit: "usd", used: 41, of: 40, status: "over", onExceed: "pause", from: "1970-01-01T00:00:00Z", to: "2200-01-01T00:00:00Z", shared: true };
    await show();
    expect(within(card()).getByText("Spent $41 of $40 in all · 102%, shared by the plan's sessions")).toBeTruthy();
    expect(card().textContent).toContain(
      "New starts are held: Refunds is over its budget for the whole plan. Continue on the Floor lets them start again. Continued while it is over a budget for the whole plan, the plan runs uncapped for the rest of its run.",
    );
    expect(card().textContent).toContain("· held: over the plan's budget");
    // A total never resets: no time is given for it.
    expect(card().textContent).not.toMatch(/2200|resets/);
  });

  it("raised in a change of scope, says so before it is approved", async () => {
    plans.approve(1);
    plans.plan.budget = cap(25);
    plans.plan.revisions[0]!.snapshot.budget = cap(25);
    plans.bossProposes("Raised the budget to $40", (ts) => ts, undefined, cap(40));
    await show(2);
    const shown = within(card()).getByRole("list", { name: "What approving it changes" });
    expect(within(shown).getByText("Budget: $25 for the whole plan, warns at 80%, pauses new starts when over → $40 for the whole plan, warns at 80%, pauses new starts when over")).toBeTruthy();
  });
});

describe("a running plan", () => {
  beforeEach(() => {
    plans.approve(1);
  });

  it("asks whether to stop its sessions or leave them, when it is dropped", async () => {
    await show();
    fireEvent.click(within(card()).getByRole("button", { name: "Drop" }));
    // Nothing is chosen for the person: the drop waits for their answer.
    expect(within(card()).getAllByRole("radio").map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    expect((within(card()).getByRole("button", { name: "Drop the plan" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card()).getByRole("radio", { name: "Leave them running, yours to finish" }));
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Drop the plan" })));
    expect(bodies(`POST /api/desk/plans/${PLAN}/drop`)).toEqual([{ sessions: "leave" }]);
    await waitFor(() => expect(within(card()).getByText("Dropped")).toBeTruthy());
  });

  it("pauses and resumes", async () => {
    await show();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Pause" })));
    await waitFor(() => expect(within(card()).getByText("Paused: you paused it")).toBeTruthy());
    expect(within(card()).getByText(/new starts paused: you paused it/)).toBeTruthy();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Resume" })));
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
    expect(plans.requests.map((r) => r.route).filter((r) => /pause|resume/.test(r))).toEqual([`POST /api/desk/plans/${PLAN}/pause`, `POST /api/desk/plans/${PLAN}/resume`]);
  });

  it("paused for a reason the person doesn't lift, says why and offers no Resume", async () => {
    Object.assign(plans.plan, { state: "paused", paused: "budget" });
    await show();
    expect(within(card()).getByText("Paused: its budget is nearly spent. It goes on by itself once that's past.")).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("paused for a reason Desk doesn't know, says it in the hub's words, else as named", async () => {
    Object.assign(plans.plan, { state: "paused", paused: "start_failed", pausedWhy: "ACM-21 failed to start 3 times" });
    await show();
    expect(within(card()).getByText("Paused: ACM-21 failed to start 3 times")).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Resume" })).toBeNull();
    cleanup();
    usePlans.setState({ details: {}, plans: {}, cards: {} });
    Object.assign(plans.plan, { pausedWhy: null });
    await show();
    expect(within(card()).getByText("Paused: start failed")).toBeTruthy();
  });

  it("shows a change of scope the boss proposes, and runs on as approved until it is approved", async () => {
    plans.bossAdds("Fix the flaky payment test");
    await show(2);
    const change = within(card()).getByRole("group", { name: "A change to the plan" });
    expect(change.textContent).toBe(
      "Sarah wants to change the plan: Added “Fix the flaky payment test”Adds Fix the flaky payment test · Claude Code in ~/code/acme-webStarts at once, alongside the others readyA change of scope, so it needs you. The plan keeps running on revision 1 meanwhile.",
    );
    expect(within(card()).getByText("A change waits for you")).toBeTruthy();
    // The person's edit waits until Sarah's change is answered: it never
    // takes the change in unasked.
    expect((within(card()).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card()).getByText("Approve or turn down Sarah's change first, then edit the plan.")).toBeTruthy();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve the change" })));
    expect(decided).toEqual([allow(2)]);
  });

  it("shows in full what approving a change would approve: tickets added and dropped, bodies, engines, folders and the limit", async () => {
    plans.bossProposes(
      "Added “Fix the flaky payment test”; dropped “End-to-end refund test in CI”",
      (ts) => [
        ...ts
          .filter((t) => t.id !== "t23")
          .map((t) =>
            t.id === "t22" ? { ...t, body: "Also refund partial orders.", engine: "codex" as const, folder: "/Users/sam/code/acme-shop" } : t,
          ),
        ticket(19, "Fix the flaky payment test", { engine: "codex", folder: "/Users/sam/code/acme-pay", body: "Run the payment suite 20 times; fix what flakes." }),
      ],
      6,
    );
    await show(2);
    const shown = within(card()).getByRole("list", { name: "What approving it changes" });
    expect(within(shown).getByText("At once: the boss's limit → 6")).toBeTruthy();
    const added = within(shown).getByText(/Fix the flaky payment test/).closest("li")!;
    expect(added.textContent).toContain("Codex in ~/code/acme-pay");
    expect(added.textContent).toContain("Run the payment suite 20 times; fix what flakes.");
    expect(within(shown).getByText(/End-to-end refund test in CI/).closest("li")!.textContent).toBe("Drops End-to-end refund test in CI");
    const changed = within(shown).getByText(/Refund from the order page/).closest("li")!;
    expect(changed.textContent).toContain("Engine: Claude Code → Codex");
    expect(changed.textContent).toContain("Folder: ~/code/acme-web → ~/code/acme-shop");
    expect(changed.textContent).toContain("What it starts with now: Also refund partial orders.");
    expect(within(card()).getByText("rev 2")).toBeTruthy();
  });

  it("shows a ticket made to start alongside another rather than after it, and one added after another", async () => {
    plans.bossProposes("Moved “Refund from the order page”; added “Fix the flaky payment test”", (ts) => [
      ...ts.map((t) => (t.id === "t22" ? { ...t, needs: [] } : t)),
      ticket(19, "Fix the flaky payment test", { needs: ["t21"] }),
    ]);
    await show(2);
    const shown = within(card()).getByRole("list", { name: "What approving it changes" });
    expect(within(shown).getByText(/Refund from the order page/).closest("li")!.textContent).toContain("no longer waits for ACM-20, so it may start alongside it");
    expect(within(shown).getByText(/Fix the flaky payment test/).closest("li")!.textContent).toContain("Starts after ACM-21");
  });

  it("counts a revision seen only once it is in view, or Look brought it there", async () => {
    plans.bossAdds("Fix the flaky payment test");
    viewport.visible = false;
    await show(2);
    // Mounted, but scrolled away.
    expect(usePlans.getState().seen[PLAN]).toBeUndefined();
    act(() => viewport.show());
    expect(usePlans.getState().seen[PLAN]).toBe(2);
  });

  it("scrolls to the card the Floor's Look asked for, and counts it seen", async () => {
    viewport.visible = false;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await show();
    expect(usePlans.getState().seen[PLAN]).toBeUndefined();
    act(() => usePlans.getState().look(PLAN));
    expect(scrolled).toHaveBeenCalled();
    expect(usePlans.getState().seen[PLAN]).toBe(1);
    expect(usePlans.getState().looking[PLAN]).toBeUndefined();
  });

  it("decides nothing on a revision older than the newest announced, until it is read", async () => {
    plans.bossAdds("Fix the flaky payment test");
    await show(2);
    // A newer revision is announced; its read hasn't come yet.
    const hold = plans.route.bind(plans);
    plans.route = (m, p, b) => (m === "GET" && p.endsWith(PLAN) ? new Promise<Response>(() => {}) as never : hold(m, p, b));
    act(() => deskListeners.forEach((l) => l({ type: "plan", plan: { ...plans.summary(), revision: 3, updatedAt: "2030-01-01T00:00:00.000Z" } })));
    const approve = within(card()).getByRole("button", { name: "Approve the change" });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(within(card()).getByText("Revision 3 has come: reading it before anything is approved.")).toBeTruthy();
    expect(within(card()).getByText("rev 2")).toBeTruthy();
    fireEvent.click(approve);
    expect(decided).toEqual([]);
  });

  it("turns down a change of scope the boss proposes, and runs on as approved", async () => {
    plans.bossAdds("Fix the flaky payment test");
    await show(2);
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Turn down" })));
    expect(decided).toEqual([{ at: { kind: "plan", plan: PLAN, revision: 2 }, choice: "deny" }]);
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
    expect(within(card()).queryByRole("group", { name: "A change to the plan" })).toBeNull();
    expect((within(card()).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("whose sessions keep failing to start, goes on when the person says Continue", async () => {
    Object.assign(plans.plan, { state: "paused", paused: "start_failing", pausedWhy: "ACM-21 failed to start 3 times" });
    await show();
    expect(within(card()).getByText("Paused: ACM-21 failed to start 3 times. Continue tries again.")).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Resume" })).toBeNull();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Continue" })));
    expect(decided).toEqual([allow(1)]);
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
  });
});

describe("a plan's cards in the DM", () => {
  it("shows the newest whole, and the older ones as what their revision changed", async () => {
    plans.bossAdds("Fix the flaky payment test");
    render(
      <>
        <DeskActions extras={{ plan: { id: PLAN, revision: 1 } }} />
        <DeskActions extras={{ plan: { id: PLAN, revision: 2 } }} />
      </>,
    );
    await waitFor(() => expect(card()).toBeTruthy());
    expect(screen.getAllByRole("article")).toHaveLength(1);
    const notice = screen.getByRole("group", { name: "Plan revision 1" });
    expect(notice.textContent).toBe("rev 1 Sarah: Proposed 4 tickets for “Refunds from the order page and from admin, covered by a test”The plan is at revision 2 now: see its newest card below.");
  });

  it("on a hub without plans, shows what the boss said and why it can't be approved here", async () => {
    useDesk.setState({ hub: new DeskHub(transport(() => null)) });
    render(<DeskActions extras={{ plan: { id: PLAN, revision: 1 } }} text="Sarah proposes a plan: Refunds" />);
    await waitFor(() => expect(screen.getByText("Sarah proposes a plan: Refunds")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Desk couldn't read this plan/)).toBeTruthy());
  });
});

// The tickets of a plan start one at a time; Desk hears each as the board
// does, and its card keeps up.
describe("progress", () => {
  it("follows the board's tickets as they move", async () => {
    plans.approve(1);
    await show();
    await waitFor(() => expect(within(card()).getByText("0 of 4 done · 2 running")).toBeTruthy());
    const done = { ...ticket(20, "Refunds endpoint over Stripe refunds"), state: "done" as const, updatedAt: "2030-01-01T00:00:00.000Z" };
    const { engine: _e, folder: _f, view: _v, starting: _s, ...board } = done;
    act(() => deskListeners.forEach((l) => l({ type: "ticket", ticket: board })));
    expect(within(card()).getByText("1 of 4 done · 1 running · next ACM-22 when a slot frees")).toBeTruthy();
  });
});

describe("a draft plan's review: where each ticket runs, and with what", () => {
  const models = () => (bodies(`PATCH /api/desk/plans/${PLAN}`).at(-1) as { tickets: { model?: string | null; machine?: string | null; folder: string }[] }).tickets;

  it("sets every ticket's model from the plan's defaults, keeping a ticket set otherwise", async () => {
    plans.plan.tickets[1]!.model = "opus";
    plans.plan.revisions[0]!.snapshot.tickets[1]!.model = "opus";
    await show();
    expect(within(card()).getByText("Draft — review")).toBeTruthy();
    expect((within(card()).getByRole("combobox", { name: "Model for ACM-21" }) as HTMLSelectElement).value).toBe("opus");
    await act(async () => fireEvent.change(within(card()).getByRole("combobox", { name: "Every ticket's model" }), { target: { value: "sonnet" } }));
    expect(bodies(`PATCH /api/desk/plans/${PLAN}`)).toHaveLength(1);
    expect(models().map((t) => t.model)).toEqual(["sonnet", "opus", "sonnet", "sonnet"]);
    await waitFor(() => expect((within(card()).getByRole("combobox", { name: "Model for ACM-20" }) as HTMLSelectElement).value).toBe("sonnet"));
  });

  it("takes a model's exact id from Other…", async () => {
    await show();
    fireEvent.change(within(card()).getByRole("combobox", { name: "Model for ACM-20" }), { target: { value: "\u0000other" } });
    const field = within(card()).getByRole("textbox", { name: "Model for ACM-20: the model's exact id" });
    fireEvent.change(field, { target: { value: "claude-opus-4-1" } });
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    expect(models()[0]!.model).toBe("claude-opus-4-1");
    await waitFor(() => expect((within(card()).getByRole("combobox", { name: "Model for ACM-20" }) as HTMLSelectElement).value).toBe("claude-opus-4-1"));
  });

  it("shows the engine's default when the hub doesn't keep a ticket's model yet", async () => {
    plans.keepsModel = false;
    await show();
    await act(async () => fireEvent.change(within(card()).getByRole("combobox", { name: "Model for ACM-20" }), { target: { value: "sonnet" } }));
    await waitFor(() => expect(within(card()).getByText("rev 2")).toBeTruthy());
    expect((within(card()).getByRole("combobox", { name: "Model for ACM-20" }) as HTMLSelectElement).value).toBe("");
  });

  it("moves every ticket to a machine, each folder found under its home there, checked before it's saved", async () => {
    useMachines.setState({ machines: [{ id: "devbox", name: "devbox", target: "devbox", version: "1", state: { kind: "ready" } }] });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "machine_home" ? "/home/sam" : undefined) as never);
    await show();
    const where = within(card()).getByRole("radiogroup", { name: "Every ticket runs on" });
    await act(async () => fireEvent.click(within(where).getByRole("radio", { name: "devbox" })));
    const form = await within(card()).findByRole("form", { name: "Edit the plan" });
    await waitFor(() => expect((within(form).getByRole("textbox", { name: "Folder of ticket 1" }) as HTMLInputElement).value).toBe("/home/sam/code/acme-api"));
    expect(bodies(`PATCH /api/desk/plans/${PLAN}`)).toHaveLength(0);
    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Save" })));
    expect(models().map((t) => [t.machine, t.folder])).toEqual([
      ["devbox", "/home/sam/code/acme-api"],
      ["devbox", "/home/sam/code/acme-admin"],
      ["devbox", "/home/sam/code/acme-web"],
      ["devbox", "/home/sam/code/acme-web"],
    ]);
    await waitFor(() => expect(within(card()).getAllByText("devbox", { selector: ".pc-machine" })).toHaveLength(4));
  });

  it("asks a ticket's whole path on a machine", async () => {
    useMachines.setState({ machines: [{ id: "devbox", name: "devbox", target: "devbox", version: "1", state: { kind: "ready" } }] });
    await show();
    fireEvent.click(within(card()).getByRole("button", { name: "Edit" }));
    const form = within(card()).getByRole("form", { name: "Edit the plan" });
    await act(async () => fireEvent.click(within(within(form).getByRole("radiogroup", { name: "Where ticket 2 runs" })).getByRole("radio", { name: "devbox" })));
    fireEvent.change(within(form).getByRole("textbox", { name: "Folder of ticket 2" }), { target: { value: "code/acme-admin" } });
    expect(within(form).getByText("On devbox, say the folder's whole path, from /.")).toBeTruthy();
    expect((within(form).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
