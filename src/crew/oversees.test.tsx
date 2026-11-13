import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useFloor } from "../floor/store";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { useAgentConfigs } from "./agentBrain";
import { OverseesTheCrew } from "./OverseesTheCrew";

const ledger: Agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };
const desk: Agent = { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true };

const START = `[llm]\nprovider = "claude-code"\n`;

let file = START;
const fakeHub = () =>
  ({
    agentConfig: vi.fn(() => Promise.resolve(file)),
    saveAgentConfig: vi.fn((_id: string, toml: string) => {
      file = toml;
      return Promise.resolve();
    }),
    manager: vi.fn(() => Promise.resolve({ agentId: "desk", level: "watch" })),
    overview: vi.fn(() => Promise.resolve({ brief: null, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] })),
    engines: vi.fn(() => Promise.resolve(ENGINES)),
    spend: vi.fn(() => Promise.resolve(null)),
  }) as unknown as DeskHub;

const caps = (line: "submit" | "paste" | "none") => ({ state: "hooks", approvals: "desk", resume: "byId", interrupt: "keys", plan: null, line, notes: [] });
/** Claude Code and Codex have Desk's line; Gemini CLI hasn't, and Cursor
 *  isn't installed. */
const ENGINES = [
  { engine: "claude", title: "Claude Code", program: "claude", installed: true, version: "2.1.300", signIn: { state: "unknown" }, views: ["terminal"], caps: { terminal: caps("submit") } },
  { engine: "codex", title: "Codex", program: "codex", installed: true, version: "0.80.0", signIn: { state: "unknown" }, views: ["desk", "terminal"], caps: { desk: caps("paste") } },
  { engine: "gemini", title: "Gemini CLI", program: "gemini", installed: true, version: "1", signIn: { state: "unknown" }, views: ["terminal"], caps: { terminal: caps("none") } },
  { engine: "cursor", title: "Cursor CLI", program: null, installed: false, version: null, signIn: { state: "unknown" }, views: ["terminal"], caps: { terminal: caps("submit") } },
];

const oversight = () => (parse(file) as { oversight?: Record<string, unknown> }).oversight;

const show = (hub: DeskHub, toml = START) => {
  file = toml;
  useDesk.setState({ hub });
  useAgentConfigs.setState({ configs: { "local/ledger": toml } });
  render(<OverseesTheCrew agent={ledger} />);
};

beforeEach(() => {
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [desk, ledger] });
  useOverview.setState({ manager: { agentId: "desk", level: "watch" }, managerSupport: "yes", overviewSupport: "unknown" });
});
afterEach(() => {
  cleanup();
  useFloor.setState({ hubs: {} });
});

const boss = (unbound?: boolean) =>
  useFloor.setState({
    hubs: {
      local: {
        state: "ready",
        floor: { bosses: [{ scope: { kind: "ungrouped" }, agent: "ledger", name: "Ledger", level: "full", state: "idle", ...(unbound === undefined ? {} : { unbound }) }] },
        usage: null,
        offset: 0,
        stale: false,
        at: null,
      },
    } as never,
  });
const UNBOUND = `[oversight]\nenabled = true\nlevel = "full"\n[oversight.wake]\nhold_minutes = 7\n[oversight.act]\nnudge = true\nresume_restart = true\nread_only_approvals = true\nhand_out_work = true\ninterrupt = true\nmessage_agents = true\nmessage_terminal_sessions = true\nanswer_sessions = true\nhand_off = true\nset_mode = true\n[oversight.full]\nanywhere = true\nbudget_usd_per_day = 25\n`;

