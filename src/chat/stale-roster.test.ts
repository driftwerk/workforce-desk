import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => useChat.setState({ hubs: [], roster: [], rosterErrors: {} }));

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
