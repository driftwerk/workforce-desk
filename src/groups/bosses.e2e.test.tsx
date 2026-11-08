// A group's boss, end to end against a fake hub: Desk's own client over a
// transport that keeps the sidebar's groups, the agents' config files and
// says the bosses those files make, as the hub does. Mia is made Globex's
// boss from his row (asked first: the main overseer saw Globex), and Globex is
// then deleted (asked first: it has a boss), which takes Mia off before the
// group goes.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskEvent, Manager } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { EMPTY_LAYOUT, type Layout } from "./model";
import { useHubLayout } from "./hubLayout";
import { SidebarGroups } from "./SidebarGroups";
import { oversightHub } from "./testing";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

class Socket implements DeskSocket {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  say(e: DeskEvent) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The hub, as far as groups and their bosses go. */
class FakeHub implements DeskTransport {
  requests: string[] = [];
  events: Socket | null = null;
  layout: Layout = {
    groups: [
      { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/sarah"] },
      { id: "globex", name: "Globex", collapsed: false, items: ["agent:local/mia"] },
    ],
    ungrouped: { collapsed: false, items: ["agent:local/desk"] },
  };
  configs: Record<string, string> = {
    desk: `[oversight]\nenabled = true\nlevel = "act"\n`,
    sarah: `[oversight]\nenabled = true\ngroup = "acme"\nlevel = "act"\n`,
    mia: `[llm]\nprovider = "claude-code"\n`,
  };

  /** The configs as the hub keeps them (one boss per group, a boss replaced
   *  naming its group no more). */
  kept = oversightHub(this.configs);
  manager = (): Manager => this.kept.manager(this.layout.groups.map((g) => g.id));

  fetch = async (method: string, path: string, body?: { data: string | Blob }): Promise<Response> => {
    const route = `${method} ${path}`;
    this.requests.push(route);
    const config = /^\/api\/agents\/([^/]+)\/config$/.exec(path);
    if (config && method === "GET") return new Response(this.configs[config[1]!] ?? "", { status: 200 });
    if (config && method === "PUT") {
      const toml = String(body!.data);
      const group = (parse(toml) as { oversight?: { group?: string } }).oversight?.group;
      // The hub refuses a group the sidebar hasn't got.
      if (group && !this.layout.groups.some((g) => g.id === group))
        return json({ error: "The group it oversees must be one of your sidebar's groups." }, 400);
      this.kept.save(config[1]!, toml);
      return new Response(null, { status: 204 });
    }
    if (route === "GET /api/desk/manager") return json(this.manager());
    if (route === "GET /api/desk/sessions") return json([]);
    if (route === "GET /api/desk/layout") return json(this.layout);
    const group = /^\/api\/desk\/groups\/([^/]+)$/.exec(path);
    if (group && method === "DELETE") {
      const gone = this.layout.groups.find((g) => g.id === group[1]);
      if (!gone) return json({ error: "not found" }, 404);
      // The hub takes the group's boss off itself, first.
      for (const [id, toml] of Object.entries(this.configs)) {
        const o = (parse(toml) as { oversight?: { group?: string } }).oversight;
        if (o?.group !== gone.id) continue;
        const { group: _g, ...rest } = o;
        this.configs[id] = stringify({ ...(parse(toml) as object), oversight: { ...rest, enabled: false } });
      }
      this.layout = {
        groups: this.layout.groups.filter((g) => g !== gone),
        ungrouped: { ...this.layout.ungrouped, items: [...this.layout.ungrouped.items, ...gone.items] },
      };
      return json(this.layout);
    }
    if (route === "PUT /api/desk/groups/ungrouped/order") {
      const items = (JSON.parse(String(body!.data)) as { items: string[] }).items;
      this.layout = { ...this.layout, ungrouped: { ...this.layout.ungrouped, items } };
      return json(this.layout);
    }
    return new Response("Not Found", { status: 404 });
  };

  socket = (path: string): DeskSocket => {
    const s = new Socket();
    if (path === "/api/desk/events") this.events = s;
    return s;
  };
}

let hub: FakeHub;
let disconnect: () => void;

const connect = async () => {
  disconnect = useDesk.getState().connect(hub);
  await act(async () => {
    await Promise.resolve();
    hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [], layout: hub.layout } as DeskEvent);
  });
  await waitFor(() => expect(useHubLayout.getState().layout).not.toBeNull());
  await waitFor(() => expect(useOverview.getState().manager?.bosses).toHaveLength(1));
};

