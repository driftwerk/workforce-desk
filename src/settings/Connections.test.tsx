import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import type { Connection, ConnectionsApi, Connector, PicksChange, ServicePicks } from "../hub/connections";
import { useChat } from "../chat/store";
import { useOverview } from "../overview/store";
import { useUi } from "../shell/ui";
import { Connections } from "./Connections";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const opened = vi.hoisted(() => [] as string[]);
const asked = vi.hoisted(() => [] as { agent: string; text: string }[]);
vi.mock("../ui/askDesk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/askDesk")>()),
  askAgent: (agent: string, text: string) => asked.push({ agent, text }) > 0,
}));
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  openUrl: (url: string) => opened.push(url),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  opened.length = 0;
  asked.length = 0;
  useOverview.setState({ manager: null });
  useChat.setState({ hubs: [], roster: [] });
});

/** Desk's own agent on this computer, there to ask. */
const withDeskAgent = () => {
  useOverview.setState({ manager: { agentId: "desk", level: null } });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "desk", name: "Kat", model: null, provider: null, isDefault: true }],
  });
};

const connection = (c: Partial<Connection> = {}): Connection => ({
  id: "all~~default",
  name: "Acme",
  site: null,
  level: "all",
  agent: null,
  agentName: null,
  account: "sarah@acme.example",
  status: "connected",
  detail: null,
  connectedAt: "2026-11-02T10:00:00Z",
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  source: "global_per_user",
  usedBy: [],
  ...c,
});

const connector = (c: Partial<Connector> & Pick<Connector, "id" | "name">): Connector => ({
  about: `What ${c.name} gives agents.`,
  signIn: "fields",
  fields: [{ name: "api_key", label: "API key", secret: true, required: true, placeholder: "" }],
  signInReady: true,
  several: true,
  nameHint: "Acme",
  connections: [],
  usedBy: [],
  ...c,
});

const api = (list: Connector[], over: Partial<ConnectionsApi> = {}): ConnectionsApi => ({
  list: vi.fn(async () => ({ connectors: list, adapters: [] })),
  connect: vi.fn(async () => connection()),
  reconnect: vi.fn(async () => connection()),
  rename: vi.fn(async () => connection()),
  test: vi.fn(async () => connection()),
  renew: vi.fn(async () => connection()),
  disconnect: vi.fn(async () => ({ stillKept: null, note: null })),
  saveApp: vi.fn(async () => {}),
  start: vi.fn(),
  approveAgain: vi.fn(),
  flow: vi.fn(),
  cancel: vi.fn(async () => {}),
  picks: vi.fn(async () => []),
  setPicks: vi.fn(async () => []),
  setups: vi.fn(async () => []),
  signedIn: vi.fn(),
  choose: vi.fn(),
  pasteToken: vi.fn(),
  pasteApp: vi.fn(),
  ...over,
});

const show = async (a: ConnectionsApi, ask: (c: Connector | null) => boolean = () => true) => {
  render(<Connections api={a} ask={ask} />);
  await act(async () => {});
};

const service = (name: string) => screen.getByRole("listitem", { name });

const jira = connector({
  id: "jira",
  name: "Jira",
  connections: [
    connection({
      id: "all~~default",
      name: "Acme",
      site: "acme.atlassian.net",
      usedBy: [
        { agent: "desk", name: "Desk", connection: "mine" },
        { agent: "allan", name: "Allan", connection: "mine" },
      ],
    }),
    connection({
      id: "agent~lattice~globex",
      name: "Globex",
      site: "globex.atlassian.net",
      level: "agent",
      agent: "lattice",
      agentName: "Lattice",
      account: "sam@globex.example",
      usedBy: [{ agent: "lattice", name: "Lattice", connection: "own" }],
    }),
  ],
  usedBy: [
    { agent: "desk", name: "Desk", connection: "mine" },
    { agent: "allan", name: "Allan", connection: "mine" },
    { agent: "lattice", name: "Lattice", connection: "own" },
  ],
});

