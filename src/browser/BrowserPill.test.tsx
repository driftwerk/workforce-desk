import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserLive, DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { BrowserPill } from "./BrowserPill";
import { useBrowser } from "./store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const live = (l: Partial<BrowserLive> = {}): BrowserLive => ({
  agent: "allan",
  user: "sarah",
  session: "s1",
  url: "https://shop.example/cart",
  host: "shop.example",
  backend: "desk",
  idle_secs: 2,
  ...l,
});

let hub: { stopBrowser: ReturnType<typeof vi.fn>; browserLive: ReturnType<typeof vi.fn> };

beforeEach(() => {
  hub = { stopBrowser: vi.fn(async () => ({ closed: 1, turns_stopped: 1, allowances_dropped: 0 })), browserLive: vi.fn(async () => []) };
  useDesk.setState({ hub: hub as unknown as DeskHub });
});

afterEach(() => {
  cleanup();
  useBrowser.setState({ live: [], problem: null, stopping: false });
});

it("shows nothing while no browser is open", () => {
  render(<BrowserPill place="titlebar" />);
  expect(screen.queryByRole("status", { name: "Desk is using the browser" })).toBeNull();
});

it("says Desk is using the browser, where and in which, and Stop stops it", async () => {
  useBrowser.setState({ live: [live({ backend: "chrome" })] });
  render(<BrowserPill place="titlebar" />);
  const pill = screen.getByRole("status", { name: "Desk is using the browser" });
  expect(pill.textContent).toContain("shop.example");
  expect(pill.textContent).toContain("My Chrome");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
  expect(hub.stopBrowser).toHaveBeenCalledWith(undefined);
  expect(useBrowser.getState().live).toEqual([]);
});

it("on the overseer's card shows only its own browser, and stops only that", async () => {
  useBrowser.setState({ live: [live({ agent: "ben" }), live({ agent: "allan", host: "docs.example" })] });
  render(<BrowserPill agent="allan" place="card" />);
  expect(screen.getByRole("status").textContent).toContain("docs.example");
  expect(screen.getByRole("status").textContent).not.toContain("more");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
  expect(hub.stopBrowser).toHaveBeenCalledWith("allan");
});

it("opens Settings → Browser to show what it did", () => {
  useBrowser.setState({ live: [live(), live({ agent: "ben" })] });
  render(<BrowserPill place="band" />);
  expect(screen.getByRole("status").textContent).toContain("1 more");
  fireEvent.click(screen.getByTitle("See what it did in the browser"));
  expect(useUi.getState().settings).toBe("browser");
});
