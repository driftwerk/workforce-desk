import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichMarkdown } from "@workforce/rich";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { useAgentConfigs } from "../crew/agentBrain";
import type { ComputerActivityRow, ComputerGrant, DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { Computer } from "../settings/Computer";
import { AgentAccess } from "./AgentAccess";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(),
  backendHome: vi.fn(() => Promise.resolve("/Users/me")),
  pickFolder: vi.fn(() => Promise.resolve(picked)),
}));

/** What the folder picker answers next. */
let picked: string | null = null;
vi.mock("../rooms/AgentPanel", () => ({ openAgent: vi.fn() }));

const allan: Agent = { hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false };
const local = { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" };

const grant = (over: Partial<ComputerGrant> = {}): ComputerGrant => ({
  id: "g1",
  agent: "allan",
  ability: "run",
  folder: "~/dev/acme-web",
  connector: null,
  session_id: null,
  run_name: null,
  expires_at: null,
  created_at: "2026-11-03T09:00:00Z",
  ...over,
});
const row = (over: Partial<ComputerActivityRow> = {}): ComputerActivityRow => ({
  id: "r1",
  at: new Date().toISOString(),
  agent: "allan",
  kind: "exec",
  doing: "run `npm test` in ~/dev/acme-web",
  folder: "~/dev/acme-web",
  tool: "exec.run",
  decided_by: "person",
  outcome: { outcome: "allowed" },
  reason: null,
  ...over,
});

let file = "";
const fakeHub = (over: Partial<DeskHub> = {}): DeskHub =>
  ({
    agentConfig: vi.fn(() => Promise.resolve(file)),
    saveAgentConfig: vi.fn((_: string, toml: string) => {
      file = toml;
      return Promise.resolve();
    }),
    computerAccess: vi.fn(() => Promise.resolve({ stopped: false })),
    setComputerStopped: vi.fn((stopped: boolean) => Promise.resolve({ stopped })),
    computerGrants: vi.fn(() => Promise.resolve([grant(), grant({ id: "g2", session_id: "s1" })])),
    revokeGrant: vi.fn(() => Promise.resolve()),
    forgetSession: vi.fn(() => Promise.resolve()),
    computerActivity: vi.fn(() => Promise.resolve({ rows: [row(), row({ id: "r2", kind: "write", doing: "change ~/notes.md", outcome: { outcome: "ran" }, decided_by: "rule" })], next: null })),
    diskAccess: vi.fn(() => Promise.resolve("missing" as const)),
    ...over,
  }) as unknown as DeskHub;

const setUp = (hub: DeskHub, toml = "") => {
  file = toml;
  useDesk.setState({ hub });
  useChat.setState({ hubs: [local], roster: [allan] });
  useAgentConfigs.setState({ configs: { "local/allan": toml } });
};

beforeEach(() => useUi.setState({ settings: "computer", agentTabs: {} }));
afterEach(cleanup);

describe("Settings → This computer", () => {
  it("lists each agent's level, what's always allowed and what they did", async () => {
    const hub = fakeHub();
    setUp(hub);
    render(<Computer />);
    const agents = await screen.findByRole("list", { name: "Agents" });
    expect(within(agents).getByText("Full access · asks before irreversible things")).toBeTruthy();
    // Once always, once for this session.
    expect(await screen.findAllByText("Allan · run commands in ~/dev/acme-web")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Forget" })).toBeTruthy();
    const activity = await screen.findByRole("list", { name: "What agents did here" });
    expect(within(activity).getByText("You allowed")).toBeTruthy();
    expect(within(activity).getByText("Ran")).toBeTruthy();
    // Kind filters the page: Files leaves out the command.
    fireEvent.click(screen.getByRole("radio", { name: "Files" }));
    expect(within(screen.getByRole("list", { name: "What agents did here" })).queryByText("You allowed")).toBeNull();
  });

  it("stops all access at once, says so, and allows again", async () => {
    const hub = fakeHub();
    setUp(hub);
    render(<Computer />);
    const stop = await screen.findByRole("button", { name: "Stop all access now" });
    await waitFor(() => expect(stop).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(stop));
    expect(hub.setComputerStopped).toHaveBeenCalledWith(true);
    expect(screen.getByRole("status").textContent).toContain("Stopped. No agent can read, change or run anything here.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow again" })));
    expect(hub.setComputerStopped).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("checkbox", { name: "Agents can use this computer" })).toHaveProperty("checked", true);
  });

  it("revokes a grant and forgets a session's", async () => {
    const hub = fakeHub();
    setUp(hub);
    render(<Computer />);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Revoke" })));
    expect(hub.revokeGrant).toHaveBeenCalledWith("g1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Forget" })));
    expect(hub.forgetSession).toHaveBeenCalledWith("s1");
  });

  it("shows the Full Disk Access card only while it's missing and an agent reads past its folder", async () => {
    setUp(fakeHub());
    render(<Computer />);
    expect(await screen.findByRole("button", { name: "Grant Full Disk Access" })).toBeTruthy();
    cleanup();
    setUp(fakeHub(), '[computer]\naccess = "own_folder"\n');
    render(<Computer />);
    await screen.findByText("Own folder");
    expect(screen.queryByRole("button", { name: "Grant Full Disk Access" })).toBeNull();
    cleanup();
    setUp(fakeHub({ diskAccess: vi.fn(() => Promise.resolve("granted" as const)) }));
    render(<Computer />);
    expect(await screen.findByText("Full Disk Access is on.")).toBeTruthy();
  });

  it("opens Full Disk Access natively, and the card goes once it's on and Desk is back in front", async () => {
    const { invoke } = await import("../platform");
    let state: "missing" | "granted" = "missing";
    setUp(fakeHub({ diskAccess: vi.fn(() => Promise.resolve(state)) }));
    render(<Computer />);
    fireEvent.click(await screen.findByRole("button", { name: "Grant Full Disk Access" }));
    // Not a link the page's opener refuses: the native command, by pane.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("privacy_open", { pane: "fullDiskAccess" });
    state = "granted";
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("Full Disk Access is on.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Grant Full Disk Access" })).toBeNull();
  });

  it("says when there's nothing yet, and when the hub can't be read", async () => {
    setUp(fakeHub({ computerGrants: vi.fn(() => Promise.resolve([])), computerActivity: vi.fn(() => Promise.resolve({ rows: [], next: null })) }));
    render(<Computer />);
    expect(await screen.findByText(/Nothing yet\. Choose “Always allow”/)).toBeTruthy();
    expect(await screen.findByText(/When an agent reads, changes or runs something here/)).toBeTruthy();
    cleanup();
    setUp(
      fakeHub({
        computerAccess: vi.fn(() => Promise.reject(new Error("down"))),
        computerGrants: vi.fn(() => Promise.reject(new Error("down"))),
        computerActivity: vi.fn(() => Promise.reject(new Error("down"))),
      }),
    );
    render(<Computer />);
    expect(await screen.findByText("Couldn’t ask the hub about this computer just now.")).toBeTruthy();
    expect(await screen.findByText("Couldn’t read what’s allowed just now.")).toBeTruthy();
    expect(await screen.findByText("Couldn’t read the activity just now.")).toBeTruthy();
  });
});

