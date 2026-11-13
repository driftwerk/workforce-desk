import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import type { Connection, ConnectionsApi, Connector, PicksChange, ServicePicks } from "../hub/connections";
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
  disconnect: vi.fn(async () => ({ stillKept: null, note: null })),
  saveGoogleClient: vi.fn(async () => {}),
  start: vi.fn(),
  flow: vi.fn(),
  cancel: vi.fn(async () => {}),
  picks: vi.fn(async () => []),
  setPicks: vi.fn(async () => []),
  setups: vi.fn(async () => []),
  signedIn: vi.fn(),
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

it("asks for the person's own Google client once, then signs in in the browser", async () => {
  const a = api([connector({ id: "google", name: "Google", signIn: "google", signInReady: false, fields: [] })], {
    start: vi.fn(async () => ({ flow: "g1", url: "https://accounts.google.com/o/oauth2/auth?x", userCode: null, verificationUri: null, expiresIn: 900 })),
    flow: vi.fn(async () => ({ state: "waiting" as const })),
  });
  await show(a);
  fireEvent.click(within(service("Google")).getByRole("button", { name: "Connect" }));
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
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
  expect(a.cancel).toHaveBeenCalledWith("g1");
  expect(screen.getByText("Sign-in was cancelled. Nothing was saved.")).toBeTruthy();
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
  const google = connector({ id: "google", name: "Google", signIn: "google", fields: [], connections: [work, personal] });
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
