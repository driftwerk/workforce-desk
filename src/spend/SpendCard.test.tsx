import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { SpendRow, SpendView } from "../hub/types";
import { SpendCard } from "./SpendCard";
import { SpendStrip } from "./SpendStrip";
import { useSpend } from "./store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

afterEach(cleanup);
beforeEach(() => useSpend.setState({ views: {}, supported: null, failed: false }));

const row = (session: string, label: string, usd: number, calls = 10): SpendRow => ({
  key: session,
  label,
  session,
  engine: "claude",
  folder: `/Users/allan/dev/${label}`,
  totals: {
    tokens: { input: 1000, output: 20_000, cacheRead: 2_000_000, cacheWrite: 100_000, reasoning: 0 },
    usd,
    calls,
    unpricedCalls: 0,
    unpricedModels: [],
    billing: ["plan"],
  },
});

const view = (rows: SpendRow[]): SpendView => ({
  from: "2026-10-31T00:00:00Z",
  to: "2026-10-31T12:00:00Z",
  by: "session",
  total: { ...rows[0]!.totals, usd: rows.reduce((n, r) => n + r.totals.usd, 0), calls: rows.reduce((n, r) => n + r.totals.calls, 0) },
  rows,
  more: 0,
});

it("lists the sessions that spent most today and this week, and a row opens its session", async () => {
  const today = view([row("s-web", "acme-web", 30), row("s-api", "atlas-api", 10)]);
  const week = view([row("s-api", "atlas-api", 90, 80), row("s-web", "acme-web", 31, 12)]);
  const spend = vi.fn(async (period: string) => (period === "day" ? today : week));
  useDesk.setState({ hub: { spend } as unknown as DeskHub, openId: null });
  render(<SpendCard />);
  await act(async () => {});
  expect(spend).toHaveBeenCalledWith("day", "session", 200);
  const names = () => screen.getAllByRole("button", { name: /acme-web|atlas-api/ }).map((b) => b.textContent);
  expect(names()).toEqual(["acme-web", "atlas-api"]);
  expect(screen.getByRole("img", { name: "75% of the spend" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "This week" }));
  expect(names()).toEqual(["atlas-api", "acme-web"]);
  fireEvent.click(screen.getByRole("button", { name: "atlas-api" }));
  expect(useDesk.getState().openId).toBe("s-api");
});

it("shows nothing from a hub without a ledger", async () => {
  useDesk.setState({ hub: { spend: vi.fn(async () => null) } as unknown as DeskHub });
  const { container } = render(<SpendCard />);
  await act(async () => {});
  expect(container.innerHTML).toBe("");
});

it("puts a session's spend today and this week on its card", () => {
  useSpend.setState({
    supported: true,
    views: { day: view([row("s-web", "acme-web", 4.1, 10)]), week: view([row("s-web", "acme-web", 12, 30)]) },
  });
  render(<SpendStrip sessionId="s-web" />);
  const strip = screen.getByLabelText("Spend");
  expect(strip.textContent).toBe("Today 2.1M tokens · $4.10 API-equivalent · this week 2.1M tokens · $12.00 API-equivalent");
  cleanup();
  const { container } = render(<SpendStrip sessionId="s-other" />);
  expect(container.innerHTML).toBe("");
});