describe("a hub without these routes", () => {
  it("says it doesn't have that yet, in Settings and on the tab", async () => {
    const { HubError } = await import("../hub/client");
    const old = () => Promise.reject(new HubError(404, "This hub doesn’t have that yet."));
    setUp(fakeHub({ computerAccess: vi.fn(old), computerGrants: vi.fn(old), computerActivity: vi.fn(old), diskAccess: vi.fn(old) }));
    render(<Computer />);
    expect(await screen.findByText("This hub doesn’t have that yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop all access now" })).toBeNull();
    cleanup();
    render(<AgentAccess agent={allan} />);
    expect(await screen.findByText("This hub doesn’t have that yet.")).toBeTruthy();
  });
});

describe("an agent's This computer tab", () => {
  it("offers two ways of Full access, asking only before irreversible things first", async () => {
    const hub = fakeHub();
    setUp(hub, "");
    render(<AgentAccess agent={allan} />);
    const asks = await screen.findByRole("radiogroup", { name: "What Allan asks you about first" });
    const options = within(asks).getAllByRole("radio");
    expect(options.map((o) => o.querySelector("b")!.textContent)).toEqual(["Ask only before irreversible things", "Do anything"]);
    expect(options[0]!.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(options[1]!));
    expect((parse(file) as Record<string, Record<string, unknown>>).computer).toEqual({ access: "full", asks: "never" });
    expect(screen.queryByText(/asks before changing/)).toBeNull();
  });

  it("writes the level chosen into its file and keeps the rest", async () => {
    const hub = fakeHub();
    setUp(hub, '[llm]\nprovider = "claude-code"\n');
    render(<AgentAccess agent={allan} />);
    const full = await screen.findByRole("radio", { name: /Full access/ });
    expect(full.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /Its own folder/ })));
    const doc = parse(file) as Record<string, Record<string, unknown>>;
    expect(doc.computer).toEqual({ access: "own_folder" });
    expect(doc.llm).toEqual({ provider: "claude-code" });
    expect(screen.getByText("Commands are off at this level on this computer.")).toBeTruthy();
  });

  it("lists what's allowed for it with Revoke, and its recent activity", async () => {
    const hub = fakeHub();
    setUp(hub);
    render(<AgentAccess agent={allan} />);
    expect(await screen.findAllByText("Allan · run commands in ~/dev/acme-web")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(hub.computerGrants).toHaveBeenCalledWith("allan");
    expect(hub.computerActivity).toHaveBeenCalledWith({ agent: "allan" });
    fireEvent.click(screen.getByRole("button", { name: "See all" }));
    expect(useUi.getState().settings).toBe("computer");
  });

  it("refuses to change a file with a mistake in it, in plain words", async () => {
    setUp(fakeHub(), "not = [toml");
    render(<AgentAccess agent={allan} />);
    await act(async () => fireEvent.click(await screen.findByRole("radio", { name: /Read anywhere/ })));
    expect((await screen.findByRole("alert")).textContent).toContain("has a mistake in it");
  });
});

