import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useFloor } from "../floor/store";
import { NOW, agent, approval, at, hub, need, ready, session, view } from "../floor/testing";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useSettings } from "../settings/store";
import { openTarget } from "../shell/navigate";
import { EMPTY_LAYOUT } from "./model";
import { SidebarGroups } from "./SidebarGroups";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("../shell/navigate", async (actual) => ({ ...(await actual<typeof import("../shell/navigate")>()), openTarget: vi.fn() }));

const live = (id: string, name: string, more: Partial<Session> = {}): Session =>
  ({ id, name, engine: "claude", state: "idle", live: true, origin: "desk", pending: null, updatedAt: at(1), createdAt: at(60), ...more }) as Session;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  useChat.setState({
    hubs: [hub("local"), hub("b")],
    roster: [
      { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      { hubId: "b", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
    ],
  });
  useDesk.setState({
    sessions: { s1: live("s1", "api-e7"), s2: live("s2", "repo", { state: "done", background: { count: 2, since: at(6) } }) },
    openId: null,
  });
  useSettings.setState({
    loaded: true,
    groups: [{ id: "acme", name: "Acme", collapsed: false, items: ["session:s1", "agent:b/scout"] }],
    ungrouped: EMPTY_LAYOUT.ungrouped,
    sessionNames: {},
  });
  useFloor.setState({
    hubs: {
      local: ready(view({ needs: [approval("ap-1", "s1"), need("q-1", session("s1"))] })),
      b: ready(view({ needs: [need("q-2", agent("scout"))] })),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const row = (name: string, group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("button")
    .find((b) => b.querySelector(".gi-name")?.textContent === name)!;

describe("the sidebar's needs badges", () => {
  it("count what waits on each session and agent, the same agent on each hub apart", () => {
    render(<SidebarGroups />);
    expect(within(row("api-e7", "Acme")).getByText("2 need you")).toBeTruthy();
    expect(within(row("Scout", "Acme")).getByText("1 needs you")).toBeTruthy();
    expect(within(row("Scout", "Ungrouped")).queryByText(/need/)).toBeNull();
  });

  it("sum a collapsed group's, and open a row where it shows", () => {
    render(<SidebarGroups />);
    fireEvent.click(row("Scout", "Acme"));
    expect(openTarget).toHaveBeenCalledWith({ kind: "agent", key: "b/scout" });
    fireEvent.click(within(screen.getByRole("group", { name: "Acme" })).getAllByRole("button")[0]!);
    expect(within(screen.getByRole("group", { name: "Acme" })).getByText("3 need you")).toBeTruthy();
  });

  it("show a session waiting on its background work as working", () => {
    render(<SidebarGroups />);
    const repo = row("repo", "Ungrouped");
    expect(repo.querySelector(".dot-background")).toBeTruthy();
    expect(repo.getAttribute("title")).toBe("Claude · Waiting on 2 background tasks · 6m");
  });
});
