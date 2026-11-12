import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  helper: { state: "not-registered" } as { state: string },
  started: 0,
}));
vi.mock("../platform", async (real) => ({
  ...(await real<typeof import("../platform")>()),
  helperStatus: vi.fn(async () => platform.helper),
  startHelper: vi.fn(async () => {
    platform.started += 1;
    platform.helper = { state: "running" };
    return platform.helper;
  }),
  openLoginItems: vi.fn(async () => undefined),
  saveSettings: vi.fn(async () => undefined),
  cliInstalled: vi.fn(async () => true),
  onInstallProgress: vi.fn(() => Promise.resolve(() => {})),
  onLoginProgress: vi.fn(() => Promise.resolve(() => {})),
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(() => Promise.resolve(() => {})),
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useMachines } = await import("../hub/engines");
const { useOverview } = await import("../overview/store");
const { NO_SETUP, useSettings } = await import("../settings/store");
const { useUi } = await import("../shell/ui");
const { SetupGuide, helpText } = await import("./SetupGuide");
const { SetupLauncher, SetupOnFloor } = await import("./SetupLauncher");
const { leftOf, useFacts, watchFacts } = await import("./steps");
const { laterSetup } = await import("../settings/store");
const { SetupInDm, useSetupViews } = await import("./slot");
const { searchSections } = await import("../settings/search");

const desk = {
  hubId: "local",
  id: "desk",
  name: "Desk",
  model: null,
  provider: null,
  isDefault: true,
};
const scout = {
  hubId: "local",
  id: "scout",
  name: "Scout",
  model: null,
  provider: null,
  isDefault: false,
};

const sent: [string, string][] = [];
beforeEach(() => {
  sent.length = 0;
  platform.helper = { state: "not-registered" };
  platform.started = 0;
  useChat.setState({
    hubs: [
      {
        id: "local",
        label: "This computer",
        url: "http://127.0.0.1:1",
        local: true,
        revision: "t",
      },
    ],
    roster: [scout, desk],
    rosterRead: true,
    panelAgent: null,
    send: (key: string, text: string) => {
      sent.push([key, text]);
      return true;
    },
  } as never);
  useDesk.setState({
    hub: {
      providers: vi.fn(async () => [{ id: "claude-code", connected: false }]),
      manager: vi.fn(async () => ({ agentId: null, level: null })),
    } as never,
    sessions: {},
  });
  useOverview.setState({
    manager: { agentId: null, level: null },
    managerSupport: "yes",
  });
  useMachines.setState({ machines: [], listed: true });
  useFacts.setState({ plan: null, helper: null, connections: null });
  useSettings.setState({ loaded: true, setup: NO_SETUP });
});
afterEach(cleanup);

describe("first-run setup", () => {
  it("on an update for someone already set up, is marked offered quietly and doesn't open", async () => {
    useDesk.setState({
      hub: {
        providers: vi.fn(async () => [{ id: "claude-code", connected: true }]),
      } as never,
    });
    render(<SetupLauncher />);
    await waitFor(() =>
      expect(useSettings.getState().setup).toMatchObject({
        started: true,
        closed: true,
      }),
    );
    expect(useChat.getState().panelAgent).toBeNull();
    cleanup();
    // Sessions alone say so too.
    useSettings.setState({ setup: NO_SETUP });
    useDesk.setState({
      hub: { providers: vi.fn(async () => []) } as never,
      sessions: { s1: { id: "s1" } as never },
    });
    render(<SetupLauncher />);
    await waitFor(() =>
      expect(useSettings.getState().setup).toMatchObject({
        started: true,
        closed: true,
      }),
    );
    expect(useChat.getState().panelAgent).toBeNull();
  });

  it("opens once, by itself, in Desk's own agent's DM on a first run, and isn't opened again", async () => {
    render(<SetupLauncher />);
    await waitFor(() =>
      expect(useSettings.getState().setup).toMatchObject({
        started: true,
        closed: false,
      }),
    );
    expect(useChat.getState().panelAgent).toBe("local/desk");
    useChat.setState({ panelAgent: null });
    useSettings.getState().set({ setup: { started: true, closed: true, skipped: [] } });
    cleanup();
    render(<SetupLauncher />);
    await new Promise((r) => setTimeout(r, 10));
    expect(useChat.getState().panelAgent).toBeNull();
  });

  it("says each step as Desk's agent, ticks what's done, and each card does its step", async () => {
    render(<SetupGuide agent={desk} />);
    expect(screen.getByText(/Hi, I’m Desk\. Let’s get Desk ready/)).toBeTruthy();
    const helper = await screen.findByRole("listitem", {
      name: "Keep Desk's helper running",
    });
    await act(async () => fireEvent.click(within(helper).getByRole("button", { name: "Start it" })));
    expect(platform.started).toBe(1);
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "Keep Desk's helper running" })).getByText("Done")).toBeTruthy());
    // The plan's card signs in; another way is a key.
    const plan = screen.getByRole("listitem", { name: "Sign in to a plan" });
    expect(within(plan).getByRole("button", { name: "Sign in to Claude" })).toBeTruthy();
    expect(within(plan).getByRole("button", { name: "Sign in to ChatGPT" })).toBeTruthy();
    // The overseer's card is #175's, there to pick from.
    expect(within(screen.getByRole("listitem", { name: "Pick who oversees your crew" })).getByRole("radiogroup")).toBeTruthy();
    // Others open where they're done.
    fireEvent.click(screen.getByRole("button", { name: "Add a machine" }));
    expect(useUi.getState().settings).toBe("machines");
    fireEvent.click(screen.getByRole("button", { name: "Pair a workspace" }));
    expect(useUi.getState().settings).toBe("hubs");
    // Desk's agent is asked to connect services, and to help with the rest.
    fireEvent.click(screen.getByRole("button", { name: "Ask Desk to connect one" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Desk to help with the rest" }));
    expect(sent.map(([k]) => k)).toEqual(["local/desk", "local/desk"]);
    expect(sent[1]![1]).toContain("Sign in to a plan");
    expect(sent[1]![1]).not.toContain("Keep Desk's helper running");
  });

  it("is skippable, step by step and as a whole, and picks up where it was", async () => {
    render(<SetupGuide agent={desk} />);
    const machines = screen.getByRole("listitem", { name: "Add a machine" });
    fireEvent.click(within(machines).getByRole("button", { name: "Skip" }));
    expect(useSettings.getState().setup.skipped).toEqual(["machines"]);
    expect(within(screen.getByRole("listitem", { name: "Add a machine" })).getByText(/Skipped/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("listitem", { name: "Add a machine" })).getByRole("button", { name: "Do it now" }));
    expect(useSettings.getState().setup.skipped).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    expect(useSettings.getState().setup).toMatchObject({
      started: true,
      closed: true,
    });
  });

  it("shows in Desk's agent's DM and on the Floor only once the main window put it there", () => {
    useSettings.getState().set({ setup: { started: true, closed: false, skipped: [] } });
    useSetupViews.setState({ inDm: null, onFloor: null });
    const { unmount } = render(<SetupInDm agent={desk} />);
    expect(screen.queryByRole("article", { name: "Set up Desk" })).toBeNull();
    unmount();
    render(<SetupLauncher />);
    render(<SetupInDm agent={scout} />);
    expect(screen.queryByRole("article", { name: "Set up Desk" })).toBeNull();
    render(<SetupInDm agent={desk} />);
    expect(screen.getByRole("article", { name: "Set up Desk" })).toBeTruthy();
  });

  it("on the Floor, says it in full without an agent, else offers to go back to it", () => {
    useSettings.getState().set({ setup: { started: true, closed: false, skipped: [] } });
    const { unmount } = render(<SetupOnFloor />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Desk" }));
    expect(useChat.getState().panelAgent).toBe("local/desk");
    unmount();
    useChat.setState({ roster: [] });
    render(<SetupOnFloor />);
    expect(screen.getByRole("article", { name: "Set up Desk" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ask .* to help/ })).toBeNull();
  });

  it("leaves out what's done and skipped, and asks for the rest in plain words", () => {
    const steps = {
      plan: "done",
      helper: "todo",
      overseer: "unknown",
      connections: "todo",
      workspaces: "todo",
      machines: "todo",
    } as const;
    expect(leftOf(steps, ["machines"])).toEqual(["helper", "overseer", "connections", "workspaces"]);
    expect(helpText(["plan"])).toMatch(/^Help me finish setting up Desk/);
    const both = helpText(["plan"], ["machines"]);
    expect(both).toContain("I skipped these for now:\n- Add a machine");
    expect(helpText(["plan"])).not.toContain("skipped");
  });
});

describe("keeping the setup's progress", () => {
  it("keeps the later of two windows' setups, never rolling one back", () => {
    const older = {
      started: true,
      closed: false,
      skipped: [],
      at: "2026-11-12T08:00:00.000Z",
    };
    const newer = {
      started: true,
      closed: true,
      skipped: ["machines"],
      at: "2026-11-12T09:00:00.000Z",
    };
    expect(laterSetup(older, newer)).toBe(newer);
    expect(laterSetup(newer, older)).toBe(newer);
    expect(laterSetup(older, undefined)).toBe(older);
    expect(laterSetup(NO_SETUP, newer)).toBe(newer);
  });

  it("reads again on one timer however many watch, skips while hidden, and stops when none do", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => undefined);
    useFacts.setState({ read });
    const stopA = watchFacts();
    const stopB = watchFacts();
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    stopA();
    stopB();
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("offers a new crew member when there's no one to oversee", () => {
    useChat.setState({ roster: [] });
    render(<SetupGuide />);
    fireEvent.click(within(screen.getByRole("listitem", { name: "Pick who oversees your crew" })).getByRole("button", { name: "New crew member" }));
    expect(useUi.getState().newCrew).toBe(true);
  });
});

describe("Settings search", () => {
  it("finds a section by its name, then by what's in it", () => {
    expect(searchSections("")).toHaveLength(16);
    expect(searchSections("calls")[0]).toBe("voices");
    expect(searchSections("machines")[0]).toBe("machines");
    expect(searchSections("github")).toEqual(["connections"]);
    expect(searchSections("api key")[0]).toBe("providers");
    expect(searchSections("set up")).toEqual(["help"]);
    expect(searchSections("zzz")).toEqual([]);
  });
});
