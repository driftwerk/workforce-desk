import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { BossPlan, BossPlanDetail, RegroupedPlan } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { PlanGroup } from "./PlanGroup";
import { PlanHub } from "./planTesting";
import { usePlans } from "./planStore";

const detail = (over: Partial<BossPlan> = {}): BossPlanDetail => ({ ...new PlanHub().plan, group: null, boss: "desk", ...over });
const plan = (over: Partial<BossPlan> = {}): BossPlan => {
  const { tickets: _t, waves: _w, revisions: _r, spend: _s, ...p } = detail(over);
  return p;
};
const group = (id: string, name: string) => ({ id, name, collapsed: false, items: [] });

let regroupPlan: ReturnType<typeof vi.fn<(id: string, group: string | null) => Promise<RegroupedPlan>>>;

beforeEach(() => {
  regroupPlan = vi.fn(async (_id: string, to: string | null) => detail({ group: to }));
  useDesk.setState({ hub: { regroupPlan, plan: vi.fn(async () => detail()) } as unknown as DeskHub });
  usePlans.setState({ plans: {}, details: {}, refusals: {} });
  useSettings.setState({ groups: [group("g-mantis", "Mantis"), group("g-acme", "Acme"), group("g-old", "Old")], ungrouped: { collapsed: false, items: [] } });
  useOverview.setState({ manager: { agentId: "desk", level: "act", bosses: [{ agentId: "ada", name: "Ada", group: "g-acme", level: "act" }], sealed: ["g-old"] } });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null });
});

const change = () => fireEvent.click(screen.getByRole("button", { name: "Change group" }));
const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const choosing = () => screen.queryByRole("radiogroup", { name: "Group" });

describe("a plan's group on its card", () => {
  it("shows the group its sessions start in", () => {
    render(<PlanGroup plan={plan({ group: "g-mantis" })} />);
    expect(screen.getByTitle("Its sessions start in Mantis")).toBeTruthy();
    cleanup();
    render(<PlanGroup plan={plan()} />);
    expect(screen.getByTitle("Its sessions start in Ungrouped")).toBeTruthy();
  });

  it("offers only the groups with no boss of their own, and Ungrouped", () => {
    render(<PlanGroup plan={plan()} />);
    change();
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Mantis", "Ungrouped"]);
  });

  it("sends the group picked, and Ungrouped as none", async () => {
    render(<PlanGroup plan={plan()} />);
    change();
    choose("Mantis");
    await waitFor(() => expect(regroupPlan).toHaveBeenCalledWith(expect.any(String), "g-mantis"));
    await waitFor(() => expect(choosing()).toBeNull());
    cleanup();
    render(<PlanGroup plan={plan({ group: "g-mantis" })} />);
    change();
    choose("Ungrouped");
    await waitFor(() => expect(regroupPlan).toHaveBeenLastCalledWith(expect.any(String), null));
  });

  it("sends nothing for the group it is in, and closes without a pick", () => {
    render(<PlanGroup plan={plan({ group: "g-mantis" })} />);
    change();
    choose("Mantis");
    expect(choosing()).toBeNull();
    change();
    fireEvent.click(screen.getByRole("button", { name: "Keep it here" }));
    expect(choosing()).toBeNull();
    expect(regroupPlan).not.toHaveBeenCalled();
  });

  it("keeps the choice open when the hub refuses, for the card to say why", async () => {
    regroupPlan.mockRejectedValue(new HubError(409, "No boss runs Mantis: a plan moves only between groups its own boss runs."));
    const p = plan();
    render(<PlanGroup plan={p} />);
    change();
    choose("Mantis");
    await waitFor(() => expect(usePlans.getState().refusals[p.id]?.text).toBe("No boss runs Mantis: a plan moves only between groups its own boss runs."));
    expect(choosing()).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says what else went wrong beside the choice", async () => {
    regroupPlan.mockRejectedValue(new TypeError("Load failed"));
    render(<PlanGroup plan={plan()} />);
    change();
    choose("Mantis");
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
    expect(choosing()).toBeTruthy();
  });

  it("notes on the card, as no refusal, when its running sessions stayed where they were", async () => {
    const said = "Its running sessions stayed where they were: the sidebar refused.";
    regroupPlan.mockResolvedValue({ ...detail({ group: "g-mantis" }), unmoved: said });
    render(<PlanGroup plan={plan()} />);
    change();
    choose("Mantis");
    expect((await screen.findByRole("status")).textContent).toBe(said);
    expect(choosing()).toBeNull();
    expect(usePlans.getState().refusals).toEqual({});
  });

  it("offers no move for a group boss's plan or a finished one", () => {
    render(<PlanGroup plan={plan({ group: "g-acme", boss: "ada" })} />);
    expect(screen.getByTitle("Its sessions start in Acme")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change group" })).toBeNull();
    cleanup();
    render(<PlanGroup plan={plan({ state: "done" })} />);
    expect(screen.queryByRole("button", { name: "Change group" })).toBeNull();
  });

  it("names a group this computer's sidebar hasn't heard of as the hub does", () => {
    render(<PlanGroup plan={plan({ group: "g-new", groupName: "Starmoire" })} />);
    expect(screen.getByTitle("Its sessions start in Starmoire")).toBeTruthy();
  });
});
