import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { PlanReading, UsageView } from "../hub/types";
import { startLogin } from "../platform";
import { PlanCards } from "./PlanCards";
import { useFloor } from "./store";
import { NOW, at, hub, ready, view } from "./testing";
import { clock } from "./time";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
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
});

describe("the plan cards", () => {
  it("show each window's use, reset and pace, with the plan and where", () => {
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
    const claude = card("Claude plan usage");
    expect(within(claude).getByText("Max · this computer")).toBeTruthy();
    expect(within(claude).getByText(`as of ${clock(at(1))}`)).toBeTruthy();
    expect(within(claude).getByText("40%").className).toBe("plan-ok");
    expect(within(claude).getByText(`resets ${clock(later(148))} · in 2h 28m`)).toBeTruthy();
    expect(within(claude).getByText(/^resets [A-Z][a-z]{2} /)).toBeTruthy();
    const [five, week] = within(claude).getAllByRole("img");
    expect(five!.getAttribute("aria-label")).toBe(`40 percent of the 5-hour window used; resets ${clock(later(148))}`);
    expect(week!.getAttribute("aria-label")).toMatch(/^38 percent of the weekly limit used; resets /);
    expect(five!.querySelector(".plan-pace")!.getAttribute("title")).toBe("Where you’d be at an even pace");
  });

  it("warn near the limit with when it runs out, and say plainly at it", () => {
    show(
      usage({
        readings: [
          reading([
            { usedPercent: 92, resetsAt: later(60), minutes: 300 },
            { usedPercent: 100, resetsAt: later(300), minutes: 10_080 },
          ]),
        ],
      }),
    );
    render(<PlanCards />);
    const claude = card("Claude plan usage");
    expect(within(claude).getByText("92%").className).toBe("plan-full");
    const hits = NOW + 8 / (92 / (240 * MIN));
    expect(
      within(claude).getByText(
        `At this pace you reach the limit about ${clock(hits)}, ${Math.round((NOW + 60 * MIN - hits) / MIN)} minutes before it resets.`,
      ),
    ).toBeTruthy();
    expect(within(claude).getAllByRole("img")[0]!.getAttribute("aria-label")).toContain(`at this pace it runs out about ${clock(hits)}`);
    expect(within(claude).getByText(/^At the limit\. It resets at .+\.$/)).toBeTruthy();
  });

  it("colour a window by the percent they show", () => {
    show(usage({ readings: [reading([{ usedPercent: 89.6, resetsAt: later(60), minutes: 300 }])] }));
    render(<PlanCards />);
    const shown = within(card("Claude plan usage")).getByText("90%");
    expect(shown.className).toBe("plan-full");
  });

  it("show a window that resets while shown as reset, without reading again", async () => {
    show(usage({ readings: [reading([{ usedPercent: 70, resetsAt: later(2), minutes: 300 }])] }));
    render(<PlanCards />);
    expect(within(card("Claude plan usage")).getByText("70%")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3 * MIN));
    expect(within(card("Claude plan usage")).getByText("0%")).toBeTruthy();
    expect(within(card("Claude plan usage")).getByText(`Reset at ${clock(later(2))} · no use seen since.`)).toBeTruthy();
  });

  it("wait for a first reading on a plan signed in", () => {
    show(usage({}));
    render(<PlanCards />);
    expect(within(card("ChatGPT plan usage")).getByText("No reading yet. It shows after Codex next answers on this plan.")).toBeTruthy();
  });

  it("offer sign-in on this computer when no plan of a kind is, and nothing for a remote hub", async () => {
    show(usage({ logins: [] }));
    render(<PlanCards />);
    const claude = card("Claude plan usage");
    expect(within(claude).getByText("Not signed in on this computer, so there’s no usage to show.")).toBeTruthy();
    await act(async () => fireEvent.click(within(claude).getByRole("button", { name: "Sign in to Claude" })));
    expect(startLogin).toHaveBeenCalledWith("claude");
    expect(within(card("ChatGPT plan usage")).getByRole("button", { name: "Sign in to ChatGPT" })).toBeTruthy();
    cleanup();
    show(usage({ logins: [] }), "b");
    render(<PlanCards />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});
