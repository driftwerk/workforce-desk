import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent, HubAccount } from "../chat/types";
import { useOverview } from "../overview/store";
import { BossSheet } from "./BossSheet";
import { BossOfAGroup } from "../crew/BossOfAGroup";
import { AgentSettings, MainWindowParts } from "../crew/AgentSettings";
import { MAIN_WINDOW_PARTS } from "../crew/mainWindow";
import { useGrantBosses } from "../crew/grantBoss";
import { useSettings } from "../settings/store";
import { useHubLayout } from "./hubLayout";
import { fullLine, notInForce, type BossChoice, type BossEngine, type RemoteBoss } from "./remoteBoss";

const calls = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../platform", async (original) => ({ ...(await original<typeof import("../platform")>()), invoke: calls.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const HUBS: HubAccount[] = [
  { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "r" },
  { id: "driftwerk", label: "Driftwerk", url: "https://driftwerk.example", local: false, revision: "r" },
  { id: "atlas", label: "Atlas", url: "https://atlas.example", local: false, revision: "r" },
  { id: "machine:devbox", label: "devbox", url: "http://devbox", local: false, machine: "devbox", revision: "r" },
];
const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });
const ROSTER = [agent("local", "desk", "Desk"), agent("local", "sarah", "Sarah"), agent("driftwerk", "allan", "Allan"), agent("atlas", "ada", "Ada")];

const engine = (id: string, name: string, sessions: number, over: Partial<BossEngine> = {}): BossEngine => ({
  engine: id,
  name,
  linked: true,
  sessions,
  live: true,
  why: null,
  enginePaused: false,
  stopped: false,
  expiresAt: "2026-12-14T00:00:00Z",
  reachedAt: null,
  problem: null,
  belowFull: [],
  spentTodayUsd: null,
  ...over,
});

const FULL: BossChoice = { level: "full", sees: "replies", budgetUsdPerDay: 40 };
const linked = (choice: BossChoice, over: Partial<RemoteBoss> = {}): RemoteBoss => ({
  hub: "driftwerk",
  hubLabel: "Driftwerk",
  agent: "allan",
  party: "driftwerk/allan",
  choice,
  paused: false,
  pausing: false,
  stopping: false,
  waiting: 0,
  spentTodayUsd: null,
  engines: [engine("local", "this computer", 2), engine("devbox", "devbox", 4)],
  ...over,
});

let status: RemoteBoss | null = null;
const answers = (cmd: string, args?: Record<string, unknown>): unknown => {
  switch (cmd) {
    case "boss_status":
      return status;
    case "boss_offer":
      return args?.hub === "atlas" ? { kind: "not", why: "Atlas doesn’t take bosses from Desk yet: its admin turns it on." } : { kind: "takes" };
    case "boss_link":
    case "boss_set":
    case "boss_pause":
    case "boss_unlink":
    case "boss_retry":
    case "boss_unpause_engine":
      return { cancelled: false, done: ["devbox"], failed: [] };
    default:
      return undefined;
  }
};

beforeEach(() => {
  status = null;
  calls.invoke.mockReset();
  calls.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => answers(cmd, args));
  useChat.setState({ hubs: HUBS, roster: ROSTER });
  useOverview.setState({ manager: { agentId: "desk", level: "act", bosses: [] } });
  useHubLayout.setState({ layout: { groups: [{ id: "acme", name: "Acme", collapsed: false, items: [] }], ungrouped: { collapsed: false, items: [] } }, kept: true });
});
afterEach(cleanup);

const open = async () => {
  render(<BossSheet group="acme" onClose={() => {}} />);
  await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_status", { group: "acme" }));
};