const row = (name: string) => screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;

beforeEach(() => {
  hub = new FakeHub();
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [
      { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
      { hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "mia", name: "Mia", model: null, provider: null, isDefault: false },
    ],
  });
  useSettings.setState({ loaded: true, layoutOnHub: true, groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useOverview.setState({ manager: null, managerSupport: "unknown", overviewSupport: "no", suggestions: {}, suggestionsLoaded: true });
});
afterEach(() => {
  disconnect?.();
  cleanup();
});

describe("a group's boss, against the hub", () => {
  it("replaced by another and then stopped, leaves its group open to the main overseer", async () => {
    hub.layout = { ...hub.layout, groups: [{ ...hub.layout.groups[0]!, items: ["agent:local/sarah", "agent:local/mia"] }, { ...hub.layout.groups[1]!, items: [] }] };
    await connect();
    render(<SidebarGroups />);
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    // Acme had a boss: it only changes boss, unasked.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(within(row("Mia")).getByText("boss")).toBeTruthy());
    expect((parse(hub.configs.sarah!) as { oversight: object }).oversight).not.toHaveProperty("group");
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop overseeing" }));
    await waitFor(() => expect(within(row("Mia")).queryByText("boss")).toBeNull());
    expect(hub.manager()).toEqual({ agentId: "desk", level: "act", bosses: [], sealed: [] });
    expect(within(screen.getByRole("group", { name: "Acme" })).queryByText(/oversees/)).toBeNull();
  });

  it("is made from its row once asked, shows on its row and group, and is taken off before its group is deleted", async () => {
    await connect();
    render(<SidebarGroups />);
    expect(within(row("Sarah")).getByText("boss")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Acme" })).getByRole("button", { name: "Sarah oversees" })).toBeTruthy();

    // Mia oversees Globex, which the main overseer saw: asked first.
    fireEvent.contextMenu(row("Mia"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oversee this group" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Oversee Globex with Mia?" })).getByRole("button", { name: "Oversee Globex" }));
    await waitFor(() => expect(within(row("Mia")).getByText("boss")).toBeTruthy());
    expect(parse(hub.configs.mia!)).toEqual({ llm: { provider: "claude-code" }, oversight: expect.objectContaining({ enabled: true, group: "globex" }) });
    expect(within(screen.getByRole("group", { name: "Globex" })).getByRole("button", { name: "Mia oversees" })).toBeTruthy();
    // The main overseer is untouched.
    expect(hub.configs.desk).toBe(`[oversight]\nenabled = true\nlevel = "act"\n`);

    // Globex is deleted: asked, then Mia is taken off, then the group goes.
    hub.requests = [];
    fireEvent.click(screen.getByRole("button", { name: "Globex options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete Globex?" })).getByRole("button", { name: "Delete Globex" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Globex" })).toBeNull());
    await waitFor(() => expect(hub.requests).toContain("DELETE /api/desk/groups/globex"));
    const put = hub.requests.indexOf("PUT /api/agents/mia/config");
    expect(put).toBeGreaterThanOrEqual(0);
    expect(put).toBeLessThan(hub.requests.indexOf("DELETE /api/desk/groups/globex"));
    const o = (parse(hub.configs.mia!) as { oversight: Record<string, unknown> }).oversight;
    expect(o.enabled).toBe(false);
    expect("group" in o).toBe(false);
    await waitFor(() => expect(within(row("Mia")).queryByText("boss")).toBeNull());
    expect(hub.layout.groups.map((g) => g.id)).toEqual(["acme"]);
  });
});
