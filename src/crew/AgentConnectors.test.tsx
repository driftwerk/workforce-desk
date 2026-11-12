import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { HubError, type DeskHub } from "../hub/client";
import type { Connection, ConnectionsApi, Connector } from "../hub/connections";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { AgentConnectors } from "./AgentConnectors";
import { useAgentConfigs } from "./agentBrain";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const ALLAN: Agent = { hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false };

const mineConn = (c: Partial<Connection> = {}): Connection => ({
  level: "all",
  agent: null,
  agentName: null,
  account: "sarah@acme.example",
  status: "connected",
  detail: null,
  connectedAt: null,
  checkedAt: null,
  source: "global_per_user",
  ...c,
});

const connector = (c: Partial<Connector> & Pick<Connector, "id" | "name">): Connector => ({
  about: "",
  signIn: "fields",
  fields: [{ name: "api_key", label: "API key", secret: true, required: true, placeholder: "" }],
  signInReady: true,
  connections: [],
  usedBy: [],
  ...c,
});

const LIST = [
  connector({ id: "linear", name: "Linear", connections: [mineConn()], usedBy: [{ agent: "allan", name: "Allan", connection: "mine" }] }),
  connector({ id: "jira", name: "Jira" }),
];

let config = "";
let saved: string[] = [];
let calls: unknown = [];

const api = (list: Connector[], over: Partial<ConnectionsApi> = {}): ConnectionsApi => ({
  list: vi.fn(async () => ({ connectors: list, adapters: ["xero"] })),
  connect: vi.fn(async () => mineConn({ level: "agent", agent: "allan" })),
  test: vi.fn(),
  disconnect: vi.fn(),
  saveGoogleClient: vi.fn(),
  start: vi.fn(),
  flow: vi.fn(),
  cancel: vi.fn(),
  ...over,
});

beforeEach(() => {
  config = "";
  saved = [];
  calls = [];
  useAgentConfigs.setState({ configs: {} });
  useDesk.setState({
    hub: {
      agentConfig: vi.fn(async () => config),
      saveAgentConfig: vi.fn(async (_id: string, toml: string) => {
        config = toml;
        saved.push(toml);
      }),
      computerActivity: vi.fn(async () => {
        if (calls instanceof Error) throw calls;
        return { rows: calls, next: null };
      }),
    } as unknown as DeskHub,
  });
});
afterEach(cleanup);

const show = async (a: ConnectionsApi) => {
  render(<AgentConnectors agent={ALLAN} api={a} />);
  await act(async () => {});
};

const row = (name: string) => screen.getByRole("listitem", { name });
const radio = (name: string, label: string) => within(row(name)).getByRole("radio", { name: label }) as HTMLButtonElement;
const skills = () => (parse(saved.at(-1)!) as { skills?: Record<string, unknown> }).skills;

it("says there's nothing to turn on before anything is connected", async () => {
  await show(api([connector({ id: "linear", name: "Linear" })]));
  expect(screen.getByText("No connections yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Connections" }));
  expect(useUi.getState().settings).toBe("connections");
});

it("shows an agent nobody has chosen for with every connector, and keeps them when one goes off", async () => {
  await show(api(LIST));
  expect(screen.getByRole("note").textContent).toContain("Allan has every connector");
  expect(radio("Linear", "My connection").getAttribute("aria-checked")).toBe("true");
  expect(within(row("Linear")).getByText(/sends to people ask first/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(radio("Jira", "Off"));
  });
  expect(skills()).toEqual({ enabled: ["linear", "xero"] });
});

it("can't use my connection before it's connected, and links to Connections", async () => {
  config = "[skills]\nenabled = []\n";
  await show(api(LIST));
  expect(radio("Jira", "Off").getAttribute("aria-checked")).toBe("true");
  expect(radio("Jira", "My connection").disabled).toBe(true);
  expect(radio("Linear", "My connection").disabled).toBe(false);
  fireEvent.click(within(row("Jira")).getByRole("button", { name: "Connect Jira first" }));
  expect(useUi.getState().settings).toBe("connections");
});

it("turns a connector on through my connection, read only, as the grammar says", async () => {
  config = "[skills]\nenabled = []\n";
  await show(api(LIST));
  await act(async () => {
    fireEvent.click(radio("Linear", "My connection"));
  });
  expect(skills()).toEqual({ enabled: ["linear"] });
  await act(async () => {
    fireEvent.click(radio("Linear", "Read only"));
  });
  expect(skills()).toEqual({ enabled: ["linear"], read_only: ["linear"] });
  expect(within(row("Linear")).getByText(/reads only/)).toBeTruthy();
});

it("connects its own connection first, just for this agent, then uses it", async () => {
  config = "[skills]\nenabled = []\n";
  const a = api(LIST);
  await show(a);
  await act(async () => {
    fireEvent.click(radio("Jira", "Its own connection"));
  });
  const form = screen.getByRole("group", { name: "Jira for Allan only" });
  fireEvent.change(within(form).getByLabelText("API key"), { target: { value: "jira-key" } });
  await act(async () => {
    fireEvent.click(within(form).getByRole("button", { name: "Save and connect" }));
  });
  expect(a.connect).toHaveBeenCalledWith("jira", { level: "agent", agent: "allan" }, { api_key: "jira-key" });
  expect(skills()).toEqual({ enabled: ["jira"], own_credential: ["jira"] });
});

it("says its changes ask first below Full access", async () => {
  config = '[computer]\naccess = "own_folder"\n\n[skills]\nenabled = ["linear"]\n';
  await show(api(LIST));
  expect(within(row("Linear")).getByText(/asks before changes/)).toBeTruthy();
  expect(screen.getByText(/asks you before it changes anything/)).toBeTruthy();
});

it("says the agent works on its own when it asks before nothing", async () => {
  config = '[computer]\nasks = "never"\n\n[skills]\nenabled = ["linear"]\n';
  await show(api(LIST));
  expect(within(row("Linear")).getByText(/works on its own/)).toBeTruthy();
});

it("lists its recent connector calls, and nothing when the hub keeps none", async () => {
  calls = [
    {
      id: "1",
      at: new Date().toISOString(),
      agent: "allan",
      kind: "connector",
      doing: "change something in linear",
      folder: null,
      tool: "linear.issue_create",
      decided_by: "rule",
      outcome: { outcome: "ran" },
      reason: null,
    },
  ];
  await show(api(LIST));
  const recent = screen.getByRole("region", { name: "Recent connector calls" });
  expect(within(recent).getByText("linear.issue_create")).toBeTruthy();
  cleanup();
  calls = new HubError(404, "no route");
  await show(api(LIST));
  expect(screen.queryByRole("region", { name: "Recent connector calls" })).toBeNull();
});

it("says when its settings file can't be changed", async () => {
  config = "[skills\nenabled = []\n";
  await show(api(LIST));
  await act(async () => {
    fireEvent.click(radio("Jira", "Off"));
  });
  expect(screen.getByRole("status").textContent).toBe("Their settings file has a mistake in it, so Desk won’t change it.");
  expect(saved).toEqual([]);
});

it("says when the hub couldn't be asked", async () => {
  await show(api([], { list: vi.fn(async () => Promise.reject(new Error("down"))) }));
  expect(screen.getByRole("alert").textContent).toContain("Desk couldn’t read your connections just now.");
});
