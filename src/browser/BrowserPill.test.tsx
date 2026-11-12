import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { BrowserLive } from "../hub/client";
import { useUi } from "../shell/ui";
import { BrowserPill } from "./BrowserPill";
import { useBrowser } from "./store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

// This computer's hub, asked as the person over the paired path: every
// request recorded with the hub it went to.
const asked = vi.hoisted(() => [] as { hub: string; method: string; path: string; body: unknown }[]);
vi.mock("../hub/net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hub/net")>()),
  pairedHub: (hub: { id: string }) => ({
    fetch: async (method: string, path: string, body?: { data: string }) => {
      asked.push({ hub: hub.id, method, path, body: body ? JSON.parse(body.data) : undefined });
      return new Response(JSON.stringify(path.endsWith("/stop") ? { closed: 1, turns_stopped: 1, allowances_dropped: 0 } : { live: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    socket: () => {
      throw new Error("no sockets here");
    },
  }),
}));

const live = (l: Partial<BrowserLive> = {}): BrowserLive => ({
  agent: "allan",
  user: "sarah",
  session: "s1",
  url: "https://shop.example/cart",
  host: "shop.example",
  idle_secs: 2,
  ...l,
});

beforeEach(() => {
  asked.length = 0;
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:50148", local: true, revision: "r1" }] });
});

const stops = () => asked.filter((a) => a.path === "/api/desk/browser/stop");

afterEach(() => {
  cleanup();
  useBrowser.setState({ live: [], problem: null, stopping: false });
});

it("shows nothing while no browser is open", () => {
  render(<BrowserPill place="titlebar" />);
  expect(screen.queryByRole("status", { name: "Desk is using the browser" })).toBeNull();
});

it("says Desk is using the browser, where and in which, and Stop stops it", async () => {
  useBrowser.setState({ live: [live()] });
  render(<BrowserPill place="titlebar" />);
  const pill = screen.getByRole("status", { name: "Desk is using the browser" });
  expect(pill.textContent).toContain("shop.example");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
  expect(stops()).toEqual([{ hub: "local", method: "POST", path: "/api/desk/browser/stop", body: {} }]);
  expect(useBrowser.getState().live).toEqual([]);
});

it("on the overseer's card shows only its own browser, and stops only that", async () => {
  useBrowser.setState({ live: [live({ agent: "ben" }), live({ agent: "allan", host: "docs.example" })] });
  render(<BrowserPill agent="allan" place="card" />);
  expect(screen.getByRole("status").textContent).toContain("docs.example");
  expect(screen.getByRole("status").textContent).not.toContain("more");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
  expect(stops()).toEqual([{ hub: "local", method: "POST", path: "/api/desk/browser/stop", body: { agent: "allan" } }]);
});

it("opens Settings → Browser to show what it did", () => {
  useBrowser.setState({ live: [live(), live({ agent: "ben" })] });
  render(<BrowserPill place="band" />);
  expect(screen.getByRole("status").textContent).toContain("1 more");
  fireEvent.click(screen.getByTitle("See what it did in the browser"));
  expect(useUi.getState().settings).toBe("browser");
});