describe("Oversees the crew", () => {
  it("switched back on, asks before a group's boss becomes the main one, then names no group", async () => {
    useSettings.setState({ groups: [{ id: "g-acme", name: "Acme", collapsed: false, items: ["agent:local/ledger"] }] });
    const hub = fakeHub();
    // A boss taken off by hand, its group still named.
    show(hub, `${START}\n[oversight]\nenabled = false\ngroup = "g-acme"\n`);
    fireEvent.click(screen.getByRole("switch", { name: "Oversees the crew" }));
    expect(screen.getByRole("dialog", { name: "Make Ledger the main boss?" })).toBeTruthy();
    expect(screen.getByText(/Ledger stops overseeing only Acme: everything no boss of its own oversees is Ledger’s from now on, Acme included/)).toBeTruthy();
    expect(screen.getByText(/What Ledger learned in Acme stays there: it won’t recall it as the main boss/)).toBeTruthy();
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make Ledger the main boss" })));
    await waitFor(() => expect(oversight()?.enabled).toBe(true));
    expect("group" in oversight()!).toBe(false);
    useSettings.setState({ groups: [] });
  });

  it("asks before taking over from the current overseer, then writes only this agent's config", async () => {
    const hub = fakeHub();
    show(hub);
    expect(screen.getByText("Desk oversees the crew now.")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Oversees the crew" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("dialog", { name: "Make Ledger the overseer?" })).toBeTruthy();
    expect(screen.getByText(/Desk oversees the crew now — make Ledger the overseer instead\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Desk" }));
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make Ledger the overseer" })));
    await waitFor(() => expect(hub.saveAgentConfig).toHaveBeenCalledTimes(1));
    expect((hub.saveAgentConfig as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("ledger");
    expect(oversight()).toMatchObject({ enabled: true, level: "watch" });
    expect((parse(file) as { llm: unknown }).llm).toEqual({ provider: "claude-code" });
    expect(hub.manager).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("says a group's boss oversees only its group, and switching it off names the group no more", async () => {
    useSettings.setState({ groups: [{ id: "g-acme", name: "Acme", collapsed: false, items: ["agent:local/ledger"] }] });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\ngroup = "g-acme"\n`);
    expect(screen.getByText("Oversees only Acme: its sessions and agents.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Oversees the crew" })));
    await waitFor(() => expect(oversight()?.enabled).toBe(false));
    expect("group" in oversight()!).toBe(false);
    useSettings.setState({ groups: [] });
  });

  it("shows Act's own rules only at Act, and saves each choice as it's made", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "suggest" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "suggest"\n`);
    expect(screen.getByRole("radio", { name: /Suggest/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("heading", { name: "What Ledger may do without asking" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /^Act ?Does the work/ })));
    expect(screen.getByRole("heading", { name: "What Ledger may do without asking" })).toBeTruthy();
    expect(screen.getByText(/Ledger always asks you first before pushing code/)).toBeTruthy();
    // Act starts sessions by default; turned off, starts come to you.
    expect(screen.queryByText(/With “Hand out work” off/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Hand out work/ })));
    expect(screen.getByText(/With “Hand out work” off, each session it would start comes to you/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Crew in your workspaces/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ level: "act", act: { hand_out_work: false }, track: { workspaces: true } }));
  });

  it("offers Act fully after Act, unbound with every switch on, and keeps its lists for when Anywhere is off", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const hub = fakeHub();
    // The hub runs it at Act until Act fully is in force.
    (hub.manager as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ agentId: "ledger", level: "act" }));
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "act"\n`);
    const levels = within(screen.getByRole("radiogroup", { name: "How much it does on its own" }))
      .getAllByRole("radio")
      .map((r) => r.querySelector("b")?.textContent);
    expect(levels).toEqual(["Watch", "Suggest", "Act", "Act fully"]);
    expect(screen.getByText("Does everything itself, in any repo: it decides every request its sessions ask the moment they ask, with its reason in the activity log. Only your budget and Stop hold it.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where Ledger acts fully" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /^Act fully/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ level: "full", act: { set_mode: true, hand_off: true }, full: { anywhere: true } }));
    expect(screen.getByRole("heading", { name: "Where Ledger acts fully" })).toBeTruthy();
    // It needs no repo: it is unbound.
    expect(screen.queryByText(/Act fully needs/)).toBeNull();
    expect(screen.getByRole("heading", { name: "What Ledger may do without asking" })).toBeTruthy();
    // Its lists, kept for when Anywhere is off.
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Anywhere/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { anywhere: false } }));

    // Repos: checked as the hub takes them, added and removed.
    const repo = screen.getByRole("textbox", { name: "Add a repo" });
    fireEvent.change(repo, { target: { value: "acme" } });
    fireEvent.keyDown(repo, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("Name a repo as owner/name, its address, or a folder like ~/dev/acme-web.");
    // Saved for Act fully and for Anywhere off, never for what was refused.
    expect(hub.saveAgentConfig).toHaveBeenCalledTimes(2);
    fireEvent.change(repo, { target: { value: "acme/acme-web" } });
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { repos: ["acme/acme-web"] } }));
    // A repo is all it needs: the budget is optional.
    expect(screen.queryByText(/Act fully needs/)).toBeNull();
    expect(screen.getByText(/^Optional \(blank: no budget, so only the check-in ceilings and Stop bound it\)/)).toBeTruthy();

    // The budget, in the hub's words when it's wrong.
    const budget = screen.getByRole("textbox", { name: "Daily budget in US dollars" });
    fireEvent.change(budget, { target: { value: "0" } });
    fireEvent.blur(budget);
    expect(screen.getByRole("alert").textContent).toBe("Its daily budget must be an amount in dollars above 0 and up to 10000.");
    fireEvent.change(budget, { target: { value: "25" } });
    await act(async () => fireEvent.keyDown(budget, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { repos: ["acme/acme-web"], budget_usd_per_day: 25 } }));
    expect(screen.queryByText(/Act fully needs/)).toBeNull();
    // Set, but the hub still runs it at Act: it says why, as far as Desk can tell.
    expect(screen.getByText(/Acting as Act until the hub has read today’s spend/)).toBeTruthy();
    // Blank is no budget.
    fireEvent.change(budget, { target: { value: "" } });
    await act(async () => fireEvent.keyDown(budget, { key: "Enter" }));
    await waitFor(() => expect("budget_usd_per_day" in (oversight()!.full as object)).toBe(false));

    // Workflows: plain file names only.
    const workflow = screen.getByRole("textbox", { name: "Add a workflow" });
    for (const bad of [".github/workflows/deploy.yml", "123.yml", "deploy"]) {
      fireEvent.change(workflow, { target: { value: bad } });
      fireEvent.keyDown(workflow, { key: "Enter" });
      expect(screen.getByRole("alert").textContent).toBe("The workflows it may run must be a list of up to 20 file names like deploy.yml.");
    }
    fireEvent.change(workflow, { target: { value: "deploy.yml" } });
    await act(async () => fireEvent.keyDown(workflow, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { workflows: ["deploy.yml"] } }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove acme/acme-web" })));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { repos: [] } }));
    expect(screen.queryByText(/Act fully needs/)).toBeNull();
  });

  it("shows the real money Act fully has spent today, and once it's spent says what stopped and offers Raise or Clear", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const hub = fakeHub();
    (hub.manager as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ agentId: "ledger", level: "act" }));
    const atFull = (actFully: object) =>
      useFloor.setState({
        hubs: {
          local: {
            state: "ready",
            floor: { bosses: [{ scope: { kind: "ungrouped" }, agent: "ledger", name: "Ledger", level: "act", state: "idle", actFully }] },
            usage: null,
            offset: 0,
            stale: false,
            at: null,
          },
        } as never,
      });
    atFull({ spentUsd: 12.5, budgetUsd: 200, spent: false });
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "full"\n[oversight.full]\nrepos = ["acme/acme-web"]\nbudget_usd_per_day = 200\n`);
    expect(screen.getByText(/Real money spent today: \$12\.50 of \$200\.00 \(your plans aren’t counted\)/)).toBeTruthy();
    expect(screen.getByText(/Your Claude and ChatGPT plans aren’t counted/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    atFull({ spentUsd: 210, budgetUsd: 200, spent: true });
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "full"\n[oversight.full]\nrepos = ["acme/acme-web"]\nbudget_usd_per_day = 200\n`);
    const spent = screen.getByRole("alert");
    expect(spent.textContent).toContain("Act fully stopped: today’s budget is spent.");
    expect(spent.textContent).toContain("$210 of $200 in real money today (your plans aren’t counted), so it no longer merges, tags, releases or runs workflows on its own.");
    expect(screen.queryByText(/until the hub has read today’s spend/)).toBeNull();
    await act(async () => fireEvent.click(within(spent).getByRole("button", { name: "Raise to $315 a day" })));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { budget_usd_per_day: 315 } }));
    expect((screen.getByRole("textbox", { name: "Daily budget in US dollars" }) as HTMLInputElement).value).toBe("315");
    await act(async () => fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Clear today’s count" })));
    await waitFor(() => expect(typeof (oversight()!.full as Record<string, unknown>).budget_cleared_at).toBe("string"));
    expect((oversight()!.full as Record<string, unknown>).budget_usd_per_day).toBe(315);
  });

  it("says nothing of acting as Act once the hub runs it at Act fully", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "full" } });
    const hub = fakeHub();
    (hub.manager as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ agentId: "ledger", level: "full" }));
    show(
      hub,
      `${START}\n[oversight]\nenabled = true\nlevel = "full"\n[oversight.full]\nrepos = ["acme/acme-web"]\nbudget_usd_per_day = 25\nworkflows = ["deploy.yml"]\n`,
    );
    expect(screen.getByRole("heading", { name: "Where Ledger acts fully" })).toBeTruthy();
    expect(screen.queryByText(/Acting as Act/)).toBeNull();
    expect(screen.getByRole("list", { name: "Repos" }).textContent).toContain("acme/acme-web");
    expect(screen.getByRole("list", { name: "Workflows" }).textContent).toContain("deploy.yml");
    expect((screen.getByRole("textbox", { name: "Daily budget in US dollars" }) as HTMLInputElement).value).toBe("25");
  });

  it("offers Anywhere: lists greyed, budget optional, and saves it with the permission-mode switch", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "full" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "full"\n[oversight.full]\nrepos = ["acme/acme-web"]\nworkflows = ["deploy.yml"]\n`);
    const anywhere = screen.getByRole("checkbox", { name: /Anywhere/ }) as HTMLInputElement;
    expect(anywhere.checked).toBe(false);
    expect(screen.getByText("Not limited to the repos, folders and workflows listed")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Add a repo" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/^Optional \(blank: no budget/)).toBeTruthy();
    expect(screen.queryByText(/Acting as Act until/)).toBeNull();
    await act(async () => fireEvent.click(anywhere));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { anywhere: true } }));
    expect((screen.getByRole("textbox", { name: "Add a repo" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Add a workflow" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove acme/acme-web" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("The repos and workflows below don’t apply while Anywhere is on.")).toBeTruthy();
    expect(screen.getByText(/^Optional \(blank: no budget, so/)).toBeTruthy();
    expect(screen.queryByText(/Acting as Act until/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Change sessions’ permission mode/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ act: { set_mode: true }, full: { anywhere: true } }));
  });

  it("says there are no limits at Act fully, whatever its switches and Anywhere say", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "full" } });
    const hub = fakeHub();
    const acts = `nudge = true\nresume_restart = true\nread_only_approvals = true\nhand_out_work = true\ninterrupt = true\nmessage_agents = true\nmessage_terminal_sessions = true\nanswer_sessions = true\nhand_off = true\nset_mode = true\n`;
    const line = /^No limits: Desk acts on everything itself, including publishing, deploys and secrets\. Only your budget, Stop and the activity log remain\./;
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "full"\n[oversight.act]\n${acts}[oversight.full]\nanywhere = true\n`);
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText(/It decides every request its sessions ask the moment they ask/)).toBeTruthy();
    // A switch off, or Anywhere off: still no limits.
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Change sessions’ permission mode/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ act: { set_mode: false } }));
    expect(screen.getByText(line)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Anywhere/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ full: { anywhere: false } }));
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText(/No budget set: only the check-in ceilings and Stop bound what it spends\./)).toBeTruthy();
    expect(screen.getByText(/Desk can switch a session it runs to auto or bypass/)).toBeTruthy();
    expect(screen.queryByText(/always asks you first before pushing code/)).toBeNull();
    expect(screen.getByText(/Everything it does shows in Activity/)).toBeTruthy();
  });

  it("keeps the no-limits line as it is when a budget is set", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "full" } });
    const acts = `nudge = true\nresume_restart = true\nread_only_approvals = true\nhand_out_work = true\ninterrupt = true\nmessage_agents = true\nmessage_terminal_sessions = true\nanswer_sessions = true\nhand_off = true\nset_mode = true\n`;
    show(fakeHub(), `${START}\n[oversight]\nenabled = true\nlevel = "full"\n[oversight.act]\n${acts}[oversight.full]\nanywhere = true\nbudget_usd_per_day = 25\n`);
    expect(screen.getByText(/^No limits: /)).toBeTruthy();
    expect(screen.queryByText(/No budget set/)).toBeNull();
  });

  it("says the typing hold, and the full mode-switch words, while unbound", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "full" } });
    show(fakeHub(), `${START}\n${UNBOUND}`);
    expect(screen.getByText(/its messages to a session it runs wait while you type, for 7 minutes after your last keystroke\./)).toBeTruthy();
    expect(
      screen.getByText(
        "Desk can switch a session it runs to auto or bypass. It goes back to its own mode, started again in place between turns, as soon as unbound ends, the session is released or handed to another boss, or you resume it",
      ),
    ).toBeTruthy();
  });

  it("uses 2 minutes for the hold when the config says none", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "full" } });
    show(fakeHub(), `${START}\n${UNBOUND.replace("[oversight.wake]\nhold_minutes = 7\n", "")}`);
    expect(screen.getByText(/wait while you type, for 2 minutes/)).toBeTruthy();
  });

  it("says Unbound now only when the hub says it is, and otherwise that it is set but not in force", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "full" } });
    boss(true);
    show(fakeHub(), `${START}\n${UNBOUND}`);
    expect(screen.getByText("Unbound now.")).toBeTruthy();
    expect(screen.queryByText(/not in force now/)).toBeNull();
    cleanup();
    boss(false);
    show(fakeHub(), `${START}\n${UNBOUND}`);
    expect(screen.queryByText("Unbound now.")).toBeNull();
    expect(screen.queryByText(/^No limits: /)).toBeNull();
    expect(screen.getByText(/Acting as Act until the hub has read today’s spend/)).toBeTruthy();
    cleanup();
    // No boss view at hand: the configured line, without a claim of force.
    useFloor.setState({ hubs: {} });
    show(fakeHub(), `${START}\n${UNBOUND}`);
    expect(screen.getByText(/^No limits: /)).toBeTruthy();
    expect(screen.queryByText("Unbound now.")).toBeNull();
  });

  it("says when a level sets switches changed by hand again, and Undo puts them back", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "act"\n[oversight.act]\nset_mode = true\n`);
    expect(screen.getByText(/Its switches below were changed from what Act sets/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /^Act fully/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ level: "full", act: { set_mode: true, hand_off: true } }));
    expect(screen.getByText(/Act fully set its switches again, over the ones you’d changed/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(oversight()).toMatchObject({ level: "act", act: { set_mode: true } }));
    expect(screen.queryByText(/set its switches again/)).toBeNull();
  });

  it("shows the hub's own refusal when it won't save", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const hub = fakeHub();
    (hub.saveAgentConfig as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject(new Error("That change couldn’t be saved. How much the overseer does on its own must be watch, suggest, act or full.")),
    );
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "act"\n`);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /^Act fully/ })));
    expect(await screen.findByText(/must be watch, suggest, act or full/)).toBeTruthy();
  });

  it("holds a session for you 2 minutes after you type unless you say, 1 to 60", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "act"\n`);
    const hold = screen.getByRole("textbox", { name: "Hold minutes" }) as HTMLInputElement;
    expect(hold.value).toBe("2");
    expect(screen.getByText(/you’re driving for 2 minutes after your last keystroke/)).toBeTruthy();
    fireEvent.change(hold, { target: { value: "61" } });
    fireEvent.blur(hold);
    expect(screen.getByRole("alert").textContent).toBe(
      "How long your typing in a session keeps it yours must be a whole number of minutes from 1 to 60.",
    );
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.change(hold, { target: { value: "5" } });
    await act(async () => fireEvent.keyDown(hold, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { hold_minutes: 5 } }));
  });

  it("says in plain words what's wrong with a number or time, and saves it once it's right", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\n`);
    const waiting = screen.getByRole("textbox", { name: "Minutes waiting" });
    fireEvent.change(waiting, { target: { value: "0" } });
    fireEvent.blur(waiting);
    expect(screen.getByRole("alert").textContent).toBe("Use 1 to 1440 minutes (a day).");
    expect(waiting.getAttribute("aria-invalid")).toBe("true");
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.change(waiting, { target: { value: "12" } });
    await act(async () => fireEvent.keyDown(waiting, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 12 } }));

    const evening = screen.getByRole("textbox", { name: "End-of-day summary time" }) as HTMLInputElement;
    expect(evening.disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "End-of-day summary at" })));
    await waitFor(() => expect(oversight()).toMatchObject({ summaries: { evening: "18:00" } }));
    fireEvent.change(evening, { target: { value: "6pm" } });
    fireEvent.blur(evening);
    expect(screen.getByRole("alert").textContent).toBe("Use a time like 09:00 or 18:30.");

    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "Something has waited on you for" })));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 0 } }));
    expect((screen.getByRole("textbox", { name: "Minutes waiting" }) as HTMLInputElement).value).toBe("12");
  });

  it("spends check-ins by the hour, under a ceiling for the day", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nmax_checkins_per_day = 150\n`);
    expect((screen.getByRole("textbox", { name: "Check-ins a day" }) as HTMLInputElement).value).toBe("150");
    const hourly = screen.getByRole("textbox", { name: "Check-ins an hour" }) as HTMLInputElement;
    expect(hourly.value).toBe("6");
    fireEvent.change(hourly, { target: { value: "61" } });
    fireEvent.blur(hourly);
    expect(screen.getByRole("alert").textContent).toBe("Use a whole number from 1 to 60.");
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.change(hourly, { target: { value: "4" } });
    await act(async () => fireEvent.keyDown(hourly, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ max_checkins_per_hour: 4, max_checkins_per_day: 150 }));
  });

  it("reads minutes of 0 as off, and turns them back on with the last minutes, else 5 and 30", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nwake = { waiting_minutes = 0, quiet_minutes = 0 }\n`);
    const waitingBox = () => screen.getByRole("checkbox", { name: "Something has waited on you for" }) as HTMLInputElement;
    const quietBox = () => screen.getByRole("checkbox", { name: "Work has gone quiet while working for" }) as HTMLInputElement;
    const quiet = () => screen.getByRole("textbox", { name: "Minutes quiet" }) as HTMLInputElement;
    expect(waitingBox().checked).toBe(false);
    expect(quietBox().checked).toBe(false);
    expect((screen.getByRole("textbox", { name: "Minutes waiting" }) as HTMLInputElement).value).toBe("5");
    expect(quiet().value).toBe("30");
    expect(quiet().disabled).toBe(true);

    await act(async () => fireEvent.click(quietBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 30, waiting_minutes: 0 } }));
    expect(quietBox().checked).toBe(true);

    fireEvent.change(quiet(), { target: { value: "45" } });
    await act(async () => fireEvent.keyDown(quiet(), { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 45 } }));
    await act(async () => fireEvent.click(quietBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 0 } }));
    expect(quietBox().checked).toBe(false);
    expect(quiet().value).toBe("45");
    await act(async () => fireEvent.click(quietBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 45 } }));

    await act(async () => fireEvent.click(waitingBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 5, quiet_minutes: 45 } }));
  });

  it("turns minutes back on with what they were, not something typed that can't be used", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nwake = { waiting_minutes = 0 }\n`);
    const box = () => screen.getByRole("checkbox", { name: "Something has waited on you for" }) as HTMLInputElement;
    const field = () => screen.getByRole("textbox", { name: "Minutes waiting" }) as HTMLInputElement;
    await act(async () => fireEvent.click(box()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 5 } }));
    fireEvent.change(field(), { target: { value: "lots" } });
    fireEvent.blur(field());
    expect(screen.getByRole("alert").textContent).toBe("Use a whole number of minutes.");
    await act(async () => fireEvent.click(box()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 0 } }));
    await waitFor(() => expect(field().value).toBe("5"));
    await act(async () => fireEvent.click(box()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 5 } }));
  });

  it("says how it works, and writes each choice to [oversight.work] as the hub reads it", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "act"\n`);
    expect(screen.getByRole("heading", { name: "How Ledger works" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Always work in real sessions/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Only what I hand it/ }).getAttribute("aria-checked")).toBe("true");
    const parallel = screen.getByRole("textbox", { name: "Sessions at once" }) as HTMLInputElement;
    expect(parallel.value).toBe("4");
    // The engines a session of it could run on: installed, with Desk's line.
    const engine = screen.getByRole("combobox", { name: "New sessions run" }) as HTMLSelectElement;
    await waitFor(() => expect([...engine.options].map((o) => o.textContent)).toEqual(["Claude Code", "Codex"]));

    fireEvent.change(parallel, { target: { value: "13" } });
    fireEvent.blur(parallel);
    expect(screen.getByRole("alert").textContent).toBe("How many sessions it may run at once must be a whole number from 1 to 12.");
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.change(parallel, { target: { value: "6" } });
    await act(async () => fireEvent.keyDown(parallel, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ work: { parallel: 6 } }));

    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /Every session it can/ })));
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Always work in real sessions/ })));
    await act(async () => fireEvent.change(engine, { target: { value: "codex" } }));
    const turns = screen.getByRole("textbox", { name: "Work turns an hour" });
    fireEvent.change(turns, { target: { value: "90" } });
    await act(async () => fireEvent.blur(turns));
    await waitFor(() =>
      expect(oversight()?.work).toEqual({ prefer_sessions: false, parallel: 6, take_on: "all", engine: "codex", max_turns_per_hour: 90 }),
    );
    expect(file).toContain("[oversight.work]");
  });

  it("says a watching overseer runs no sessions", () => {
    show(fakeHub(), `${START}\n[oversight]\nenabled = true\n`);
    expect(screen.getByText("At Watch, Ledger runs no sessions. Set it to Suggest or Act to hand it work.")).toBeTruthy();
  });

  it("isn't offered by a hub that has no overseer", () => {
    useOverview.setState({ managerSupport: "no", manager: null });
    show(fakeHub());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("won't change a config it can't read", () => {
    const hub = fakeHub();
    show(hub, "[llm\nprovider =");
    expect(screen.getByText("Their settings file has a mistake in it, so Desk won’t change it.")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });
});
