import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { BreakerView, BudgetView, BudgetsView, LedgerRow, Session, Standing } from "../hub/types";
import { Budgets } from "../settings/Budgets";
import { useUi } from "../shell/ui";
import { BreakerBanner } from "./BreakerBanner";
import { amountText, budgetLine, heldSession, parseAmount, percentOf, scopeLabel, standingText, subjectOf, type Names } from "./budgets";
import { useBudgets, withBreaker } from "./budgetStore";
import { LedgerPanel, byDay } from "./Ledger";
import { SpendCard } from "./SpendCard";
import { useSpend } from "./store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const names: Names = {
  session: (id) => ({ "s-1": "acme-api" })[id],
  agent: (id) => ({ atlas: "Atlas" })[id],
  group: (id) => ({ "g-acme": "Acme" })[id],
};

const standing = (used: number, of: number, status: Standing["status"] = "under"): Standing => ({
  budget: "b-1",
  period: "day",
  unit: "usd",
  used,
  of,
  status,
  onExceed: "pause",
  from: "2026-11-03T00:00:00Z",
  to: "2026-11-04T00:00:00Z",
});

const budget = (over: Partial<BudgetView> = {}): BudgetView => ({
  id: "b-1",
  scope: { kind: "desk" },
  group: null,
  period: "day",
  unit: "usd",
  amount: 11,
  warnAt: 0.8,
  onExceed: "pause",
  updatedAt: "2026-11-03T09:00:00Z",
  standing: standing(9.13, 11, "warn"),
  ...over,
});

const held = (subject: string, kept = false): BreakerView => ({
  subject,
  name: "acme-api",
  level: {
    level: "held",
    reason: { kind: "budget", budget: "b-2" },
    since: "2026-11-03T10:00:00Z",
    until: "2026-11-04T00:00:00Z",
    kept,
  },
  ask: "acme-api is at 115% of its day budget ($1.15 of $1). Desk paused it after its turn.",
  why: "Continue lets it go on for the rest of the day; Keep paused leaves it paused until you say.",
});

const budgetsView = (over: Partial<BudgetsView> = {}): BudgetsView => ({ budgets: [], breakers: [], rules: { loops: false }, ...over });

beforeEach(() => {
  useBudgets.setState({ view: null, supported: null, failed: false });
  useSpend.setState({ views: {}, supported: null, failed: false });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null, sessions: {} });
});

describe("budget words", () => {
  it("say what a budget is for, what it is, and where it stands", () => {
    expect(scopeLabel({ kind: "desk" }, null, names)).toBe("Everything on Desk");
    expect(scopeLabel({ kind: "desk" }, "g-acme", names)).toBe("Everything in Acme");
    expect(scopeLabel({ kind: "each_session" }, "g-acme", names)).toBe("Each session in Acme");
    expect(scopeLabel({ kind: "each_agent" }, null, names)).toBe("Each agent");
    expect(scopeLabel({ kind: "session", id: "s-1" }, null, names)).toBe("acme-api");
    expect(scopeLabel({ kind: "session", id: "gone" }, null, names)).toBe("A session since forgotten");
    expect(scopeLabel({ kind: "agent", id: "atlas" }, null, names)).toBe("Atlas");
    expect(budgetLine(budget())).toBe("$11 a day · warns at 80% · pauses when over");
    expect(budgetLine(budget({ unit: "tokens", amount: 500_000, period: "five_hours", onExceed: "warn" }))).toBe(
      "500k tokens per five hours · warns at 80% · only warns",
    );
    expect(standingText(standing(9.13, 11, "warn"))).toBe("$9.13 of $11 today · 83%");
    expect(percentOf({ used: 1.15, of: 1 })).toBe(115);
    expect(amountText("tokens", 1_200_000)).toBe("1.2M tokens");
  });

  it("read subjects, amounts and holds", () => {
    expect(subjectOf("session:s-1")).toEqual({ kind: "session", id: "s-1" });
    expect(subjectOf("agent:atlas")).toEqual({ kind: "agent", id: "atlas" });
    expect(subjectOf("pool:desk")).toEqual({ kind: "pool", group: null });
    expect(subjectOf("pool:group:g-acme")).toEqual({ kind: "pool", group: "g-acme" });
    expect(subjectOf("pool:group:")).toBeNull();
    expect(parseAmount("$11.50", "usd")).toBe(11.5);
    expect(parseAmount("0", "usd")).toBeNull();
    expect(parseAmount("1.5", "tokens")).toBeNull();
    expect(parseAmount("500,000", "tokens")).toBe(500_000);
    expect(parseAmount("500k", "tokens")).toBe(500_000);
    expect(parseAmount("1.2M", "tokens")).toBe(1_200_000);
    expect(parseAmount("2.5k", "usd")).toBe(2500);
    expect(parseAmount("lots", "usd")).toBeNull();
    expect(heldSession([held("session:s-1")], "s-1")?.subject).toBe("session:s-1");
    expect(heldSession([held("session:s-1")], "s-2")).toBeNull();
    const cleared = withBreaker(budgetsView({ breakers: [held("session:s-1")] }), { ...held("session:s-1"), level: { level: "clear" } });
    expect(cleared.breakers).toEqual([]);
  });
});

