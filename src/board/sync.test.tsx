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
import { boardSyncOf, fixOf, isGithubProject, shortKey, issueUrl, linkedTo, looksLikeToken, pausedWords, syncHubId, syncStatus, targetOk, targetWords } from "../hub/boardSync";
import { useDesk } from "../hub/store";
import type { ActivityParty, Board as BoardT, SyncHub, Ticket } from "../hub/types";
import { Board } from "./BoardView";
import { BOARD_CHROME } from "./chrome";
import { OpenTicket } from "./TicketDetail";
import { LinkBoardDialog } from "./LinkBoard";
import { BoardActionDialog } from "./boardActions";
import { SyncBar } from "./SyncBar";
import { useBoard } from "./store";
import { useSyncHubs } from "./syncStore";
import { useBoardViews } from "./views";
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
  if (method === "PUT" && link) return { status: 200, body: { ...ACME, id: link[1], prefix: null, sync: { link: "l1", ...body, person: "p1" } } };
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
  useBoardViews.setState({ views: {} });
  useBoard.setState({ boards: { [ACME.id]: ACME }, tickets: {}, supported: true, shown: ACME.id, open: null });
});
afterEach(cleanup);

const pickSystem = (s: "Jira" | "Linear" | "GitHub") => fireEvent.click(within(screen.getByRole("radiogroup", { name: "System" })).getByRole("radio", { name: s }));
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
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Import" })).getByRole("radio", { name: "A Jira search" }));
    fireEvent.change(screen.getByLabelText("The search"), { target: { value: "project = ACME ORDER BY created" } });
    await screen.findByText(/can’t sort the issues: leave out its “order by” part/, undefined, { timeout: 2000 });
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

  it("offers a new board for the link when this one has tickets, leaving this one as it is", async () => {
    const created: BoardT[] = [];
    const createBoard = vi.fn(async (b: { name: string }) => {
      const nb = { ...ACME, id: "b-new", name: b.name, prefix: null } as BoardT;
      created.push(nb as never);
      return nb;
    });
    const updateBoard = vi.fn(async (_id: string, _p: unknown) => ({ ...ACME, id: "b-new", name: "Acme · Jira", group: "g1" }) as BoardT);
    useDesk.setState({ hub: { createBoard, updateBoard } as never });
    useBoard.setState({ tickets: { t1: ticket(1) } });
    render(<LinkBoardDialog board={{ ...ACME, group: "g1" }} tickets={1} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Make a new board and link it/ }));
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Jira project key"), { target: { value: "ACME" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Link to ACME" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Link to ACME" }));
    await waitFor(() => expect(native.asked.some((a) => a.method === "PUT" && a.path === "/api/desk/boards/b-new/link")).toBe(true));
    expect(createBoard).toHaveBeenCalledWith({ name: "Acme · Jira" });
    expect(updateBoard).toHaveBeenCalledWith("b-new", { group: "g1" });
    expect(native.asked.some((a) => a.path === `/api/desk/boards/${ACME.id}/link`)).toBe(false);
    expect(native.asked.find((a) => a.path === "/api/desk/boards/b-new/link")!.body!.keepTickets).toBeUndefined();
  });

  it("says its import choices in plain words, with no JQL or JSON", async () => {
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    await screen.findByLabelText("Atlas’s Jira project key");
    fireEvent.change(screen.getByLabelText("Atlas’s Jira project key"), { target: { value: "ACME" } });
    await screen.findByRole("radiogroup", { name: "Import" });
    for (const name of ["Assigned to me", "The current sprint", "A Jira search"]) {
      fireEvent.click(within(screen.getByRole("radiogroup", { name: "Import" })).getByRole("radio", { name }));
      expect(document.querySelector(".sync-link")!.textContent).not.toMatch(/JQL|JSON|currentUser|openSprints/);
    }
    cleanup();
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Linear");
    expect(document.body.textContent).not.toMatch(/JSON/);
  });

  it("lists the Jira projects to pick from when the hub says them, else takes a typed key", async () => {
    native.route = (hub, method, path, body) => {
      const r = localRoutes(method, path, body);
      if (hub === "local" && path === "/api/desk/boards/link/check" && r.status === 200) return { status: 200, body: { ...(r.body as object), projects: [{ key: "ACME", name: "Acme web" }, { key: "OPS", name: "Operations" }] } };
      return r;
    };
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    const pick = (await screen.findByLabelText("Atlas’s Jira project")) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(["Pick a project", "ACME · Acme web", "OPS · Operations"]);
    expect(screen.queryByLabelText("Atlas’s Jira project key")).toBeNull();
    fireEvent.change(pick, { target: { value: "OPS" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Link to OPS" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    // A project that isn't listed can still be typed.
    fireEvent.click(screen.getByRole("button", { name: "Not listed? Type the key" }));
    expect(screen.getByLabelText("Atlas’s Jira project key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick from the list" }));
    expect(screen.getByLabelText("Atlas’s Jira project")).toBeTruthy();
  });

  it("takes a new board away again when its link fails, leaving no ghost and showing the first board", async () => {
    const nb = { ...ACME, id: "b-new", name: "Acme · Jira", prefix: null } as BoardT;
    const deleteBoard = vi.fn(async (_id: string) => {});
    useDesk.setState({ hub: { createBoard: async () => nb, updateBoard: async () => nb, boards: async () => [ACME, nb], deleteBoard } as never });
    native.route = (hub, method, path, body) => (hub === "local" && method === "PUT" && path.endsWith("/b-new/link") ? { status: 422, body: { error: "Atlas refused that." } } : localRoutes(method, path, body));
    useBoard.setState({ tickets: { t1: ticket(1) } });
    render(<LinkBoardDialog board={ACME} tickets={1} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Make a new board and link it/ }));
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Jira project key"), { target: { value: "ACME" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Link to ACME" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Link to ACME" }));
    await waitFor(() => expect(deleteBoard).toHaveBeenCalledWith("b-new"));
    await waitFor(() => expect(useBoard.getState().boards["b-new"]).toBeUndefined());
    expect(useBoard.getState().shown).toBe(ACME.id);
  });

  it("keeps a new board whose link did apply though the answer was lost", async () => {
    const nb = { ...ACME, id: "b-new", name: "Acme · Jira", prefix: null } as BoardT;
    const deleteBoard = vi.fn(async (_id: string) => {});
    useDesk.setState({ hub: { createBoard: async () => nb, updateBoard: async () => nb, boards: async () => [ACME, { ...nb, sync: { link: "l", system: "jira", target: "ACME" } }], deleteBoard } as never });
    native.route = (hub, method, path, body) => (hub === "local" && method === "PUT" && path.endsWith("/b-new/link") ? { status: 502, body: { error: "lost" } } : localRoutes(method, path, body));
    useBoard.setState({ tickets: { t1: ticket(1) } });
    render(<LinkBoardDialog board={ACME} tickets={1} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Make a new board and link it/ }));
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Jira project key"), { target: { value: "ACME" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Link to ACME" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Link to ACME" }));
    await waitFor(() => expect(useBoard.getState().shown).toBe("b-new"));
    expect(deleteBoard).not.toHaveBeenCalled();
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

  it("asks which Linear workspace first where you have several there, lists its teams, and keeps it with the link", async () => {
    const WS = ["driftwerk", "mantiscrm", "petmobile"];
    native.route = (hub, method, path, body) => {
      if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "linear") {
        const ws = body.workspace as string | undefined;
        if (!ws) return { status: 200, body: { offered: true, workspaces: WS, workspace: null, workspaceWhy: "Pick which Linear workspace: driftwerk, mantiscrm or petmobile" } };
        if (!body.target) return { status: 200, body: { offered: true, workspaces: WS, workspace: ws, teams: ws === "mantiscrm" ? [{ id: "8a7b-man", key: "MAN", name: "Mantis" }] : [{ id: "8a7b-dri", key: "DRI", name: "Driftwerk" }] } };
        return { status: 200, body: { offered: true, workspaces: WS, workspace: ws, states: ["Todo", "Done"], prefill: { todo: "Todo", done: "Done" }, me: { id: "u1", name: "Sam" }, ...(body.filter ? { matches: 4, matchesAtLeast: false } : {}) } };
      }
      return localRoutes(method, path, body);
    };
    const closed = vi.fn();
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={closed} />);
    pickSystem("Linear");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    const picker = within(await screen.findByRole("radiogroup", { name: "Linear workspace" }));
    expect(picker.getAllByRole("radio").map((r) => r.closest("label")!.querySelector(".move-opt-main > span")!.textContent)).toEqual(WS);
    // No team until one is picked, and the button says why, plainly.
    expect(screen.queryByLabelText("Atlas’s Linear team")).toBeNull();
    expect(document.querySelector(".dialog-foot-note")!.textContent).toBe("Pick which Linear workspace: driftwerk, mantiscrm or petmobile");
    expect(document.body.textContent).not.toMatch(/'default'/);
    fireEvent.click(picker.getByRole("radio", { name: /^mantiscrm/ }));
    const team = await screen.findByLabelText("Atlas’s Linear team");
    expect(within(team).getByRole("option", { name: "MAN · Mantis" })).toBeTruthy();
    expect(native.asked.some((a) => a.path === "/api/desk/boards/link/check" && a.body?.workspace === "mantiscrm" && !a.body?.target)).toBe(true);
    fireEvent.change(team, { target: { value: "8a7b-man" } });
    await screen.findByText("4 open issues", undefined, { timeout: 2000 });
    expect(native.asked.some((a) => a.path === "/api/desk/boards/link/check" && a.body?.workspace === "mantiscrm" && a.body?.target === "MAN")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Link to MAN" }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    const linked = native.asked.find((a) => a.method === "PUT" && a.path === `/api/desk/boards/${ACME.id}/link`)!;
    expect(linked.body).toMatchObject({ system: "linear", target: "MAN", targetId: "8a7b-man", workspace: "mantiscrm" });
  });

  it("shows no workspace picker where you have one there", async () => {
    native.route = (hub, method, path, body) => {
      if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "linear")
        return { status: 200, body: { offered: true, workspaces: ["driftwerk"], workspace: "driftwerk", teams: [{ id: "6f1c0a2e-1b2c", key: "ATL", name: "Atlas core" }] } };
      return localRoutes(method, path, body);
    };
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Linear");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    await screen.findByLabelText("Atlas’s Linear team");
    expect(screen.queryByRole("radiogroup", { name: "Linear workspace" })).toBeNull();
  });

  describe("GitHub", () => {
    /** What the hub says of GitHub: acme's projects and repos, and another owner's. */
    const ghRoutes = (hub: string, method: string, path: string, body: Record<string, unknown> | null) => {
      if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "github") {
        const owner = (body.owner as string | undefined) ?? "sam";
        const out: Record<string, unknown> = { offered: true, owner };
        if (!body.target) {
          if (owner === "sam") {
            out.projectsWhy = "This GitHub key can't read projects. Sign in again with Projects allowed, or link the repository's issues instead.";
            out.projects = [];
          } else out.projects = [{ key: `${owner}/projects/7`, name: "Roadmap", id: "PVT_kwDOroad" }];
          out.repos = [{ key: `${owner}/web`, name: `${owner}/web` }];
          return { status: 200, body: out };
        }
        const project = /\/projects\//.test(body.target as string);
        out.states = project ? ["Todo", "In Progress", "Done"] : ["Open", "Closed", "label:in progress"];
        out.prefill = project ? { todo: "Todo", doing: "In Progress", done: "Done" } : { todo: "Open", done: "Closed" };
        if (!project) out.milestones = ["v1", "v2"];
        out.me = { id: "sam", name: "Sam" };
        const filter = body.filter as { kind: string } | undefined;
        if (filter) Object.assign(out, { matches: 9, matchesAtLeast: false, ceiling: 2000 });
        return { status: 200, body: out };
      }
      return localRoutes(method, path, body);
    };
    const open = async () => {
      render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
      pickSystem("GitHub");
      await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
      fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    };

    it("offers a project first, says plainly when projects can't be read and still offers repositories", async () => {
      native.route = ghRoutes;
      await open();
      const where = within(await screen.findByRole("radiogroup", { name: "Project or repository" }));
      expect(where.getAllByRole("radio")[0]!.textContent).toBe("A project");
      expect(where.getByRole("radio", { name: "A project" }).getAttribute("aria-checked")).toBe("true");
      expect((await screen.findByRole("alert")).textContent).toMatch(/This GitHub key can't read projects/);
      expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("sam");
      fireEvent.click(screen.getByRole("button", { name: "Link a repository’s issues instead" }));
      fireEvent.change(await screen.findByLabelText("sam’s repository"), { target: { value: "sam/web" } });
      // A repository's issues: no project filter, a milestone picked from the list, states as "Label x".
      const imports = within(await screen.findByRole("radiogroup", { name: "Import" }));
      expect(imports.queryByRole("radio", { name: "A project filter" })).toBeNull();
      expect(imports.queryByRole("radio", { name: /cycle|sprint/i })).toBeNull();
      fireEvent.click(imports.getByRole("radio", { name: "A milestone" }));
      fireEvent.change(await screen.findByLabelText("Milestone"), { target: { value: "v2" } });
      await screen.findByText("9 issues", undefined, { timeout: 2000 });
      const options = within(screen.getByLabelText("Doing moves its issue to")).getAllByRole("option").map((o) => o.textContent);
      expect(options).toContain("Label in progress");
      fireEvent.change(screen.getByLabelText("Doing moves its issue to"), { target: { value: "label:in progress" } });
      fireEvent.click(screen.getByRole("button", { name: "Link to sam/web" }));
      await waitFor(() => expect(native.asked.some((a) => a.method === "PUT" && a.path === `/api/desk/boards/${ACME.id}/link`)).toBe(true));
      const linked = native.asked.find((a) => a.method === "PUT" && a.path === `/api/desk/boards/${ACME.id}/link`)!;
      expect(linked.body).toEqual({
        system: "github",
        target: "sam/web",
        via: { kind: "hub", hub: "atlas-acme-example" },
        filter: { kind: "milestone", value: "v2" },
        states: { todo: "Open", done: "Closed", doing: "label:in progress" },
      });
    });

    it("lists another owner's projects when the owner is changed, and links a project with its id and a repo for new tickets", async () => {
      native.route = ghRoutes;
      await open();
      fireEvent.change(await screen.findByLabelText("Owner"), { target: { value: "acme" } });
      await waitFor(() => expect(native.asked.some((a) => a.path === "/api/desk/boards/link/check" && a.body?.owner === "acme" && !a.body?.target)).toBe(true));
      fireEvent.change(await screen.findByLabelText("acme’s GitHub project"), { target: { value: "acme/projects/7" } });
      const imports = within(await screen.findByRole("radiogroup", { name: "Import" }));
      expect(imports.getByRole("radio", { name: "A project filter" })).toBeTruthy();
      fireEvent.change(screen.getByLabelText("New tickets go to"), { target: { value: "acme/web" } });
      await screen.findByText("9 open issues", undefined, { timeout: 2000 });
      const checkedProject = native.asked.filter((a) => a.path === "/api/desk/boards/link/check" && a.body?.target === "acme/projects/7").at(-1)!;
      expect(checkedProject.body).toMatchObject({ system: "github", owner: "acme", targetId: "PVT_kwDOroad" });
      fireEvent.click(screen.getByRole("button", { name: "Link to acme · project 7" }));
      await waitFor(() => expect(native.asked.some((a) => a.method === "PUT" && a.path === `/api/desk/boards/${ACME.id}/link`)).toBe(true));
      const linked = native.asked.find((a) => a.method === "PUT")!;
      expect(linked.body).toMatchObject({ system: "github", target: "acme/projects/7", targetId: "PVT_kwDOroad", repo: "acme/web" });
    });

    it("links a typed project with the id the hub resolved, naming no connection the person didn't pick", async () => {
      native.route = (hub, method, path, body) => {
        if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "github") {
          if (!body.workspace && !body.target && !body.owner) return { status: 200, body: { offered: true, workspaces: ["acme-ws", "other-ws"], workspace: "acme-ws" } };
          if (body.target === "acme/projects/8") {
            const r = ghRoutes(hub, method, path, body) as { body: Record<string, unknown> };
            return { status: 200, body: { ...r.body, targetId: "PVT_resolved" } };
          }
        }
        return ghRoutes(hub, method, path, body);
      };
      await open();
      fireEvent.change(await screen.findByLabelText("Owner"), { target: { value: "acme" } });
      await waitFor(() => expect(native.asked.some((a) => a.path === "/api/desk/boards/link/check" && a.body?.owner === "acme" && a.body?.workspace === undefined)).toBe(true));
      fireEvent.click(await screen.findByRole("button", { name: "Not listed? Type it" }));
      fireEvent.change(await screen.findByLabelText("The project’s address"), { target: { value: "acme/projects/8" } });
      await screen.findByRole("radiogroup", { name: "Import" });
      await screen.findByText("9 open issues", undefined, { timeout: 2000 });
      fireEvent.click(within(screen.getByRole("radiogroup", { name: "Import" })).getByRole("radio", { name: "A label" }));
      fireEvent.change(screen.getByPlaceholderText("desk"), { target: { value: "bug" } });
      await waitFor(() => expect(native.asked.some((a) => a.body?.filter && (a.body.filter as { kind: string }).kind === "label" && a.body.target === "acme/projects/8")).toBe(true));
      // The re-check with the filter carries the resolved id too.
      expect(native.asked.filter((a) => a.body?.target === "acme/projects/8" && a.body?.filter && (a.body.filter as { kind: string }).kind === "label").at(-1)!.body).toMatchObject({ targetId: "PVT_resolved" });
      await screen.findByText("9 issues", undefined, { timeout: 2000 });
      fireEvent.click(screen.getByRole("button", { name: "Link to acme · project 8" }));
      await waitFor(() => expect(native.asked.some((a) => a.method === "PUT")).toBe(true));
      const put = native.asked.find((a) => a.method === "PUT")!.body!;
      expect(put).toMatchObject({ system: "github", target: "acme/projects/8", targetId: "PVT_resolved" });
      expect(put.workspace).toBeUndefined();
    });

    it("goes through the connection the hub found reaching the owner, keeping the owner typed", async () => {
      const CONNECTIONS = ["driftwerk", "mantis", "patchwork"];
      native.route = (hub, method, path, body) => {
        if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "github") {
          const r = ghRoutes(hub, method, path, body) as { body: Record<string, unknown> };
          const workspace = body.owner === "acme" ? "driftwerk" : ((body.workspace as string | undefined) ?? "mantis");
          return { status: 200, body: { ...r.body, workspaces: CONNECTIONS, workspace } };
        }
        return ghRoutes(hub, method, path, body);
      };
      await open();
      const picker = within(await screen.findByRole("radiogroup", { name: "GitHub connection" }));
      expect((picker.getByRole("radio", { name: /^mantis/ }) as HTMLInputElement).checked).toBe(true);
      fireEvent.change(await screen.findByLabelText("Owner"), { target: { value: "acme" } });
      await waitFor(() => expect((picker.getByRole("radio", { name: /^driftwerk/ }) as HTMLInputElement).checked).toBe(true));
      expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("acme");
      fireEvent.change(await screen.findByLabelText("acme’s GitHub project"), { target: { value: "acme/projects/7" } });
      await screen.findByText("9 open issues", undefined, { timeout: 2000 });
      const checks = () => native.asked.filter((a) => a.path === "/api/desk/boards/link/check" && a.body?.target === "acme/projects/7");
      // Not picked: the hub finds the connection, so none is named.
      expect(checks().at(-1)!.body).toMatchObject({ owner: "acme" });
      expect(checks().every((a) => a.body?.workspace === undefined)).toBe(true);
      fireEvent.click(picker.getByRole("radio", { name: /^patchwork/ }));
      await waitFor(() => expect(checks().at(-1)!.body).toMatchObject({ owner: "acme", workspace: "patchwork" }), { timeout: 2000 });
      expect((picker.getByRole("radio", { name: /^patchwork/ }) as HTMLInputElement).checked).toBe(true);
    });

    it("asks which connection where several reach the project, from those only", async () => {
      const why = "Pick which GitHub connection: driftwerk or patchwork";
      native.route = (hub, method, path, body) => {
        if (hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "github") {
          const r = ghRoutes(hub, method, path, body) as { body: Record<string, unknown> };
          if (body.target && !body.workspace) return { status: 200, body: { offered: true, workspaces: ["driftwerk", "patchwork"], workspaceWhy: why } };
          return { status: 200, body: { ...r.body, workspaces: ["driftwerk", "mantis", "patchwork"], workspace: (body.workspace as string | undefined) ?? "mantis" } };
        }
        return ghRoutes(hub, method, path, body);
      };
      await open();
      fireEvent.change(await screen.findByLabelText("Owner"), { target: { value: "acme" } });
      fireEvent.change(await screen.findByLabelText("acme’s GitHub project"), { target: { value: "acme/projects/7" } });
      await waitFor(() => expect(document.querySelector(".dialog-foot-note")?.textContent).toBe(why), { timeout: 2000 });
      expect((screen.getByRole("button", { name: /^Link/ }) as HTMLButtonElement).disabled).toBe(true);
      const picker = within(screen.getByRole("radiogroup", { name: "GitHub connection" }));
      expect(picker.getAllByRole("radio").map((r) => r.closest("label")!.querySelector(".move-opt-main > span")!.textContent)).toEqual(["driftwerk", "patchwork"]);
      fireEvent.click(picker.getByRole("radio", { name: /^patchwork/ }));
      await screen.findByText("9 open issues", undefined, { timeout: 2000 });
      const checked = native.asked.filter((a) => a.path === "/api/desk/boards/link/check" && a.body?.target === "acme/projects/7").at(-1)!;
      expect(checked.body).toMatchObject({ owner: "acme", workspace: "patchwork" });
    });

    it("takes a typed repository where the hub lists none, and says what it waits on", async () => {
      native.route = (hub, method, path, body) =>
        hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "github" && !body.target
          ? { status: 200, body: { offered: true, owner: "sam", projects: [], repos: [] } }
          : ghRoutes(hub, method, path, body);
      await open();
      fireEvent.click(await screen.findByRole("radio", { name: "A repository" }));
      expect(document.querySelector(".dialog-foot-note")?.textContent).toBe("Enter the repository as owner/name.");
      fireEvent.change(await screen.findByLabelText("The repository"), { target: { value: "acme/web" } });
      await screen.findByRole("radiogroup", { name: "Import" });
    });
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
    expect(note()).toBe("Pick Jira, Linear or GitHub.");
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

  it("keeps one sync bar, the shown board's, however often the board shown changes", async () => {
    const plt: BoardT = { ...synced({ target: "PLT" }), id: "b-plt", name: "Platform board" };
    const man: BoardT = { ...synced({ link: "l2", system: "linear", target: "MAN" }), id: "b-man", name: "Mantis board" };
    useBoard.setState({ boards: { [plt.id]: plt, [man.id]: man }, tickets: {}, supported: true, shown: plt.id });
    useSyncHubs.setState({ hubs: kept });
    render(<Board chrome={BOARD_CHROME} />);
    const bars = () => document.querySelectorAll(".board-sync");
    const once = (target: RegExp, other: RegExp) => {
      expect(bars()).toHaveLength(1);
      expect(bars()[0]!.textContent).toMatch(target);
      expect(bars()[0]!.textContent).not.toMatch(other);
    };
    once(/Jira PLT/, /Linear MAN/);
    for (let i = 0; i < 3; i++) {
      act(() => useBoard.getState().show(man.id));
      once(/Linear MAN/, /Jira PLT/);
      act(() => useBoard.getState().show(plt.id));
      once(/Jira PLT/, /Linear MAN/);
    }
  });

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
    expect(todo.getByText("AD")).toBeTruthy();
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

  it("lets you choose who you are on a shared key, by name only, and says so", async () => {
    const b = synced({ meNote: "Atlas uses a shared Jira key, so it can't say who you are." });
    const chosen = { ...b, sync: { ...b.sync!, me: "557058:kay", meName: "K. Hendrickse", meSource: "chosen" as const, meNote: undefined } };
    native.route = (hub, method, path, body) => {
      if (hub === "local" && path === "/api/desk/boards/link/members")
        return { status: 200, body: { members: [{ id: "557058:kay", name: "K. Hendrickse", avatar: null }] } };
      if (hub === "local" && path === "/api/desk/boards/link/me") return { status: 200, body: { chosen: { id: body?.id, name: body?.name } } };
      if (hub === "local" && path === `/api/desk/boards/${ACME.id}/me`) return { status: 200, body: chosen };
      return localRoutes(method, path, body);
    };
    show(b, []);
    fireEvent.click(screen.getByRole("button", { name: "Choose who you are" }));
    fireEvent.change(screen.getByPlaceholderText("Part of your name there"), { target: { value: "hendr" } });
    fireEvent.click(await screen.findByRole("button", { name: "I'm K. Hendrickse" }));
    await waitFor(() => expect(document.querySelector(".board-sync-me")?.textContent).toMatch(/you're K\. Hendrickse there, you chose this/));
    const asked = native.asked.filter((a) => a.hub === "local");
    expect(asked.find((a) => a.path === "/api/desk/boards/link/members")?.body).toMatchObject({ system: "jira", name: "hendr" });
    expect(asked.find((a) => a.path === "/api/desk/boards/link/me")?.body).toMatchObject({ system: "jira", id: "557058:kay", name: "K. Hendrickse" });
    // Changed, or cleared: back to the email.
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Go by my email instead" }));
    await waitFor(() => expect(native.asked.some((a) => a.path === "/api/desk/boards/link/me" && a.body?.clear === true)).toBe(true));
  });

  it("says a Slack email's match as such", () => {
    show(synced({ me: "557058:sam", meName: "Sam", meSource: "vouchedBySlack" }), []);
    expect(screen.getByText(/you're Sam there, by your Slack email/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "That’s not me" })).toBeTruthy();
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

  it("draws what each issue says of itself: type, epic, priority, points, PRs, and what blocks it there", () => {
    const epic = { key: "ACME-9", title: "Permissions", kind: "Epic" };
    const story = ticket(41, {
      key: "ACME-41",
      title: "Map hub roles",
      state: "todo",
      external: ext("ACME-41", {
        assignee: null,
        details: {
          kind: "Story",
          epic,
          priority: "Now",
          priorityRank: 1,
          points: 5,
          subItems: { done: 1, total: 4 },
          prs: { count: 2, state: "review" },
          comments: 3,
          links: [
            { rel: "blockedBy", issue: { key: "ACME-77", title: "Shared roles", done: false } },
            { rel: "blockedBy", issue: { key: "ACME-78", done: true } },
            { rel: "blocks", issue: { key: "ACME-80" } },
          ],
        },
      }),
    });
    const bare = ticket(42, { key: "ACME-42", title: "Plain task", state: "backlog", external: ext("ACME-42", { details: { kind: "Task" } }) });
    const old = ticket(43, { key: "ACME-43", title: "Shipped", state: "done", stateAt: "2026-01-01T00:00:00Z", external: ext("ACME-43", { details: { kind: "Bug", points: 2, priorityRank: 2, prs: { count: 1, state: "merged", number: 58 } } }) });
    show(synced(), [story, bare, old]);
    const card = screen.getByRole("button", { name: "ACME-41: Map hub roles" });
    expect(within(card).getByRole("img", { name: "Story" })).toBeTruthy();
    expect(within(card).getByTitle("Epic ACME-9 · Permissions").textContent).toBe("Permissions");
    expect(within(card).getByRole("img", { name: "Priority Now" }).textContent).toBe("!");
    expect(within(card).getByText("5 pts")).toBeTruthy();
    expect(within(card).getByTitle("1 of 4 sub-items done")).toBeTruthy();
    expect(within(card).getByText("2 PRs")).toBeTruthy();
    // Blocked there by what isn't done, though it isn't on the board.
    expect(within(card).getByText("Blocked by ACME-77").className).toContain("state-blocked");
    // Synced cards never say Jira wrote them: every one would.
    expect(within(card).queryByText(/by Jira|added this/)).toBeNull();
    expect(within(card).getByTitle("Blocks ACME-80")).toBeTruthy();
    expect(within(card).getByTitle("3 comments")).toBeTruthy();
    // A plain task stays as short as a card ever was.
    const plain = screen.getByRole("button", { name: "ACME-42: Plain task" });
    expect(plain.querySelector(".board-card-facts")).toBeNull();
    // The column adds its points up.
    expect(within(screen.getByRole("region", { name: "To do" })).getByText(/1 · 5 pts/)).toBeTruthy();
    // A screen reader hears what the glyphs and chips say.
    expect(document.getElementById(card.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Story. Epic Permissions. Priority Now. 5 points. 1 of 4 sub-items done. 2 pull requests, in review. Blocked by ACME-77",
    );
    // Done's points aren't added up: they would only grow.
    expect(within(screen.getByRole("region", { name: "Done" })).getByLabelText("1 ticket")).toBeTruthy();
    // A settled card keeps only its PR.
    fireEvent.click(screen.getByRole("button", { name: /settled after 3 days/ }));
    const done = screen.getByRole("button", { name: "ACME-43: Shipped" });
    expect(within(done).getByText("#58")).toBeTruthy();
    expect(within(done).queryByText("2 pts")).toBeNull();
    expect(within(done).queryByRole("img", { name: /^Priority/ })).toBeNull();
  });

  it("puts who has an issue there beside the session that has it here, and leaves a local card's head as it was", () => {
    const run: ActivityParty = { kind: "session", id: "s-run", name: "brisk-otter", engine: "claude" };
    show(synced({ me: "acct-sam", meName: "Sam" }), [
      ticket(71, { key: "ACME-71", title: "Run it", state: "doing", assignee: run, external: ext("ACME-71", { assignee: { id: "acct-sam", name: "Sam Lee" }, details: { kind: "Task" } }) }),
      ticket(72, { key: null, title: "Local one", pinned: true }),
    ]);
    const who = screen.getByRole("button", { name: "ACME-71: Run it" }).querySelector(".board-who")!;
    expect(who.querySelector(".board-who-name")!.nextElementSibling!.getAttribute("title")).toBe("You have it on Jira");
    const local = screen.getByRole("button", { name: /Local one/ });
    expect(local.querySelector(".board-card-head")!.className).toBe("board-card-head");
    expect(local.querySelector(".board-card-facts")).toBeNull();
  });

  it("filters a Jira board by epic and type, and a Linear one by project and label", () => {
    const a = ticket(51, { key: "ACME-51", title: "Alpha", state: "todo", external: ext("ACME-51", { details: { kind: "Story", epic: { key: "ACME-1", title: "Permissions" } } }) });
    const b = ticket(52, { key: "ACME-52", title: "Beta", state: "todo", external: ext("ACME-52", { details: { kind: "Bug", epic: { key: "ACME-2", title: "Insights" } } }) });
    const { unmount } = show(synced(), [a, b]);
    const epic = screen.getByRole("combobox", { name: "Epic" }) as HTMLSelectElement;
    expect([...epic.options].map((o) => o.textContent)).toEqual(["Epic: all", "Epic: Insights", "Epic: Permissions"]);
    fireEvent.change(epic, { target: { value: "Insights" } });
    expect(screen.queryByRole("button", { name: "ACME-51: Alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: "ACME-52: Beta" })).toBeTruthy();
    expect(epic.closest(".board-facet")!.textContent).toContain("Epic: Insights");
    fireEvent.change(epic, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "ACME-51: Alpha" })).toBeTruthy();
    unmount();
    const lin = (n: number, title: string, project: string, labels: string[]) =>
      ticket(n, { key: `MAN-${n}`, title, state: "todo", external: { ...ext(`MAN-${n}`), system: "linear" as const, details: { project, labels, stateKind: "unstarted", remoteState: "Todo" } } });
    show(synced({ system: "linear", target: "MAN" }), [lin(61, "Gamma", "Edge cloud", ["Bug"]), lin(62, "Delta", "Voice box", ["Feature"])]);
    expect(screen.queryByRole("combobox", { name: "Epic" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Label" }), { target: { value: "Feature" } });
    expect(screen.queryByRole("button", { name: "MAN-61: Gamma" })).toBeNull();
    expect(screen.getByRole("button", { name: "MAN-62: Delta" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Todo" })).toBeTruthy();
  });

  it("draws a GitHub board: Milestone, Label and Type chips, keys as repo#12 with the full one on hover, and As on GitHub only on a project", () => {
    const gh = (n: number, title: string, milestone: string, labels: string[], kind: string) =>
      ticket(n, {
        key: `acme/web#${n}`,
        title,
        state: "todo",
        upstreamRank: String(n * 1024).padStart(10, "0") as never,
        external: ext(`acme/web#${n}`, { system: "github" as const, url: `https://github.invalid/acme/web/issues/${n}`, details: { kind, labels, sprint: { name: milestone } } }),
      });
    const a = gh(12, "Alpha", "v1", ["bug"], "Bug");
    const b = gh(13, "Beta", "v2", ["ui"], "Feature");
    const { unmount } = show(synced({ system: "github", target: "acme/projects/7" }), [a, b]);
    expect(screen.getByText("GitHub acme · project 7 via Atlas", { exact: false })).toBeTruthy();
    expect(screen.getByText("web#12").getAttribute("title")).toBe("GitHub issue acme/web#12");
    expect(screen.queryByText("acme/web#12")).toBeNull();
    expect(screen.getByRole("button", { name: "acme/web#12: Alpha" })).toBeTruthy();
    expect([...(screen.getByRole("combobox", { name: "Milestone" }) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Milestone: all", "v1", "v2"]);
    expect(screen.getByRole("combobox", { name: "Label" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Epic" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Milestone" }), { target: { value: "v2" } });
    expect(screen.queryByRole("button", { name: "acme/web#12: Alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: "acme/web#13: Beta" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Order: as on GitHub" }));
    expect(within(screen.getByRole("menu", { name: "Order" })).getAllByRole("menuitemradio").map((i) => i.firstChild!.firstChild!.textContent)).toEqual(["As on GitHub", "Newest first", "Oldest first", "Recently changed"]);
    expect(screen.getByText("The project's own order, as GitHub has it")).toBeTruthy();
    // Enter on repo#12 opens that issue, owner left out.
    const search = screen.getByLabelText("Search tickets");
    fireEvent.change(search, { target: { value: "web#13" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(useBoard.getState().open).toBe(b.id);
    // A repository's board has no order of its own: it offers none, and a saved one falls back.
    unmount();
    useBoardViews.setState({ views: { [ACME.id]: { order: "source" } } as never });
    show(synced({ system: "github", target: "acme/web" }), [a, b]);
    fireEvent.click(screen.getByRole("button", { name: "Order: newest first" }));
    expect(within(screen.getByRole("menu", { name: "Order" })).getAllByRole("menuitemradio").map((i) => i.firstChild!.firstChild!.textContent)).toEqual(["Newest first", "Oldest first", "Recently changed"]);
  });

  it("keeps a board's own filters and its order when it is shown again, and orders it as on Jira until another is picked", () => {
    const a = ticket(51, { key: "ACME-51", title: "Alpha", state: "todo", external: ext("ACME-51", { details: { kind: "Story", epic: { key: "ACME-1", title: "Permissions" } } }) });
    const b = ticket(52, { key: "ACME-52", title: "Beta", state: "todo", external: ext("ACME-52", { details: { kind: "Bug", epic: { key: "ACME-2", title: "Insights" } } }) });
    const { unmount } = show(synced(), [a, b]);
    fireEvent.change(screen.getByRole("combobox", { name: "Epic" }), { target: { value: "Insights" } });
    fireEvent.click(screen.getByRole("button", { name: "Order: as on Jira" }));
    expect(within(screen.getByRole("menu", { name: "Order" })).getAllByRole("menuitemradio").map((i) => i.firstChild!.firstChild!.textContent)).toEqual([
      "As on Jira",
      "Newest first",
      "Oldest first",
      "Recently changed",
    ]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Oldest first/ }));
    unmount();
    show(synced(), [a, b]);
    expect(screen.getByRole("button", { name: "Order: oldest first" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Epic" }) as HTMLSelectElement).value).toBe("Insights");
    expect(screen.queryByRole("button", { name: "ACME-51: Alpha" })).toBeNull();
  });

  it("drops a kept filter its Jira or Linear has no chip for, as when the board was linked to the other", () => {
    useBoardViews.setState({ views: { [ACME.id]: { facets: { epic: "Insights", label: "Feature" } } } });
    const lin = (n: number, title: string, labels: string[]) =>
      ticket(n, { key: `MAN-${n}`, title, state: "todo", external: { ...ext(`MAN-${n}`), system: "linear" as const, details: { labels } } });
    show(synced({ system: "linear", target: "MAN" }), [lin(61, "Gamma", ["Bug"]), lin(62, "Delta", ["Feature"])]);
    // The epic (Jira's) is left out; the label (Linear's) still filters.
    expect(screen.queryByRole("button", { name: "MAN-61: Gamma" })).toBeNull();
    expect(screen.getByRole("button", { name: "MAN-62: Delta" })).toBeTruthy();
  });

  it("shows a card's created date beside Take it, never under it, with the full date on hover", () => {
    const free = ticket(71, { key: "ACME-71", state: "todo", external: ext("ACME-71", { assignee: null, details: { created: "2026-11-17T14:02:00Z" } }) });
    const held = ticket(72, { key: "ACME-72", state: "todo", external: ext("ACME-72", { assignee: { id: "u2", name: "Kate Fisher" }, details: { created: "2026-03-04T10:00:00Z" } }) });
    show(synced({ me: "557058:sam", meName: "Sam", meSource: "vouched" }), [free, held]);
    const card = screen.getByRole("button", { name: /^ACME-71:/ });
    const take = screen.getByRole("button", { name: "Take ACME-71" });
    // Take it is its own button beside the card's, never inside it.
    expect(card.contains(take)).toBe(false);
    expect(take.closest(".board-card-wrap")).toBe(card.closest(".board-card-wrap"));
    // The card's own date, in its foot after Take it's place.
    const end = card.querySelector(".board-foot-end")!;
    expect([...end.children].map((c) => c.className)).toEqual(["btn btn-sm board-take board-take-room", "board-when"]);
    const when = end.querySelector(".board-when")!;
    expect(when.textContent).toBe("Nov 17");
    expect(when.getAttribute("title")).toBe("Created 17 Nov 2026, 14:02 UTC");
    // The room Take it lies over, and the date's width beside Take it, are unseen.
    expect(end.querySelector(".board-take-room")!.getAttribute("aria-hidden")).toBe("true");
    expect(take.parentElement!.querySelector(".board-when-room")!.textContent).toBe("Nov 17");
    // A card someone has shows its date as well.
    expect(screen.getByRole("button", { name: /^ACME-72:/ }).querySelector(".board-when")!.textContent).toBe("Mar 4");
    expect(screen.getByRole("button", { name: /^ACME-72:/ }).querySelector(".board-take-room")).toBeNull();
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
    expect(screen.getByText("Paused: paste a new token for Atlas.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New token…" })).toBeTruthy();
  });

  it("says a drag the hub couldn't make there on the bar, and clears it once the board no longer says it", () => {
    const said = "ACME-1 stays where you dropped it here, but couldn't be moved on Jira: no permission. Its place there comes back on the next sync.";
    show(synced({ orderProblem: said }), []);
    expect(screen.getByText(said).className).toContain("board-sync-failed");
    expect(screen.getByText("Synced")).toBeTruthy();
    act(() => useBoard.setState((s) => ({ boards: { ...s.boards, [ACME.id]: synced({ orderProblem: null }) } })));
    expect(screen.queryByText(said)).toBeNull();
    act(() => useBoard.setState((s) => ({ boards: { ...s.boards, [ACME.id]: synced({ orderProblem: said }) } })));
    expect(screen.getByText(said)).toBeTruthy();
    // A board without the field at all, as an older hub's.
    act(() => useBoard.setState((s) => ({ boards: { ...s.boards, [ACME.id]: synced() } })));
    expect(screen.queryByText(said)).toBeNull();
  });

  it("gives each pause and problem its own fix button, none telling you to unlink and link again", async () => {
    const words = () => document.querySelector(".board-sync")!.textContent!;
    let u = show(synced({ paused: { kind: "hubUnpaired" } }), []);
    expect(words()).not.toMatch(/link it again/);
    fireEvent.click(screen.getByRole("button", { name: "Keep the tickets, unlink" }));
    await screen.findByText(/Its tickets stay here with their keys/);
    cleanup();
    u = show(synced({ paused: { kind: "missing", tools: ["jira.search"] } }), []);
    useUi.getState().closeSettings();
    fireEvent.click(screen.getByRole("button", { name: "Ask an agent on Atlas to switch Jira on" }));
    expect(document.querySelector(".sync-no-agent, .move-callout")).toBeTruthy();
    expect(useUi.getState().settings).not.toBe("connections");
    u.unmount();
    u = show({ ...synced({ paused: { kind: "missing", tools: ["jira.search"] } }), sync: { ...synced().sync!, via: { kind: "thisHub" }, paused: { kind: "missing", tools: ["jira.search"] } } } as BoardT, []);
    // This computer: Desk turns it on itself, or says where it can't.
    fireEvent.click(screen.getByRole("button", { name: "Turn Jira on here" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open connections" }));
    expect(useUi.getState().settings).toBe("connections");
    u.unmount();
    native.route = (_hub, method, path, body) =>
      path.endsWith("/pause") ? { status: 200, body: synced({ paused: null }) } : path.endsWith("/sync") ? { status: 202 } : localRoutes(method, path, body);
    show(synced({ paused: { kind: "refused", reason: "policy denied" } }), []);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(native.asked.some((a) => a.path.endsWith("/pause") && a.body?.paused === false)).toBe(true));
    await waitFor(() => expect(native.asked.some((a) => a.path.endsWith("/sync"))).toBe(true));
  });

  it("names the one fix for each pause and problem", () => {
    const base = synced().sync!;
    const hubVia = { kind: "hub", hub: "atlas" } as const;
    const fix = (over: object) => fixOf({ ...base, via: hubVia, paused: null, problem: null, ...over } as never, "Atlas");
    expect(fix({ paused: { kind: "byYou" } })).toBeNull();
    expect(fix({ paused: { kind: "hubOffline", since: "2026-11-10T10:00:00Z" } })).toEqual({ kind: "retry", label: "Try again" });
    expect(fix({ paused: { kind: "hubUnpaired" } })?.kind).toBe("unlink");
    expect(fix({ paused: { kind: "noToken" } })?.kind).toBe("token");
    expect(fix({ paused: { kind: "noToken" }, via: { kind: "thisHub" } })).toEqual({ kind: "connections", label: "Open connections" });
    expect(fix({ paused: { kind: "missing", tools: [] } })?.kind).toBe("ask");
    expect(fix({ paused: { kind: "missing", tools: [] }, via: { kind: "thisHub" } })).toEqual({ kind: "setup", label: "Turn Jira on here" });
    expect(fix({ paused: { kind: "refused", reason: "x" } })?.kind).toBe("retry");
    expect(fix({ paused: { kind: "leftGroup" } })?.kind).toBe("unlink");
    expect(fix({ problem: "x" })?.kind).toBe("retry");
    expect(fix({})).toBeNull();
  });

  it("shows a sync that failed in the bar, with Try again, and not in the window's toast", async () => {
    const fail = vi.fn();
    useDesk.setState({ fail });
    native.route = (_hub, method, path, body) => (path.endsWith("/sync") ? { status: 409, body: { error: "Atlas is busy." } } : localRoutes(method, path, body));
    show(synced(), []);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Try again");
    expect(fail).not.toHaveBeenCalled();
  });

  it("leaves the reason to the hub when a try to resume it failed, never a pause by you", async () => {
    native.route = (_hub, method, path, body) =>
      path.endsWith("/pause") ? { status: 200, body: synced({ paused: (body as { paused: boolean }).paused ? { kind: "byYou" } : null }) } : path.endsWith("/sync") ? { status: 409, body: { error: "Atlas is busy." } } : localRoutes(method, path, body);
    show(synced({ paused: { kind: "refused", reason: "policy denied" } }), []);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(native.asked.some((a) => a.path.endsWith("/sync"))).toBe(true));
    expect(native.asked.filter((a) => a.path.endsWith("/pause")).map((a) => a.body?.paused)).toEqual([false]);
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
    expect(screen.getByRole("button", { name: /#12/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /alert/ })).toBeNull();
  });

  it("shows a GitHub issue's type and its full key in its ticket, with the milestone as such", () => {
    const t = ticket(9, { key: "acme/web#9", title: "Postcode", external: ext("acme/web#9", { system: "github" as const, details: { kind: "Bug", sprint: { number: 4 } } }) });
    useDesk.setState({ hub: { ticketHistory: async () => ({ events: [], next: null }), ledger: async () => ({ rows: [], next: null }) } as never });
    useBoard.setState({ boards: { [ACME.id]: synced({ system: "github", target: "acme/projects/7" }) }, tickets: { [t.id]: t }, open: t.id });
    render(<OpenTicket />);
    expect(document.querySelector(".ticket-crumb-self .ticket-crumb-key")?.textContent).toBe("acme/web#9");
    expect(document.querySelector(".ticket-key")?.textContent).toBe("acme/web#9");
    expect(screen.getByText("Milestone 4")).toBeTruthy();
  });

  it("says beside Desk's state what its issue calls it, faint, and stacks the view under 760px", async () => {
    const t = ticket(8, { key: "ACME-8", state: "doing", external: ext("ACME-8", { details: { remoteState: "In Progress", kind: "Story" } }) });
    useDesk.setState({ hub: { ticketHistory: async () => ({ events: [], next: null }), ledger: async () => ({ rows: [], next: null }) } as never });
    useBoard.setState({ boards: { [ACME.id]: synced() }, tickets: { [t.id]: t }, open: t.id });
    const view = render(<OpenTicket />);
    // Wide: two columns, the word there with where it's said.
    expect(document.querySelector(".ticket-view.ticket-wide")).not.toBeNull();
    const state = screen.getByRole("combobox", { name: "State" }).closest("dd")!;
    expect(state.querySelector(".ticket-there")?.textContent).toBe("In Progress on Jira");
    view.unmount();
    // Measured at 700px: one column, the facts in a band under its title.
    const was = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { ...was.call(this), width: this.classList.contains("ticket-body") ? 700 : 0 } as DOMRect;
    };
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    try {
      render(<OpenTicket />);
      await waitFor(() => expect(document.querySelector(".ticket-view.ticket-stacked")).not.toBeNull());
      expect(document.querySelector(".ticket-side")).toBeNull();
      expect(screen.getByRole("complementary", { name: "Details" }).classList.contains("ticket-band")).toBe(true);
      const band = screen.getByRole("combobox", { name: "State" }).closest("dd")!;
      expect(band.querySelector(".ticket-there")?.textContent).toBe("In Progress");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = was;
      vi.unstubAllGlobals();
    }
  });

  it("offers linking from the board's menu, and unlinking once linked", async () => {
    show(ACME, []);
    fireEvent.click(screen.getByRole("button", { name: "Boards" }));
    expect(screen.getByRole("menuitem", { name: "Link to Jira, Linear or GitHub…" })).toBeTruthy();
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
    const mantis = { ...ACME, sync: { link: "l", system: "linear", target: "MAN", workspace: "mantiscrm", via: { kind: "hub", hub: "driftwerk" }, person: "p", filter: { kind: "all", value: { includeDone: false } }, states: {} } } as BoardT;
    expect(linkedTo(mantis, "Driftwerk")).toBe("Linear · mantiscrm · MAN via Driftwerk");
    expect(pausedWords({ kind: "workspace", what: "Linear workspace", names: ["driftwerk", "mantiscrm", "petmobile"] }, "Driftwerk")).toBe(
      "Paused: you have more than one Linear workspace on Driftwerk (driftwerk, mantiscrm or petmobile), and this link doesn't say which.",
    );
    expect(pausedWords({ kind: "workspace", what: "Jira site", asked: "client", names: ["acme"] }, "Atlas")).toBe("Paused: Atlas has no Jira site client of yours any more; yours there are acme.");
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

  it("names a GitHub board's project or repository as a person reads it, and checks the target as the hub does", () => {
    expect(targetOk("github", "acme/projects/7")).toBe(true);
    expect(targetOk("github", "acme/web")).toBe(true);
    expect(targetOk("github", "acme/projects/x")).toBe(false);
    expect(targetOk("github", "acme")).toBe(false);
    expect(targetOk("github", "-acme/web")).toBe(false);
    expect(targetOk("github", "acme/..")).toBe(false);
    expect(isGithubProject("acme/projects/7")).toBe(true);
    expect(isGithubProject("acme/projects")).toBe(false);
    expect(shortKey("acme/web#12")).toBe("web#12");
    expect(shortKey("web#12")).toBe("web#12");
    expect(targetWords("github", "acme/projects/7")).toBe("acme · project 7");
    expect(targetWords("github", "acme/web")).toBe("acme/web");
    expect(targetWords("jira", "ACME")).toBe("ACME");
    const gh = { ...ACME, sync: { link: "l", system: "github", target: "acme/projects/7", via: { kind: "hub", hub: "atlas" }, person: "p", filter: { kind: "all", value: { includeDone: false } }, states: {} } } as BoardT;
    expect(linkedTo(gh, "Atlas")).toBe("GitHub acme · project 7 via Atlas");
    expect(pausedWords({ kind: "missing", tools: ["github.project_items"] }, "Atlas")).toBe("Paused: no agent on Atlas you can reach has GitHub switched on any more.");
    expect(fixOf({ ...gh.sync!, paused: { kind: "missing", tools: ["github.project_items"] } }, "Atlas")?.label).toBe("Ask an agent on Atlas to switch GitHub on");
    expect(pausedWords({ kind: "missing", tools: ["github.project_items"] }, "This computer")).toBe("Paused: no agent on this computer you can reach has GitHub switched on any more.");
    const here = { ...gh, sync: { ...gh.sync!, via: { kind: "thisHub" as const } } };
    expect(linkedTo(here, "This computer")).toBe("GitHub acme · project 7 with this computer's keys");
    expect(linkedTo({ ...here, sync: { ...here.sync, agent: "desk" } }, "This computer")).toBe("GitHub acme · project 7 through Desk on this computer");
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

describe("a new board from Linear, Jira or GitHub", () => {
  const NEW = { ...ACME, id: "b-new", name: "PLT", prefix: null } as BoardT;
  let createBoard: ReturnType<typeof vi.fn>;
  let deleteBoard: ReturnType<typeof vi.fn>;
  const pickAtlasJira = async (key: string) => {
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Jira project key"), { target: { value: key } });
  };
  const ready = (name: string) => waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
  beforeEach(() => {
    createBoard = vi.fn(async (b: { name: string }) => ({ ...NEW, name: b.name }));
    deleteBoard = vi.fn(async (_id: string) => {});
    useDesk.setState({ hub: { createBoard, deleteBoard, boards: async () => [ACME, NEW] } as never });
  });
  afterEach(() => useDesk.setState({ hub: null }));

  it("asks for no board, makes one named after the project, links it and shows it", async () => {
    const closed = vi.fn();
    const made = vi.fn();
    render(<LinkBoardDialog onMade={made} onClose={closed} />);
    expect(screen.getByRole("heading", { name: "New board from Linear, Jira or GitHub" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: /tickets/ })).toBeNull();
    expect(document.querySelector(".move-foot .dialog-foot-note")!.textContent).toBe("Pick Jira, Linear or GitHub.");
    await pickAtlasJira("PLT");
    await ready("Make “PLT”");
    fireEvent.click(screen.getByRole("button", { name: "Make “PLT”" }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(createBoard).toHaveBeenCalledWith({ name: "PLT" });
    expect(native.asked.find((a) => a.method === "PUT" && a.path === "/api/desk/boards/b-new/link")!.body).toMatchObject({ system: "jira", target: "PLT" });
    await waitFor(() => expect(native.asked.some((a) => a.method === "POST" && a.path === "/api/desk/boards/b-new/sync")).toBe(true));
    expect(made).toHaveBeenCalledTimes(1);
    expect(useBoard.getState().shown).toBe("b-new");
    expect(deleteBoard).not.toHaveBeenCalled();
  });

  it("names a Linear board after its team", async () => {
    native.route = (hub, method, path, body) =>
      hub === "local" && path === "/api/desk/boards/link/check" && body?.system === "linear" && !body.target
        ? { status: 200, body: { offered: true, teams: [{ id: "8a7b-man", key: "MAN", name: "Mantis" }] } }
        : hub === "local"
          ? localRoutes(method, path, body)
          : { status: 404 };
    render(<LinkBoardDialog onClose={() => {}} />);
    pickSystem("Linear");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Linear team"), { target: { value: "8a7b-man" } });
    await ready("Make “Mantis”");
    fireEvent.click(screen.getByRole("button", { name: "Make “Mantis”" }));
    await waitFor(() => expect(createBoard).toHaveBeenCalledWith({ name: "Mantis" }));
  });

  it("removes the new board and says so when the link is refused", async () => {
    useBoard.setState({ shown: ACME.id });
    const closed = vi.fn();
    const was = native.route;
    native.route = (hub, method, path, body) =>
      method === "PUT" && /\/boards\/b-new\/link$/.test(path) ? { status: 422, body: { error: "Atlas couldn’t read that project." } } : was(hub, method, path, body);
    render(<LinkBoardDialog onClose={closed} />);
    await pickAtlasJira("PLT");
    await ready("Make “PLT”");
    fireEvent.click(screen.getByRole("button", { name: "Make “PLT”" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Atlas couldn’t read that project. No board was made: “PLT” was removed again.");
    expect(deleteBoard).toHaveBeenCalledWith("b-new");
    expect(useBoard.getState().boards["b-new"]).toBeUndefined();
    expect(useBoard.getState().shown).toBe(ACME.id);
    expect(closed).not.toHaveBeenCalled();
  });

  it("removes the new board when the dialog is closed while it is being made", async () => {
    let finish: (b: BoardT) => void = () => {};
    createBoard.mockImplementation(() => new Promise<BoardT>((r) => (finish = r)));
    const closed = vi.fn();
    const made = vi.fn();
    render(<LinkBoardDialog onMade={made} onClose={closed} />);
    await pickAtlasJira("PLT");
    await ready("Make “PLT”");
    fireEvent.click(screen.getByRole("button", { name: "Make “PLT”" }));
    await screen.findByRole("button", { name: "Making the board…" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closed).toHaveBeenCalledTimes(1);
    await act(async () => finish(NEW));
    await waitFor(() => expect(deleteBoard).toHaveBeenCalledWith("b-new"));
    expect(native.asked.some((a) => a.method === "PUT" && a.path === "/api/desk/boards/b-new/link")).toBe(false);
    expect(made).not.toHaveBeenCalled();
    expect(useBoard.getState().boards["b-new"]).toBeUndefined();
  });

  it("shows a board that has pulled nothing yet as on its first sync, and as synced once it has", () => {
    const linked = { ...ACME, updatedAt: new Date().toISOString(), sync: { link: "l", system: "jira", target: "PLT", via: { kind: "hub", hub: "atlas-acme-example" }, person: "p", filter: { kind: "all", value: { includeDone: false } }, states: {} } } as BoardT;
    const { rerender } = render(<SyncBar board={linked} now={Date.now()} />);
    expect(screen.getByText("Syncing")).toBeTruthy();
    expect(screen.getByText(/bringing in its issues for the first time/)).toBeTruthy();
    rerender(<SyncBar board={{ ...linked, sync: { ...linked.sync!, pulledAt: new Date().toISOString() } }} now={Date.now()} />);
    expect(screen.getByText("Synced")).toBeTruthy();
    expect(screen.queryByText(/for the first time/)).toBeNull();
  });

  it("says outside the dialog when a board made for a closed dialog couldn’t be removed", async () => {
    let finish: (b: BoardT) => void = () => {};
    createBoard.mockImplementation(() => new Promise<BoardT>((r) => (finish = r)));
    deleteBoard.mockRejectedValue(new Error("no"));
    const platform = await import("../platform");
    const said = vi.fn();
    platform.setOpenReporter(said);
    render(<LinkBoardDialog onClose={() => {}} />);
    await pickAtlasJira("PLT");
    await ready("Make “PLT”");
    fireEvent.click(screen.getByRole("button", { name: "Make “PLT”" }));
    await screen.findByRole("button", { name: "Making the board…" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => finish(NEW));
    await waitFor(() => expect(said).toHaveBeenCalled());
    expect((said.mock.calls[0]![0] as Error).message).toMatch(/“PLT” couldn’t be removed: delete it from its menu/);
    platform.setOpenReporter(null);
  });

  it("removes the new board, though its link applied, when the dialog was closed while linking, and leaves the view where the person went", async () => {
    const platform = await import("../platform");
    const said = vi.fn();
    platform.setOpenReporter(said);
    const was = native.route;
    native.route = (hub, method, path, body) => {
      if (method === "PUT" && /\/boards\/b-new\/link$/.test(path)) {
        // Closed while the link is out; the person has gone to another board.
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        useBoard.setState({ shown: "b-other" });
        return { status: 200, body: { ...NEW, sync: { link: "l1", ...body, person: "p" } } };
      }
      return was(hub, method, path, body);
    };
    const made = vi.fn();
    render(<LinkBoardDialog onMade={made} onClose={() => {}} />);
    await pickAtlasJira("PLT");
    await ready("Make “PLT”");
    fireEvent.click(screen.getByRole("button", { name: "Make “PLT”" }));
    await waitFor(() => expect(deleteBoard).toHaveBeenCalledWith("b-new"));
    await waitFor(() => expect(said).toHaveBeenCalled());
    expect((said.mock.calls[0]![0] as Error).message).toMatch(/“PLT” was removed again; no board was made/);
    expect(made).not.toHaveBeenCalled();
    expect(useBoard.getState().shown).toBe("b-other");
    platform.setOpenReporter(null);
  });

  it("is in the board's header menu, opening the same dialog", async () => {
    expect(BOARD_CHROME.entries(ACME, () => []).find((e) => e.kind === "item" && e.label === "New board from Linear, Jira or GitHub…")).toBeTruthy();
    render(<BoardActionDialog board={ACME} action="fromSystem" onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "New board from Linear, Jira or GitHub" })).toBeTruthy();
  });
});
