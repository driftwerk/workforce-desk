import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGrids } from "../grids/store";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { EngineInfo, Session } from "../hub/types";
import { useMachines } from "../machines/engines";
import { fakeNative, machine, noEngines, withEngine } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { useUi } from "../shell/ui";
import { Machines } from "./Machines";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.0") }));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null), inApp: true, openUrl: vi.fn() }));

const session = (id: string, machine?: string): Session =>
  ({ id, machine, engine: "claude", state: "idle", name: id, cwd: "/w", updatedAt: "2026-11-05T09:00:00Z" }) as unknown as Session;

const engine = (e: Partial<EngineInfo> & Pick<EngineInfo, "engine" | "title">): EngineInfo => ({
  program: e.engine,
  installed: true,
  version: "1.0.0",
  signIn: { state: "in", via: "plan", who: null, plan: null },
  views: ["terminal"],
  caps: {},
  ...e,
});

beforeEach(() => {
  useHost.setState(DEFAULT_HOST);
  useDesk.setState({
    sessions: Object.fromEntries([session("a"), session("b"), session("devbox/c", "devbox"), session("devbox/d", "devbox")].map((s) => [s.id, s])),
  });
  noEngines();
  withEngine(
    "devbox",
    {
      engines: vi.fn(async () => [engine({ engine: "claude", title: "Claude Code" }), engine({ engine: "codex", title: "Codex" })]),
    } as unknown as DeskHub,
  );
  useMachines.setState({
    listed: true,
    machines: [
      machine({ id: "devbox", target: "dev@203.0.113.7" }),
      machine({ id: "buildbox", target: "ubuntu@build via bastion", state: { kind: "unreachable" } }),
      machine({ id: "edge-1", target: "ops@edge-1", state: { kind: "updating" } }),
      machine({ id: "old-box", target: "old-box", state: { kind: "newer" }, version: "0.3.0" }),
    ],
  });
});
afterEach(cleanup);

const row = (name: string) => screen.getByRole("listitem", { name });

it("lists this computer and each machine, saying where each stands", async () => {
  render(<Machines native={fakeNative().native} />);
  await act(async () => {});
  expect(row("This Mac").textContent).toContain("2 sessions · Desk 0.2.0");
  expect(row("devbox").textContent).toContain("dev@203.0.113.7");
  expect(row("devbox").textContent).toContain("Connected · 2 sessions · Desk 0.2.0 · Linux x86_64 · Claude Code and Codex signed in");
  expect(row("devbox").querySelector(".dot-done")).toBeTruthy();
  expect(row("buildbox").textContent).toContain("Can’t reach it right now. Its sessions keep running; Desk reconnects when it can.");
  expect(row("buildbox").querySelector(".dot-blocked")).toBeTruthy();
  expect(row("edge-1").textContent).toContain("Updating Desk to 0.2.0… its sessions carry on");
  expect(row("edge-1").querySelector(".dot-working")).toBeTruthy();
  expect(within(row("edge-1")).queryAllByRole("button")).toEqual([]);
  expect(row("old-box").textContent).toContain("It runs a newer Desk (0.3.0)");
  expect(within(row("devbox")).getByRole("button", { name: "Open a terminal" })).toBeTruthy();
  expect(within(row("buildbox")).queryByRole("button", { name: "Open a terminal" })).toBeNull();
});

it("tries an unreachable machine again", async () => {
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  fireEvent.click(within(row("buildbox")).getByRole("button", { name: "Try again" }));
  expect(fake.reconnect).toHaveBeenCalledWith("buildbox");
});

it("removes a machine only once asked, saying it keeps running there", async () => {
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  fireEvent.click(within(row("devbox")).getByRole("button", { name: "Remove…" }));
  expect(screen.getByRole("dialog").textContent).toContain("Desk keeps running there, with its sessions");
  expect(fake.remove).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
  expect(fake.remove).toHaveBeenCalledWith("devbox");
});

it("opens a terminal on a machine in a grid, and shows it", () => {
  useUi.getState().openSettings("machines");
  render(<Machines native={fakeNative().native} />);
  fireEvent.click(within(row("devbox")).getByRole("button", { name: "Open a terminal" }));
  const panes = Object.values(useGrids.getState().grids).flatMap((g) => g.panes);
  expect(panes.some((p) => p.content?.kind === "terminal" && (p.content as { machine?: string }).machine === "devbox")).toBe(true);
  expect(useUi.getState().settings).toBeNull();
  expect(useDesk.getState().view).toBe("grids");
});

it("opens the add card", () => {
  render(<Machines native={fakeNative().native} />);
  fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
  expect(screen.getByRole("form", { name: "Add a machine" })).toBeTruthy();
});
