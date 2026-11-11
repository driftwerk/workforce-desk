import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { BrowserSettings, BrowserSettingsView, ComputerActivityRow, DeskHub } from "../hub/client";
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
      const answer = { settings: { use: "both", sites: { allow: [], block: [] } }, chrome: { available: false, connected: false, min_version: 144, turn_on: "chrome://inspect/#remote-debugging" } };
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
});

const view = (s: Partial<BrowserSettings> = {}, chrome: Partial<BrowserSettingsView["chrome"]> = {}): BrowserSettingsView => ({
  settings: { use: "both", sites: { allow: [], block: [] }, ...s },
  chrome: { available: false, connected: false, min_version: 144, turn_on: "chrome://inspect/#remote-debugging", ...chrome },
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
  arguments: { url: "https://shop.example/cart", target: "#save", backend: "chrome", screenshot: "a.png" },
  ...r,
});

const api = (v: BrowserSettingsView, rows: ComputerActivityRow[] = [], over: Partial<BrowserApi> = {}): BrowserApi => ({
  settings: vi.fn(async () => v),
  save: vi.fn(async (s: BrowserSettings) => ({ ...v, settings: s })),
  activity: vi.fn(async () => rows),
  shot: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
  ...over,
});

const show = async (a: BrowserApi) => {
  render(<Browser api={a} />);
  await act(async () => {});
};

it("offers Off, Desk's own browser, My Chrome and Both, and saves the choice", async () => {
  const a = api(view());
  await show(a);
  const group = screen.getByRole("radiogroup", { name: "Desk uses" });
  expect(Array.from(group.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Off", "Desk’s own browser", "My Chrome", "Both"]);
  expect(screen.getByRole("radio", { name: "Both" }).getAttribute("aria-checked")).toBe("true");
  await act(async () => fireEvent.click(screen.getByRole("radio", { name: "My Chrome" })));
  expect(a.save).toHaveBeenCalledWith({ use: "chrome", sites: { allow: [], block: [] } });
  expect(screen.getByRole("radio", { name: "My Chrome" }).getAttribute("aria-checked")).toBe("true");
});

it("shows Desk's browser by default, and turning that off saves it", async () => {
  const a = api(view());
  await show(a);
  const box = screen.getByLabelText("Show Desk’s browser") as HTMLInputElement;
  expect(box.checked).toBe(true);
  await act(async () => fireEvent.click(box));
  expect(a.save).toHaveBeenCalledWith(expect.objectContaining({ show: false }));
});

it("Connect my Chrome copies Chrome's page, opens Chrome natively, and says Ready once Chrome turns it on", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const copied: string[] = [];
  const openChrome = vi.fn(async () => undefined);
  let on = false;
  const a = api(view(), [], {
    settings: vi.fn(async () => view({}, { available: on })),
    openChrome,
    copy: async (t) => void copied.push(t),
  });
  await show(a);
  expect(screen.getByText(/Connect it once and Chrome remembers/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open in Chrome" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect my Chrome" })));
  expect(copied).toEqual(["chrome://inspect/#remote-debugging"]);
  expect(openChrome).toHaveBeenCalledOnce();
  // No chrome:// address goes to the link opener.
  expect(opened).toEqual([]);
  const guide = screen.getByRole("group", { name: "Connect my Chrome" });
  expect(guide.textContent).toContain("paste and press Return");
  expect(guide.textContent).toContain("Allow remote debugging for this browser instance");
  on = true;
  await act(async () => vi.advanceTimersByTime(2100));
  expect(screen.queryByRole("group", { name: "Connect my Chrome" })).toBeNull();
  expect(screen.getByText(/^Ready\./)).toBeTruthy();
  vi.useRealTimers();
});

it("says when Chrome isn't installed and where to get it", async () => {
  await show(api(view(), [], { openChrome: vi.fn(async () => Promise.reject(new Error("Chrome isn't installed on this computer."))), copy: async () => undefined }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect my Chrome" })));
  expect(screen.getByRole("alert").textContent).toContain("Chrome isn't installed on this computer.");
  fireEvent.click(screen.getByRole("button", { name: "Get Chrome" }));
  expect(opened).toEqual(["https://www.google.com/chrome/"]);
});

it("says Connected when Desk is working in the person's Chrome", async () => {
  await show(api(view({}, { available: true, connected: true })));
  expect(screen.getByText(/^Connected\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect my Chrome" })).toBeNull();
});

it("says what unbound means in plain words", async () => {
  await show(api(view()));
  expect(screen.getByText(/Unless you let it act fully, it asks you/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/unbound|once by hand/);
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

it("hides My Chrome's part when only Desk's own browser is used", async () => {
  await show(api(view({ use: "desk" })));
  expect(screen.queryByText("My Chrome", { selector: "h2" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save sites" })).toBeNull();
});

it("lists what the browser did with the page as it looked after", async () => {
  const a = api(view(), [row()]);
  globalThis.URL.createObjectURL = vi.fn(() => "blob:shot");
  globalThis.URL.revokeObjectURL = vi.fn();
  await show(a);
  await act(async () => {});
  const list = screen.getByRole("list", { name: "What the browser did" });
  expect(list.textContent).toContain("Clicked #save on shop.example");
  expect(list.textContent).toContain("My Chrome");
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
  expect(chromeLine({ available: true, connected: false, min_version: 144, turn_on: "" }).text).toMatch(/Chrome asks you to Allow it first/);
});

it("asks this computer's hub as the person for the settings, a change and the screenshots", async () => {
  const shot = "0f0e0d0c-0b0a-4909-8807-060504030201.png";
  const computerActivity = vi.fn(async () => ({ rows: [row({ arguments: { url: "https://shop.example/cart", backend: "desk", screenshot: shot } })], next: null }));
  useDesk.setState({ hub: { computerActivity } as unknown as DeskHub });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:50148", local: true, revision: "r1" }] });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:shot");
  globalThis.URL.revokeObjectURL = vi.fn();
  render(<Browser />);
  await act(async () => {});
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("radio", { name: "My Chrome" })));
  expect(asked).toEqual([
    { hub: "local", method: "GET", path: "/api/desk/browser/settings" },
    { hub: "local", method: "GET", path: `/api/desk/browser/shots/${shot}` },
    { hub: "local", method: "PUT", path: "/api/desk/browser/settings" },
  ]);
  expect(computerActivity).toHaveBeenCalledWith({ kind: "browser" });
  useDesk.setState({ hub: null });
});