it("shows a service's several connections, each with its account, for whom and who uses it", async () => {
  await show(api([jira]));
  const card = service("Jira");
  expect(within(card).getByText("2 connections · 3 agents use them")).toBeTruthy();
  const acme = within(card).getByLabelText("Acme");
  expect(within(acme).getByText("acme.atlassian.net")).toBeTruthy();
  expect(within(acme).getByText("sarah@acme.example")).toBeTruthy();
  expect(within(acme).getByText("All my agents")).toBeTruthy();
  expect(within(acme).getByText("Desk and Allan")).toBeTruthy();
  const globex = within(card).getByLabelText("Globex");
  expect(within(globex).getByText("Just Lattice")).toBeTruthy();
  expect(within(card).getByRole("button", { name: "+ Add another Jira" })).toBeTruthy();
  // No raw ids or keys anywhere.
  expect(document.body.textContent).not.toMatch(/~|default|global_per_user/);
});

it("adds another connection with a name, tested before anything is kept", async () => {
  const a = api([jira]);
  await show(a);
  fireEvent.click(screen.getByRole("button", { name: "+ Add another Jira" }));
  const form = screen.getByRole("group", { name: "Add another Jira" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: " Initech " } });
  fireEvent.change(within(form).getByLabelText("API key"), { target: { value: " key " } });
  await act(async () => {
    fireEvent.click(within(form).getByRole("button", { name: "Save and connect" }));
  });
  expect(a.connect).toHaveBeenCalledWith("jira", { level: "all" }, { api_key: "key" }, "Initech");
  expect(a.list).toHaveBeenCalledTimes(2);
});

it("keeps the form open with the service's own words when the test fails", async () => {
  const a = api([connector({ id: "linear", name: "Linear" })], {
    connect: vi.fn(async () => Promise.reject(new HubError(422, "Linear says this key is invalid"))),
  });
  await show(a);
  fireEvent.click(within(service("Linear")).getByRole("button", { name: "Connect" }));
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  });
  expect(screen.getByRole("alert").textContent).toBe("Linear says this key is invalid");
  expect(screen.getByLabelText("API key")).toBeTruthy();
});

it("renames a connection in place", async () => {
  const a = api([jira]);
  await show(a);
  const acme = within(service("Jira")).getByLabelText("Acme");
  fireEvent.click(within(acme).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(acme).getByLabelText("New name for Acme"), { target: { value: "Acme Corp" } });
  await act(async () => {
    fireEvent.click(within(acme).getByRole("button", { name: "Save" }));
  });
  expect(a.rename).toHaveBeenCalledWith("jira", "all~~default", "Acme Corp");
});

it("tests, reconnects and disconnects the connection it is on, saying who loses it", async () => {
  const a = api([jira]);
  await show(a);
  const acme = within(service("Jira")).getByLabelText("Acme");
  await act(async () => {
    fireEvent.click(within(acme).getByRole("button", { name: "Test" }));
  });
  expect(a.test).toHaveBeenCalledWith("jira", "all~~default");

  fireEvent.click(within(acme).getByRole("button", { name: "Disconnect" }));
  const asking = within(acme).getByText("Desk and Allan will lose Acme.").parentElement!;
  await act(async () => {
    fireEvent.click(within(asking).getByRole("button", { name: "Disconnect" }));
  });
  expect(a.disconnect).toHaveBeenCalledWith("jira", "all~~default");

  const globex = within(service("Jira")).getByLabelText("Globex");
  fireEvent.click(within(globex).getByRole("button", { name: "Reconnect" }));
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "new" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  });
  expect(a.reconnect).toHaveBeenCalledWith("jira", "agent~lattice~globex", { api_key: "new" });
});

