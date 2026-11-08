import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoard } from "../board/store";
import { useChat } from "../chat/store";
import { DeskHub } from "../hub/client";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import { DeskActions } from "../overview/DeskActions";
import { PLAN, PlanHub, ticket } from "./planTesting";
import { usePlans } from "./planStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

let plans: PlanHub;

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
  plans.say = (e) => deskListeners.forEach((l) => l(e));
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false }],
  });
  useDesk.setState({ hub: new DeskHub(transport(() => plans)) });
  usePlans.setState({ supported: null, plans: {}, details: {}, unread: {}, refusals: {}, cards: {} });
  useBoard.setState({ boards: { "board-acme": { id: "board-acme", name: "Acme", group: "acme", prefix: "ACM", createdAt: "", updatedAt: "" } }, tickets: {} });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null });
});

describe("a plan waiting for the person", () => {
  it("shows its goal, its waves with an engine and folder per ticket, and asks to approve it", async () => {
    await show();
    const c = card();
    expect(within(c).getByRole("heading", { name: "Refunds from the order page and from admin, covered by a test" })).toBeTruthy();
    expect(within(c).getByText("Waiting for you")).toBeTruthy();
    expect(within(c).getByText("rev 1")).toBeTruthy();
    expect(within(c).getByText("Board: Acme · Sarah's plan")).toBeTruthy();
    expect([...c.querySelectorAll(".pc-wave-label")].map((l) => l.textContent)).toEqual(["Starts at once · 2 side by side", "Then · after ACM-20", "Last"]);
    const engine = within(c).getByRole("combobox", { name: "Engine for ACM-21" }) as HTMLSelectElement;
    expect(engine.value).toBe("codex");
    // An engine that can't run here is offered, and can't be chosen.
    expect((within(engine).getByRole("option", { name: "Devin (not installed)" }) as HTMLOptionElement).disabled).toBe(true);
    expect(within(c).getByText("~/code/acme-admin")).toBeTruthy();
    expect(within(c).getByText("· needs ACM-21, ACM-22")).toBeTruthy();
    expect(within(c).getByText("4 tickets")).toBeTruthy();
    expect(within(c).getAllByRole("button").map((b) => b.textContent)).toEqual(["Drop", "Edit", "Approve and run"]);
  });

  it("runs once approved, and shows its progress as its sessions start", async () => {
    await show();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and run" })));
    expect(bodies(`POST /api/desk/plans/${PLAN}/approve`)).toEqual([{ revision: 1 }]);
    await waitFor(() => expect(within(card()).getByText("Running")).toBeTruthy());
    expect(within(card()).getByText("0 of 4 done · 2 running")).toBeTruthy();
    expect(within(card()).getByRole("img", { name: "2 doing, 2 waiting" })).toBeTruthy();
    expect(within(card()).getAllByText("· Doing")).toHaveLength(2);
    // Running, it can't be approved again, and its engines no longer change.
    expect(within(card()).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(within(card()).queryByRole("combobox")).toBeNull();
    expect(within(card()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Drop", "Edit", "Pause"]);
  });

  it("shows the newer revision when the boss changed it first, and asks again", async () => {
    await show();
    plans.bossAdds("Fix the flaky payment test");
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and run" })));
    expect(within(card()).getByRole("alert").textContent).toContain("Sarah changed the plan since you read it. This is revision 2: look at it, then ask again.");
    expect(within(card()).getByText("rev 2")).toBeTruthy();
    expect(within(card()).getByText("Fix the flaky payment test")).toBeTruthy();
    expect(usePlans.getState().plans[PLAN]!.state).toBe("proposed");
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve and run" })));
    expect(bodies(`POST /api/desk/plans/${PLAN}/approve`)).toEqual([{ revision: 1 }, { revision: 2 }]);
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
          { id: "t20", title: "Refunds endpoint over Stripe refunds", body: "", engine: "codex", folder: "/Users/sam/code/acme-api", view: null, needs: [] },
          { id: "t21", title: "Refund button in the admin", body: "", engine: "codex", folder: "/Users/sam/code/acme-admin", view: null, needs: [] },
          { id: "t22", title: "Refund from the order page", body: "", engine: "claude", folder: "/Users/sam/code/acme-web", view: null, needs: [0] },
          { title: "Fix the flaky payment test", engine: "codex", folder: "/Users/sam/code/acme-web", needs: [2] },
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
    expect(change.textContent).toBe("Sarah wants to change the plan: Added “Fix the flaky payment test”A change of scope, so it needs you. The plan keeps running on revision 1 meanwhile.");
    expect(within(card()).getByText("A change waits for you")).toBeTruthy();
    // The person's edit waits until Sarah's change is answered: it never
    // takes the change in unasked.
    expect((within(card()).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card()).getByText("Approve or turn down Sarah's change first, then edit the plan.")).toBeTruthy();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Approve the change" })));
    expect(bodies(`POST /api/desk/plans/${PLAN}/approve`)).toEqual([{ revision: 2 }]);
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
