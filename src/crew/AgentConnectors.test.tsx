import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { HubError, type DeskHub } from "../hub/client";
import type { ConnectionsApi, Connector, Listing, Pick as Choice, PicksChange, ServicePicks } from "../hub/connections";
import { useDesk } from "../hub/store";
import { AgentConnectors } from "./AgentConnectors";
import { useAgentConfigs } from "./agentBrain";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const ALLAN: Agent = { hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false };

const pick = (p: Partial<Choice> & Pick<Choice, "id" | "name">): Choice => ({
  site: null,
  account: null,
  level: "all",
  status: "connected",
  picked: false,
  write: true,
  default: false,
  ...p,
});

const svc = (s: Partial<ServicePicks> & Pick<ServicePicks, "id" | "name">): ServicePicks => ({
  several: true,
  readOnlyEach: true,
  chosen: false,
  connections: [],
  ...s,
});

const JIRA = svc({
  id: "jira",
  name: "Jira",
  connections: [
    pick({ id: "all~~default", name: "Acme", site: "acme.atlassian.net", picked: true, default: true }),
    pick({ id: "all~~globex", name: "Globex", site: "globex.atlassian.net", picked: true, write: false }),
  ],
});
const EMAIL = svc({
  id: "email",
  name: "Email",
  readOnlyEach: false,
  connections: [
    pick({ id: "all~~work", name: "Work", account: "sam@acme.example", picked: true, write: false }),
    pick({ id: "all~~personal", name: "Personal", account: "sam@mail.example" }),
  ],
});
const DATADOG = svc({ id: "datadog", name: "Datadog" });

let config = "";

const api = (services: ServicePicks[], over: Partial<ConnectionsApi> = {}): ConnectionsApi => ({
  list: vi.fn(),
  connect: vi.fn(),
  reconnect: vi.fn(),
  rename: vi.fn(),
  test: vi.fn(),
  disconnect: vi.fn(),
  saveGoogleClient: vi.fn(),
  start: vi.fn(),
  flow: vi.fn(),
  cancel: vi.fn(),
  picks: vi.fn(async () => services),
  setPicks: vi.fn(async () => services),
  setups: vi.fn(async () => []),
  signedIn: vi.fn(),
  ...over,
});

beforeEach(() => {
  config = "";
  useAgentConfigs.setState({ configs: {} });
  useDesk.setState({
    hub: {
      agentConfig: vi.fn(async () => config),
      saveAgentConfig: vi.fn(async (_id: string, toml: string) => {
        config = toml;
      }),
      computerActivity: vi.fn(async () => ({ rows: [], next: null })),
    } as unknown as DeskHub,
  });
});
afterEach(cleanup);

const show = async (a: ConnectionsApi, ask?: (agent: Agent, service: string) => boolean) => {
  render(<AgentConnectors agent={ALLAN} api={a} ask={ask} />);
  await act(async () => {});
};

const box = (name: string) => screen.getByRole("listitem", { name: `${name} for Allan` });

it("shows a checkbox per connection, whether each takes changes, and the default", async () => {
  await show(api([JIRA, EMAIL, DATADOG]));
  const jira = box("Jira");
  expect(within(jira).getByText("2 of 2 on")).toBeTruthy();
  expect((within(jira).getByRole("checkbox", { name: /Acme/ }) as HTMLInputElement).checked).toBe(true);
  expect(within(jira).getByRole("button", { name: /Acme: read and write/ })).toBeTruthy();
  expect(within(jira).getByRole("button", { name: /Globex: read only/ })).toBeTruthy();
  expect(within(jira).getByText("Acme", { selector: ".conn-pick-default-name" })).toBeTruthy();
  const email = box("Email");
  expect(within(email).getByText("1 of 2 on")).toBeTruthy();
  expect(within(email).getByText("off")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/~/);
});

