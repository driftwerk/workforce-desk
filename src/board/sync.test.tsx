// Board sync (BD7) against a fake native side and hub: the link dialog
// (minting where the hub allows it, else pasting a token once; which hubs
// offer the system; the filter's live count; the state map; the hub's
// refusals), the board's sync states and its Left-the-filter shelf.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return {
    /** Every request the page made of a hub, by hub id. */
    asked: [] as { hub: string; method: string; path: string; body: Record<string, unknown> | null }[],
    commands: [] as { cmd: string; args: unknown }[],
    route: (_hub: string, _method: string, _path: string, _body: Record<string, unknown> | null): { status: number; body?: unknown } => ({ status: 404 }),
    mint: (_args: unknown): unknown => ({ kind: "notAllowed", status: 403, error: "this hub's admin hasn't let paired devices make remote MCP tokens" }),
  };
});

const framed = (status: number, body: unknown): ArrayBuffer => {
  const head = new TextEncoder().encode(JSON.stringify({ status, contentType: body === undefined ? null : "application/json" }));
  const b = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(4 + head.length + b.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(b, 4 + head.length);
  return out.buffer;
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
    native.commands.push({ cmd, args });
    if (cmd === "hub_fetch") {
      const h = options?.headers ?? {};
      const hub = decodeURIComponent(h["x-desk-hub"] ?? "");
      const method = decodeURIComponent(h["x-desk-method"] ?? "");
      const path = decodeURIComponent(h["x-desk-path"] ?? "");
      // A Uint8Array of another realm, in jsdom: read by its values.
      const bytes = args && typeof args === "object" ? new Uint8Array(Object.values(args as Record<string, number>)) : new Uint8Array();
      const body = bytes.length ? (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>) : null;
      native.asked.push({ hub, method, path, body });
      const a = native.route(hub, method, path, body);
      return framed(a.status, a.body);
    }
    if (cmd === "board_sync_mint") return native.mint(args);
    return null;
  }),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useChat } from "../chat/store";
import { boardSyncOf, issueUrl, linkedTo, looksLikeToken, pausedWords, syncHubId, syncStatus, targetOk } from "../hub/boardSync";
import { useDesk } from "../hub/store";
import type { Board as BoardT, SyncHub, Ticket } from "../hub/types";
import { Board } from "./BoardView";
import { BOARD_CHROME } from "./chrome";
import { OpenTicket } from "./TicketDetail";
import { LinkBoardDialog } from "./LinkBoard";
import { useBoard } from "./store";
import { useSyncHubs } from "./syncStore";
import { useAgentConfigs } from "../crew/agentBrain";
import { useUi } from "../shell/ui";
import { ACME, ticket } from "./testing";

const LOCAL = { id: "local", label: "This computer", url: "http://127.0.0.1:50148", local: true, revision: "" };
const ATLAS = { id: "atlas-acme-example", label: "Atlas", url: "https://atlas.acme.example", local: false, revision: "" };
const GLOBEX = { id: "hub-globex-example", label: "Globex", url: "https://hub.globex.example", local: false, revision: "" };
const MACHINE = { id: "machine:devbox", label: "devbox", url: "http://127.0.0.1:1", local: false, machine: "devbox", revision: "" };
const SECRET = "wfr_SENTINELpastedtoken0123456789";

/** The local hub's board sync, as far as the dialog goes. */
let kept: SyncHub[] = [];
let offers: Record<string, boolean> = {};
/** The agent each hub offers its tools through, when not its default. */
let agents: Record<string, string> = {};

const localRoutes = (method: string, path: string, body: Record<string, unknown> | null): { status: number; body?: unknown } => {
  if (method === "GET" && path === "/api/desk/sync-hubs") return { status: 200, body: { hubs: kept } };
  const putHub = /^\/api\/desk\/sync-hubs\/([a-z0-9-]+)$/.exec(path);
  if (method === "PUT" && putHub) {
    if (body?.token !== SECRET) return { status: 422, body: { error: "Globex refused that token; make a new one there." } };
    kept = [...kept.filter((h) => h.id !== putHub[1]), { id: putHub[1]!, name: String(body.name), url: String(body.url), hasToken: true }];
    return { status: 200, body: { id: putHub[1], offers: { jira: true, linear: false } } };
  }
  if (method === "POST" && path === "/api/desk/boards/link/check") {
    const via = body!.via as { kind: string; hub?: string };
    const key = via.kind === "thisHub" ? "this" : via.hub!;
    if (!offers[key]) return { status: 422, body: { error: `No agent on ${key} you can reach has Jira switched on.`, paused: { kind: "missing", tools: ["jira.search"] } } };
    const out: Record<string, unknown> = { offered: true, ...(agents[key] ? { agent: { id: agents[key], name: agents[key]![0]!.toUpperCase() + agents[key]!.slice(1) } } : {}) };
    if (!body!.target) return { status: 200, body: out };
    out.states = ["Backlog", "To Do", "In Progress", "In Review", "Done"];
    out.prefill = { backlog: "Backlog", todo: "To Do", doing: "In Progress", review: "In Review", done: "Done" };
    const filter = body!.filter as { kind: string; value?: string } | undefined;
    if (filter?.kind === "query" && /order by/i.test(filter.value ?? "")) return { status: 400, body: { error: "JQL here can't sort: leave out ORDER BY." } };
    out.me = { id: "557058:sam", name: "Sam" };
    if (filter) {
      out.matches = filter.kind === "label" ? 7 : filter.kind === "all" ? 2000 : 12;
      out.matchesAtLeast = filter.kind === "all";
      out.ceiling = 2000;
    }
    return { status: 200, body: out };
  }
  const link = /^\/api\/desk\/boards\/([^/]+)\/link$/.exec(path);
  if (method === "PUT" && link) return { status: 200, body: { ...ACME, prefix: null, sync: { link: "l1", ...body, person: "p1" } } };
  if (method === "POST" && /\/sync$/.test(path)) return { status: 202 };
  return { status: 404 };
};

