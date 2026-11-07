import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { Manager } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { openTarget } from "../shell/navigate";
import { asksBeforeOverseeing, bossOfGroup, deleteAsk, groupDot, groupOfBoss, isSealed, overseeAsk, overseeChoices, overseeGroup, overseeSaid, stopOverseeing } from "./bosses";
import { oversightHub } from "./testing";
import { GroupChip } from "./GroupChip";
import { EMPTY_LAYOUT, type DeskGroup } from "./model";
import { SidebarGroups } from "./SidebarGroups";
import { useHubLayout } from "./hubLayout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("../shell/navigate", async (actual) => ({ ...(await actual<typeof import("../shell/navigate")>()), openTarget: vi.fn() }));

const SARAH = { agentId: "sarah", name: "Sarah", group: "acme", level: "act" } as const;
const MAIN: Manager = { agentId: "desk", level: "act", bosses: [SARAH] };

describe("who oversees a group", () => {
  it("is read from the hub's bosses, and an older hub says none", () => {
    expect(bossOfGroup(MAIN, "acme")).toEqual(SARAH);
    expect(bossOfGroup(MAIN, "globex")).toBeNull();
    expect(groupOfBoss(MAIN, "sarah")).toBe("acme");
    expect(groupOfBoss(MAIN, "desk")).toBeNull();
    expect(bossOfGroup({ agentId: "desk", level: "act" }, "acme")).toBeNull();
    expect(bossOfGroup(null, "acme")).toBeNull();
  });

  it("is offered only to this computer's agents in a group, never to the main overseer or on an older hub", () => {
    const local = (id: string) => ({ id, local: true });
    expect(overseeChoices(MAIN, local("mia"), "globex")).toEqual({ oversee: true, stop: false });
    expect(overseeChoices(MAIN, local("sarah"), "acme")).toEqual({ oversee: false, stop: true });
    // A boss moved into another group can oversee that one instead.
    expect(overseeChoices(MAIN, local("sarah"), "globex")).toEqual({ oversee: true, stop: true });
    expect(overseeChoices(MAIN, local("mia"), "ungrouped")).toEqual({ oversee: false, stop: false });
    expect(overseeChoices(MAIN, local("desk"), "globex")).toEqual({ oversee: false, stop: false });
    expect(overseeChoices(MAIN, { id: "ada", local: false }, "globex")).toEqual({ oversee: false, stop: false });
    expect(overseeChoices({ agentId: "desk", level: "act" }, local("mia"), "globex")).toEqual({ oversee: false, stop: false });
  });

  it("asks first only when the main overseer saw the group", () => {
    expect(asksBeforeOverseeing(MAIN, "globex")).toBe(true);
    // Acme has a boss: it only changes boss.
    expect(asksBeforeOverseeing(MAIN, "acme")).toBe(false);
    expect(asksBeforeOverseeing({ agentId: null, level: null, bosses: [] }, "globex")).toBe(false);
  });

  it("says the two questions in plain words", () => {
    expect(overseeAsk("Mia", "Globex")).toEqual({
      title: "Oversee Globex with Mia?",
      body: "The main boss stops seeing Globex from now on; what it already remembers stays.",
      action: "Oversee Globex",
    });
    expect(deleteAsk("Sarah", "Acme")).toEqual({
      title: "Delete Acme?",
      body: "Sarah stops overseeing; its sessions and agents become ungrouped.",
      action: "Delete Acme",
    });
  });

  it("colours each group's dot from its id, in the theme's toned terminal colours only", () => {
    const ids = ["acme", "globex", "g-1", "g-2", "7f3c", "a long id with spaces"];
    for (const id of ids) {
      expect(groupDot(id)).toMatch(/^var\(--ansi-(cyan|green|magenta)\)$/);
      expect(groupDot(id)).toBe(groupDot(id));
    }
    expect(new Set(ids.map(groupDot)).size).toBeGreaterThan(1);
  });

  it("doesn't ask for a sealed group, which the main overseer can't see", () => {
    const sealed: Manager = { ...MAIN, sealed: ["globex"] };
    expect(isSealed(sealed, "globex")).toBe(true);
    expect(asksBeforeOverseeing(sealed, "globex")).toBe(false);
    expect(asksBeforeOverseeing(sealed, "initech")).toBe(true);
  });

  it("says, when a boss moves to another group, that the main boss sees the old one from now on", () => {
    expect(overseeSaid("Sarah", "Globex", "Acme", true)).toBe("Sarah oversees Globex; the main boss sees Acme from now on");
    expect(overseeSaid("Sarah", "Globex", null, true)).toBe("Sarah oversees Globex");
    expect(overseeSaid("Sarah", "Globex", "Acme", false)).toBe("Sarah oversees Globex");
  });

  it("says plainly when Desk isn't connected, rather than doing nothing", async () => {
    await expect(overseeGroup(null, "mia", "globex", null)).rejects.toThrow(/isn’t connected/);
    await expect(stopOverseeing(null, "mia", null)).rejects.toThrow(/isn’t connected/);
  });
});

