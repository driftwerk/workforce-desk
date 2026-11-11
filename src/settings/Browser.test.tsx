import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserSettings, BrowserSettingsView, ComputerActivityRow } from "../hub/client";
import { Browser, chromeLine, sitesOf, type BrowserApi } from "./Browser";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  openUrl: (url: string) => opened.push(url),
}));

afterEach(() => {
  cleanup();
  opened.length = 0;
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

it("says how to turn on remote debugging when Chrome isn't connected, and opens it", async () => {
  await show(api(view()));
  expect(screen.getByText(/Turn on remote debugging in Chrome 144 or later/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open in Chrome" }));
  expect(opened).toEqual(["chrome://inspect/#remote-debugging"]);
});

it("says Connected when Desk is working in the person's Chrome", async () => {
  await show(api(view({}, { available: true, connected: true })));
  expect(screen.getByText(/^Connected\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open in Chrome" })).toBeNull();
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
  expect(chromeLine({ available: true, connected: false, min_version: 144, turn_on: "" }).text).toMatch(/Chrome asks you first/);
});
