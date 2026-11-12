import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { BrowserSettings, BrowserSettingsView, ChromeProfile, ComputerActivityRow, DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { Browser, chromeLine, sitesOf, type BrowserApi } from "./Browser";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  openUrl: (url: string) => opened.push(url),
}));

// This computer's hub, asked as the person over the paired path: every
// request recorded with the hub it went to.
const asked = vi.hoisted(() => [] as { hub: string; method: string; path: string }[]);
vi.mock("../hub/net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hub/net")>()),
  pairedHub: (hub: { id: string }) => ({
    fetch: async (method: string, path: string) => {
      asked.push({ hub: hub.id, method, path });
      if (path.startsWith("/api/desk/browser/shots/")) return new Response(new Blob(["png"]), { status: 200, headers: { "content-type": "image/png" } });
      const answer: BrowserSettingsView = {
        settings: { on: true, sites: { allow: [], block: [] } },
        chrome: { connected: false, profiles: [profile({ state: "pending" })], store_url: null },
      };
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    },
    socket: () => {
      throw new Error("no sockets here");
    },
  }),
}));

afterEach(() => {
  cleanup();
  opened.length = 0;
  asked.length = 0;
  vi.useRealTimers();
});

function profile(p: Partial<ChromeProfile> = {}): ChromeProfile {
  return { id: "p1", label: "1A2B-3C4D-5E6F-7A8B", version: "0.1.0", state: "confirmed", connected: true, chosen: true, ...p };
}

const STORE = "https://chromewebstore.google.com/detail/desk/abcdefghijklmnopabcdefghijklmnop";

const view = (s: Partial<BrowserSettings> = {}, chrome: Partial<BrowserSettingsView["chrome"]> = {}): BrowserSettingsView => ({
  settings: { on: true, sites: { allow: [], block: [] }, ...s },
  chrome: { connected: false, profiles: [], store_url: STORE, ...chrome },
});

const row = (r: Partial<ComputerActivityRow> = {}): ComputerActivityRow => ({
  id: "r1",
  at: new Date().toISOString(),
  agent: "allan",
  kind: "browser",
  doing: "Clicked #save on shop.example",
  folder: null,
  tool: "browser.click",
  decided_by: "rule",
  outcome: { outcome: "ran" },
  reason: null,
  arguments: { url: "https://shop.example/cart", target: "#save", screenshot: "a.png" },
  ...r,
});

const api = (v: BrowserSettingsView, rows: ComputerActivityRow[] = [], over: Partial<BrowserApi> = {}): BrowserApi => ({
  settings: vi.fn(async () => v),
  save: vi.fn(async (s: BrowserSettings) => ({ ...v, settings: s })),
  confirm: vi.fn(async (id: string) => ({ ...v, chrome: { ...v.chrome, connected: true, profiles: v.chrome.profiles.map((p) => (p.id === id ? { ...p, state: "confirmed" as const } : p)) } })),
  choose: vi.fn(async () => v),
  forget: vi.fn(async (id: string) => ({ ...v, chrome: { ...v.chrome, profiles: v.chrome.profiles.filter((p) => p.id !== id) } })),
  activity: vi.fn(async () => rows),
  shot: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
  ...over,
});

const show = async (a: BrowserApi) => {
  render(<Browser api={a} />);
  await act(async () => {});
};

it("offers Add Desk to Chrome, which opens the Chrome Web Store listing", async () => {
  await show(api(view()));
  expect(screen.getByText(/Add Desk to Chrome, and Desk can work in your own Chrome/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add Desk to Chrome" }));
  expect(opened).toEqual([STORE]);
  // No remote debugging, no chrome:// page to paste.
  expect(document.body.textContent).not.toMatch(/remote debugging|chrome:\/\/inspect/);
});

it("says plainly when the extension isn't in the store yet", async () => {
  await show(api(view({}, { store_url: null })));
  expect(screen.queryByRole("button", { name: "Add Desk to Chrome" })).toBeNull();
  expect(screen.getByText("Desk’s extension isn’t in the Chrome Web Store yet.")).toBeTruthy();
});

it("puts a Chrome asking to connect to the person, with its code, until they confirm it", async () => {
  const a = api(view({}, { profiles: [profile({ state: "pending", connected: true, chosen: false })] }));
  await show(a);
  const card = screen.getByRole("group", { name: "A Chrome asks to connect" });
  expect(card.textContent).toContain("1A2B-3C4D-5E6F-7A8B");
  expect(card.textContent).toContain("confirm only if it shows the same code");
  expect(screen.getByText(/A Chrome is asking to connect/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "It’s my Chrome" })));
  expect(a.confirm).toHaveBeenCalledWith("p1");
  expect(screen.queryByRole("group", { name: "A Chrome asks to connect" })).toBeNull();
  expect(screen.getByText(/^Connected\./)).toBeTruthy();
});

it("refuses a Chrome that isn't the person's", async () => {
  const a = api(view({}, { profiles: [profile({ state: "pending", connected: true, chosen: false })] }));
  await show(a);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not mine" })));
  expect(a.forget).toHaveBeenCalledWith("p1");
});

