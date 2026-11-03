import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import type { Connection, ConnectionsApi, Connector } from "../hub/connections";
import { Connections } from "./Connections";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  openUrl: (url: string) => opened.push(url),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  opened.length = 0;
});

const connection = (c: Partial<Connection> = {}): Connection => ({
  level: "all",
  agent: null,
  agentName: null,
  account: "sarah@acme.example",
  status: "connected",
  detail: null,
  connectedAt: "2026-11-02T10:00:00Z",
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  source: "global_per_user",
  ...c,
});

const connector = (c: Partial<Connector> & Pick<Connector, "id" | "name">): Connector => ({
  about: `What ${c.name} gives agents.`,
  signIn: "fields",
  fields: [{ name: "api_key", label: "API key", secret: true, required: true, placeholder: "" }],
  signInReady: true,
  connections: [],
  usedBy: [],
  ...c,
});

const api = (list: Connector[], over: Partial<ConnectionsApi> = {}): ConnectionsApi => ({
  list: vi.fn(async () => ({ connectors: list, adapters: [] })),
  connect: vi.fn(async () => connection()),
  test: vi.fn(async () => connection()),
  disconnect: vi.fn(async () => {}),
  saveGoogleClient: vi.fn(async () => {}),
  start: vi.fn(),
  flow: vi.fn(),
  cancel: vi.fn(async () => {}),
  ...over,
});

const show = async (a: ConnectionsApi) => {
  render(<Connections api={a} />);
  await act(async () => {});
};

const row = (name: string) => screen.getByRole("listitem", { name });

it("says what to do when nothing is connected, and lists every connector as not connected", async () => {
  await show(api([connector({ id: "linear", name: "Linear" }), connector({ id: "jira", name: "Jira" })]));
  expect(screen.getByText("Connect the tools your agents work with. Each agent only gets the ones you turn on for it.")).toBeTruthy();
  expect(within(row("Linear")).getByText("Not connected")).toBeTruthy();
  expect(within(row("Jira")).getByRole("button", { name: "Connect" })).toBeTruthy();
});

it("shows each status: connected as someone, needing reconnecting, not answering, just one agent's", async () => {
  await show(
    api([
      connector({ id: "linear", name: "Linear", connections: [connection()], usedBy: [{ agent: "allan", name: "Allan", connection: "mine" }] }),
      connector({ id: "jira", name: "Jira", connections: [connection({ status: "needs_reconnect", detail: "Jira says this token is invalid" })] }),
      connector({ id: "datadog", name: "Datadog", connections: [connection({ status: "failing" })] }),
      connector({
        id: "github",
        name: "GitHub",
        connections: [connection({ level: "agent", agent: "ben", agentName: "Ben", source: "agent_per_user" })],
      }),
    ]),
  );
  expect(within(row("Linear")).getByText("Connected as sarah@acme.example").className).toContain("state-on");
  expect(within(row("Linear")).getByText(/1 agent uses it/)).toBeTruthy();
  expect(within(row("Jira")).getByText("Needs reconnecting").className).toContain("state-blocked");
  expect(within(row("Datadog")).getByText("Not answering")).toBeTruthy();
  expect(within(row("GitHub")).getByText("Connected just for Ben")).toBeTruthy();
  expect(row("Jira").querySelector(".conn-dot-blocked")).toBeTruthy();
  expect(screen.queryByText(/Nothing connected yet/)).toBeNull();

  fireEvent.click(within(row("Jira")).getByRole("button", { name: "Manage" }));
  expect(within(row("Jira")).getByText("Jira says this token is invalid")).toBeTruthy();
});

it("connects with the fields, for all my agents, saying where the key is kept", async () => {
  const a = api([connector({ id: "linear", name: "Linear" })]);
  await show(a);
  fireEvent.click(within(row("Linear")).getByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect for all my agents" }));
  expect(screen.getByText("Saved in Desk’s vault on this computer. Never in a file.")).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save and connect" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: " lin_api_x " } });
  await act(async () => {
    fireEvent.click(save);
  });
  expect(a.connect).toHaveBeenCalledWith("linear", { level: "all" }, { api_key: "lin_api_x" });
  expect(a.list).toHaveBeenCalledTimes(2);
});

it("keeps the form open with the service's own words when the test fails", async () => {
  const a = api([connector({ id: "linear", name: "Linear" })], {
    connect: vi.fn(async () => Promise.reject(new HubError(422, "Linear says this key is invalid"))),
  });
  await show(a);
  fireEvent.click(within(row("Linear")).getByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect for all my agents" }));
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  });
  expect(screen.getByRole("alert").textContent).toBe("Linear says this key is invalid");
  expect(screen.getByLabelText("API key")).toBeTruthy();
  expect(a.list).toHaveBeenCalledTimes(1);
});