it("turns a connection on, keeping the rest and the default", async () => {
  const a = api([EMAIL]);
  await show(a);
  await act(async () => {
    fireEvent.click(within(box("Email")).getByRole("checkbox", { name: /Personal/ }));
  });
  const change = (a.setPicks as ReturnType<typeof vi.fn>).mock.calls[0]![1] as PicksChange;
  expect(change).toEqual({
    service: "email",
    connections: [
      { id: "all~~work", write: false },
      { id: "all~~personal", write: true },
    ],
    default: "all~~work",
  });
  expect(screen.getByRole("status").textContent).toBe("Saved.");
});

it("lets one connection only read, or, where they go together, all of them", async () => {
  const a = api([JIRA, EMAIL]);
  await show(a);
  await act(async () => {
    fireEvent.click(within(box("Jira")).getByRole("button", { name: /Globex: read only/ }));
  });
  expect((a.setPicks as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({
    service: "jira",
    connections: [
      { id: "all~~default", write: true },
      { id: "all~~globex", write: true },
    ],
    default: "all~~default",
  });
  await act(async () => {
    fireEvent.click(within(box("Email")).getByRole("button", { name: /Work: read only/ }));
  });
  expect((a.setPicks as ReturnType<typeof vi.fn>).mock.calls[1]![1]).toEqual({
    service: "email",
    connections: [{ id: "all~~work", write: true }],
    default: "all~~work",
  });
});

it("changes the default", async () => {
  const a = api([JIRA]);
  await show(a);
  fireEvent.click(within(box("Jira")).getByRole("button", { name: "change" }));
  await act(async () => {
    fireEvent.change(within(box("Jira")).getByLabelText("Jira default"), { target: { value: "all~~globex" } });
  });
  expect(((a.setPicks as ReturnType<typeof vi.fn>).mock.calls[0]![1] as PicksChange).default).toBe("all~~globex");
});

it("asks the agent to set up a service it has no connection to, or offers to connect it", async () => {
  const asked: string[] = [];
  await show(api([DATADOG, svc({ id: "slack", name: "Slack", several: false })]), (_a, s) => {
    asked.push(s);
    return true;
  });
  const dd = box("Datadog");
  expect(within(dd).getByText("no connection yet")).toBeTruthy();
  fireEvent.click(within(dd).getByRole("button", { name: "Ask Allan to set it up" }));
  expect(asked).toEqual(["Datadog"]);
  expect(within(dd).getByRole("button", { name: "Connect myself" })).toBeTruthy();
  // Slack the person connects.
  expect(within(box("Slack")).queryByRole("button", { name: "Ask Allan to set it up" })).toBeNull();
});

it("turns Slack's one connection on through the agent's own settings", async () => {
  const slack = svc({ id: "slack", name: "Slack", several: false, connections: [pick({ id: "all~~default", name: "Slack" })] });
  const a = api([slack]);
  await show(a);
  await act(async () => {
    fireEvent.click(within(box("Slack")).getByRole("checkbox", { name: /Slack/ }));
  });
  expect(a.setPicks).not.toHaveBeenCalled();
  expect((parse(config).skills as { enabled: string[] }).enabled).toContain("slack");
});

it("says what went wrong saving, and tries again", async () => {
  let fail = true;
  const a = api([EMAIL], {
    setPicks: vi.fn(async () => {
      if (fail) throw new HubError(400, "That Email connection isn’t there any more. Reload Connections.");
      return [EMAIL];
    }),
  });
  await show(a);
  await act(async () => {
    fireEvent.click(within(box("Email")).getByRole("checkbox", { name: /Personal/ }));
  });
  expect(screen.getByRole("status").textContent).toMatch(/isn’t there any more/);
  fail = false;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  expect(screen.getByRole("status").textContent).toBe("Saved.");
});

/** A hub that keeps what it is told, and answers each save only when let. */
const slowHub = (start: ServicePicks[]) => {
  let state = start;
  const waiting: (() => void)[] = [];
  const setPicks = vi.fn(
    (_agent: string, change: PicksChange) =>
      new Promise<ServicePicks[]>((done) => {
        waiting.push(() => {
          state = state.map((s) =>
            s.id !== change.service
              ? s
              : {
                  ...s,
                  chosen: true,
                  connections: s.connections.map((p) => {
                    const use = change.connections.find((c) => c.id === p.id);
                    return { ...p, picked: !!use, write: use?.write ?? p.write, default: change.default === p.id };
                  }),
                },
          );
          done(state);
        });
      }),
  );
  return { setPicks, answer: () => waiting.shift()!(), state: () => state };
};

it("keeps every quick tick: a queued save works from what the last one left, not what was on screen", async () => {
  const off = svc({
    id: "jira",
    name: "Jira",
    connections: [pick({ id: "all~~acme", name: "Acme" }), pick({ id: "all~~globex", name: "Globex" })],
  });
  const hub = slowHub([off]);
  const a = api([off], { setPicks: hub.setPicks });
  await show(a);
  // Both ticked before the first save comes back.
  await act(async () => {
    fireEvent.click(within(box("Jira")).getByRole("checkbox", { name: /Acme/ }));
  });
  await act(async () => {
    fireEvent.click(within(box("Jira")).getByRole("checkbox", { name: /Globex/ }));
  });
  await act(async () => hub.answer());
  await act(async () => hub.answer());
  const second = hub.setPicks.mock.calls[1]![1];
  expect(second.connections.map((c) => c.id)).toEqual(["all~~acme", "all~~globex"]);
  expect(within(box("Jira")).getByText("2 of 2 on")).toBeTruthy();
});

it("tries a failed save again from what is there now", async () => {
  const off = svc({
    id: "jira",
    name: "Jira",
    connections: [pick({ id: "all~~acme", name: "Acme" }), pick({ id: "all~~globex", name: "Globex" })],
  });
  const hub = slowHub([off]);
  let fail = true;
  const a = api([off], {
    setPicks: vi.fn(async (agent: string, change: PicksChange) => {
      if (fail && change.connections.some((c) => c.id === "all~~globex")) throw new Error("Desk couldn’t save that just now.");
      const p = hub.setPicks(agent, change);
      hub.answer();
      return p;
    }),
  });
  await show(a);
  // Acme saves; Globex, queued behind it, fails.
  await act(async () => {
    fireEvent.click(within(box("Jira")).getByRole("checkbox", { name: /Acme/ }));
    fireEvent.click(within(box("Jira")).getByRole("checkbox", { name: /Globex/ }));
  });
  expect(screen.getByRole("status").textContent).toMatch(/couldn’t save/);
  fail = false;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  const last = (a.setPicks as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as PicksChange;
  expect(last.connections.map((c) => c.id)).toEqual(["all~~acme", "all~~globex"]);
  expect(screen.getByRole("status").textContent).toBe("Saved.");
});

const listing = (ids: string[], adapters: string[]): Listing => ({
  connectors: ids.map((id) => ({ id, usedBy: [] }) as unknown as Connector),
  adapters,
});

it("turning Slack on for an agent nobody chose connectors for keeps every other one it had", async () => {
  const slack = svc({ id: "slack", name: "Slack", several: false, connections: [pick({ id: "all~~default", name: "Slack" })] });
  const a = api([slack, JIRA], { list: vi.fn(async () => listing(["slack", "jira", "linear"], ["notion", "hubspot"])) });
  await show(a);
  await act(async () => {
    fireEvent.click(within(box("Slack")).getByRole("checkbox", { name: /Slack/ }));
  });
  expect((parse(config).skills as { enabled: string[] }).enabled).toEqual(["hubspot", "jira", "linear", "notion", "slack"]);
});

it("keeps Slack on its own connection where the agent has one", async () => {
  const slack = svc({
    id: "slack",
    name: "Slack",
    several: false,
    connections: [pick({ id: "agent~allan~default", name: "Slack", level: "agent" })],
  });
  const a = api([slack], { list: vi.fn(async () => listing(["slack"], [])) });
  await show(a);
  await act(async () => {
    fireEvent.click(within(box("Slack")).getByRole("checkbox", { name: /Slack/ }));
  });
  expect((parse(config).skills as { own_credential: string[] }).own_credential).toEqual(["slack"]);
});

it("makes Slack read only, and says so once the hub does", async () => {
  const on = (write: boolean) =>
    svc({ id: "slack", name: "Slack", several: false, connections: [pick({ id: "all~~default", name: "Slack", picked: true, write })] });
  let write = true;
  const a = api([on(true)], {
    list: vi.fn(async () => listing(["slack"], [])),
    picks: vi.fn(async () => [on(write)]),
  });
  config = `[skills]\nenabled = ["slack"]\n`;
  await show(a);
  write = false;
  await act(async () => {
    fireEvent.click(within(box("Slack")).getByRole("button", { name: /Slack: read and write/ }));
  });
  expect((parse(config).skills as { read_only: string[] }).read_only).toEqual(["slack"]);
  expect(within(box("Slack")).getByRole("button", { name: /Slack: read only/ })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Saved.");
});

it("has its saving line there before the first save, so the first is read out", async () => {
  await show(api([EMAIL]));
  expect(screen.getByRole("status").textContent).toBe("");
});

it("takes two quick clicks on the same control as two: on then off, writes then not", async () => {
  const off = svc({
    id: "jira",
    name: "Jira",
    connections: [pick({ id: "all~~acme", name: "Acme" }), pick({ id: "all~~globex", name: "Globex", picked: true, default: true })],
  });
  const hub = slowHub([off]);
  const a = api([off], { setPicks: hub.setPicks });
  await show(a);
  const acme = () => within(box("Jira")).getByRole("checkbox", { name: /Acme/ }) as HTMLInputElement;
  await act(async () => {
    fireEvent.click(acme());
  });
  // Shown as made while it saves, so the next click turns it off.
  expect(acme().checked).toBe(true);
  await act(async () => {
    fireEvent.click(acme());
  });
  expect(acme().checked).toBe(false);
  const globex = () => within(box("Jira")).getByRole("button", { name: /Globex: / });
  await act(async () => {
    fireEvent.click(globex());
  });
  await act(async () => {
    fireEvent.click(globex());
  });
  expect(globex().textContent).toBe("read and write");
  for (let i = 0; i < 4; i++) await act(async () => hub.answer());
  const sent = hub.setPicks.mock.calls.map((c) => c[1].connections);
  expect(sent).toEqual([
    [
      { id: "all~~globex", write: true },
      { id: "all~~acme", write: true },
    ],
    [{ id: "all~~globex", write: true }],
    [{ id: "all~~globex", write: false }],
    [{ id: "all~~globex", write: true }],
  ]);
  expect(acme().checked).toBe(false);
  expect(globex().textContent).toBe("read and write");
  expect(screen.getByRole("status").textContent).toBe("Saved.");
});

it("says Saved only once every save is in and none failed since", async () => {
  const off = svc({
    id: "jira",
    name: "Jira",
    connections: [pick({ id: "all~~acme", name: "Acme" }), pick({ id: "all~~globex", name: "Globex" })],
  });
  const hub = slowHub([off]);
  let failAcme = true;
  const answers: (() => void)[] = [];
  const a = api([off], {
    setPicks: vi.fn(
      (agent: string, change: PicksChange) =>
        new Promise<ServicePicks[]>((done, fail) => {
          answers.push(() => {
            if (failAcme && change.connections.some((c) => c.id === "all~~acme")) return fail(new Error("Desk couldn’t save Acme."));
            const p = hub.setPicks(agent, change);
            hub.answer();
            void p.then(done);
          });
        }),
    ),
  });
  await show(a);
  await act(async () => {
    fireEvent.click(within(box("Jira")).getByRole("checkbox", { name: /Acme/ }));
  });
  await act(async () => {
    fireEvent.click(within(box("Jira")).getByRole("checkbox", { name: /Globex/ }));
  });
  await act(async () => answers.shift()!());
  // Acme failed; Globex still saving.
  expect(screen.getByRole("status").textContent).toBe("Saving…");
  await act(async () => answers.shift()!());
  // Globex is in, but Acme isn't: not "Saved."
  expect(screen.getByRole("status").textContent).toMatch(/couldn’t save Acme/);
  failAcme = false;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  await act(async () => answers.shift()!());
  expect(screen.getByRole("status").textContent).toBe("Saved.");
  expect(within(box("Jira")).getByText("2 of 2 on")).toBeTruthy();
});