it("says what is wrong with a connection, and offers its fix", async () => {
  await show(
    api([
      connector({
        id: "email",
        name: "Email",
        signIn: "fields",
        connections: [
          connection({ id: "all~~work", name: "Work" }),
          connection({ id: "all~~personal", name: "Personal", status: "needs_reconnect", detail: "The mailbox refused the password" }),
        ],
      }),
    ]),
  );
  const card = service("Email");
  fireEvent.click(within(card).getByRole("button", { name: "Close" }));
  expect(card.querySelector(".conn-summary")!.textContent).toBe("Work · Personal (needs signing in again)");
  expect(within(card).getByText("(needs signing in again)")).toBeTruthy();
  expect(card.querySelector(".conn-dot-blocked")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Manage" }));
  const personal = within(card).getByLabelText("Personal");
  expect(within(personal).getByText(/The mailbox refused the password. Reconnect it to carry on./)).toBeTruthy();
  expect(within(personal).getByRole("button", { name: "Reconnect" }).className).toContain("btn-signal");
});

it("has Desk set a service up, in its chat", async () => {
  const asked: (string | null)[] = [];
  await show(api([connector({ id: "datadog", name: "Datadog" }), connector({ id: "slack", name: "Slack", several: false })]), (c) => {
    asked.push(c?.id ?? null);
    return true;
  });
  expect(within(service("Datadog")).getByText("Not connected")).toBeTruthy();
  fireEvent.click(within(service("Datadog")).getByRole("button", { name: "Have Desk set it up" }));
  // Slack is connected by the person.
  expect(within(service("Slack")).queryByRole("button", { name: "Have Desk set it up" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Ask an agent to set one up" }));
  expect(asked).toEqual(["datadog", null]);
});

it("says what to do when Desk's agent isn't there to ask", async () => {
  await show(api([connector({ id: "datadog", name: "Datadog" })]), () => false);
  fireEvent.click(screen.getByRole("button", { name: "Have Desk set it up" }));
  expect(screen.getByRole("status").textContent).toMatch(/Connect it yourself/);
});

it("says when a key saved for the whole hub still connects it after Disconnect", async () => {
  const note = "A Linear key saved for everyone on this hub is still kept, so agents still reach Linear.";
  const a = api([connector({ id: "linear", name: "Linear", connections: [connection()] })], {
    disconnect: vi.fn(async () => ({ stillKept: "global", note })),
  });
  await show(a);
  fireEvent.click(within(service("Linear")).getByRole("button", { name: "Manage" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  const asking = screen.getByText("Disconnect Acme?").parentElement!;
  await act(async () => {
    fireEvent.click(within(asking).getByRole("button", { name: "Disconnect" }));
  });
  expect(screen.getByRole("status").textContent).toBe(note);
});

it("signs in to GitHub with a code for a new connection, and says nothing was saved when it's cancelled", async () => {
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
  fireEvent.click(within(service("GitHub")).getByRole("button", { name: "Connect" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "acme" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  });
  expect(a.start).toHaveBeenCalledWith("github", { level: "all" }, "acme");
  expect(screen.getByText("ABCD-1234")).toBeTruthy();
  expect(opened).toEqual(["https://github.com/login/device"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByText("Sign-in was cancelled. Nothing was saved.")).toBeTruthy();
});

const google = (c: Partial<Connector> = {}) => connector({ id: "google", name: "Google", signIn: "app", app: "ready", fields: [], ...c });
const freeagent = (c: Partial<Connector> = {}) => connector({ id: "freeagent", name: "FreeAgent", signIn: "app", app: "ready", fields: [], ...c });
const BROWSER = { flow: "g1", url: "https://accounts.google.com/o/oauth2/auth?x", userCode: null, verificationUri: null, expiresIn: 900 };

describe("signing in on the person's own app", () => {
  it("signs in in the browser once the app is kept, and says so while it waits", async () => {
    const a = api([google()], {
      start: vi.fn(async () => BROWSER),
      flow: vi.fn(async () => ({ state: "waiting" as const })),
    });
    await show(a);
    fireEvent.click(within(service("Google")).getByRole("button", { name: "Connect" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    });
    expect(a.start).toHaveBeenCalledWith("google", { level: "all" }, undefined);
    expect(opened).toEqual([BROWSER.url]);
    expect(screen.getByText("Waiting for Google…")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(a.cancel).toHaveBeenCalledWith("g1");
    expect(screen.getByText("Sign-in was cancelled. Nothing was saved.")).toBeTruthy();
  });

  it("tells FreeAgent's person to choose the business on its page", async () => {
    await show(api([freeagent()]));
    fireEvent.click(within(service("FreeAgent")).getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Choose the business on FreeAgent’s page.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with FreeAgent" })).toBeTruthy();
    cleanup();
    await show(api([google()]));
    fireEvent.click(within(service("Google")).getByRole("button", { name: "Connect" }));
    expect(screen.queryByText(/Choose the business/)).toBeNull();
  });

  it("asks the agent to set the app up when there is none, and leaves the page", async () => {
    withDeskAgent();
    const closed = vi.spyOn(useUi.getState(), "closeSettings");
    await show(api([google({ app: "missing", signInReady: false })]));
    fireEvent.click(within(service("Google")).getByRole("button", { name: "Connect" }));
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Kat to set it up" }));
    expect(asked).toEqual([
      { agent: "desk", text: "Set up Google for yourself: make the key in your browser and keep it in the vault. I’ll sign in when you ask." },
    ]);
    expect(closed).toHaveBeenCalled();
  });

  it("keeps an app the person already has, then signs in", async () => {
    withDeskAgent();
    const a = api([freeagent({ app: "missing", signInReady: false })], {
      start: vi.fn(async () => ({ ...BROWSER, url: "https://api.freeagent.com/v2/approve_app?x" })),
      flow: vi.fn(async () => ({ state: "waiting" as const })),
    });
    await show(a);
    fireEvent.click(within(service("FreeAgent")).getByRole("button", { name: "Connect" }));
    fireEvent.click(screen.getByRole("button", { name: "I have an app already" }));
    fireEvent.change(screen.getByLabelText("OAuth identifier"), { target: { value: " id-1 " } });
    fireEvent.change(screen.getByLabelText("OAuth secret"), { target: { value: " s-1 " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save app" }));
    });
    expect(a.saveApp).toHaveBeenCalledWith("freeagent", "id-1", "s-1");
    expect(a.list).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with FreeAgent" }));
    });
    expect(opened).toEqual(["https://api.freeagent.com/v2/approve_app?x"]);
  });

  it("goes back from the app form to the choices, and says what the hub refused", async () => {
    withDeskAgent();
    const a = api([google({ app: "missing", signInReady: false })], {
      saveApp: vi.fn(async () => Promise.reject(new HubError(422, "That client id isn’t one of Google’s"))),
    });
    await show(a);
    fireEvent.click(within(service("Google")).getByRole("button", { name: "Connect" }));
    fireEvent.click(screen.getByRole("button", { name: "I have an app already" }));
    expect((screen.getByRole("button", { name: "Save app" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "y" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save app" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("That client id isn’t one of Google’s");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Ask Kat to set it up" })).toBeTruthy();
  });

  it("says Desk's address changed when FreeAgent's app was made for an older one", async () => {
    withDeskAgent();
    await show(api([freeagent({ app: "moved", signInReady: false })]));
    fireEvent.click(within(service("FreeAgent")).getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Desk’s address changed. Ask Kat to update your FreeAgent app.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask Kat to set it up" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I have an app already" })).toBeTruthy();
  });

  it("shows only the form where there is no agent to ask", async () => {
    await show(api([google({ app: "missing", signInReady: false })]));
    fireEvent.click(within(service("Google")).getByRole("button", { name: "Connect" }));
    expect(screen.getByLabelText("Client ID")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /to set it up/ })).toBeNull();
  });

  it("asks again for a connection whose sign-in lapsed, as a new sign-in is waited on, and reads the list after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lapsed = connection({ id: "all~~acme", name: "Acme Ltd", account: "Acme Ltd", status: "needs_reconnect", approveAgain: true });
    const a = api([freeagent({ connections: [lapsed] })], {
      approveAgain: vi.fn(async () => ({ ...BROWSER, url: "https://api.freeagent.com/v2/approve_app?y" })),
      flow: vi.fn(async () => ({ state: "connected" as const, account: "Acme Ltd" })),
    });
    await show(a);
    fireEvent.click(within(service("FreeAgent")).getByRole("button", { name: "Manage" }));
    const card = within(service("FreeAgent")).getByLabelText("Acme Ltd");
    expect(within(card).getAllByText(/to carry on/)).toHaveLength(1);
    expect(within(card).getByText("Approve Desk on FreeAgent again to carry on with Acme Ltd.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Approve again" }));
    });
    expect(a.approveAgain).toHaveBeenCalledWith("freeagent", "all~~acme");
    expect(opened).toEqual(["https://api.freeagent.com/v2/approve_app?y"]);
    expect(a.start).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(a.flow).toHaveBeenCalledWith("g1");
    expect(a.list).toHaveBeenCalledTimes(2);
  });

  it("offers to set the app up, not to approve again, where the app isn't kept", async () => {
    withDeskAgent();
    const lapsed = connection({ id: "all~~acme", name: "Acme Ltd", status: "needs_reconnect", approveAgain: true });
    const a = api([freeagent({ app: "missing", signInReady: false, connections: [lapsed] })]);
    await show(a);
    fireEvent.click(within(service("FreeAgent")).getByRole("button", { name: "Manage" }));
    const card = within(service("FreeAgent")).getByLabelText("Acme Ltd");
    expect(within(card).queryByRole("button", { name: "Approve again" })).toBeNull();
    expect(within(card).getByText(/app isn’t kept/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Ask Kat to set it up" }));
    expect(asked).toHaveLength(1);
    expect(a.approveAgain).not.toHaveBeenCalled();
  });

  it("offers no approving again to a connection that doesn't need it", async () => {
    await show(api([freeagent({ connections: [connection({ id: "all~~acme", name: "Acme Ltd" })] })]));
    fireEvent.click(within(service("FreeAgent")).getByRole("button", { name: "Manage" }));
    expect(screen.queryByRole("button", { name: "Approve again" })).toBeNull();
  });

  it("lists several FreeAgent connections by name, each with its company", async () => {
    const fa = freeagent({
      connections: [
        connection({ id: "all~~acme", name: "Acme", account: "Acme Ltd" }),
        connection({ id: "all~~globex", name: "Globex", account: "Globex Trading", level: "agent", agent: "kat", agentName: "Kat" }),
      ],
    });
    await show(api([fa]));
    const card = service("FreeAgent");
    expect(within(card).getByText("2 connections")).toBeTruthy();
    expect(within(within(card).getByLabelText("Acme")).getByText("Acme Ltd")).toBeTruthy();
    expect(within(within(card).getByLabelText("Globex")).getByText("Globex Trading")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "+ Add another FreeAgent" })).toBeTruthy();
  });
});

it("says when Desk couldn't read the connections, and asks again", async () => {
  const a = api([], { list: vi.fn(async () => Promise.reject(new Error("down"))) });
  await show(a);
  expect(screen.getByRole("alert").textContent).toBe("Desk couldn’t read your connections just now.");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  expect(a.list).toHaveBeenCalledTimes(2);
});

it("says so when Desk on this computer has no connections yet", async () => {
  await show(api([], { list: vi.fn(async () => Promise.reject(new HubError(404, "no route"))) }));
  expect(screen.getByText(/doesn’t offer connections yet/)).toBeTruthy();
});

describe("reconnecting a connection made by signing in", () => {
  const work = connection({
    id: "all~~work",
    name: "Work",
    account: "sam@acme.example",
    status: "needs_reconnect",
    usedBy: [
      { agent: "allan", name: "Allan", connection: "mine" },
      { agent: "lattice", name: "Lattice", connection: "mine" },
    ],
  });
  const personal = connection({ id: "all~~personal", name: "Personal" });
  const google = connector({ id: "google", name: "Google", signIn: "app", app: "ready", fields: [], connections: [work, personal] });
  // Another sign-in, of someone else's account, made just before.
  const other = connection({ id: "all~~work-3", name: "Work", account: "kim@acme.example" });
  const fresh = connection({ id: "all~~work-2", name: "Work", account: "sam@acme.example", connectedAt: new Date().toISOString() });
  const picksOf = (agent: string): ServicePicks[] =>
    agent === "allan"
      ? [
          {
            id: "google",
            name: "Google",
            several: true,
            readOnlyEach: false,
            chosen: true,
            connections: [
              { id: "all~~personal", name: "Personal", site: null, account: null, level: "all", status: "connected", picked: true, write: false, default: false },
              { id: "all~~work", name: "Work", site: null, account: null, level: "all", status: "needs_reconnect", picked: true, write: false, default: true },
            ],
          },
        ]
      : // Lattice follows whom a connection is for: the new one reaches it already.
        [{ id: "google", name: "Google", several: true, readOnlyEach: false, chosen: false, connections: [] }];

  const signIn = async (a: ConnectionsApi) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await show(a);
    const card = within(service("Google")).getByLabelText("Work");
    fireEvent.click(within(card).getByRole("button", { name: "Reconnect" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
  };

  const hub = (over: Partial<ConnectionsApi> = {}) => {
    let signedIn = false;
    const moved = new Set<string>();
    return api([], {
      list: vi.fn(async () => ({
        connectors: [{ ...google, connections: signedIn ? [work, personal, other, fresh] : [work, personal] }],
        adapters: [],
      })),
      start: vi.fn(async () => ({ flow: "g1", url: "https://accounts.google.com/x", userCode: null, verificationUri: null, expiresIn: 900 })),
      flow: vi.fn(async () => {
        signedIn = true;
        return { state: "connected" as const, account: "sam@acme.example" };
      }),
      // Ben picks as Allan does.
      picks: vi.fn(async (agent: string) => (moved.has(agent) ? [] : picksOf(agent === "ben" ? "allan" : agent))),
      ...over,
      // An agent moved over picks the old one no more.
      setPicks: vi.fn(async (agent: string, change: PicksChange) => {
        const got = await (over.setPicks ?? (async () => []))(agent, change);
        moved.add(agent);
        return got;
      }),
    });
  };

  it("moves each agent that picked it over to the new sign-in, as it was, before the old one goes", async () => {
    const order: string[] = [];
    const a = hub({
      setPicks: vi.fn(async () => (order.push("picks"), [])),
      disconnect: vi.fn(async () => (order.push("disconnect"), { stillKept: null, note: null })),
    });
    await signIn(a);
    expect(a.setPicks).toHaveBeenCalledTimes(1);
    expect(a.setPicks).toHaveBeenCalledWith("allan", {
      service: "google",
      connections: [
        { id: "all~~personal", write: false },
        { id: "all~~work-2", write: false },
      ],
      default: "all~~work-2",
    });
    expect(a.disconnect).toHaveBeenCalledWith("google", "all~~work");
    expect(order).toEqual(["picks", "disconnect"]);
  });

  it("says so when the old one couldn't be removed, keeps it, and finishes from there", async () => {
    let locked = true;
    const a = hub({
      setPicks: vi.fn(async () => []),
      disconnect: vi.fn(async () => {
        if (locked) throw new HubError(500, "The vault is locked");
        return { stillKept: null, note: null };
      }),
    });
    await signIn(a);
    const old = within(service("Google")).getAllByLabelText("Work")[0]!;
    const said = within(old).getByRole("alert");
    expect(said.textContent).toMatch(/^Signed in again, but Desk couldn’t remove the old Work: The vault is locked\./);
    locked = false;
    await act(async () => {
      fireEvent.click(within(said).getByRole("button", { name: "Finish moving to the new sign-in" }));
    });
    expect(a.disconnect).toHaveBeenCalledTimes(2);
    // Nothing more made: no third sign-in.
    expect(a.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the new sign-in and the old one when an agent couldn't be moved, and moves it on asking again", async () => {
    let down = true;
    const setPicks = vi.fn(async () => {
      if (down) throw new Error("no");
      return [];
    });
    const a = hub({ setPicks });
    await signIn(a);
    expect(a.disconnect).not.toHaveBeenCalled();
    const said = screen.getByRole("alert");
    expect(said.textContent).toMatch(/couldn’t move Allan over to it yet, so the old Work is kept too/);
    down = false;
    await act(async () => {
      fireEvent.click(within(said).getByRole("button", { name: "Finish moving to the new sign-in" }));
    });
    expect(a.setPicks).toHaveBeenLastCalledWith("allan", expect.objectContaining({ default: "all~~work-2" }));
    expect(a.disconnect).toHaveBeenCalledWith("google", "all~~work");
    expect(a.start).toHaveBeenCalledTimes(1);
  });

  it("moves an agent that picked the old one while the sign-in ran, read again before it goes", async () => {
    const a = hub();
    let reads = 0;
    const lists = a.list as ReturnType<typeof vi.fn>;
    const real = lists.getMockImplementation() as () => Promise<{ connectors: Connector[]; adapters: string[] }>;
    lists.mockImplementation(async () => {
      const got = await real();
      reads += 1;
      // From the second read on, Ben uses it too.
      return reads < 3
        ? got
        : {
            ...got,
            connectors: got.connectors.map((k: Connector) => ({
              ...k,
              connections: k.connections.map((x: Connection) =>
                x.id === "all~~work" ? { ...x, usedBy: [...x.usedBy, { agent: "ben", name: "Ben", connection: "mine" as const }] } : x,
              ),
            })),
          };
    });
    await signIn(a);
    expect((a.setPicks as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain("ben");
  });
});

it("reconnects GitHub with a token in place, so its agents keep it", async () => {
  const a = api([connector({ id: "github", name: "GitHub", signIn: "github", fields: [{ name: "token", label: "Token", secret: true, required: true, placeholder: "" }], connections: [connection({ id: "all~~acme", name: "acme" })] })]);
  await show(a);
  fireEvent.click(within(service("GitHub")).getByRole("button", { name: "Manage" }));
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  fireEvent.click(screen.getByRole("button", { name: "Use a token instead" }));
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: "t" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  });
  expect(a.reconnect).toHaveBeenCalledWith("github", "all~~acme", { token: "t" });
  expect(a.connect).not.toHaveBeenCalled();
  expect(a.disconnect).not.toHaveBeenCalled();
});

it("won't add or rename a connection to a name the service has already", async () => {
  const a = api([jira]);
  await show(a);
  fireEvent.click(screen.getByRole("button", { name: "+ Add another Jira" }));
  const form = screen.getByRole("group", { name: "Add another Jira" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: " globex " } });
  fireEvent.change(within(form).getByLabelText("API key"), { target: { value: "key" } });
  expect(within(form).getByRole("alert").textContent).toBe("Jira has a connection called Globex already. Give this one another name.");
  expect((within(form).getByRole("button", { name: "Save and connect" }) as HTMLButtonElement).disabled).toBe(true);

  const acme = within(service("Jira")).getByLabelText("Acme");
  fireEvent.click(within(acme).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(acme).getByLabelText("New name for Acme"), { target: { value: "Globex" } });
  expect(within(acme).getByRole("alert").textContent).toMatch(/called Globex already/);
  expect((within(acme).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  // Its own name, in other letters, is fine.
  fireEvent.change(within(acme).getByLabelText("New name for Acme"), { target: { value: "ACME" } });
  expect(within(acme).queryByRole("alert")).toBeNull();
});

describe("a bank", () => {
  const approval = (daysLeft: number) => ({ until: "2027-02-19", daysLeft, due: daysLeft <= 7, estimated: true });
  const renewal = {
    service: "BankSync",
    label: "Bank approval",
    page: "https://app.banksync.io",
    open: "Open BankSync",
    about: "Renew the approval in BankSync: it takes you to your bank to approve it again.",
    done: "I’ve renewed it, check it",
  };
  const bank = (days: number) =>
    connector({
      id: "bank",
      name: "Bank",
      renewal,
      readsOnly: true,
      connections: [connection({ id: "agent~kat~natwest", name: "NatWest", account: "NatWest", approval: approval(days) })],
    });

  it("says about when its approval lapses, on the hub's UTC date, and marks it when due", async () => {
    await show(api([bank(40)]));
    expect(within(service("Bank")).queryByText(/approved until/)).toBeNull();
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Manage" }));
    const row = within(service("Bank")).getByLabelText("NatWest");
    expect(within(row).getByText("Bank approval")).toBeTruthy();
    const line = within(row).getByText(/^Approved until about .*19.* \(40 days\)$/);
    expect(line.textContent).toMatch(/Feb/);
    expect(line.textContent?.match(/about|estimated/g)).toHaveLength(1);
    expect(line.className).not.toContain("state-blocked");
    cleanup();
    await show(api([bank(5)]));
    expect(within(service("Bank")).getByText(/^\(approved until about .* \(5 days\)\)$/).className).toContain("state-blocked");
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Manage" }));
    expect(within(service("Bank")).getByText(/^Approved until about .* \(5 days\)$/).className).toContain("state-blocked");
  });

  it("is told apart by the hub's renewal, not by an approval date", async () => {
    const plain = connector({ id: "jira", name: "Jira", connections: [connection({ id: "all~~acme", name: "Acme" })] });
    const undated = connector({ ...bank(40), connections: [connection({ id: "agent~kat~natwest", name: "NatWest" })] });
    await show(api([plain, undated]));
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Manage" }));
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Reconnect" }));
    expect(screen.getByLabelText("Reconnect NatWest").textContent).toContain(renewal.about);
  });

  it("says a lapsed one needs renewing, and what BankSync still says when it isn't", async () => {
    const lapsed = (detail: string | null) =>
      connection({ id: "agent~kat~natwest", name: "NatWest", status: "needs_reconnect", detail, approval: approval(-1) });
    const renew = vi.fn<ConnectionsApi["renew"]>().mockResolvedValue(lapsed(null));
    await show(api([{ ...bank(-1), connections: [lapsed("Approval lapsed")] }], { renew }));
    expect(within(service("Bank")).getByText(/needs renewing/)).toBeTruthy();
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Manage" }));
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Reconnect" }));
    const card = screen.getByLabelText("Reconnect NatWest");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: renewal.done }));
    });
    expect(within(card).getByRole("alert").textContent).toBe("BankSync still says NatWest isn’t approved.");
  });

  it("is reconnected by renewing it in BankSync, then checked, never by typing a key", async () => {
    const lapsed = connection({ id: "agent~kat~natwest", name: "NatWest", status: "needs_reconnect", detail: "Approval lapsed" });
    const renew = vi
      .fn<ConnectionsApi["renew"]>()
      .mockResolvedValueOnce(lapsed)
      .mockResolvedValueOnce(connection({ id: "agent~kat~natwest", approval: approval(90) }));
    const a = api([bank(-1)], { renew });
    await show(a);
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Manage" }));
    fireEvent.click(within(service("Bank")).getByRole("button", { name: "Reconnect" }));
    const card = screen.getByLabelText("Reconnect NatWest");
    expect(within(card).queryByLabelText("API key")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Open BankSync" }));
    expect(opened).toEqual(["https://app.banksync.io"]);

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "I’ve renewed it, check it" }));
    });
    expect(within(card).getByRole("alert").textContent).toBe("Approval lapsed.");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "I’ve renewed it, check it" }));
    });
    expect(renew).toHaveBeenCalledWith("bank", "agent~kat~natwest");
    expect(screen.queryByLabelText("Reconnect NatWest")).toBeNull();
    expect(a.reconnect).not.toHaveBeenCalled();
  });
});
