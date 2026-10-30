import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { HubAccount, Me } from "../chat/types";
import { AgentMark, initialsFor, Mark, YouMark } from "../ui/Mark";
import { forgetImages, imageUrl, pictureOf, type Picture } from "./pictures";
import { servePictures } from "./testing";
import { youOn } from "./who";

const LOCAL: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, token: "t-local" };
const DW: HubAccount = { id: "dw", label: "Driftwerk", url: "https://dw.example", local: false, token: "t-dw" };
const ACME: HubAccount = { id: "acme", label: "Acme", url: "https://acme.example", local: false, token: "t-acme" };
const pic = (version: string, source: Picture["source"] = "chosen"): Picture => ({ version, source, at: "2026-10-30T09:00:00Z", slack: null });
const me = (name: string, picture: Picture | null): Me => ({ id: `u-${name}`, name, picture });

beforeEach(() => forgetImages());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a mark", () => {
  it("shows the letter without a picture, and the picture with one, in the same ring", () => {
    const { container, rerender } = render(<Mark name="allan" state="working" />);
    expect(container.textContent).toBe("A");
    expect(container.querySelector(".mark")!.className).toContain("ring-working");
    rerender(<Mark name="allan" state="working" src="blob:allan" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("blob:allan");
    expect(container.textContent).toBe("");
    expect(container.querySelector(".mark")!.className).toContain("ring-working");
  });

  it("takes a whole first character for its letter, past any space", () => {
    expect(initialsFor("🦊 Fox")).toBe("🦊");
    expect(initialsFor("  sarah")).toBe("S");
    expect(initialsFor("")).toBe("?");
  });

  it("falls back to the letter when the picture won't load", () => {
    const { container } = render(<Mark name="brian" src="blob:gone" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("B");
  });

  it("is round for people and a rounded square for agents", () => {
    const { container } = render(
      <>
        <Mark name="you" person />
        <Mark name="allan" />
      </>,
    );
    const [person, agent] = container.querySelectorAll(".mark");
    expect(person!.className).toContain("mark-person");
    expect(agent!.className).not.toContain("mark-person");
  });
});

describe("pictures from hubs", () => {
  it("reads a picture's image once per version, with the token in the header, and lets the old one go", async () => {
    const fetch = servePictures();
    const ref = { hubId: "dw", conn: DW, path: "/api/agents/allan/picture", version: "v1" };
    const [a, b] = await Promise.all([imageUrl(ref), imageUrl(ref)]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://dw.example/api/agents/allan/picture");
    expect(String(url)).not.toContain("t-dw");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t-dw");
    const next = await imageUrl({ ...ref, version: "v2" });
    expect(next).not.toBe(a);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(a);
  });

  it("shows the letter when a hub answers with something that isn't an image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } })));
    expect(await imageUrl({ hubId: "old", conn: DW, path: "/api/agents/a/picture", version: "v1" })).toBeNull();
  });

  it("reads a hub's picture only when it's one", () => {
    expect(pictureOf({ version: "v1", source: "slack", at: "x", slack: "Acme" })).toEqual({ version: "v1", source: "slack", at: "x", slack: "Acme" });
    expect(pictureOf({ version: "", source: "chosen" })).toBeNull();
    expect(pictureOf({ version: "v1", source: "gravatar" })).toBeNull();
    expect(pictureOf(null)).toBeNull();
  });

  it("shows an agent's picture from its own hub", async () => {
    servePictures();
    useChat.setState({ hubs: [LOCAL, DW], roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false, picture: pic("v1", "slack") }], me: {} });
    const { container } = render(<AgentMark agent="dw/allan" name="Allan" />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
  });
});

describe("you, as each place shows you", () => {
  const hubs = [LOCAL, DW, ACME];

  it("in a hub's places, as that hub has you", () => {
    const you = youOn(hubs, { local: me("Sam", null), dw: me("Sam Lee", pic("dw1", "slack")), acme: me("K", pic("ac1")) }, "acme");
    expect([you?.hub.id, you?.me.picture?.version]).toEqual(["acme", "ac1"]);
    expect(youOn(hubs, { local: me("Sam", null) }, "dw")).toBeNull();
  });

  it("in Desk's own places, with this computer's account picture once it has one", () => {
    const you = youOn(hubs, { local: me("Sam", pic("l1")), dw: me("Sam Lee", pic("dw1")) }, null);
    expect([you?.hub.id, you?.me.picture?.version]).toEqual(["local", "l1"]);
  });

  it("until then with the first connected hub's that has one, under your name here", () => {
    const you = youOn(hubs, { local: me("Sam", null), dw: me("Sam Lee", null), acme: me("K", pic("ac1")) }, "local");
    expect([you?.hub.id, you?.me.picture?.version, you?.me.name]).toEqual(["acme", "ac1", "Sam"]);
    expect(youOn(hubs, { local: me("Sam", null) }, null)?.me).toEqual(me("Sam", null));
  });

  it("is round, with your picture there", async () => {
    servePictures();
    useChat.setState({ hubs, me: { local: me("Sam", null), dw: me("Sam Lee", pic("dw1", "slack")) } });
    const { container } = render(<YouMark hub="dw" />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    expect(container.querySelector(".mark")!.className).toContain("mark-person");
    cleanup();
    render(<YouMark hub="acme" />);
    expect(screen.getByText("Y")).toBeTruthy();
  });
});