describe("a group's Boss sheet", () => {

  it("calls the main boss by its name once it is renamed", async () => {
    useChat.setState({ roster: [agent("local", "desk", "Kat"), ...ROSTER.slice(1)] });
    useOverview.setState({ manager: { agentId: "desk", level: "act", bosses: [{ agentId: "sarah", name: "Sarah", group: "acme", level: "act" }] } });
    await open();
    const main = await screen.findByRole("radio", { name: /Kat/ });
    expect(main.closest("label")!.textContent).toContain("The main boss");
    expect(screen.queryByRole("radio", { name: /^Desk/ })).toBeNull();
    fireEvent.click(main);
    expect(await screen.findByRole("button", { name: "Give it back to Kat" })).toBeTruthy();
  });
  it("offers the agents of paired team hubs, and says plainly why a hub offers none", async () => {
    await open();
    expect(await screen.findByText("Allan")).toBeTruthy();
    expect(screen.getByText("On Driftwerk, another hub")).toBeTruthy();
    expect(await screen.findByText("Atlas doesn’t take bosses from Desk yet: its admin turns it on.")).toBeTruthy();
    // A machine's hub is never asked: its agents aren't bosses.
    expect(calls.invoke).not.toHaveBeenCalledWith("boss_offer", { hub: "machine:devbox" });
    expect(screen.queryByText("Ada")).toBeNull();
  });

  it("makes Allan the boss through the native side, sending ids and choices only", async () => {
    await open();
    fireEvent.click(await screen.findByLabelText(/Allan/));
    fireEvent.click(screen.getByRole("button", { name: "Make Allan Acme’s boss" }));
    await waitFor(() =>
      expect(calls.invoke).toHaveBeenCalledWith("boss_link", {
        group: "acme",
        hub: "driftwerk",
        agent: "allan",
        choice: { level: "suggest", sees: "replies", budgetUsdPerDay: null },
      }),
    );
  });

  it("opens Act fully's own sheet, with exactly one line on what still holds", async () => {
    status = linked({ level: "act", sees: "replies", budgetUsdPerDay: null });
    await open();
    fireEvent.click(await screen.findByRole("radio", { name: /Act fully/ }));
    const sheet = await screen.findByRole("dialog", { name: "Let Allan act fully in Acme?" });
    expect(within(sheet).getAllByText(fullLine("Allan"))).toHaveLength(1);
    expect(sheet.querySelectorAll(".oversee-never")).toHaveLength(1);
    // Pause and Stop stay in the Boss sheet's footer until Act fully is in force.
    expect(within(sheet).queryByRole("button", { name: "Pause Allan" })).toBeNull();
    // A budget is needed; Status can't be picked.
    const turnOn = within(sheet).getByRole("button", { name: "Turn on Act fully" }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    expect(within(sheet).getByRole("radio", { name: "Status" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(within(sheet).getByLabelText("Daily budget in US dollars"), { target: { value: "40" } });
    fireEvent.click(turnOn);
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_set", { group: "acme", choice: FULL }));
  });

  it("pauses and stops from the sheet", async () => {
    status = linked({ level: "suggest", sees: "replies", budgetUsdPerDay: null });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Pause Allan" }));
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_pause", { group: "acme" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Allan" }));
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_unlink", { group: "acme" }));
  });

  it("says where Allan is linked", async () => {
    status = linked({ level: "suggest", sees: "replies", budgetUsdPerDay: null });
    await open();
    expect(await screen.findByText("This Mac")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Try .* again/ })).toBeNull();
    expect(screen.getAllByText(/linked until/)).toHaveLength(2);
    await act(async () => {});
  });
});