const sealed = (): string => document.body.innerHTML + JSON.stringify(useSyncHubs.getState()) + JSON.stringify(useBoard.getState().boards);

beforeEach(() => {
  native.asked.length = 0;
  native.commands.length = 0;
  kept = [{ id: "atlas-acme-example", name: "Atlas", url: ATLAS.url, hasToken: true }];
  offers = { "atlas-acme-example": true };
  agents = {};
  native.route = (hub, method, path, body) => (hub === "local" ? localRoutes(method, path, body) : { status: 404 });
  native.mint = () => ({ kind: "notAllowed", status: 403, error: "this hub's admin hasn't let paired devices make remote MCP tokens" });
  useChat.setState({ hubs: [LOCAL, ATLAS, GLOBEX, MACHINE] as never });
  useSyncHubs.setState({ hubs: null });
  useBoard.setState({ boards: { [ACME.id]: ACME }, tickets: {}, supported: true, shown: ACME.id, open: null });
});
afterEach(cleanup);

const pickSystem = (s: "Jira" | "Linear") => fireEvent.click(within(screen.getByRole("radiogroup", { name: "System" })).getByRole("radio", { name: s }));
const via = () => within(screen.getByRole("radiogroup", { name: "Through" }));

describe("the link dialog", () => {
  it("lists every paired hub but this computer's and the machines', says which offer the system, and keeps This computer off while one does", async () => {
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await waitFor(() => expect(via().getByText("Offers its Jira tools to you")).toBeTruthy());
    expect(via().queryByText("devbox")).toBeNull();
    expect(via().getByText(/Needs a token/)).toBeTruthy();
    const thisComputer = via().getByRole("radio", { name: /This computer/ }) as HTMLInputElement;
    expect(thisComputer.disabled).toBe(true);
    expect(via().getByText(/Atlas has Jira: link through it/)).toBeTruthy();
    // Every ask went to this computer's hub, as the person.
    expect(native.asked.every((a) => a.hub === "local")).toBe(true);
  });

  it("makes a token on a hub that allows it with nothing in the page, then the hub is asked again", async () => {
    native.mint = (args) => {
      expect(args).toEqual({ remote: GLOBEX.id, local: "local", id: "hub-globex-example", name: "Globex" });
      kept = [...kept, { id: "hub-globex-example", name: "Globex", url: GLOBEX.url, hasToken: true }];
      offers["hub-globex-example"] = true;
      return { kind: "kept", offers: { jira: true, linear: false } };
    };
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await waitFor(() => expect(via().getByText(/Needs a token/)).toBeTruthy());
    fireEvent.click(via().getByRole("radio", { name: /^Globex/ }));
    await waitFor(() => expect(within(via().getByText("Globex").closest("label")!).getByText("Offers its Jira tools to you")).toBeTruthy());
    expect(native.commands.filter((c) => c.cmd === "board_sync_mint")).toHaveLength(1);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("falls back to pasting where the hub doesn't allow minting: a password field, sent once, never kept or shown", async () => {
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await waitFor(() => expect(via().getByText(/Needs a token/)).toBeTruthy());
    fireEvent.click(via().getByRole("radio", { name: /^Globex/ }));
    const field = (await screen.findByLabelText("Globex’s token for you")) as HTMLInputElement;
    expect(field.type).toBe("password");
    // Plain words, never the hub's config key.
    expect(screen.getByText(/Globex doesn’t let Desk make this token itself yet — its admin can turn that on, or make a token on Globex and paste it here\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/allow_device_tokens|remote MCP tokens/);
    // A refused token: the hub's words, and the field empty again.
    fireEvent.change(field, { target: { value: "wfr_notthetokenatall0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this token" }));
    await screen.findByText("Globex refused that token; make a new one there.");
    expect((screen.getByLabelText("Globex’s token for you") as HTMLInputElement).value).toBe("");
    offers["hub-globex-example"] = true;
    fireEvent.change(screen.getByLabelText("Globex’s token for you"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Use this token" }));
    await waitFor(() => expect(within(via().getByText("Globex").closest("label")!).getByText("Offers its Jira tools to you")).toBeTruthy());
    const put = native.asked.filter((a) => a.method === "PUT" && a.path === "/api/desk/sync-hubs/hub-globex-example");
    expect(put.at(-1)!.body).toEqual({ name: "Globex", url: GLOBEX.url, token: SECRET });
    expect(sealed()).not.toContain("SENTINEL");
  });

  it("asks the hub again each time the link opens, and on Try again: an admin may have allowed it since", async () => {
    const mints = () => native.commands.filter((c) => c.cmd === "board_sync_mint").length;
    const open = async () => {
      const r = render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
      pickSystem("Jira");
      await waitFor(() => expect(via().getByText(/Needs a token/)).toBeTruthy());
      fireEvent.click(via().getByRole("radio", { name: /^Globex/ }));
      return r;
    };
    const first = await open();
    await screen.findByRole("button", { name: "Try again" });
    expect(mints()).toBe(1);
    first.unmount();
    // Opened again: asked again, not remembered as refused.
    await open();
    await screen.findByRole("button", { name: "Try again" });
    expect(mints()).toBe(2);
    // The admin turns it on; Try again makes it, and the paste box goes.
    native.mint = () => {
      kept = [...kept, { id: "hub-globex-example", name: "Globex", url: GLOBEX.url, hasToken: true }];
      offers["hub-globex-example"] = true;
      return { kind: "kept", offers: { jira: true, linear: false } };
    };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(via().getByText("Globex").closest("label")!).getByText("Offers its Jira tools to you")).toBeTruthy());
    expect(mints()).toBe(3);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("checks the filter live, prefills the state map, and links with what was chosen", async () => {
    const closed = vi.fn();
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={closed} />);
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    const key = await screen.findByLabelText("Atlas’s Jira project key");
    fireEvent.change(key, { target: { value: "acme" } });
    expect((key as HTMLInputElement).value).toBe("ACME");
    // The whole project comes first, and is what it starts on: counted to
    // the hub's ceiling, and said so.
    const imports = within(screen.getByRole("radiogroup", { name: "Import" }));
    expect(imports.getAllByRole("radio")[0]!.textContent).toBe("Whole project");
    expect(imports.getByRole("radio", { name: "Whole project" }).getAttribute("aria-checked")).toBe("true");
    await screen.findByText("2,000 or more open issues", undefined, { timeout: 2000 });
    expect(screen.getByText(/Desk counts up to 2,000; it brings them all in/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".sync-me")?.textContent).toMatch(/^Atlas knows you as Sam on Jira/));
    fireEvent.click(screen.getByRole("button", { name: "That’s not me" }));
    expect(screen.getByText(/Desk won’t go by Atlas’s answer/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Also bring in what was done in the last two weeks"));
    await waitFor(() =>
      expect(native.asked.some((a) => a.path === "/api/desk/boards/link/check" && JSON.stringify(a.body?.filter) === JSON.stringify({ kind: "all", value: { includeDone: true } }))).toBe(true),
    );
    fireEvent.click(imports.getByRole("radio", { name: "Assigned to me" }));
    await screen.findByText("12 issues", undefined, { timeout: 2000 });
    // The map is prefilled once the hub's states are in.
    await waitFor(() => expect((screen.getByLabelText("Review moves its issue to") as HTMLSelectElement).value).toBe("In Review"));
    // A label: counted again.
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Import" })).getByRole("radio", { name: "A label" }));
    fireEvent.change(screen.getByPlaceholderText("desk"), { target: { value: "desk" } });
    await screen.findByText("7 issues", undefined, { timeout: 2000 });
    fireEvent.change(screen.getByLabelText("Dropped moves its issue to"), { target: { value: "Done" } });
    fireEvent.click(screen.getByRole("button", { name: "Link to ACME" }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    const linked = native.asked.find((a) => a.method === "PUT" && a.path === `/api/desk/boards/${ACME.id}/link`)!;
    expect(linked.body).toEqual({
      system: "jira",
      target: "ACME",
      via: { kind: "hub", hub: "atlas-acme-example" },
      filter: { kind: "label", value: "desk" },
      notMe: true,
      states: { backlog: "Backlog", todo: "To Do", doing: "In Progress", review: "In Review", done: "Done", dropped: "Done" },
    });
    expect(useBoard.getState().boards[ACME.id]!.sync?.target).toBe("ACME");
    // And it is synced at once: the hub's 202 is no error.
    await waitFor(() => expect(native.asked.some((a) => a.path === `/api/desk/boards/${ACME.id}/sync`)).toBe(true));
  });

  it("says which agent there has Jira, and offers to ask one to switch it on where none has", async () => {
    agents = { "atlas-acme-example": "lattice" };
    kept = [...kept, { id: "hub-globex-example", name: "Globex", url: GLOBEX.url, hasToken: true }];
    useChat.setState({ roster: [{ hubId: GLOBEX.id, id: "helper", name: "Helper", model: null, provider: null, isDefault: true }] as never });
    const sendTo = vi.fn(async () => true);
    const was = useChat.getState().sendTo;
    useChat.setState({ sendTo });
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await waitFor(() => expect(within(via().getByText("Atlas").closest("label")!).getByText("Offers Jira through Lattice")).toBeTruthy());
    expect(within(via().getByText("Globex").closest("label")!).getByText("No agent there you can reach has Jira switched on")).toBeTruthy();
    expect(screen.getByText("No agent on hub-globex-example you can reach has Jira switched on.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Helper to switch Jira on" }));
    await waitFor(() => expect(sendTo).toHaveBeenCalledWith(`${GLOBEX.id}/helper`, expect.stringContaining("switch Jira on for an agent I can use on Globex")));
    await screen.findByText(/Asked Helper on Globex to switch Jira on/);
    useChat.setState({ sendTo: was, roster: [] as never });
  });

  describe("where no hub offers it, This computer", () => {
    const MAX = { hubId: "local", id: "max", name: "Max", model: null, provider: null, isDefault: true };
    const jiraConnector = (connected: boolean) => ({
      id: "jira",
      name: "Jira",
      about: "Issues and projects",
      signIn: "fields",
      fields: [{ name: "api_token", label: "API token", secret: true, required: true, placeholder: "" }],
      signInReady: true,
      connections: connected
        ? [{ level: "all", agent: null, agentName: null, account: "sam@acme.example", status: "connected", detail: null, connectedAt: null, checkedAt: null, source: "user" }]
        : [],
      usedBy: [],
    });
    let saved: string[] = [];
    const withConnections = (connected: boolean) => {
      native.route = (hub, method, path, body) =>
        hub === "local" && method === "GET" && path === "/api/desk/connections"
          ? { status: 200, body: { connectors: [jiraConnector(connected)], adapters: ["browser"] } }
          : hub === "local"
            ? localRoutes(method, path, body)
            : { status: 404 };
    };
    beforeEach(() => {
      offers = {};
      saved = [];
      useChat.setState({ roster: [MAX] as never });
      useAgentConfigs.setState({ configs: {} });
      useDesk.setState({
        hub: {
          agentConfig: async () => saved.at(-1) ?? '[skills]\nenabled = ["github"]\n',
          saveAgentConfig: async (_id: string, toml: string) => {
            saved.push(toml);
            offers.this = true;
          },
        } as never,
      });
    });
    afterEach(() => {
      useChat.setState({ roster: [] as never });
      useDesk.setState({ hub: null });
    });

    it("turns the person's connection on for its default agent itself, then asks again", async () => {
      withConnections(true);
      render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
      pickSystem("Jira");
      fireEvent.click(await screen.findByRole("button", { name: "Turn Jira on for Max" }));
      await waitFor(() => expect(via().getByText("With this computer’s own Jira keys")).toBeTruthy());
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatch(/enabled = \[[^\]]*"github"[^\]]*"jira"/);
      expect((via().getByRole("radio", { name: /This computer/ }) as HTMLInputElement).disabled).toBe(false);
      expect(document.body.textContent).not.toMatch(/admin|remote MCP/);
    });

    it("asks for the person's own key where only an agent's own connection is kept", async () => {
      native.route = (hub, method, path, body) =>
        hub === "local" && method === "GET" && path === "/api/desk/connections"
          ? {
              status: 200,
              body: {
                connectors: [
                  {
                    ...jiraConnector(true),
                    connections: [{ ...jiraConnector(true).connections[0], level: "agent", agent: "max", agentName: "Max" }],
                  },
                ],
                adapters: [],
              },
            }
          : hub === "local"
            ? localRoutes(method, path, body)
            : { status: 404 };
      render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
      pickSystem("Jira");
      expect(await screen.findByRole("button", { name: "Connect Jira" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Turn Jira on for Max" })).toBeNull();
    });

    it("asks for the person's own key in place where there's no connection yet", async () => {
      withConnections(false);
      render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
      pickSystem("Jira");
      expect(await screen.findByRole("button", { name: "Connect Jira" })).toBeTruthy();
      expect(screen.getByText("Connect Jira to sync through this computer; Desk turns it on for Max.")).toBeTruthy();
      expect(saved).toHaveLength(0);
    });
  });

  it("says the hub's refusals in its words: tools missing, a filter it won't take, a board with tickets", async () => {
    kept = [...kept, { id: "hub-globex-example", name: "Globex", url: GLOBEX.url, hasToken: true }];
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await screen.findByText("No agent on hub-globex-example you can reach has Jira switched on.");
    expect((via().getByRole("radio", { name: /^Globex/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Jira project key"), { target: { value: "ACME" } });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Import" })).getByRole("radio", { name: "JQL" }));
    fireEvent.change(screen.getByLabelText("The query"), { target: { value: "project = ACME ORDER BY created" } });
    await screen.findByText("JQL here can't sort: leave out ORDER BY.", undefined, { timeout: 2000 });
    expect((screen.getByRole("button", { name: "Link to ACME" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<LinkBoardDialog board={ACME} tickets={3} onClose={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Acme’s tickets" })).toBeTruthy();
  });

  it("links a board with tickets of its own, keeping them beside the issues or clearing them first", async () => {
    const ours = [ticket(1, { state: "todo" }), ticket(2, { state: "backlog" })];
    useBoard.setState({ tickets: Object.fromEntries(ours.map((t) => [t.id, t])) });
    const deleteTicket = vi.fn(async (_id: string) => {});
    useDesk.setState({ hub: { deleteTicket } as never });
    const linkUp = async (choice: RegExp) => {
      render(<LinkBoardDialog board={ACME} tickets={2} onClose={() => {}} />);
      expect(document.querySelector(".move-foot .dialog-foot-note")!.textContent).toBe("Say what happens to Acme’s 2 tickets.");
      fireEvent.click(screen.getByRole("radio", { name: choice }));
      pickSystem("Jira");
      await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
      fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
      fireEvent.change(await screen.findByLabelText("Atlas’s Jira project key"), { target: { value: "ACME" } });
      await waitFor(() => expect((screen.getByRole("button", { name: "Link to ACME" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
      fireEvent.click(screen.getByRole("button", { name: "Link to ACME" }));
      await waitFor(() => expect(native.asked.some((a) => a.method === "PUT" && a.path === `/api/desk/boards/${ACME.id}/link`)).toBe(true));
      return native.asked.filter((a) => a.method === "PUT" && a.path === `/api/desk/boards/${ACME.id}/link`).pop()!.body!;
    };
    expect(await linkUp(/Keep them beside the issues/)).toMatchObject({ keepTickets: true });
    expect(deleteTicket).not.toHaveBeenCalled();
    cleanup();
    native.asked.length = 0;
    useBoard.setState({ tickets: Object.fromEntries(ours.map((t) => [t.id, t])) });
    const cleared = await linkUp(/Clear them first/);
    expect(cleared.keepTickets).toBeUndefined();
    expect(deleteTicket.mock.calls.map((c) => c[0]).sort()).toEqual(["t1", "t2"]);
  });

  it("links a whole team by default, and asks for a member id only where the hub can't say who you are", async () => {
    let saysMe = true;
    native.route = (hub, method, path, body) => {
      if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "linear") {
        const out: Record<string, unknown> = { offered: true, teams: [{ id: "6f1c0a2e-1b2c", key: "ATL", name: "Atlas core" }] };
        if (!body.target) return { status: 200, body: out };
        out.states = ["Todo", "In Progress", "Done"];
        out.prefill = { todo: "Todo", doing: "In Progress", done: "Done" };
        out.me = saysMe ? { id: "11111111-2222-4333-8444-555555555555", name: "Sam" } : null;
        const filter = body.filter as { kind: string } | undefined;
        if (filter?.kind === "assignedToMe" && !saysMe && !body.me) out.filterError = 'Say which Linear member you are, for "assigned to me".';
        else if (filter) out.matches = filter.kind === "all" ? 340 : 9;
        return { status: 200, body: out };
      }
      return localRoutes(method, path, body);
    };
    const { unmount } = render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Linear");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Linear team"), { target: { value: "6f1c0a2e-1b2c" } });
    const imports = within(await screen.findByRole("radiogroup", { name: "Import" }));
    expect(imports.getByRole("radio", { name: "Whole team" }).getAttribute("aria-checked")).toBe("true");
    await screen.findByText("340 open issues", undefined, { timeout: 2000 });
    // The hub knows who you are: "assigned to me" asks nothing.
    fireEvent.click(imports.getByRole("radio", { name: "Assigned to me" }));
    await screen.findByText("9 issues", undefined, { timeout: 2000 });
    expect(screen.queryByLabelText("Your Linear member id")).toBeNull();
    unmount();
    // A hub that can't say: the id is asked for, once.
    saysMe = false;
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Linear");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Linear team"), { target: { value: "6f1c0a2e-1b2c" } });
    fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Import" })).getByRole("radio", { name: "Assigned to me" }));
    const id = await screen.findByLabelText("Your Linear member id", undefined, { timeout: 2000 });
    fireEvent.change(id, { target: { value: "11111111-2222-4333-8444-555555555555" } });
    await screen.findByText("9 issues", undefined, { timeout: 2000 });
  });

  it("offers Linear's teams, and no current cycle", async () => {
    native.route = (hub, method, path, body) => {
      if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "linear")
        return { status: 200, body: { offered: true, teams: [{ id: "6f1c0a2e-1b2c", key: "ATL", name: "Atlas core" }] } };
      return localRoutes(method, path, body);
    };
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Linear");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Linear team"), { target: { value: "6f1c0a2e-1b2c" } });
    const imports = within(await screen.findByRole("radiogroup", { name: "Import" }));
    expect(imports.queryByRole("radio", { name: /sprint/ })).toBeNull();
    expect(imports.getByRole("radio", { name: "Assigned to me" })).toBeTruthy();
    // An older hub, which can't count without the id, gets asked for it.
    fireEvent.click(imports.getByRole("radio", { name: "Assigned to me" }));
    expect(screen.queryByLabelText("Your Linear member id")).toBeNull();
  });

  it("says by the Link button what it still waits on, first thing first", async () => {
    let matching: { status: number; body: unknown } = { status: 200, body: { offered: true, states: ["Todo", "Done"], matches: 4, matchesAtLeast: false } };
    native.route = (hub, method, path, body) => {
      if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "linear") {
        if (!body.target) return { status: 200, body: { offered: true, teams: [{ id: "6f1c0a2e-1b2c", key: "ATL", name: "Atlas core" }] } };
        // A hub that can't say who the person is.
        if (matching.status === 200) return { ...matching, body: { ...(matching.body as object), me: null, meWhy: "Atlas uses a shared Linear key, so it can't say who you are." } };
        return matching;
      }
      return localRoutes(method, path, body);
    };
    const note = () => document.querySelector(".move-foot .dialog-foot-note")!.textContent;
    const button = () => screen.getByRole("button", { name: /^Link/ }) as HTMLButtonElement;
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    expect(note()).toBe("Pick Jira or Linear.");
    pickSystem("Linear");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    expect(note()).toBe("Pick where Linear is reached through.");
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    await waitFor(() => expect(note()).toBe("Pick a team."));
    fireEvent.change(await screen.findByLabelText("Atlas’s Linear team"), { target: { value: "6f1c0a2e-1b2c" } });
    // The whole team needs no id: it waits only on the count.
    expect(note()).toBe("Waiting for the match count…");
    await waitFor(() => expect(button().disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Import" })).getByRole("radio", { name: "Assigned to me" }));
    expect(note()).toBe("Enter your Linear member id.");
    // The field says what an id is, and that the hub can't say who you are.
    expect(screen.getByText(/not your name or email\. Atlas can’t say who you are on Linear, so Desk asks once\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your Linear member id"), { target: { value: "Sam Lee" } });
    expect(screen.getByText(/That isn’t a Linear id/)).toBeTruthy();
    expect(note()).toBe("Enter your Linear member id.");
    fireEvent.change(screen.getByLabelText("Your Linear member id"), { target: { value: "0b9e7c1a-55aa-4e0f-9d1b-3c2f8a6e4d10" } });
    expect(note()).toBe("Waiting for the match count…");
    await waitFor(() => expect(button().disabled).toBe(false), { timeout: 2000 });
    expect(note()).toBe("");
    // A failed check: its words, by the button.
    matching = { status: 422, body: { error: "Linear says that team is archived." } };
    fireEvent.change(screen.getByLabelText("Your Linear member id"), { target: { value: "0b9e7c1a-55aa-4e0f-9d1b-3c2f8a6e4d11" } });
    await waitFor(() => expect(note()).toBe("The match check failed: Linear says that team is archived."), { timeout: 2000 });
    expect(button().disabled).toBe(true);
    cleanup();
    render(<LinkBoardDialog board={ACME} tickets={2} onClose={() => {}} />);
    expect(note()).toBe(`Say what happens to ${ACME.name}’s 2 tickets.`);
    // No hub on this computer: said, not waited on.
    cleanup();
    useChat.setState({ hubs: [ATLAS] as never });
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Linear");
    expect(note()).toBe("Desk isn’t ready yet, so nothing can be checked or linked. Try again in a moment.");
  });
});

describe("the board, synced", () => {
  const synced = (over: Partial<NonNullable<BoardT["sync"]>> = {}): BoardT => ({
    ...ACME,
    prefix: null,
    sync: { link: "l1", system: "jira", target: "ACME", via: { kind: "hub", hub: "atlas-acme-example" }, person: "p1", filter: { kind: "assignedToMe" }, states: {}, pulledAt: new Date().toISOString(), ...over },
  });
  const ext = (key: string, more = {}) => ({ system: "jira" as const, key, url: `https://acme.atlassian.example/browse/${key}`, remoteUpdatedAt: "2026-11-05T09:00:00Z", synced: true, link: "l1", ...more });
  const show = (b: BoardT, tickets: Ticket[]) => {
    useBoard.setState({ boards: { [b.id]: b }, tickets: Object.fromEntries(tickets.map((t) => [t.id, t])), supported: true, shown: b.id });
    useSyncHubs.setState({ hubs: kept });
    return render(<Board chrome={BOARD_CHROME} />);
  };

  it("shows synced, with the issues' keys, a push problem on its card, and syncs on opening", async () => {
    show(synced(), [
      ticket(1, { key: "ACME-482", title: "Checkout <b>loses</b> the postcode", external: ext("ACME-482") }),
      ticket(2, { key: "ACME-471", external: ext("ACME-471"), state: "review", pushProblem: "Atlas refused the move to In Review." }),
      ticket(3, { key: null, title: "Made here" }),
    ]);
    expect(screen.getByText("Synced")).toBeTruthy();
    expect(screen.getByText(/Jira ACME via Atlas/)).toBeTruthy();
    expect(screen.getByText("ACME-482")).toBeTruthy();
    expect(screen.getByText("Not on Jira yet")).toBeTruthy();
    expect(screen.getByText("Atlas refused the move to In Review.")).toBeTruthy();
    // An issue's words are text, never markup.
    expect(screen.getByText("Checkout <b>loses</b> the postcode")).toBeTruthy();
    expect(document.querySelector(".board-card b b")).toBeNull();
    await waitFor(() => expect(native.asked.some((a) => a.method === "POST" && a.path === `/api/desk/boards/${ACME.id}/sync`)).toBe(true));
  });

  it("shows who has each issue, takes an unassigned one for you, and filters to Mine and Unassigned", async () => {
    const me = "557058:sam";
    const b = synced({ filter: { kind: "all", value: { includeDone: false } }, me, meName: "Sam", meSource: "vouched" });
    const free = ticket(11, { key: "ACME-11", title: "Nobody has this", external: ext("ACME-11", { assignee: null }), state: "todo" });
    const ana = ticket(12, { key: "ACME-12", title: "Ana has this", external: ext("ACME-12", { assignee: { id: "acct-ana", name: "Ana Diaz" } }), state: "todo" });
    const mine = ticket(13, { key: "ACME-13", title: "Mine there", external: ext("ACME-13", { assignee: { id: me, name: "Sam" } }), state: "doing" });
    const older = ticket(14, { key: "ACME-14", title: "From an older hub", external: ext("ACME-14"), state: "todo" });
    native.route = (hub, method, path, body) => {
      if (hub === "local" && method === "POST" && path === `/api/desk/tickets/${free.id}/take`)
        return { status: 200, body: { ...free, external: ext("ACME-11", { assignee: { id: me, name: "Sam" } }) } };
      return localRoutes(method, path, body);
    };
    show(b, [free, ana, mine, older]);
    const todo = within(screen.getByRole("region", { name: "To do" }));
    expect(todo.getByText("Unassigned")).toBeTruthy();
    expect(todo.getByText("Ana Diaz")).toBeTruthy();
    expect(todo.getByText("A")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Doing" })).getByText("You")).toBeTruthy();
    // Only the one no one has can be taken; an older hub's says nothing.
    expect(screen.getAllByRole("button", { name: /^Take / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Mine · 1" })).toBeTruthy();
    // One an older hub sent without saying who has it isn't counted as no one's.
    fireEvent.click(screen.getByRole("button", { name: "Unassigned · 1" }));
    expect(screen.queryByText("Ana has this")).toBeNull();
    expect(screen.queryByText("From an older hub")).toBeNull();
    expect(screen.getByText("Nobody has this")).toBeTruthy();
    // A chip counts what it would show, as the search leaves it.
    fireEvent.change(screen.getByLabelText("Search tickets"), { target: { value: "Ana" } });
    expect(screen.getByRole("button", { name: "Unassigned" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search tickets"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    fireEvent.click(screen.getByRole("button", { name: "Take ACME-11" }));
    await waitFor(() => expect(native.asked.some((a) => a.hub === "local" && a.method === "POST" && a.path === `/api/desk/tickets/${free.id}/take`)).toBe(true));
    await waitFor(() => expect(screen.queryAllByRole("button", { name: /^Take / })).toHaveLength(0));
    expect(useBoard.getState().tickets[free.id]!.external!.assignee).toEqual({ id: me, name: "Sam" });
    fireEvent.click(screen.getByRole("button", { name: "Mine · 2" }));
    expect(screen.getByText("Nobody has this")).toBeTruthy();
    expect(screen.queryByText("Ana has this")).toBeNull();
  });

  it("says who you are there, and asks the hub again", async () => {
    const b = synced({ me: "557058:sam", meName: "Sam", meSource: "vouched" });
    native.route = (hub, method, path, body) =>
      hub === "local" && path === `/api/desk/boards/${ACME.id}/me`
        ? { status: 200, body: { ...b, sync: { ...b.sync!, me: undefined, meName: undefined, meSource: undefined, meNote: "Atlas uses a shared Jira key, so it can't say who you are." } } }
        : localRoutes(method, path, body);
    show(b, []);
    expect(screen.getByText(/you're Sam there/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(document.querySelector(".board-sync-me")?.textContent).toMatch(/Atlas uses a shared Jira key, so it can't say who you are\./));
    expect(screen.getByRole("button", { name: "Check who you are" })).toBeTruthy();
    // A shared key: their own key is the way to be known there.
    fireEvent.click(screen.getByRole("button", { name: "Set up your own Jira key" }));
    expect(useUi.getState().settings).toBe("connections");
  });

  it("says when a shared key knows you by your verified email, and Take it goes by it", () => {
    const b = synced({ me: "557058:sam", meName: "Sam", meSource: "vouchedByEmail" });
    show(b, [ticket(31, { key: "ACME-31", external: ext("ACME-31", { assignee: null }), state: "todo" })]);
    expect(screen.getByText(/you're Sam there, by your verified email/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take ACME-31" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set up your own/ })).toBeNull();
  });

  it("says plainly when Jira hides your email from the shared key, and offers your own key", () => {
    const note = "Atlas uses a shared Jira key, and Jira doesn't show your email to the shared key, so it can't say who you are.";
    show(synced({ meNote: note }), []);
    expect(document.querySelector(".board-sync-me")?.textContent).toContain("Jira doesn't show your email to the shared key");
    fireEvent.click(screen.getByRole("button", { name: "Set up your own Jira key" }));
    expect(useUi.getState().settings).toBe("connections");
  });

  it("says why Take it didn't, and shows who took it meanwhile", async () => {
    const free = ticket(21, { key: "ACME-21", external: ext("ACME-21", { assignee: null }), state: "todo" });
    const fail = vi.fn();
    useDesk.setState({ fail, hub: { ticket: async () => ({ ...free, external: ext("ACME-21", { assignee: { id: "acct-ana", name: "Ana Diaz" } }) }) } as never });
    native.route = (hub, method, path, body) =>
      hub === "local" && path.endsWith("/take") ? { status: 409, body: { error: "Ana Diaz has ACME-21 on Jira already." } } : localRoutes(method, path, body);
    show(synced({ me: "557058:sam", meSource: "vouched" }), [free]);
    fireEvent.click(screen.getByRole("button", { name: "Take ACME-21" }));
    await waitFor(() => expect(fail).toHaveBeenCalled());
    expect(String((fail.mock.calls[0]![0] as Error).message)).toMatch(/Ana Diaz has ACME-21/);
    await screen.findByText("Ana Diaz");
    expect(screen.queryByRole("button", { name: /^Take / })).toBeNull();
  });

  it("draws a column of hundreds a page at a time", () => {
    // Without the hub vouching for who you are, nothing offers Take it.
    const { unmount } = show(synced({ meNote: "Atlas uses a shared Jira key, so it can't say who you are." }), [ticket(99, { key: "ACME-99", external: ext("ACME-99", { assignee: null }), state: "todo" })]);
    expect(screen.queryByRole("button", { name: /^Take / })).toBeNull();
    unmount();
    const many = Array.from({ length: 200 }, (_, i) => ticket(100 + i, { key: `ACME-${100 + i}`, external: ext(`ACME-${100 + i}`, { assignee: null }), state: "backlog" }));
    show(synced(), many);
    const backlog = within(screen.getByRole("region", { name: "Backlog" }));
    expect(backlog.getAllByRole("button", { name: /^ACME-\d+:/ })).toHaveLength(80);
    fireEvent.click(backlog.getByRole("button", { name: "Show 80 more of 120" }));
    expect(backlog.getAllByRole("button", { name: /^ACME-\d+:/ })).toHaveLength(160);
    expect(backlog.getByRole("button", { name: "Show 40 more of 40" })).toBeTruthy();
  });

  it("says why it is paused, and pauses and resumes", async () => {
    const since = "2026-11-10T10:42:00Z";
    native.route = (_hub, method, path, body) =>
      path.endsWith("/pause") ? { status: 200, body: synced({ paused: (body as { paused: boolean }).paused ? { kind: "byYou" } : null }) } : localRoutes(method, path, body);
    show(synced({ paused: { kind: "hubOffline", since } }), []);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText(/Atlas is offline since \d\d:\d\d; changes go out when it's back/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await screen.findByRole("button", { name: "Pause" });
    expect(native.asked.find((a) => a.path.endsWith("/pause"))!.body).toEqual({ paused: false });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await screen.findByText("Paused by you; changes go out when you resume it.");
  });

  it("says a problem in the hub's words, and offers a new token when the hub refused the old one", () => {
    const { unmount } = show(synced({ problem: "Atlas: jira.transition_issue failed." }), []);
    expect(screen.getByText("Sync problem")).toBeTruthy();
    expect(screen.getByText("Atlas: jira.transition_issue failed.")).toBeTruthy();
    unmount();
    show(synced({ paused: { kind: "noToken" } }), []);
    expect(screen.getByText("Paused: Atlas needs a new token.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New token…" })).toBeTruthy();
  });

  it("puts issues that left the filter on their shelf, out of the columns, to keep or drop", async () => {
    const left = ticket(5, { key: "ACME-455", title: "Mobile nav focus ring", external: ext("ACME-455", { synced: false }), leftFilter: true, state: "todo" });
    const leftFilter = vi.fn(async (id: string, keep: boolean) => ({ ...left, id, leftFilter: false, external: ext("ACME-455", { synced: false, kept: keep }) }));
    useDesk.setState({ hub: { leftFilter } as never });
    show(synced(), [left, ticket(6, { key: "ACME-456", external: ext("ACME-456"), state: "todo" })]);
    const shelf = screen.getByRole("region", { name: /Left the filter · 1/ });
    expect(within(shelf).getByText("Mobile nav focus ring")).toBeTruthy();
    const todo = screen.getByRole("region", { name: "To do" });
    expect(within(todo).queryByText("ACME-455")).toBeNull();
    fireEvent.click(within(shelf).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(leftFilter).toHaveBeenCalledWith(left.id, true));
    await waitFor(() => expect(screen.queryByRole("region", { name: /Left the filter/ })).toBeNull());
    expect(within(screen.getByRole("region", { name: "To do" })).getByText("ACME-455")).toBeTruthy();
  });

  it("opens a ticket's issue and its PRs only at https addresses", () => {
    const t = ticket(7, {
      key: "ACME-7",
      external: ext("ACME-7"),
      links: [
        { kind: "pr", number: 12, url: "https://github.com/acme/web/pull/12" },
        { kind: "pr", number: 13, url: "javascript:alert(1)" },
      ],
    });
    useDesk.setState({ hub: { ticketHistory: async () => ({ events: [], next: null }), ledger: async () => ({ rows: [], next: null }) } as never });
    useBoard.setState({ boards: { [ACME.id]: synced() }, tickets: { [t.id]: t }, open: t.id });
    render(<OpenTicket />);
    expect(screen.getByRole("button", { name: "Open in Jira" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "github.com/acme/web/pull/12" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /alert/ })).toBeNull();
  });

  it("offers linking from the board's menu, and unlinking once linked", async () => {
    show(ACME, []);
    fireEvent.click(screen.getByRole("button", { name: "Boards" }));
    expect(screen.getByRole("menuitem", { name: "Link to Jira or Linear…" })).toBeTruthy();
    cleanup();
    show(synced(), []);
    fireEvent.click(screen.getByRole("button", { name: "Boards" }));
    expect(screen.getByRole("menuitem", { name: "Unlink from Jira…" })).toBeTruthy();
  });
});

describe("board sync's words and checks", () => {
  it("says each pause as the hub does", () => {
    expect(pausedWords({ kind: "byYou" }, "Atlas")).toBe("Paused by you; changes go out when you resume it.");
    expect(pausedWords({ kind: "missing", tools: ["jira.search", "jira.add_comment"] }, "Atlas")).toBe("Paused: no agent on Atlas you can reach has Jira switched on any more.");
    const through = { ...ACME, sync: { link: "l", system: "jira", target: "ACME", via: { kind: "hub", hub: "atlas" }, agent: "lattice", person: "p", filter: { kind: "assignedToMe" }, states: {} } } as BoardT;
    expect(linkedTo(through, "Atlas")).toBe("Jira ACME through Lattice on Atlas");
    expect(linkedTo({ ...through, sync: { ...through.sync!, agent: undefined } }, "Atlas")).toBe("Jira ACME via Atlas");
    expect(pausedWords({ kind: "refused", reason: "policy denied" }, "Atlas")).toBe("Paused: Atlas refused: policy denied");
    expect(pausedWords({ kind: "hubUnpaired" }, "Atlas")).toMatch(/isn't linked any more/);
    expect(pausedWords({ kind: "leftGroup" }, "Atlas")).toMatch(/left the group/);
  });

  it("puts a pause before a problem", () => {
    const b = { ...ACME, sync: { link: "l", system: "jira", target: "A", via: { kind: "thisHub" }, person: "p", filter: { kind: "assignedToMe" }, states: {}, paused: { kind: "noToken" }, problem: "x" } } as BoardT;
    expect(syncStatus(b, "This computer")!.kind).toBe("paused");
    expect(syncStatus({ ...b, sync: { ...b.sync!, paused: null } }, "x")).toEqual({ kind: "problem", words: "x" });
    expect(syncStatus(ACME, "x")).toBeNull();
  });

  it("names sync hubs as the hub takes them, and checks keys as it does", () => {
    expect(syncHubId("atlas-acme-example")).toBe("atlas-acme-example");
    expect(syncHubId("Weird_Hub.example")).toBe("weird-hub-example");
    expect(syncHubId("x".repeat(60))).toHaveLength(40);
    expect(targetOk("jira", "ACME_WEB")).toBe(true);
    expect(targetOk("linear", "ACME_WEB")).toBe(false);
    expect(targetOk("jira", "acme")).toBe(false);
  });

  it("takes a pasted token as the local hub does: wfr_, letters, digits, _ and -, longer than 20", () => {
    expect(looksLikeToken("wfr_Xk3_9-aZq0PLm2vB7cNw4Rt")).toBe(true);
    expect(looksLikeToken("  wfr_Xk3_9-aZq0PLm2vB7cNw4Rt\n")).toBe(true);
    expect(looksLikeToken("wfr_short_but_17ch")).toBe(false);
    expect(looksLikeToken("wfr_Xk3+9/aZq0PLm2vB7cNw4Rt=")).toBe(false);
    expect(looksLikeToken("wfp_Xk3_9-aZq0PLm2vB7cNw4Rt")).toBe(false);
  });

  it("opens only an issue's https address", () => {
    const t = (url: string) => ticket(1, { external: { system: "jira", key: "A-1", url, remoteUpdatedAt: "", synced: true, link: "l" } });
    expect(issueUrl(t("https://acme.atlassian.example/browse/A-1"))).toBe("https://acme.atlassian.example/browse/A-1");
    expect(issueUrl(t("javascript:alert(1)"))).toBeNull();
    expect(issueUrl(t("http://acme.example/A-1"))).toBeNull();
  });

  it("takes a sync now's 202 as done, and a refusal in the hub's words", async () => {
    native.route = (_h, _m, path) => (path.endsWith("/b1/sync") ? { status: 202 } : { status: 409, body: { error: "That board isn't synced." } });
    const api = boardSyncOf(LOCAL);
    await expect(api.syncNow("b1")).resolves.toBeUndefined();
    await expect(api.syncNow("b2")).rejects.toThrow("That board isn't synced.");
    await act(async () => {});
  });
});