// ── In the sidebar ─────────────────────────────────────────────────────────

const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });

const ACME: DeskGroup = { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/sarah", "agent:local/desk"] };
const GLOBEX: DeskGroup = { id: "globex", name: "Globex", collapsed: false, items: ["agent:local/mia", "agent:remote/ada"] };

/** A hub keeping each agent's config as the real one does (see `testing`),
 *  saying the bosses and sealed groups the configs make. */
const fakeHub = (configs: Record<string, string>) => {
  const order: string[] = [];
  const kept = oversightHub(configs);
  const hub = {
    agentConfig: vi.fn(async (id: string) => configs[id] ?? ""),
    saveAgentConfig: vi.fn(async (id: string, toml: string) => {
      order.push(`save ${id}: groups ${useSettings.getState().groups.map((g) => g.id).join(",")}`);
      kept.save(id, toml);
    }),
    manager: vi.fn(async (): Promise<Manager> => kept.manager(useSettings.getState().groups.map((g) => g.id))),
  };
  return { hub, order, configs };
};

const row = (name: string) => screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;
const menuOf = (name: string) => {
  fireEvent.contextMenu(row(name));
  return within(screen.getByRole("menu", { name: `${name} options` }))
    .getAllByRole("menuitem")
    .map((m) => m.textContent);
};

let world: ReturnType<typeof fakeHub>;

beforeEach(() => {
  vi.mocked(openTarget).mockClear();
  world = fakeHub({ sarah: `[oversight]\nenabled = true\ngroup = "acme"\nlevel = "act"\n`, mia: `[llm]\nprovider = "claude-code"\n`, desk: "" });
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "", local: true, revision: "" },
      { id: "remote", label: "Office", url: "", local: false, revision: "" },
    ],
    roster: [agent("local", "sarah", "Sarah"), agent("local", "desk", "Desk"), agent("local", "mia", "Mia"), agent("remote", "ada", "Ada")],
  });
  useDesk.setState({ sessions: {}, openId: null, hub: world.hub as unknown as DeskHub });
  useOverview.setState({ manager: MAIN, managerSupport: "yes" });
  useSettings.setState({ loaded: true, groups: [ACME, GLOBEX], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
});
afterEach(cleanup);

