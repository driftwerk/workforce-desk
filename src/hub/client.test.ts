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
