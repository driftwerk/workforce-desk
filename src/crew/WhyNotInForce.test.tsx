import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByText("Acting as Act: Act fully needs repos to work in and a daily budget.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use Desk’s suggestions" })));
    await waitFor(() => expect(r.onChange).toHaveBeenCalled());
    expect(r.now().full).toMatchObject({ repos: ["acme/acme-web"], workflows: ["deploy.yml"], budgetUsdPerDay: 10 });
  });

  it("offers a higher budget when today's spend reached it, and only then", async () => {
    const ready = { ...withPreset(DEFAULT_OVERSIGHT, "full"), full: { anywhere: false, repos: ["acme/a"], workflows: [], budgetUsdPerDay: 20 } };
    const r = shown(ready, true, hubWith(day(25)));
    const raise = await screen.findByRole("button", { name: "Raise to $40.00 a day" });
    expect(screen.getByText("Acting as Act: today’s spend ($25.00) reached its $20.00 daily budget.")).toBeTruthy();
    fireEvent.click(raise);
    expect(r.now().full.budgetUsdPerDay).toBe(40);
    cleanup();
    shown(ready, true, hubWith(day(3)));
    expect(await screen.findByText(/until the hub has read today’s spend/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    // In force: nothing to say.
    shown(ready, false, hubWith(day(25)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("turns every switch on for Unbound", () => {
    const r = shown({ ...withPreset(DEFAULT_OVERSIGHT, "unbound"), act: { ...ACT_SWITCHES } }, false);
    fireEvent.click(screen.getByRole("button", { name: "Turn every switch on" }));
    expect(Object.values(r.now().act).every(Boolean)).toBe(true);
  });
});
