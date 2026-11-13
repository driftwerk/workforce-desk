import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import { useChat } from "./store";
import type { Agent, HubAccount } from "./types";

const fetches = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../hub/net", async (original) => ({
  ...(await original<typeof import("../hub/net")>()),
  pairedHub: () => fetches,
}));

const local: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" };
const acme: HubAccount = { id: "acme", label: "Acme", url: "https://hub.example.com", local: false, revision: "t" };
const agent = (hubId: string, id: string): Agent => ({ hubId, id, name: id, model: null, provider: null, isDefault: false });

afterEach(() => useChat.setState({ hubs: [], roster: [], rosterErrors: {}, settling: {} }));

describe("The agent list while a hub can't be read", () => {
  it("keeps this computer's agents from before, and drops a remote workspace's", async () => {
    useChat.setState({ hubs: [local, acme], roster: [agent("local", "ledger"), agent("acme", "scout")] });
    fetches.fetch.mockRejectedValue(new Error("connection refused"));
    await useChat.getState().refreshRoster();
    const { roster, rosterErrors } = useChat.getState();
    expect(roster.map((a) => a.id)).toEqual(["ledger"]);
    expect(Object.keys(rosterErrors).sort()).toEqual(["acme", "local"]);
  });

  it("shows what this computer's hub says once it answers", async () => {
    useChat.setState({ hubs: [local], roster: [agent("local", "ledger")] });
    fetches.fetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: "scribe" }] }) });
    await useChat.getState().refreshRoster();
    expect(useChat.getState().roster.map((a) => a.id)).toEqual(["scribe"]);
  });
});

describe("An agent being built again (a new name)", () => {
  it("stays on the list, where it was, while its hub leaves it out, and goes once it's done if the hub still does", async () => {
    useChat.setState({ hubs: [local], roster: [{ ...agent("local", "ledger"), name: "Penny" }, agent("local", "scout")] });
    useChat.getState().settle("local/ledger", true);
    fetches.fetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: "scout" }] }) });
    await useChat.getState().refreshRoster();
    expect(useChat.getState().roster.map((a) => `${a.id} ${a.name}`)).toEqual(["ledger Penny", "scout scout"]);

    useChat.getState().settle("local/ledger", false);
    await useChat.getState().refreshRoster();
    expect(useChat.getState().roster.map((a) => a.id)).toEqual(["scout"]);
  });
});

describe("A machine's agents", () => {
  const devbox: HubAccount = { id: "devbox-hub", label: "devbox", url: "http://127.0.0.1:2", local: false, machine: "devbox", revision: "t" };
  afterEach(() => useDesk.setState({ engines: {} }));

  it("are never listed, even an older machine's Desk agent, and its boss is never asked for", async () => {
    useChat.setState({ hubs: [local, devbox], roster: [] });
    fetches.fetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: "desk", name: "Desk" }, { id: "scout" }] }) });
    const manager = vi.fn(async () => ({ agentId: "desk", level: "act" }));
    useDesk.setState({ engines: { devbox: { hub: { manager } as never, connected: true, loaded: true, error: null } } });
    await useChat.getState().refreshRoster();
    expect(useChat.getState().roster.map((a) => `${a.hubId}/${a.id}`)).toEqual(["local/desk", "local/scout"]);
    expect(manager).not.toHaveBeenCalled();
  });
});
