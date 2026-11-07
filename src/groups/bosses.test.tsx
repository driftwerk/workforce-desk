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
import { asksBeforeOverseeing, bossOfGroup, deleteAsk, groupDot, groupOfBoss, overseeAsk, overseeChoices } from "./bosses";
import { GroupChip } from "./GroupChip";
import { EMPTY_LAYOUT, type DeskGroup } from "./model";
import { SidebarGroups } from "./SidebarGroups";

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

  it("colours each group's dot from the theme's terminal colours", () => {
    expect(groupDot(0)).toBe("var(--ansi-cyan)");
    expect(groupDot(1)).toBe("var(--ansi-green)");
    expect(groupDot(2)).toBe("var(--ansi-magenta)");
    expect(groupDot(3)).toBe(groupDot(0));
  });
});

// ── In the sidebar ─────────────────────────────────────────────────────────

const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });

const ACME: DeskGroup = { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/sarah", "agent:local/desk"] };
const ATLAS: DeskGroup = { id: "globex", name: "Globex", collapsed: false, items: ["agent:local/mia", "agent:remote/ada"] };

/** A hub keeping each agent's config, saying the bosses the configs make. */
const fakeHub = (configs: Record<string, string>) => {
  const order: string[] = [];
  const bosses = () =>
    Object.entries(configs).flatMap(([id, toml]) => {
      const o = (parse(toml) as { oversight?: { enabled?: boolean; group?: string } }).oversight;
      return o?.enabled && o.group ? [{ agentId: id, name: id[0]!.toUpperCase() + id.slice(1), group: o.group, level: "act" as const }] : [];
    });
  const hub = {
    agentConfig: vi.fn(async (id: string) => configs[id] ?? ""),
    saveAgentConfig: vi.fn(async (id: string, toml: string) => {
      order.push(`save ${id}: groups ${useSettings.getState().groups.map((g) => g.id).join(",")}`);
      configs[id] = toml;
    }),
    manager: vi.fn(async (): Promise<Manager> => ({ agentId: "desk", level: "act", bosses: bosses() })),
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
  useSettings.setState({ loaded: true, groups: [ACME, ATLAS], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
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
    useSettings.setState({ groups: [{ ...ACME, items: [...ACME.items, "agent:local/mia"] }, { ...ATLAS, items: ["agent:remote/ada"] }] });
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(world.hub.saveAgentConfig).toHaveBeenCalledTimes(1));
    expect(parse(world.configs.mia!)).toMatchObject({ oversight: { enabled: true, group: "acme" } });

    cleanup();
    useOverview.setState({ manager: { agentId: null, level: null, bosses: [] } });
    useSettings.setState({ groups: [ACME, ATLAS] });
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
    expect((chips[0]!.querySelector(".grp-dot") as HTMLElement).style.background).toBe("var(--ansi-green)");
  });

  it("follows the group when it is renamed", () => {
    render(<GroupChip item="agent:local/sarah" />);
    expect(screen.getByText("Acme")).toBeTruthy();
    act(() => useSettings.setState({ groups: [{ ...ACME, name: "Acme Labs" }, ATLAS] }));
    expect(screen.getByText("Acme Labs")).toBeTruthy();
  });
});