describe("a group's boss in the sidebar", () => {
  it("tags the boss's row and names it on its group's header, which opens its messages", () => {
    render(<SidebarGroups />);
    expect(within(row("Sarah")).getByText("boss")).toBeTruthy();
    expect(row("Sarah").title).toContain("oversees Acme");
    expect(within(row("Mia")).queryByText("boss")).toBeNull();
    // The main overseer is still said as before.
    expect(row("Desk").textContent).toContain("overseer");
    const acme = screen.getByRole("group", { name: "Acme" });
    fireEvent.click(within(acme).getByRole("button", { name: "Sarah oversees" }));
    expect(openTarget).toHaveBeenCalledWith({ kind: "agent", key: "local/sarah" });
    expect(within(screen.getByRole("group", { name: "Globex" })).queryByText(/oversees/)).toBeNull();
    // The group's count still shows on a header with a boss.
    expect(acme.querySelector(".grp-count")?.textContent).toBe("2");
  });

  it("offers Oversee this group after Remove from group, and Stop overseeing to a boss", () => {
    render(<SidebarGroups />);
    expect(menuOf("Mia").slice(0, 4)).toEqual(["Move to group▸", "Add to grid▸", "Remove from group", "Oversee this group"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    const sarah = menuOf("Sarah");
    expect(sarah).toContain("Stop overseeing");
    expect(sarah).not.toContain("Oversee this group");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(menuOf("Desk")).not.toContain("Oversee this group");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(menuOf("Ada")).not.toContain("Oversee this group");
  });

  it("asks before a group the main overseer saw gets a boss, then makes it one", async () => {
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Oversee Globex with Mia?");
    expect(dialog.textContent).toContain("The main boss stops seeing Globex from now on; what it already remembers stays.");
    expect(world.hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Oversee Globex" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const written = parse(world.configs.mia!) as { llm: unknown; oversight: { enabled: boolean; group: string } };
    expect(written.oversight).toMatchObject({ enabled: true, group: "globex" });
    expect(written.llm).toEqual({ provider: "claude-code" });
    await waitFor(() => expect(within(row("Mia")).getByText("boss")).toBeTruthy());
    expect(within(screen.getByRole("group", { name: "Globex" })).getByRole("button", { name: "Mia oversees" })).toBeTruthy();
  });

  it("Cancel asks nothing of the hub", () => {
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(world.hub.saveAgentConfig).not.toHaveBeenCalled();
  });

  it("doesn't ask when the group only changes boss, or there is no main overseer", async () => {
    useSettings.setState({ groups: [{ ...ACME, items: [...ACME.items, "agent:local/mia"] }, { ...GLOBEX, items: ["agent:remote/ada"] }] });
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(world.hub.saveAgentConfig).toHaveBeenCalledTimes(1));
    expect(parse(world.configs.mia!)).toMatchObject({ oversight: { enabled: true, group: "acme" } });

    cleanup();
    useOverview.setState({ manager: { agentId: null, level: null, bosses: [] } });
    useSettings.setState({ groups: [ACME, GLOBEX] });
    world.configs.mia = "";
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(world.hub.saveAgentConfig).toHaveBeenCalledTimes(2));
  });

  it("Stop overseeing asks nothing, and leaves the boss off and naming no group", async () => {
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Sarah"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop overseeing" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(within(row("Sarah")).queryByText("boss")).toBeNull());
    const o = (parse(world.configs.sarah!) as { oversight: Record<string, unknown> }).oversight;
    expect(o.enabled).toBe(false);
    expect("group" in o).toBe(false);
    expect(o.level).toBe("act");
    expect(within(screen.getByRole("group", { name: "Acme" })).queryByText(/oversees/)).toBeNull();
  });

  it("asks before deleting a group with a boss, and takes the boss off before the group goes", async () => {
    render(<SidebarGroups />);
    fireEvent.click(screen.getByRole("button", { name: "Acme options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete Acme?");
    expect(dialog.textContent).toContain("Sarah stops overseeing; its sessions and agents become ungrouped.");
    expect(screen.getByRole("group", { name: "Acme" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Acme" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Acme" })).toBeNull());
    expect(world.order).toEqual(["save sarah: groups acme,globex"]);
    expect("group" in (parse(world.configs.sarah!) as { oversight: object }).oversight).toBe(false);
    expect(useSettings.getState().groups.map((g) => g.id)).toEqual(["globex"]);
  });

  it("keeps the group, and says why, when the boss can't be taken off", async () => {
    world.hub.saveAgentConfig.mockRejectedValueOnce(new Error("The hub is busy."));
    render(<SidebarGroups />);
    fireEvent.click(screen.getByRole("button", { name: "Acme options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Acme" }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("The hub is busy."));
    expect(useSettings.getState().groups.map((g) => g.id)).toEqual(["acme", "globex"]);
  });

  it("deletes a group without a boss at once", () => {
    render(<SidebarGroups />);
    fireEvent.click(screen.getByRole("button", { name: "Globex options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSettings.getState().groups.map((g) => g.id)).toEqual(["acme"]);
  });

  it("offers no boss of a group on a hub that doesn't say who they are", () => {
    useOverview.setState({ manager: { agentId: "desk", level: "act" } });
    render(<SidebarGroups />);
    expect(menuOf("Mia")).not.toContain("Oversee this group");
    expect(within(row("Sarah")).queryByText("boss")).toBeNull();
  });
});

describe("the fix round", () => {
  it("replacing a boss and then stopping the new one leaves the group open, asking nothing", async () => {
    useSettings.setState({ groups: [{ ...ACME, items: [...ACME.items, "agent:local/mia"] }, { ...GLOBEX, items: ["agent:remote/ada"] }] });
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(within(row("Mia")).getByText("boss")).toBeTruthy());
    // Sarah, replaced, names Acme no more.
    expect((parse(world.configs.sarah!) as { oversight: object }).oversight).not.toHaveProperty("group");
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop overseeing" }));
    await waitFor(() => expect(within(row("Mia")).queryByText("boss")).toBeNull());
    expect(useOverview.getState().manager?.sealed).toEqual([]);
    expect(within(screen.getByRole("group", { name: "Acme" })).queryByText(/oversees/)).toBeNull();
  });

  it("shows a sealed group as nobody's, asks nothing to give it a boss, and offers its agents from its header", async () => {
    world.configs.sarah = `[oversight]\nenabled = false\ngroup = "acme"\n`;
    useOverview.setState({ manager: { agentId: "desk", level: "act", bosses: [], sealed: ["acme"] } });
    useSettings.setState({ groups: [{ ...ACME, items: [...ACME.items, "agent:local/mia"] }, GLOBEX] });
    render(<SidebarGroups />);
    const acme = screen.getByRole("group", { name: "Acme" });
    fireEvent.click(within(acme).getByRole("button", { name: "nobody oversees" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Choose who oversees/ }));
    const offered = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(offered).toContain("Sarah");
    expect(offered).toContain("Mia");
    expect(offered).not.toContain("Desk");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mia" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(within(acme).getByRole("button", { name: "Mia oversees" })).toBeTruthy());
    // The stale name went with it: stopping Mia later leaves Acme open.
    expect((parse(world.configs.sarah!) as { oversight: object }).oversight).not.toHaveProperty("group");
  });

  it("says, when a boss moves to another group, that the main boss sees the old one from now on", async () => {
    useSettings.setState({ groups: [{ ...ACME, items: ["agent:local/desk"] }, { ...GLOBEX, items: [...GLOBEX.items, "agent:local/sarah"] }] });
    render(<SidebarGroups />);
    // Sarah sits in Globex but oversees Acme: no tag there.
    expect(within(row("Sarah")).queryByText("boss")).toBeNull();
    fireEvent.contextMenu(row("Sarah"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    // Globex had no boss and the main overseer saw it: the one question.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Oversee Globex" }));
    await waitFor(() => expect(screen.getByText("Sarah oversees Globex; the main boss sees Acme from now on")).toBeTruthy());
  });

  it("says a delete that failed after the boss was taken off, and keeps the dialog open", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Kept on a hub, whose delete fails.
    const layout = { groups: [ACME, GLOBEX], ungrouped: EMPTY_LAYOUT.ungrouped };
    Object.assign(world.hub, {
      deleteGroup: vi.fn(async () => {
        throw new Error("The hub is busy.");
      }),
      layout: vi.fn(async () => layout),
    });
    useHubLayout.setState({ layout, kept: true });
    world.hub.manager.mockImplementation(async () => oversightHub(world.configs).manager(["acme", "globex"]));
    render(<SidebarGroups />);
    fireEvent.click(screen.getByRole("button", { name: "Acme options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Acme" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("Sarah no longer oversees Acme; Acme couldn’t be deleted: The hub is busy."),
    );
    await waitFor(() => expect(screen.getByRole("group", { name: "Acme" })).toBeTruthy());
    useHubLayout.setState({ layout: null, kept: null });
  });

  it("keeps a bossed header's count and unread in its toggle's name, and the shown copy out of the reading", () => {
    render(<SidebarGroups />);
    const acme = screen.getByRole("group", { name: "Acme" });
    const toggle = within(acme).getAllByRole("button")[0]!;
    expect(toggle.textContent).toContain("2");
    expect(acme.querySelector(".grp-tail")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a group's chip", () => {
  it("names the group an item sits in, with its dot, and nothing for Ungrouped", () => {
    const { container } = render(
      <>
        <GroupChip item="agent:local/mia" />
        <GroupChip item="session:loose" />
      </>,
    );
    const chips = container.querySelectorAll(".chip-group");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe("Globex");
    expect((chips[0]!.querySelector(".grp-dot") as HTMLElement).style.background).toBe(groupDot("globex"));
  });

  it("follows the group when it is renamed", () => {
    render(<GroupChip item="agent:local/sarah" />);
    expect(screen.getByText("Acme")).toBeTruthy();
    act(() => useSettings.setState({ groups: [{ ...ACME, name: "Acme Labs" }, GLOBEX] }));
    expect(screen.getByText("Acme Labs")).toBeTruthy();
  });
});
