import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { SpendView } from "../hub/types";
import { DEFAULT_OVERSIGHT, type Oversight } from "./oversight";
import { ACT_SWITCHES, withPreset } from "./presets";
import { WhyNotInForce } from "./WhyNotInForce";

vi.mock("../platform", async (real) => ({
  ...(await real<typeof import("../platform")>()),
  repoFacts: vi.fn(() => Promise.resolve([{ folder: "/w/a", top: "/r/a", remote: "git@github.com:acme/acme-web.git", workflows: ["deploy.yml"] }])),
}));

const day = (usd: number): SpendView =>
  ({
    from: "",
    to: "",
    by: "account",
    total: { usd, billing: ["key"] },
    rows: [{ key: "k", label: "k", session: null, engine: null, folder: null, totals: { usd, billing: ["key"] } }],
    more: 0,
  }) as unknown as SpendView;

const hubWith = (today: SpendView | null) => ({ spend: vi.fn(() => Promise.resolve(today)) }) as unknown as DeskHub;

/** Renders it, applying each change to `o` as the Settings section would. */
const shown = (o: Oversight, held: boolean, hub = hubWith(null)) => {
  useDesk.setState({ hub, sessions: {} });
  let now = o;
  const onChange = vi.fn((change: (o: Oversight) => Oversight) => {
    now = change(now);
  });
  render(<WhyNotInForce o={o} held={held} onChange={onChange} />);
  return { onChange, now: () => now };
};

afterEach(cleanup);

describe("Why the level chosen isn't in force", () => {
  it("fills what Act fully is missing from Desk's suggestions", async () => {
    const r = shown(withPreset(DEFAULT_OVERSIGHT, "full"), true);
    expect(screen.getByText("Acting as Act: Act fully needs a repo to work in.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "See Desk’s suggestions" })));
    // Shown first: nothing written until said yes to.
    const found = await screen.findByRole("group", { name: "Desk’s suggestions" });
    expect(found.textContent).toContain("acme/acme-web");
    expect(found.textContent).toContain("deploy.yml");
    expect(found.textContent).toContain("$10");
    expect(r.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add these" }));
    expect(r.now().full).toMatchObject({ repos: ["acme/acme-web"], workflows: ["deploy.yml"], budgetUsdPerDay: 10 });
  });

  it("offers a higher budget when today's spend reached it, and only then", async () => {
    const ready = { ...withPreset(DEFAULT_OVERSIGHT, "full"), full: { anywhere: false, repos: ["acme/a"], workflows: [], budgetUsdPerDay: 20 } };
    const r = shown(ready, true, hubWith(day(25)));
    const raise = await screen.findByRole("button", { name: "Raise to $40.00 a day" });
    expect(screen.getByRole("alert").textContent).toContain("Act fully stopped: today’s budget is spent. $25.00 of $20.00 in real money today, so it no longer merges");
    expect(screen.queryByRole("button", { name: "Clear today’s count" })).toBeNull();
    fireEvent.click(raise);
    expect(r.now().full.budgetUsdPerDay).toBe(40);
    cleanup();
    shown(ready, true, hubWith(day(3)));
    expect(await screen.findByText(/until the hub has read today’s spend/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    // At the most a budget can be: no Raise.
    shown({ ...ready, full: { ...ready.full, budgetUsdPerDay: 10_000 } }, true, hubWith(day(12_000)));
    expect(await screen.findByText("It’s at the most a daily budget can be.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Raise/ })).toBeNull();
    cleanup();
    // In force: nothing to say.
    shown(ready, false, hubWith(day(25)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("takes the hub's count of real money over Desk's reckoning, and offers Clear with it", () => {
    const ready = { ...withPreset(DEFAULT_OVERSIGHT, "full"), full: { anywhere: false, repos: ["acme/a"], workflows: [], budgetUsdPerDay: 200, budgetClearedAt: null } };
    // Plans' calls at API prices would be over it; the hub counts none of them.
    const hub = hubWith(day(1000));
    const r = shown(ready, false, hub);
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    useDesk.setState({ hub, sessions: {} });
    let now: Oversight = ready;
    render(<WhyNotInForce o={ready} held budget={{ spentUsd: 210, budgetUsd: 200, spent: true }} onChange={(c) => (now = c(now))} />);
    const spent = screen.getByRole("alert");
    expect(spent.textContent).toContain("$210 of $200 in real money today (your plans aren’t counted)");
    fireEvent.click(screen.getByRole("button", { name: "Clear today’s count" }));
    expect(typeof now.full.budgetClearedAt).toBe("string");
    expect(hub.spend).not.toHaveBeenCalled();
    void r;
  });

  it("turns every switch on for Unbound", () => {
    const r = shown({ ...withPreset(DEFAULT_OVERSIGHT, "unbound"), act: { ...ACT_SWITCHES } }, false);
    fireEvent.click(screen.getByRole("button", { name: "Turn every switch on" }));
    expect(Object.values(r.now().act).every(Boolean)).toBe(true);
  });
});
