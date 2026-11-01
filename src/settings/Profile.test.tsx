import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import { forgetImages } from "../pictures/pictures";
import { PNG_BYTES } from "../pictures/testing";
import { Profile } from "./Profile";

const hub = (id: string, label: string, local = false): HubAccount => ({ id, label, url: `https://${id}.example`, local, revision: `t-${id}` });
const HUBS = [hub("local", "This computer", true), hub("dw", "Driftwerk"), hub("acme", "Acme"), hub("lab", "Lab")];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Each hub as it knows you (none: this computer's doesn't), refusing
 *  pictures on Acme. */
const hubs = vi.fn(async (input: URL | string, init?: RequestInit) => {
  const url = new URL(String(input));
  const id = url.hostname.split(".")[0]!;
  if (url.pathname === "/api/me")
    return id === "local" ? json({ error: "unauthorized" }, 401) : json({ id: `u-${id}`, display_name: "Sam", picture: id === "dw" ? { version: "d1", source: "slack", at: "", slack: "Acme Slack" } : null });
  if (url.pathname === "/api/me/picture" && init?.method === "PUT")
    return id === "acme" ? json({ error: "Pictures need the hub's database, which isn't connected." }, 503) : json({ picture: { version: `${id}-2`, source: "chosen", at: new Date().toISOString() } });
  if (url.pathname === "/api/me/picture") return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
  return json({ agents: [] });
});

beforeEach(() => {
  forgetImages();
  vi.stubGlobal("fetch", hubs);
  URL.createObjectURL = vi.fn(() => "blob:me");
  URL.revokeObjectURL = vi.fn();
  useChat.setState({ hubs: [], me: {}, roster: [] });
  useChat.getState().setHubs(HUBS);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  hubs.mockClear();
});

describe("your Profile", () => {
  it("shows your picture on each workspace and where it came from", async () => {
    render(<Profile />);
    const dw = await screen.findByRole("article", { name: "Driftwerk" });
    expect(await within(dw).findByText("From Slack (Acme Slack)")).toBeTruthy();
    expect(within(await screen.findByRole("article", { name: "Acme" })).getByText("No picture")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "This computer" })).getByText(/Connect to This computer as yourself/)).toBeTruthy();
  });

  it("uses one picture everywhere it may, saying where it couldn't", async () => {
    render(<Profile />);
    const dw = await screen.findByRole("article", { name: "Driftwerk" });
    await act(async () => fireEvent.click(await within(dw).findByRole("button", { name: "Use this picture everywhere" })));
    expect(await within(dw).findByText("Now your picture on Lab. Couldn’t set it on Acme: Pictures need the hub's database, which isn't connected.")).toBeTruthy();
    const puts = hubs.mock.calls.filter(([, init]) => init?.method === "PUT").map(([u]) => new URL(String(u)).hostname);
    expect(puts.sort()).toEqual(["acme.example", "lab.example"]);
    expect(useChat.getState().me.lab!.picture?.version).toBe("lab-2");
    expect(useChat.getState().me.acme!.picture).toBeNull();
  });

  it("keeps you on a workspace that can't be reached for a moment, and the picture you set over a read under way", async () => {
    await vi.waitFor(() => expect(useChat.getState().me.dw).toBeTruthy());
    hubs.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    await act(() => useChat.getState().refreshMe("dw"));
    expect(useChat.getState().me.dw!.id).toBe("u-dw");

    const picture = { version: "d9", source: "chosen" as const, at: "", slack: null };
    const read = useChat.getState().refreshMe("dw");
    useChat.getState().setPicture({ me: "dw" }, picture);
    await act(() => read);
    expect(useChat.getState().me.dw!.picture).toEqual(picture);
  });
});
