import { beforeEach, describe, expect, it, vi } from "vitest";
import { ticketViewOf } from "./ticketView";

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../hub/net", async (original) => ({
  ...(await original<typeof import("../hub/net")>()),
  pairedHub: () => net,
}));

const api = ticketViewOf({ id: "local", url: "http://127.0.0.1:50148" } as never);
const answer = (status: number, body: object) => ({ ok: true, status, json: async () => body });

beforeEach(() => net.fetch.mockReset());

describe("posting a comment", () => {
  it("shows a comment the hub kept, and says so of one it posted but couldn't keep", async () => {
    net.fetch.mockResolvedValueOnce(answer(201, { id: "c1", body: "On it." }));
    expect(await api.comment("t1", "On it.")).toMatchObject({ kind: "posted", comment: { id: "c1" } });
    net.fetch.mockResolvedValueOnce(answer(201, { id: null, kept: false, body: "On it.", message: "Posted. Desk couldn't keep its copy just now." }));
    expect(await api.comment("t1", "On it.")).toEqual({ kind: "pending", message: "Posted. Desk couldn't keep its copy just now." });
    net.fetch.mockResolvedValueOnce(answer(202, { pending: true }));
    expect(await api.comment("t1", "On it.")).toEqual({ kind: "pending", message: "Waiting for your approval." });
  });
});
