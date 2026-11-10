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
import { boardSyncOf, issueUrl, looksLikeToken, pausedWords, syncHubId, syncStatus, targetOk } from "../hub/boardSync";
import { useDesk } from "../hub/store";
import type { Board as BoardT, SyncHub, Ticket } from "../hub/types";
import { Board } from "./BoardView";
import { LinkBoardDialog } from "./LinkBoard";
import { useBoard } from "./store";
import { useSyncHubs } from "./syncStore";
import { ACME, ticket } from "./testing";

const LOCAL = { id: "local", label: "This computer", url: "http://127.0.0.1:50148", local: true, revision: "" };
const ATLAS = { id: "atlas-acme-example", label: "Atlas", url: "https://atlas.acme.example", local: false, revision: "" };
const GLOBEX = { id: "hub-globex-example", label: "Globex", url: "https://hub.globex.example", local: false, revision: "" };
const MACHINE = { id: "machine:devbox", label: "devbox", url: "http://127.0.0.1:1", local: false, machine: "devbox", revision: "" };
const SECRET = "wfr_SENTINELpastedtoken0123456789";

/** The local hub's board sync, as far as the dialog goes. */
let kept: SyncHub[] = [];
let offers: Record<string, boolean> = {};

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
    if (!offers[key]) return { status: 422, body: { error: `${key} doesn't offer its Jira tools to your own apps. Ask its admin to add \`jira.*\` to remote MCP.`, paused: { kind: "missing", tools: ["jira.search"] } } };
    const out: Record<string, unknown> = { offered: true };
    if (!body!.target) return { status: 200, body: out };
    out.states = ["Backlog", "To Do", "In Progress", "In Review", "Done"];
    out.prefill = { backlog: "Backlog", todo: "To Do", doing: "In Progress", review: "In Review", done: "Done" };
    const filter = body!.filter as { kind: string; value?: string } | undefined;
    if (filter?.kind === "query" && /order by/i.test(filter.value ?? "")) return { status: 400, body: { error: "JQL here can't sort: leave out ORDER BY." } };
    if (filter) {
      out.matches = filter.kind === "label" ? 7 : 12;
      out.matchesAtLeast = false;
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
    expect(screen.getByText(/hasn't let paired devices make remote MCP tokens/)).toBeTruthy();
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

  it("checks the filter live, prefills the state map, and links with what was chosen", async () => {
    const closed = vi.fn();
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={closed} />);
    pickSystem("Jira");
    await waitFor(() => expect((via().getByRole("radio", { name: /^Atlas/ }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    const key = await screen.findByLabelText("Atlas’s Jira project key");
    fireEvent.change(key, { target: { value: "acme" } });
    expect((key as HTMLInputElement).value).toBe("ACME");
    await screen.findByText("12 issues", undefined, { timeout: 2000 });
    expect((screen.getByLabelText("Review moves its issue to") as HTMLSelectElement).value).toBe("In Review");
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
      states: { backlog: "Backlog", todo: "To Do", doing: "In Progress", review: "In Review", done: "Done", dropped: "Done" },
    });
    expect(useBoard.getState().boards[ACME.id]!.sync?.target).toBe("ACME");
    // And it is synced at once: the hub's 202 is no error.
    await waitFor(() => expect(native.asked.some((a) => a.path === `/api/desk/boards/${ACME.id}/sync`)).toBe(true));
  });

  it("says the hub's refusals in its words: tools missing, a filter it won't take, a board with tickets", async () => {
    kept = [...kept, { id: "hub-globex-example", name: "Globex", url: GLOBEX.url, hasToken: true }];
    render(<LinkBoardDialog board={ACME} tickets={0} onClose={() => {}} />);
    pickSystem("Jira");
    await screen.findByText(/hub-globex-example doesn't offer its Jira tools/);
    expect((via().getByRole("radio", { name: /^Globex/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(via().getByRole("radio", { name: /^Atlas/ }));
    fireEvent.change(await screen.findByLabelText("Atlas’s Jira project key"), { target: { value: "ACME" } });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Import" })).getByRole("radio", { name: "JQL" }));
    fireEvent.change(screen.getByLabelText("The query"), { target: { value: "project = ACME ORDER BY created" } });
    await screen.findByText("JQL here can't sort: leave out ORDER BY.", undefined, { timeout: 2000 });
    expect((screen.getByRole("button", { name: "Link to ACME" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<LinkBoardDialog board={ACME} tickets={3} onClose={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(/has tickets of its own/);
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
    expect(screen.getByLabelText("Your Linear member id")).toBeTruthy();
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
    return render(<Board />);
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
    expect(pausedWords({ kind: "missing", tools: ["jira.search", "jira.add_comment"] }, "Atlas")).toBe("Paused: Atlas no longer offers jira.search, jira.add_comment.");
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