it("lists who uses a connection, and asks before Disconnect takes it from them", async () => {
  const a = api([
    connector({
      id: "linear",
      name: "Linear",
      connections: [connection(), connection({ level: "agent", agent: "cara", agentName: "Cara", account: "bot@acme.example" })],
      usedBy: [
        { agent: "allan", name: "Allan", connection: "mine" },
        { agent: "ben", name: "Ben", connection: "mine" },
        { agent: "cara", name: "Cara", connection: "own" },
      ],
    }),
  ]);
  await show(a);
  fireEvent.click(within(row("Linear")).getByRole("button", { name: "Manage" }));
  const used = screen.getByRole("region", { name: "Used by" });
  expect(within(used).getAllByText("my connection")).toHaveLength(2);
  expect(within(used).getByText("own connection")).toBeTruthy();
  const only = screen.getByRole("region", { name: "Agent-only connections" });
  expect(within(only).getByText("Linear for Cara only")).toBeTruthy();
  expect(within(only).getByText("bot@acme.example")).toBeTruthy();

  const disconnects = screen.getAllByRole("button", { name: "Disconnect" });
  fireEvent.click(disconnects[0]!);
  const asking = screen.getByText("Allan and Ben will lose Linear.").parentElement!;
  await act(async () => {
    fireEvent.click(within(asking).getByRole("button", { name: "Disconnect" }));
  });
  expect(a.disconnect).toHaveBeenCalledWith("linear", { level: "all" });
});

it("tests a connection again and shows what it found", async () => {
  const a = api([connector({ id: "linear", name: "Linear", connections: [connection({ checkedAt: null })] })]);
  await show(a);
  fireEvent.click(within(row("Linear")).getByRole("button", { name: "Manage" }));
  expect(screen.getByText("Not checked yet")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
  });
  expect(a.test).toHaveBeenCalledWith("linear", { level: "all" });
  expect(a.list).toHaveBeenCalledTimes(2);
});

it("signs in to GitHub with a code, and says nothing was saved when it's cancelled", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const a = api([connector({ id: "github", name: "GitHub", signIn: "github" })], {
    start: vi.fn(async () => ({
      flow: "f1",
      url: null,
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
    })),
    flow: vi.fn(async () => ({ state: "cancelled" as const })),
  });
  await show(a);
  fireEvent.click(within(row("GitHub")).getByRole("button", { name: "Connect" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  });
  expect(screen.getByText("ABCD-1234")).toBeTruthy();
  expect(opened).toEqual(["https://github.com/login/device"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByText("Sign-in was cancelled. Nothing was saved.")).toBeTruthy();
  expect(screen.queryByText("ABCD-1234")).toBeNull();
});

it("offers a token when Desk's GitHub sign-in isn't set up", async () => {
  await show(api([connector({ id: "github", name: "GitHub", signIn: "github", signInReady: false, fields: [{ name: "token", label: "Personal access token", secret: true, required: true, placeholder: "" }] })]));
  fireEvent.click(within(row("GitHub")).getByRole("button", { name: "Connect" }));
  expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connect for all my agents" }));
  expect(screen.getByLabelText("Personal access token")).toBeTruthy();
});

it("asks for the person's own Google client once, then signs in in the browser", async () => {
  const a = api([connector({ id: "google", name: "Google", signIn: "google", signInReady: false, fields: [] })], {
    start: vi.fn(async () => ({ flow: "g1", url: "https://accounts.google.com/o/oauth2/auth?x", userCode: null, verificationUri: null, expiresIn: 900 })),
    flow: vi.fn(async () => ({ state: "waiting" as const })),
  });
  await show(a);
  fireEvent.click(within(row("Google")).getByRole("button", { name: "Connect" }));
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "id.apps.googleusercontent.com" } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save client" }));
  });
  expect(a.saveGoogleClient).toHaveBeenCalledWith("id.apps.googleusercontent.com", "s");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
  });
  expect(opened).toEqual(["https://accounts.google.com/o/oauth2/auth?x"]);
  expect(screen.getByText("Waiting for Google…")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
  expect(a.cancel).toHaveBeenCalledWith("g1");
  expect(screen.getByText("Sign-in was cancelled. Nothing was saved.")).toBeTruthy();
});

it("says when the hub couldn't be asked, and asks again", async () => {
  const a = api([], { list: vi.fn(async () => Promise.reject(new Error("down"))) });
  await show(a);
  expect(screen.getByRole("alert").textContent).toBe("Couldn’t ask the hub about connections just now.");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  expect(a.list).toHaveBeenCalledTimes(2);
});

it("says so when this computer's hub has no connections yet", async () => {
  await show(api([], { list: vi.fn(async () => Promise.reject(new HubError(404, "no route"))) }));
  expect(screen.getByText(/doesn’t offer connections yet/)).toBeTruthy();
});
