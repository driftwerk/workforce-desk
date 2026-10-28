import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskHub, HubError } from "./client";

const hub = new DeskHub({ url: "http://127.0.0.1:1", token: "t" });
const answer = (body: string, type: string) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": type } }));

afterEach(() => vi.restoreAllMocks());

describe("DeskHub", () => {
  it("treats a hub that answers an API route with its web page as not having it", async () => {
    answer("<!doctype html><html></html>", "text/html");
    const e = await hub.rooms().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).status).toBe(404);
  });

  it("reads JSON answers", async () => {
    answer("[]", "application/json");
    expect(await hub.rooms()).toEqual([]);
  });
});

describe("a hub's refusals", () => {
  const refuse = (status: number, body: string, type = "application/json", statusText = "Bad Request") =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status, statusText, headers: { "content-type": type } }));
  const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as HubError);

  it("reads the error a refused config write gives, not the JSON around it", async () => {
    refuse(400, JSON.stringify({ error: "config refused: unknown provider", findings: [] }));
    const e = await caught(hub.saveAgentConfig("scout", "x = 1"));
    expect(e).toBeInstanceOf(HubError);
    expect(e?.status).toBe(400);
    expect(e?.message).toBe("config refused: unknown provider");
  });

  it("reads a refused read of a file the same way", async () => {
    refuse(409, JSON.stringify({ error: "config.toml changed since it was read" }));
    expect((await caught(hub.agentConfig("scout")))?.message).toBe("config.toml changed since it was read");
  });

  it("reads JSON refusals of the other routes the same way", async () => {
    refuse(400, JSON.stringify({ error: "That name is taken." }));
    expect((await caught(hub.renameAgent("scout", "Atlas")))?.message).toBe("That name is taken.");
  });

  it("takes a plain-text body as it is", async () => {
    refuse(400, "That file is too big.", "text/plain");
    expect((await caught(hub.saveIdentityFile("scout", "SOUL.md", "…")))?.message).toBe("That file is too big.");
  });

  it("falls back to the status line for an empty body, JSON without a usable error, or a web page", async () => {
    for (const body of ["", JSON.stringify({ error: { code: 7 } }), JSON.stringify({ saved: false }), "<html>502</html>"]) {
      refuse(400, body);
      expect((await caught(hub.saveAgentConfig("scout", "x = 1")))?.message).toBe("Bad Request");
    }
    refuse(400, "", "text/plain", "");
    expect((await caught(hub.saveAgentConfig("scout", "x = 1")))?.message).toBe("The hub refused that.");
  });
});
