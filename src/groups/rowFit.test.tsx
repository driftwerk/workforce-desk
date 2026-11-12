import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { namesKey } from "../board/TicketChip";
import { useBoard } from "../board/store";
import { ticket } from "../board/testing";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useSettings } from "../settings/store";
import { EMPTY_LAYOUT } from "./model";
import { SidebarGroups } from "./SidebarGroups";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

afterEach(cleanup);

const fs = (await import("node:fs" as string)) as { readFileSync: (path: string, enc: "utf8") => string };
const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const appCss = fs.readFileSync(`${cwd}/src/styles/app.css`, "utf8");
const floorCss = fs.readFileSync(`${cwd}/src/styles/floor.css`, "utf8");

const live = (id: string, name: string): Session =>
  ({ id, name, engine: "claude", state: "idle", live: true, origin: "desk", pending: null, updatedAt: "2026-11-12T08:00:00Z", createdAt: "2026-11-12T07:00:00Z" }) as Session;

const rule = (css: string, selector: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, s]) => s!.trim().endsWith(selector)).map(([, , b]) => b!).join("\n");

describe("a session row's name and its ticket key", () => {
  it("says a key the name starts with only once", () => {
    expect(namesKey("ACM-12 Fix the flaky", "ACM-12")).toBe(true);
    expect(namesKey("acm-12", "ACM-12")).toBe(true);
    expect(namesKey("ACM-123 other", "ACM-12")).toBe(false);
    expect(namesKey("fix ACM-12", "ACM-12")).toBe(false);
  });

  it("drops the key chip when the name has the key, and keeps it otherwise", () => {
    useChat.setState({ hubs: [], roster: [] });
    useDesk.setState({ sessions: { s1: live("s1", "ACM-12 Fix the flaky"), s2: live("s2", "payments-work") }, openId: null });
    useBoard.setState({
      tickets: {
        t12: ticket(12, { assignee: { kind: "session", id: "s1", name: "s1", engine: "claude" } }),
        t13: ticket(13, { assignee: { kind: "session", id: "s2", name: "s2", engine: "claude" } }),
      },
    });
    useSettings.setState({ loaded: true, groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
    render(<SidebarGroups />);
    const chips = [...document.querySelectorAll(".gi-ticket")].map((c) => c.textContent);
    expect(chips).toEqual(["ACM-13"]);
    expect(screen.getByText("ACM-12 Fix the flaky")).toBeTruthy();
  });
});

describe("rows that would squeeze a name", () => {
  it("let the sidebar row's name size to its text, so badges wrap under a name that would be cut", () => {
    expect(rule(appCss, ".gi:not(.gi-editing)")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(appCss, ".gi-name")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(appCss, ".gi-name")).toMatch(/min-width:\s*9ch/);
  });
  it("keep the Floor row's name a minimum width, with its state and time wrapping under it", () => {
    expect(rule(floorCss, ".floor-item-head")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(floorCss, ".floor-item-head b")).toMatch(/min-width:/);
  });
});
