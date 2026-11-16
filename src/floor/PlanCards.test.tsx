import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useAccounts } from "../engines/accounts";
import type { PlanReading, UsageView } from "../hub/types";
import { startLogin } from "../platform";
import { accountsOn } from "../engines/accounts";
import type { EngineAccount } from "../hub/types";
import { deskState } from "../restore/boot";
import { Plans } from "../settings/Plans";
import { PLANS_KEY } from "./planLinks";
import { PlanCards } from "./PlanCards";
import { useFloor } from "./store";
import { NOW, at, hub, ready, view } from "./testing";
import { clock, dayClock } from "./time";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  cancelLogin: vi.fn(),
  cliInstalled: vi.fn(async () => true),
  installCli: vi.fn(),
  onInstallProgress: vi.fn(),
  onLoginProgress: vi.fn(),
  openUrl: vi.fn(),
  sendLoginCode: vi.fn(),
  startLogin: vi.fn(async () => undefined),
  statePut: vi.fn(async () => undefined),
  stateRemove: vi.fn(async () => undefined),
  subscribe: vi.fn(() => () => {}),
}));

const MIN = 60_000;
const later = (min: number) => new Date(NOW + min * MIN).toISOString();

const reading = (windows: PlanReading["windows"], over: Partial<PlanReading> = {}): PlanReading => ({
  kind: "claude",
  where: "mac",
  account: "acct",
  plan: "max",
  windows,
  observedAt: at(1),
  ...over,
});

const usage = (over: Partial<UsageView>): UsageView => ({
  asOf: at(0),
  logins: [{ kind: "chatgpt", where: "mac", signedIn: true }],
  readings: [],
  ...over,
});

const show = (u: UsageView, hubId = "local") => {
  useChat.setState({ hubs: [hub(hubId)] });
  useFloor.setState({ hubs: { [hubId]: ready(view(), { usage: u }) } });
};

const card = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.mocked(startLogin).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  deskState.remove(PLANS_KEY);
  useAccounts.setState({ accounts: [], ownPlanKey: null, claudeSignIn: null });
});