it("warns when more than one Chrome asks at once, and says a new one doesn't take over", async () => {
  const a = api(
    view({}, {
      connected: true,
      profiles: [
        profile(),
        profile({ id: "p2", label: "1111-2222-3333-4444", state: "pending", connected: true, chosen: false }),
        profile({ id: "p3", label: "5555-6666-7777-8888", state: "pending", connected: true, chosen: false }),
      ],
    }),
  );
  await show(a);
  expect(screen.getByRole("alert").textContent).toContain("More than one Chrome is asking at once");
  const cards = screen.getAllByRole("group", { name: "A Chrome asks to connect" });
  expect(cards).toHaveLength(2);
  expect(cards[0]!.textContent).toContain("Desk keeps using Chrome 1A2B-3C4D-5E6F-7A8B");
  expect(cards[0]!.textContent).toContain("only the code shows it’s Desk’s");
});

it("lists the confirmed Chromes: which is connected, which Desk uses, and forgetting one", async () => {
  const a = api(view({}, { connected: true, profiles: [profile(), profile({ id: "p2", label: "9999-8888-7777-6666", connected: false, chosen: false })] }));
  await show(a);
  const list = screen.getByRole("list", { name: "Chrome profiles" });
  expect(list.textContent).toContain("Desk uses this one");
  expect(list.textContent).toContain("Not connected now");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this one" })));
  expect(a.choose).toHaveBeenCalledWith("p2");
  await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!));
  expect(a.forget).toHaveBeenCalledWith("p1");
});

it("watches for the extension connecting, keeping site lists being edited", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let v = view();
  const a = api(v, [], { settings: vi.fn(async () => v) });
  await show(a);
  fireEvent.change(screen.getByLabelText("Only these sites (leave empty for any)"), { target: { value: "docs.example" } });
  v = view({}, { connected: true, profiles: [profile()] });
  await act(async () => vi.advanceTimersByTime(2100));
  expect(screen.getByText(/^Connected\./)).toBeTruthy();
  expect((screen.getByLabelText("Only these sites (leave empty for any)") as HTMLInputElement).value).toBe("docs.example");
});

it("turns Desk's use of Chrome off and on", async () => {
  const a = api(view());
  await show(a);
  await act(async () => fireEvent.click(screen.getByLabelText("Desk uses your Chrome")));
  expect(a.save).toHaveBeenCalledWith({ on: false, sites: { allow: [], block: [] } });
});

it("keeps the site lists as hosts and saves them", async () => {
  const a = api(view({ sites: { allow: [], block: ["bank.example"] } }));
  await show(a);
  const save = screen.getByRole("button", { name: "Save sites" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Only these sites (leave empty for any)"), { target: { value: "Example.com, docs.example.com example.com" } });
  expect(save.disabled).toBe(false);
  await act(async () => fireEvent.click(save));
  expect(a.save).toHaveBeenCalledWith(expect.objectContaining({ sites: { allow: ["example.com", "docs.example.com"], block: ["bank.example"] } }));
});

it("lists what the browser did with the page as it looked after", async () => {
  const a = api(view(), [row()]);
  globalThis.URL.createObjectURL = vi.fn(() => "blob:shot");
  globalThis.URL.revokeObjectURL = vi.fn();
  await show(a);
  await act(async () => {});
  const list = screen.getByRole("list", { name: "What the browser did" });
  expect(list.textContent).toContain("Clicked #save on shop.example");
  expect(a.shot).toHaveBeenCalledWith("a.png");
  expect(list.querySelector("img")?.getAttribute("src")).toBe("blob:shot");
});

it("says when the hub has no browser yet", async () => {
  const { HubError } = await import("../hub/client");
  await show(api(view(), [], { settings: vi.fn(async () => Promise.reject(new HubError(404, "no"))) }));
  expect(screen.getByText("This hub doesn’t have the browser yet.")).toBeTruthy();
});

it("reads sites and Chrome's standing in plain words", () => {
  expect(sitesOf(" a.test, B.test\n\na.test ")).toEqual(["a.test", "b.test"]);
  expect(chromeLine(view({}, { connected: true, profiles: [profile()] }).chrome).tone).toBe("done");
  expect(chromeLine(view({}, { profiles: [profile({ connected: false })] }).chrome).text).toMatch(/open Chrome and Desk connects/);
});

it("asks this computer's hub as the person for the settings, a confirmation and the screenshots", async () => {
  const shot = "0f0e0d0c-0b0a-4909-8807-060504030201.png";
  const computerActivity = vi.fn(async () => ({ rows: [row({ arguments: { url: "https://shop.example/cart", screenshot: shot } })], next: null }));
  useDesk.setState({ hub: { computerActivity } as unknown as DeskHub });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:50148", local: true, revision: "r1" }] });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:shot");
  globalThis.URL.revokeObjectURL = vi.fn();
  render(<Browser />);
  await act(async () => {});
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "It’s my Chrome" })));
  expect(asked).toEqual(
    expect.arrayContaining([
      { hub: "local", method: "GET", path: "/api/desk/browser/settings" },
      { hub: "local", method: "GET", path: `/api/desk/browser/shots/${shot}` },
      { hub: "local", method: "POST", path: "/api/desk/browser/chrome/p1/confirm" },
    ]),
  );
  expect(computerActivity).toHaveBeenCalledWith({ kind: "browser" });
  useDesk.setState({ hub: null });
});
