import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BossPlan } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { PlanGroup } from "./PlanGroup";
import { PlanHub } from "./planTesting";
import { usePlans } from "./planStore";

const regroup = vi.fn<(id: string, group: string | null) => Promise<void>>();
const plan = (over: Partial<BossPlan> = {}): BossPlan => ({ ...new PlanHub().summary(), group: null, boss: "desk", ...over });
const group = (id: string, name: string) => ({ id, name, collapsed: false, items: [] });

beforeEach(() => {
  regroup.mockReset().mockResolvedValue(undefined);
  usePlans.setState({ regroup });
  useSettings.setState({ groups: [group("g-mantis", "Mantis"), group("g-acme", "Acme"), group("g-old", "Old")], ungrouped: { collapsed: false, items: [] } });
  useOverview.setState({ manager: { agentId: "desk", level: "act", bosses: [{ agentId: "ada", name: "Ada", group: "g-acme", level: "act" }], sealed: ["g-old"] } });
});
afterEach(cleanup);

describe("a plan's group on its card", () => {
  it("says where its sessions start and moves it to Ungrouped or a group with no boss of its own", async () => {
    render(<PlanGroup plan={plan()} />);
    expect(screen.getByTitle("Its sessions start in Ungrouped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change group" }));
    const offered = screen.getAllByRole("radio").map((r) => r.textContent);
    expect(offered).toEqual(["Mantis", "Ungrouped"]);
    fireEvent.click(screen.getByRole("radio", { name: "Mantis" }));
    await waitFor(() => expect(regroup).toHaveBeenCalledWith(expect.any(String), "g-mantis"));
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Group" })).toBeNull());
  });

  it("moves a plan in a group back to Ungrouped, and picking where it is changes nothing", async () => {
    render(<PlanGroup plan={plan({ group: "g-mantis" })} />);
    expect(screen.getByTitle("Its sessions start in Mantis")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change group" }));
    fireEvent.click(screen.getByRole("radio", { name: "Mantis" }));
    expect(regroup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change group" }));
    fireEvent.click(screen.getByRole("radio", { name: "Ungrouped" }));
    await waitFor(() => expect(regroup).toHaveBeenCalledWith(expect.any(String), null));
  });

  it("keeps the choice open when the hub refuses, for the card to say why", async () => {
    regroup.mockRejectedValue(new Error("refused"));
    render(<PlanGroup plan={plan()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change group" }));
    fireEvent.click(screen.getByRole("radio", { name: "Mantis" }));
    await waitFor(() => expect(regroup).toHaveBeenCalled());
    expect(screen.getByRole("radiogroup", { name: "Group" })).toBeTruthy();
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