describe("the plan cards", () => {
  it("show the weekly window's use, reset and pace, with the plan", () => {
    show(
      usage({
        readings: [
          reading([
            { usedPercent: 40, resetsAt: later(148), minutes: 300 },
            { usedPercent: 38, resetsAt: later(5 * 24 * 60), minutes: 10_080 },
          ]),
        ],
      }),
    );
    render(<PlanCards />);
    // Whatever this computer's Claude Code is signed in to, none of the
    // person's accounts: said so.
    const claude = card("Claude on this computer usage");
    expect(within(claude).getByText("Claude · Max")).toBeTruthy();
    expect(within(claude).getByText("38%").className).toBe("plan-ok");
    expect(within(claude).getByText(`resets ${dayClock(later(5 * 24 * 60), NOW)} · as of ${clock(at(1))}`)).toBeTruthy();
    // One bar: the weekly one.
    const [week, ...more] = within(claude).getAllByRole("img");
    expect(more).toHaveLength(0);
    expect(week!.getAttribute("aria-label")).toMatch(/^38 percent of the weekly limit used; resets /);
    expect(week!.querySelector(".plan-pace")!.getAttribute("title")).toBe("Where you’d be at an even pace");
    expect(within(claude).getByText("Used on")).toBeTruthy();
    expect(within(claude).getByText("This computer")).toBeTruthy();
  });

  it("warn near the limit with when it runs out, and say plainly at it", () => {
    show(usage({ readings: [reading([{ usedPercent: 92, resetsAt: later(60), minutes: 300 }])] }));
    render(<PlanCards />);
    const claude = card("Claude on this computer usage");
    expect(within(claude).getByText("92%").className).toBe("plan-full");
    const hits = NOW + 8 / (92 / (240 * MIN));
    expect(
      within(claude).getByText(
        `At this pace you reach the limit about ${clock(hits)}, ${Math.round((NOW + 60 * MIN - hits) / MIN)} minutes before it resets.`,
      ),
    ).toBeTruthy();
    expect(within(claude).getByRole("img").getAttribute("aria-label")).toContain(`at this pace it runs out about ${clock(hits)}`);
    cleanup();
    show(usage({ readings: [reading([{ usedPercent: 100, resetsAt: later(300), minutes: 10_080 }])] }));
    render(<PlanCards />);
    expect(within(card("Claude on this computer usage")).getByText(/^At the limit\. It resets at .+\.$/)).toBeTruthy();
  });

  it("name the day the weekly limit is reached when it isn't today", () => {
    show(usage({ readings: [reading([{ usedPercent: 58, resetsAt: later(3 * 1440), minutes: 10_080 }])] }));
    render(<PlanCards />);
    const claude = card("Claude on this computer usage");
    const hits = NOW + 42 / (58 / (4 * 1440 * MIN));
    const line = within(claude).getByText(/^At this pace you reach the limit about /).textContent!;
    expect(line).toContain(`about ${dayClock(hits, NOW)},`);
    expect(dayClock(hits, NOW)).not.toBe(clock(hits));
  });

  it("colour a window by the percent they show", () => {
    show(usage({ readings: [reading([{ usedPercent: 89.6, resetsAt: later(60), minutes: 300 }])] }));
    render(<PlanCards />);
    const shown = within(card("Claude on this computer usage")).getByText("90%");
    expect(shown.className).toBe("plan-full");
  });

  it("show a window that resets while shown as reset, without reading again", async () => {
    show(usage({ readings: [reading([{ usedPercent: 70, resetsAt: later(2), minutes: 300 }])] }));
    render(<PlanCards />);
    expect(within(card("Claude on this computer usage")).getByText("70%")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3 * MIN));
    expect(within(card("Claude on this computer usage")).getByText("0%")).toBeTruthy();
    expect(within(card("Claude on this computer usage")).getByText(`Reset at ${clock(later(2))} · no use seen since.`)).toBeTruthy();
  });


  it("name this computer's sign-in's card by who it is, else as this computer's sign-in", () => {
    useAccounts.setState({ accounts: [], ownPlanKey: "own", claudeSignIn: { state: "in", via: "plan", who: "kim@example.com", plan: "max" } });
    const w = [{ usedPercent: 12, resetsAt: later(100), minutes: 300 }];
    show(usage({ readings: [reading(w, { account: "own" }), reading(w, { account: "left-over" })] }));
    render(<PlanCards />);
    expect(card("kim@example.com usage")).toBeTruthy();
    // Another key's card is never named by the sign-in's email.
    expect(screen.getAllByRole("region", { name: /kim@example.com/ })).toHaveLength(1);
    cleanup();
    useAccounts.setState({ claudeSignIn: null });
    show(usage({ readings: [reading(w, { account: "own" })] }));
    render(<PlanCards />);
    expect(card("This computer’s sign-in usage")).toBeTruthy();
  });

  it("give an account with no reading yet its own card, by its name", () => {
    useAccounts.setState({ accounts: [account("a-s", "Kingsley Starmoire", "star")] });
    show(usage({ readings: [reading([{ usedPercent: 26, resetsAt: later(100), minutes: 10_080 }], { account: null, where: "hub" })] }));
    render(<PlanCards />);
    expect(within(card("Kingsley Starmoire usage")).getByText(/^No reading yet/)).toBeTruthy();
  });

  it("wait for a first reading on a plan signed in", () => {
    show(usage({}));
    render(<PlanCards />);
    expect(within(card("ChatGPT on this computer usage")).getByText("No reading yet. It shows after Codex next answers on this plan.")).toBeTruthy();
  });

  it("offer sign-in on this computer when no plan of a kind is, and nothing for a remote hub", async () => {
    show(usage({ logins: [] }));
    render(<PlanCards />);
    const claude = card("Claude on this computer · not signed in usage");
    expect(within(claude).getByText("Not signed in on this computer, so there’s no usage to show.")).toBeTruthy();
    await act(async () => fireEvent.click(within(claude).getByRole("button", { name: "Sign in to Claude" })));
    expect(startLogin).toHaveBeenCalledWith("claude");
    expect(within(card("ChatGPT on this computer · not signed in usage")).getByRole("button", { name: "Sign in to ChatGPT" })).toBeTruthy();
    cleanup();
    show(usage({ logins: [] }), "b");
    render(<PlanCards />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

const account = (id: string, name: string, planKey: string, over: Partial<EngineAccount> = {}): EngineAccount => ({
  id,
  engine: "claude",
  name,
  isDefault: false,
  signedIn: true,
  sessions: [],
  createdAt: at(0),
  planKey,
  ...over,
});

const DAY = 1440;
/** Gmail's week resets tomorrow; Apple's later. */
const gmailWeek = (used: number) => ({ usedPercent: used, resetsAt: later(DAY + 150), minutes: 10_080 });
const appleWeek = (used: number) => ({ usedPercent: used, resetsAt: later(DAY - 30), minutes: 10_080 });

/** This computer, the devbox (a machine) and Driftwerk (a hub), each with
 *  its usage. */
const places = (u: { local?: UsageView; devbox?: UsageView; dw?: UsageView }) => {
  useChat.setState({ hubs: [hub("local"), hub("devbox-hub", { label: "devbox", machine: "devbox" }), hub("dw", { label: "Driftwerk" })] });
  useFloor.setState({
    hubs: {
      local: ready(view(), { usage: u.local ?? usage({}) }),
      "devbox-hub": ready(view(), { usage: u.devbox ?? usage({ logins: [] }) }),
      dw: ready(view(), { usage: u.dw ?? usage({ logins: [] }) }),
    },
  });
};

describe("the plan cards, one per account", () => {
  beforeEach(() => {
    useAccounts.setState({
      accounts: [
        account("a-g", "Kingsley Gmail", "gmail", { sessions: ["s1", "s2", "s3"] }),
        account("a-a", "Kingsley Apple", "apple", { isDefault: true, sessions: ["s4"] }),
      ],
    });
    // The devbox's copies of them: its own ids and keys, the same names.
    accountsOn("devbox").setState({
      supported: true,
      accounts: [account("m-g", "Kingsley Gmail", "dev-gmail", { sessions: ["d1", "d2"] }), account("m-a", "Kingsley Apple", "dev-apple")],
    });
  });
  afterEach(() => accountsOn("devbox").setState({ accounts: [] }));

  it("put a machine's readings on the cards of the accounts it was given, the newest on the bar, never as unmatched", () => {
    // The devbox last ran a session two days ago: its readings are of the
    // same weeks, from before this computer's.
    places({
      local: usage({ readings: [reading([gmailWeek(75)], { account: "gmail", observedAt: at(10) }), reading([appleWeek(16)], { account: "apple", observedAt: at(30) })] }),
      devbox: usage({
        logins: [],
        readings: [reading([gmailWeek(12)], { account: "dev-gmail", observedAt: at(2 * DAY) }), reading([appleWeek(2)], { account: "dev-apple", observedAt: at(2 * DAY + 60) })],
      }),
    });
    render(<PlanCards />);
    expect(screen.getAllByRole("region", { name: / usage$/ }).map((r) => r.getAttribute("aria-label"))).toEqual([
      "Kingsley Gmail usage",
      "Kingsley Apple usage",
      "ChatGPT on this computer usage",
    ]);
    const gmail = card("Kingsley Gmail usage");
    expect(within(gmail).getByText("75%")).toBeTruthy();
    expect(within(gmail).getByText(new RegExp(`newest reading ${clock(at(10))}$`))).toBeTruthy();
    const rows = within(gmail).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual([
      `This computer · 3 sessions` + `reads 75% at ${clock(at(10))}`,
      `devbox · 2 sessions` + `read 12% ${dayClock(at(2 * DAY), NOW)}`,
    ]);
    // An older, lower reading is only older: it adds up.
    expect(within(gmail).queryByText("Doesn’t add up")).toBeNull();
    expect(within(card("Kingsley Apple usage")).getByText("Claude · Max · default")).toBeTruthy();
    expect(within(card("Kingsley Apple usage")).getAllByRole("listitem")[1]!.textContent).toBe(`devbox · no sessions now` + `read 2% ${dayClock(at(2 * DAY + 60), NOW)}`);
    expect(screen.queryByRole("region", { name: "Not matched to an account yet" })).toBeNull();
  });

  it("give a machine's account none of this computer's is a card of its own", () => {
    accountsOn("devbox").setState({ accounts: [account("m-w", "Work", "dev-work")] });
    places({ devbox: usage({ logins: [], readings: [reading([gmailWeek(40)], { account: "dev-work" })] }) });
    render(<PlanCards />);
    expect(within(card("Work on devbox usage")).getByText("40%")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Not matched to an account yet" })).toBeNull();
  });

  it("put a hub's reading of an account only a machine has on that machine's card", () => {
    accountsOn("devbox").setState({ accounts: [account("m-w", "Work", "dev-work")] });
    places({
      devbox: usage({ logins: [], readings: [reading([gmailWeek(40)], { account: "dev-work", observedAt: at(9) })] }),
      dw: usage({ logins: [], readings: [reading([gmailWeek(41)], { account: "dev-work", where: "hub", observedAt: at(2) })] }),
    });
    render(<PlanCards />);
    const work = card("Work on devbox usage");
    expect(within(work).getAllByRole("listitem").map((li) => li.textContent?.split("·")[0]?.trim().replace(/read.*$/, ""))).toEqual(["devbox", "Driftwerk hub"]);
    expect(screen.queryByRole("region", { name: "Not matched to an account yet" })).toBeNull();
  });

  it("match a hub's place that names an account: ChatGPT's, by its account", () => {
    places({
      local: usage({ readings: [reading([gmailWeek(4)], { kind: "chatgpt", account: "gpt-1", plan: "prolite", observedAt: at(5) })] }),
      dw: usage({ logins: [], readings: [reading([gmailWeek(9)], { kind: "chatgpt", account: "gpt-1", where: "hub", plan: "prolite", observedAt: at(1) })] }),
    });
    render(<PlanCards />);
    const gpt = card("ChatGPT on this computer usage");
    expect(within(gpt).getByText("9%")).toBeTruthy();
    expect(within(gpt).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      `This computer` + `read 4% at ${clock(at(5))}`,
      `Driftwerk hub` + `reads 9% at ${clock(at(1))}`,
    ]);
    // Matched by what it said, not by the person: nothing to unlink.
    expect(within(gpt).queryByRole("button", { name: /^Unlink/ })).toBeNull();
  });

  it("ask which account a hub's Claude login is, and keep the answer in Desk's store", () => {
    const dwClaude = reading([appleWeek(13)], { account: null, login: "dw-login", where: "hub", observedAt: at(3) });
    places({
      local: usage({ readings: [reading([appleWeek(16)], { account: "apple", observedAt: at(30) })] }),
      dw: usage({ logins: [], readings: [dwClaude] }),
    });
    render(<PlanCards />);
    const unmatched = screen.getByRole("region", { name: "Not matched to an account yet" });
    expect(within(unmatched).getByRole("button", { name: "Not matched to an account yet · 1" }).getAttribute("aria-expanded")).toBe("true");
    const row = within(unmatched).getByRole("row", { name: /Driftwerk hub · Claude/ });
    expect(within(row).getByText(`13% · resets ${dayClock(later(DAY - 30), NOW)}`)).toBeTruthy();
    const pick = within(row).getByRole("combobox", { name: "Driftwerk hub Claude account" });
    expect([...(pick as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Choose…", "Kingsley Apple", "Kingsley Gmail", "Another account", "Don’t ask"]);
    act(() => void fireEvent.change(pick, { target: { value: "claude:apple" } }));
    expect(screen.queryByRole("region", { name: "Not matched to an account yet" })).toBeNull();
    expect(deskState.get(PLANS_KEY)).toMatchObject({ links: { "claude@dw:dw-login": { account: "claude:apple" } } });
    const apple = card("Kingsley Apple usage");
    expect(within(apple).getAllByRole("listitem")[1]!.textContent).toBe(`Driftwerk hub` + `reads 13% at ${clock(at(3))} · Unlink`);
    // 13% after 16% of the same week: can't be the same account.
    expect(within(apple).getByText("Doesn’t add up")).toBeTruthy();
    act(() => void fireEvent.click(within(apple).getByRole("button", { name: "Unlink Driftwerk hub" })));
    expect(screen.getByRole("region", { name: "Not matched to an account yet" })).toBeTruthy();
    expect(within(card("Kingsley Apple usage")).queryByText("Doesn’t add up")).toBeNull();
  });

  it("make another account's card, named by the person", () => {
    places({ dw: usage({ logins: [], readings: [reading([gmailWeek(0)], { account: null, login: "pw", where: "hub" })] }) });
    render(<PlanCards />);
    act(() => void fireEvent.change(screen.getByRole("combobox", { name: "Driftwerk hub Claude account" }), { target: { value: ":other" } }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Name the account/ }), { target: { value: "Team plan" } });
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Make its card" })));
    expect(within(card("Team plan usage")).getByText("Driftwerk hub")).toBeTruthy();
  });

  it("hide a place on Don't ask, until Settings shows it again", () => {
    places({ dw: usage({ logins: [], readings: [reading([gmailWeek(5)], { account: null, login: "pw", where: "hub" })] }) });
    render(<PlanCards />);
    act(() => void fireEvent.change(screen.getByRole("combobox", { name: "Driftwerk hub Claude account" }), { target: { value: ":hide" } }));
    expect(screen.queryByRole("region", { name: "Not matched to an account yet" })).toBeNull();
    cleanup();
    render(<Plans />);
    act(() => void fireEvent.click(within(screen.getByText("Driftwerk hub · Claude, Max").closest(".hub-row") as HTMLElement).getByRole("button", { name: "Show again" })));
    expect(screen.getByText("None.")).toBeTruthy();
    cleanup();
    render(<PlanCards />);
    expect(screen.getByRole("region", { name: "Not matched to an account yet" })).toBeTruthy();
  });

  it("fold Not matched to one line, and remember it", () => {
    places({ dw: usage({ logins: [], readings: [reading([gmailWeek(5)], { account: null, login: "pw", where: "hub" })] }) });
    render(<PlanCards />);
    act(() => void fireEvent.click(screen.getByRole("button", { name: /^Not matched/ })));
    expect(screen.getByText(/^1 place not matched/)).toBeTruthy();
    expect(deskState.get(PLANS_KEY)).toMatchObject({ folded: true });
    cleanup();
    render(<PlanCards />);
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Show" })));
    expect(screen.getByRole("region", { name: "Not matched to an account yet" })).toBeTruthy();
  });
});