describe("what the sheet offers as the boss stands", () => {
  it("offers Try again on an engine not linked, and letting an engine's own pause go", async () => {
    status = linked({ level: "suggest", sees: "replies", budgetUsdPerDay: null });
    status.engines[1] = engine("devbox", "devbox", 4, { linked: false, expiresAt: null, problem: "devbox can't be reached now." });
    status.engines[0] = { ...status.engines[0]!, enginePaused: true };
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Try devbox again" }));
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_retry", { group: "acme" }));
    fireEvent.click(screen.getByRole("button", { name: "Let This Mac’s bosses go on" }));
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_unpause_engine", { group: "acme", engine: "local" }));
  });

  it("says sessions wait on the person, and asks natively to let the boss run them", async () => {
    status = { ...linked({ level: "act", sees: "replies", budgetUsdPerDay: null }), waiting: 2 };
    await open();
    expect(await screen.findByText("2 sessions wait for you.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Let Allan run them" }));
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_set", { group: "acme", choice: { level: "act", sees: "replies", budgetUsdPerDay: null } }));
  });

  it("marks the Sees chosen, and keeps Status out of reach at Act fully", async () => {
    status = linked(FULL);
    await open();
    const replies = await screen.findByRole("radio", { name: "Status and replies" });
    expect(replies.classList.contains("on")).toBe(true);
    expect(screen.getByRole("radio", { name: "Status" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("offers Let Allan go on and Stop in the Act fully sheet while it is paused", async () => {
    status = linked(FULL, { paused: true });
    await open();
    fireEvent.click(await screen.findByRole("radio", { name: /Act fully/ }));
    const sheet = await screen.findByRole("dialog", { name: "Allan acts fully in Acme" });
    expect(within(sheet).getByRole("button", { name: "Let Allan go on" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Stop Allan" })).toBeTruthy();
  });

  it("says what Allan spent today at Act fully, and not known when an engine didn't say", async () => {
    status = linked(FULL, { spentTodayUsd: 12.5 });
    await open();
    expect(await screen.findByText(/\$40\.00 a day · Spent today: \$12\.50/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Act fully/ }));
    const sheet = await screen.findByRole("dialog", { name: "Allan acts fully in Acme" });
    expect(within(sheet).getByText("Spent today: $12.50 of $40.00")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Pause Allan" })).toBeTruthy();
    cleanup();
    status = linked(FULL);
    await open();
    expect(await screen.findByText(/Spent today: not known/)).toBeTruthy();
  });

  it("keeps Pause on offer until every engine has it, and Stop until it's clear", async () => {
    status = { ...linked({ level: "suggest", sees: "replies", budgetUsdPerDay: null }), paused: false, pausing: true };
    await open();
    expect(await screen.findByRole("button", { name: "Pause Allan again" })).toBeTruthy();
    cleanup();
    status = { ...linked({ level: "suggest", sees: "replies", budgetUsdPerDay: null }), paused: true, stopping: true };
    await open();
    expect(await screen.findByRole("button", { name: "Stop Allan again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Let Allan go on" })).toBeNull();
  });

  it("opens Act fully from the keyboard, and moves Sees by arrows past what it can't be", async () => {
    status = linked({ level: "act", sees: "replies", budgetUsdPerDay: null });
    await open();
    const act = await screen.findByRole("radio", { name: /Act within Desk/ });
    act.focus();
    fireEvent.keyDown(act, { key: "ArrowRight" });
    const sheet = await screen.findByRole("dialog", { name: "Let Allan act fully in Acme?" });
    const replies = within(sheet).getByRole("radio", { name: "Status and replies" });
    expect(replies.getAttribute("aria-checked")).toBe("true");
    expect(replies.hasAttribute("aria-pressed")).toBe(false);
    fireEvent.keyDown(replies, { key: "ArrowRight" });
    expect(within(sheet).getByRole("radio", { name: "Everything" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(within(sheet).getByRole("radio", { name: "Everything" }), { key: "ArrowRight" });
    // Past Status, which Act fully can't be.
    expect(within(sheet).getByRole("radio", { name: "Status and replies" }).getAttribute("aria-checked")).toBe("true");
  });

  it("offers another hub's agent in place of the boss there is, through one native question", async () => {
    status = linked({ level: "suggest", sees: "replies", budgetUsdPerDay: null });
    useChat.setState({ hubs: HUBS, roster: [...ROSTER, agent("driftwerk", "bea", "Bea")] });
    await open();
    fireEvent.click(await screen.findByLabelText(/Bea/));
    fireEvent.click(screen.getByRole("button", { name: "Make Bea Acme’s boss" }));
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_link", expect.objectContaining({ agent: "bea" })));
    expect(calls.invoke).not.toHaveBeenCalledWith("boss_unlink", expect.anything());
  });
});

describe("making an agent on a paired hub a group's boss from their settings", () => {
  beforeEach(() => useGrantBosses.setState({ byGroup: {}, bossed: {}, named: {}, readAt: {} }));

  it("picks the group, then opens its Boss sheet with them picked, to make them its boss there", async () => {
    render(<BossOfAGroup agent={ROSTER[2]!} hub={HUBS[1]!} />);
    fireEvent.click(screen.getByRole("button", { name: "Make Allan a group’s boss…" }));
    const menu = screen.getByRole("menu", { name: "Which group Allan runs" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Acme", "New group for Allan"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Acme" }));
    const sheet = await screen.findByRole("dialog", { name: "Acme · Boss" });
    // Picked once Driftwerk says it offers bosses.
    await waitFor(() => expect((within(sheet).getByRole("radio", { name: /^Allan/ }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(within(sheet).getByRole("button", { name: "Make Allan Acme’s boss" }));
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("boss_link", expect.objectContaining({ group: "acme", hub: "driftwerk", agent: "allan" })));
  });

  it("says which groups they run already", async () => {
    status = linked({ level: "suggest", sees: "replies", budgetUsdPerDay: null });
    render(<BossOfAGroup agent={ROSTER[2]!} hub={HUBS[1]!} />);
    expect(await screen.findByText("Allan runs Acme, from Driftwerk.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make Allan a group’s boss…" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Acme · runs it", "New group for Allan"]);
  });

  it("never picks an agent whose hub offers no bosses, and offers no Make for them", async () => {
    render(<BossSheet group="acme" preselect={ROSTER[3]!} onClose={() => {}} />);
    expect(await screen.findByText("Atlas doesn’t take bosses from Desk yet: its admin turns it on.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Make / })).toBeNull();
    expect(screen.getAllByRole("radio", { checked: true }).map((r) => r.getAttribute("aria-label") ?? r.closest("label")!.textContent)).toEqual([expect.stringMatching(/Desk/)]);
  });

  it("is offered in the main window's agent settings, and never in a grid window's", () => {
    const settings = <AgentSettings agent={ROSTER[2]!} hub={HUBS[1]!} onOpenFiles={() => {}} />;
    // A grid's own window: no main-window parts handed down.
    const { unmount } = render(settings);
    expect(screen.queryByRole("button", { name: /a group’s boss/ })).toBeNull();
    unmount();
    render(<MainWindowParts.Provider value={MAIN_WINDOW_PARTS}>{settings}</MainWindowParts.Provider>);
    expect(screen.getByRole("button", { name: "Make Allan a group’s boss…" })).toBeTruthy();
    // Handed down by the main window's shell alone, never set on import.
    const importers = Object.entries(import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>)
      .filter(([f, text]) => !f.includes(".test.") && /crew\/mainWindow"/.test(text))
      .map(([f]) => f);
    expect(importers).toEqual(["../shell/App.tsx"]);
  });

  it("makes a group for them when the person has none", async () => {
    useHubLayout.setState({ layout: null, kept: false });
    useSettings.setState({ groups: [], ungrouped: { collapsed: false, items: [] } } as never);
    render(<BossOfAGroup agent={ROSTER[2]!} hub={HUBS[1]!} />);
    fireEvent.click(screen.getByRole("button", { name: "Make Allan a group’s boss…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New group for Allan" }));
    expect(await screen.findByRole("dialog", { name: "Allan’s group · Boss" })).toBeTruthy();
    expect(useSettings.getState().groups.map((g) => g.name)).toEqual(["Allan’s group"]);
  });
});

describe("why Act fully isn't in force", () => {
  it("is said in plain words, the hub's own where it has them", () => {
    expect(notInForce(null, { ...FULL, budgetUsdPerDay: null }, "Allan")).toBe("Act fully needs a daily budget for Allan.");
    expect(notInForce(null, { ...FULL, sees: "status" }, "Allan")).toBe("Act fully needs Allan to see replies.");
    expect(notInForce(linked(FULL), FULL, "Allan")).toBeNull();
    expect(notInForce(linked(FULL, { paused: true }), FULL, "Allan")).toMatch(/paused/);
    const stopped = linked(FULL);
    stopped.engines[1] = { ...stopped.engines[1]!, live: false, why: "Acme's boss was stopped on this machine." };
    expect(notInForce(stopped, FULL, "Allan")).toBe("Acme's boss was stopped on this machine.");
    const other = linked(FULL);
    other.engines[0] = { ...other.engines[0]!, belowFull: ["Atlas (Suggest)"] };
    expect(notInForce(other, FULL, "Allan")).toMatch(/also runs Atlas \(Suggest\) on this computer/);
    expect(notInForce(linked(FULL), FULL, "Allan", ["Allan isn't connected, so this is yours."])).toBe("Allan isn't connected, so this is yours.");
    expect(notInForce(linked(FULL), { ...FULL, level: "act" }, "Allan")).toBeNull();
  });

  it("the line is the one agreed", () => {
    expect(fullLine("Allan")).toBe("Once Allan allows a request, Desk’s ship and irreversible checks no longer apply; its hold, breaker and agent-settings checks still do.");
  });
});