describe("the breaker banner", () => {
  it("shows nothing while no breaker holds the session", () => {
    useBudgets.setState({ view: budgetsView(), supported: true });
    const { container } = render(<BreakerBanner sessionId="s-1" />);
    expect(container.innerHTML).toBe("");
  });

  it("says why it is paused and lets you continue or keep it paused", async () => {
    const breakerContinue = vi.fn(async () => held("session:s-1"));
    const breakerKeep = vi.fn(async () => held("session:s-1", true));
    useDesk.setState({ hub: { breakerContinue, breakerKeep, budgets: vi.fn(async () => budgetsView({ breakers: [held("session:s-1")] })) } as unknown as DeskHub });
    useBudgets.setState({ view: budgetsView({ breakers: [held("session:s-1")] }), supported: true });
    render(<BreakerBanner sessionId="s-1" />);
    const banner = screen.getByRole("status", { name: "Paused by Desk's breaker" });
    expect(banner.textContent).toContain("Paused · over its budget");
    expect(banner.textContent).toContain("Desk paused it after its turn.");
    await act(async () => fireEvent.click(within(banner).getByRole("button", { name: "Keep paused" })));
    expect(breakerKeep).toHaveBeenCalledWith("session:s-1");
    await act(async () => fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Continue" })));
    expect(breakerContinue).toHaveBeenCalledWith("session:s-1");
  });

  it("offers only Continue once you said Keep paused, and in a pane says it short", () => {
    useBudgets.setState({ view: budgetsView({ breakers: [held("session:s-1", true)] }), supported: true });
    render(<BreakerBanner sessionId="s-1" compact />);
    const banner = screen.getByRole("status");
    expect(within(banner).getAllByRole("button").map((b) => b.textContent)).toEqual(["Continue"]);
    expect(banner.textContent).not.toContain("Desk paused it after its turn.");
  });
});

describe("the spend card", () => {
  const spendView = {
    from: "2026-11-03T00:00:00Z",
    to: "2026-11-03T12:00:00Z",
    by: "session" as const,
    total: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, usd: 9.13, calls: 3, unpricedCalls: 0, unpricedModels: [], billing: ["plan" as const] },
    rows: [],
    more: 0,
  };

  it("shows Desk's budget and how far along it is, with the ledger and budgets a click away", async () => {
    const hub = { spend: vi.fn(async () => spendView), budgets: vi.fn(async () => budgetsView({ budgets: [budget()] })) };
    useDesk.setState({ hub: hub as unknown as DeskHub });
    useUi.setState({ ledger: false, settings: null });
    render(<SpendCard />);
    await act(async () => {});
    expect(screen.getByText(/today · 83%/).closest("p")!.textContent).toBe("Desk's budget $9.13 of $11 today · 83%");
    expect(screen.getByRole("img", { name: "83% of Desk's budget" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(useUi.getState().ledger).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Budgets" }));
    expect(useUi.getState().settings).toBe("budgets");
  });

  it("offers no budgets from a hub that keeps none", async () => {
    const hub = { spend: vi.fn(async () => spendView), budgets: vi.fn(async () => null) };
    useDesk.setState({ hub: hub as unknown as DeskHub });
    render(<SpendCard />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /budget/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Ledger" })).toBeTruthy();
  });

  it("offers to set a budget when there is none", async () => {
    const hub = { spend: vi.fn(async () => spendView), budgets: vi.fn(async () => budgetsView()) };
    useDesk.setState({ hub: hub as unknown as DeskHub });
    render(<SpendCard />);
    await act(async () => {});
    expect(screen.queryByText(/Desk's budget/)).toBeNull();
    expect(screen.getByRole("button", { name: "Set a budget" })).toBeTruthy();
  });
});

describe("Settings → Budgets", () => {
  const show = async (view: BudgetsView | null, more: Partial<Record<string, unknown>> = {}) => {
    const hub = {
      budgets: vi.fn(async () => view),
      putBudget: vi.fn(async () => budget()),
      patchBudget: vi.fn(async () => budget()),
      deleteBudget: vi.fn(async () => undefined),
      setBreakerRules: vi.fn(async (r: unknown) => r),
      breakerContinue: vi.fn(async () => held("session:s-1")),
      ...more,
    };
    useDesk.setState({
      hub: hub as unknown as DeskHub,
      sessions: { "s-1": { id: "s-1", name: "acme-api", cwd: "/tmp", origin: "desk", state: "working" } as Session },
    });
    useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" }], roster: [{ hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false }] });
    render(<Budgets />);
    await act(async () => {});
    return hub;
  };

  it("says when the hub keeps no budgets", async () => {
    await show(null);
    expect(screen.getByText("This version of Desk doesn't keep budgets yet. Update Desk to set them.")).toBeTruthy();
  });

  it("starts with none, and nothing stops for spend", async () => {
    await show(budgetsView());
    expect(screen.getByText("None yet: nothing stops for spend.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Paused now" })).toBeNull();
    expect((screen.getByRole("checkbox", { name: /Watch sessions for loops/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("lists each budget with where it stands, and changes and removes one", async () => {
    const hub = await show(budgetsView({ budgets: [budget(), budget({ id: "b-2", scope: { kind: "session", id: "s-1" }, amount: 1, standing: standing(0.2, 1) })] }));
    const list = within(screen.getByRole("region", { name: "Your budgets" }));
    expect(list.getByText("Everything on Desk")).toBeTruthy();
    expect(list.getByText("$9.13 of $11 today · 83%").className).toContain("state-blocked");
    expect(list.getByText("acme-api")).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Change Everything on Desk's budget" }));
    fireEvent.change(list.getByDisplayValue("11"), { target: { value: "15" } });
    await act(async () => fireEvent.click(list.getByRole("button", { name: "Save" })));
    expect(hub.patchBudget).toHaveBeenCalledWith("b-1", { amount: 15, warnAt: 0.8, onExceed: "pause" });
    await act(async () => fireEvent.click(list.getByRole("button", { name: "Remove acme-api's budget" })));
    expect(hub.deleteBudget).toHaveBeenCalledWith("b-2");
  });

  it("adds a budget said in a sentence, saying back what it heard first", async () => {
    const hub = await show(budgetsView());
    const part = within(screen.getByRole("region", { name: "Add a budget" }));
    const add = part.getByRole("button", { name: "Add budget" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    const said = part.getByLabelText("Budget, in your words");
    fireEvent.change(said, { target: { value: "keep me under $20" } });
    expect(part.getByRole("status").textContent).toBe("Say how often: a day, a week, a month or every five hours.");
    expect(add.disabled).toBe(true);
    fireEvent.change(said, { target: { value: "Atlas under $8 a day, just warn" } });
    expect(part.getByRole("status").textContent).toBe("Atlas: $8 a day · warns at 80% · only warns.");
    await act(async () => fireEvent.click(add));
    expect(hub.putBudget).toHaveBeenCalledWith({ scope: { kind: "agent", id: "atlas" }, group: null, period: "day", unit: "usd", amount: 8, warnAt: 0.8, onExceed: "warn" });
    expect((said as HTMLInputElement).value).toBe("");
  });

  it("adds a budget for one agent field by field, and refuses an amount of nothing", async () => {
    const hub = await show(budgetsView());
    const part = within(screen.getByRole("region", { name: "Add a budget" }));
    fireEvent.click(part.getByRole("button", { name: "Set it up field by field" }));
    const form = within(part.getByDisplayValue("Everything together").closest("form")!);
    const add = form.getByRole("button", { name: "Add budget" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(form.getByDisplayValue("Everything together"), { target: { value: "agent:atlas" } });
    fireEvent.change(form.getByPlaceholderText("11"), { target: { value: "8" } });
    await act(async () => fireEvent.click(add));
    expect(hub.putBudget).toHaveBeenCalledWith({ scope: { kind: "agent", id: "atlas" }, group: null, period: "day", unit: "usd", amount: 8, warnAt: 0.8, onExceed: "pause" });
  });

  it("lists what is paused now with Continue, and turns loop watching on", async () => {
    const hub = await show(budgetsView({ breakers: [held("session:s-1")] }));
    const paused = within(screen.getByRole("region", { name: "Paused now" }));
    expect(paused.getByText(/Desk paused it after its turn/)).toBeTruthy();
    await act(async () => fireEvent.click(paused.getByRole("button", { name: "Continue" })));
    expect(hub.breakerContinue).toHaveBeenCalledWith("session:s-1");
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Watch sessions for loops/ })));
    expect(hub.setBreakerRules).toHaveBeenCalledWith({ loops: true });
  });

  it("keeps the editor open, with what was typed, when a change is refused", async () => {
    await show(budgetsView({ budgets: [budget()] }), { patchBudget: vi.fn(async () => Promise.reject(new Error("a budget's amount is more than nothing"))) });
    const list = within(screen.getByRole("region", { name: "Your budgets" }));
    fireEvent.click(list.getByRole("button", { name: "Change Everything on Desk's budget" }));
    fireEvent.change(list.getByDisplayValue("11"), { target: { value: "15" } });
    await act(async () => fireEvent.click(list.getByRole("button", { name: "Save" })));
    expect(list.getByDisplayValue("15")).toBeTruthy();
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["a budget's amount is more than nothing", "Not saved. Desk said why at the top of Budgets."]);
  });

  it("says what went wrong when the hub refuses", async () => {
    await show(budgetsView({ budgets: [budget()] }), { deleteBudget: vi.fn(async () => Promise.reject(new Error("there is no group"))) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Everything on Desk's budget" })));
    expect(screen.getByRole("alert").textContent).toContain("there is no group");
  });
});

describe("the ledger", () => {
  const row = (key: string, at: string, usd: number | null): LedgerRow => ({
    session: "s-1",
    key,
    at,
    engine: "claude",
    model: "claude-opus-5-5",
    tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    usd,
    priced: usd === null ? "none" : "priced",
    billing: "plan",
    account: null,
  });

  it("puts calls under their day, newest first", () => {
    const days = byDay([row("a", "2026-11-03T12:00:00Z", 1), row("b", "2026-11-03T09:00:00Z", 2), row("c", "2026-11-02T09:00:00Z", 3)]);
    expect(days.map((d) => d.rows.map((r) => r.key))).toEqual([["a", "b"], ["c"]]);
  });

  it("lists the calls with their session, model, tokens and price, and pages on", async () => {
    const ledger = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row("a", "2026-11-03T12:00:00Z", 0.42), row("b", "2026-11-03T11:00:00Z", null)], next: "p2" })
      .mockResolvedValueOnce({ rows: [row("c", "2026-11-03T10:00:00Z", 1)], next: null });
    useDesk.setState({ hub: { ledger } as unknown as DeskHub, sessions: { "s-1": { id: "s-1", name: "acme-api" } as Session } });
    render(<LedgerPanel />);
    await act(async () => {});
    expect(ledger).toHaveBeenCalledWith({ period: "day", session: undefined, before: undefined });
    expect(screen.getByText("$0.42")).toBeTruthy();
    expect(screen.getByText("no price")).toBeTruthy();
    expect(screen.getAllByText(/Claude Code · claude-opus-5-5 · 3k tokens · plan/).length).toBe(2);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show older" })));
    expect(ledger).toHaveBeenLastCalledWith({ period: "day", session: undefined, before: "p2" });
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("says when nothing was spent", async () => {
    useDesk.setState({ hub: { ledger: vi.fn(async () => ({ rows: [], next: null })) } as unknown as DeskHub });
    render(<LedgerPanel />);
    await act(async () => {});
    expect(screen.getByText("No calls today.")).toBeTruthy();
  });

  it("sums a piece of work handed across engines as one row, by work", async () => {
    const totals = (usd: number) => ({ tokens: { input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0 }, usd, calls: 6, unpricedCalls: 0, unpricedModels: [], billing: [] });
    const spend = vi.fn(async () => ({
      from: "2026-11-09T00:00:00Z",
      to: "2026-11-09T12:00:00Z",
      by: "work",
      total: totals(7.1),
      rows: [{ key: "s-2", label: "acme-api", session: "s-2", engine: null, folder: "/dev/acme-api", totals: totals(4.1) }],
      more: 0,
    }));
    const lineage = vi.fn(async () => ({ work: "s-1", from: { session: "s-1", name: "acme-api", engine: "claude", at: "2026-11-09T10:42:00Z" }, handedTo: null, sessions: ["s-1", "s-2"] }));
    useDesk.setState({
      hub: { ledger: vi.fn(async () => ({ rows: [], next: null })), spend, lineage } as unknown as DeskHub,
      sessions: { "s-2": { id: "s-2", name: "acme-api", engine: "codex" } as Session },
    });
    render(<LedgerPanel />);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "By work" })));
    expect(spend).toHaveBeenCalledWith("day", "work", 100);
    expect(screen.getByText("$4.10")).toBeTruthy();
    expect(await screen.findByText(/across Claude Code and Codex · 3k tokens/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Session" })).toBeNull();
  });
});