describe("an agent's own words", () => {
  it("can't draw Desk's approval card", () => {
    const { container } = render(<RichMarkdown text={'<div class="dm-approval">Allow once</div>\\n\\n<span class="dm-approval computer-ask">Desk asks</span>'} />);
    expect(container.querySelector(".dm-approval")).toBeNull();
    expect(container.querySelector(".computer-ask")).toBeNull();
  });
});

describe("the folders an agent works in", () => {
  it("adds a picked folder, lists it shown from home, and removes it, keeping its level", async () => {
    const hub = fakeHub();
    setUp(hub, '[computer]\naccess = "own_folder"\n');
    render(<AgentAccess agent={allan} />);
    const section = within(screen.getByRole("region", { name: "Works in" }));
    expect(section.getByText(/Only its own folder/)).toBeTruthy();

    picked = "/Users/me/dev/acme-web";
    await act(async () => fireEvent.click(section.getByRole("button", { name: "Add a folder…" })));
    await waitFor(() => expect(section.getByText("~/dev/acme-web")).toBeTruthy());
    expect(parse(file)).toEqual({ computer: { access: "own_folder", works_in: ["/Users/me/dev/acme-web"] } });
    expect(section.getByText("Coding work starts here")).toBeTruthy();

    picked = "/Users/me/dev/acme-api";
    await act(async () => fireEvent.click(section.getByRole("button", { name: "Add a folder…" })));
    await waitFor(() => expect(section.getByText("~/dev/acme-api")).toBeTruthy());

    await act(async () => fireEvent.click(section.getByRole("button", { name: "Remove ~/dev/acme-web" })));
    await waitFor(() => expect(section.queryByText("~/dev/acme-web")).toBeNull());
    expect(parse(file)).toEqual({ computer: { access: "own_folder", works_in: ["/Users/me/dev/acme-api"] } });
  });

  it("never adds home or above it, and says why", async () => {
    const hub = fakeHub();
    setUp(hub, "");
    render(<AgentAccess agent={allan} />);
    const section = within(screen.getByRole("region", { name: "Works in" }));
    await waitFor(() => expect(section.getByText(/Only its own folder/)).toBeTruthy());
    picked = "/Users/me";
    await act(async () => fireEvent.click(section.getByRole("button", { name: "Add a folder…" })));
    await waitFor(() => expect(section.getByRole("alert").textContent).toMatch(/inside your home/));
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
  });

  it("shows the hub's refusal as it is", async () => {
    const hub = fakeHub({
      saveAgentConfig: vi.fn(() => Promise.reject(new Error("~/Library holds Desk's own data or your keychains, which no agent works in."))),
    });
    setUp(hub, "");
    render(<AgentAccess agent={allan} />);
    const section = within(screen.getByRole("region", { name: "Works in" }));
    picked = "/Users/me/Library";
    await act(async () => fireEvent.click(section.getByRole("button", { name: "Add a folder…" })));
    await waitFor(() => expect(section.getByRole("alert").textContent).toMatch(/no agent works in/));
    expect(section.getByText(/Only its own folder/)).toBeTruthy();
  });
});
