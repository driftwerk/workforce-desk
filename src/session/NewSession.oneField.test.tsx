// New session in one field: the goal names it, the folder comes back with
// its choices, a separate copy is named for the goal, Start says why it
// waits, and git's refusals say what to do.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { DeskHub } from "../hub/client";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { EngineInfo } from "../hub/types";
import { NewSession, startProblem, whyNotStart } from "./NewSession";
import { branchFor, choicesFor, nameFromGoal, remember } from "./remembered";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: false,
  pickFolder: vi.fn(async () => null),
  claudePluginDir: vi.fn(async () => null),
  programsUnder: vi.fn(async () => []),
}));

/** What the local hub says of each folder. */
let folders: Record<string, { git?: boolean; remote?: string }> = {};

beforeEach(() => {
  localStorage.clear();
  folders = {
    "/work/atlas": { git: true, remote: "github.com/acme/atlas" },
    "/work/notes": { git: false },
  };
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "" }] as never });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/desk/folders") return Response.json(folders[u.searchParams.get("path") ?? ""] ?? {});
      return Response.json({}, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const engine = (e: Partial<EngineInfo> & Pick<EngineInfo, "engine" | "title">): EngineInfo => ({
  program: e.engine,
  installed: true,
  version: "1.0.0",
  signIn: { state: "unknown" },
  views: [],
  caps: {},
  ...e,
});
const ENGINES = [engine({ engine: "claude", title: "Claude Code", views: ["terminal"] }), engine({ engine: "codex", title: "Codex", views: ["terminal"] })];

const hubWith = (start: ReturnType<typeof vi.fn>, features = ["fresh-worktree", "folder-remotes", "keep-tickets"]) => {
  useDesk.setState({
    hub: { start, engines: vi.fn(async () => ENGINES), features: vi.fn(async () => features), sessions: vi.fn(async () => []) } as unknown as DeskHub,
    openId: null,
    sessions: {},
  });
};

it("names a session from its goal, and a separate copy's branch too", () => {
  expect(nameFromGoal("Fix the login page on Safari")).toBe("fix-login-page-safari");
  expect(nameFromGoal("  ")).toBe("");
  expect(branchFor("Fix the login page", "atlas")).toBe("desk/fix-login-page");
  expect(branchFor("", "atlas")).toBe("desk/atlas");
});

it("says the one thing Start waits on, with its fix", () => {
  const base = { hub: true, folder: "/w", remote: false, where: "this computer", noFolder: false, cantSignIn: null, starting: false };
  expect(whyNotStart(base)).toBeNull();
  expect(whyNotStart({ ...base, folder: "" })?.words).toBe("Pick the folder it works in.");
  expect(whyNotStart({ ...base, hub: false })?.words).toMatch(/can’t reach this computer’s helper/);
  const signIn = whyNotStart({ ...base, cantSignIn: "Claude Code" });
  expect(signIn?.words).toBe("Claude Code isn’t signed in on this computer.");
  expect(signIn?.fix?.label).toBe("Sign in to Claude Code");
});

it("starts with the goal as its name, on a separate copy named for it", async () => {
  const start = vi.fn(async () => ({ id: "s-1" }));
  hubWith(start);
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Pick the folder it works in.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Fix the login page" } });
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/atlas" } });
  await waitFor(() => expect(screen.getByText("github.com/acme/atlas")).toBeTruthy());
  fireEvent.click(screen.getByLabelText(/Work on a separate copy/));
  expect(screen.getByText(/Desk makes a new branch, desk\/fix-login-page, and works there/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/atlas", name: "fix-login-page", goal: "Fix the login page", worktree: "desk/fix-login-page", freshWorktree: true }));
  // Its folder and choices come back next time.
  expect(choicesFor("local", "/work/atlas")).toMatchObject({ engine: "claude", copy: true });
});

it("opens on the last folder with the choices made there, and says when a folder can't have a copy", async () => {
  remember("local", "/work/atlas", { engine: "codex", copy: true });
  const start = vi.fn(async () => ({ id: "s-2" }));
  hubWith(start);
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("/work/atlas");
  expect(screen.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByLabelText(/Work on a separate copy/) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/notes" } });
  await waitFor(() => expect(screen.getByText("That folder isn’t a git project, so there’s no separate copy to make.")).toBeTruthy());
  expect((screen.getByLabelText(/Work on a separate copy/) as HTMLInputElement).disabled).toBe(true);
});

it("says a folder that isn't a git project plainly, and starts without a copy when asked", async () => {
  const start = vi
    .fn()
    .mockRejectedValueOnce(new HubError(400, "/work/plain isn't in a git repository, so Desk can't make a separate copy of it"))
    .mockResolvedValueOnce({ id: "s-3" });
  hubWith(start);
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/plain" } });
  fireEvent.click(screen.getByLabelText(/Work on a separate copy/));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(screen.getByText("That folder isn’t a git project, so Desk can’t make a separate copy of it.")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start without a copy" })));
  expect(start).toHaveBeenLastCalledWith(expect.not.objectContaining({ worktree: expect.anything() }));
});

it("reads git's and the folder's refusals as what to do", () => {
  const offCopy = vi.fn();
  const p = startProblem("x isn't in a git repository, so …", { copy: true, offCopy, makeIt: null });
  expect(p?.fix?.label).toBe("Start without a copy");
  expect(startProblem("/work/gone is not a folder", { copy: false, offCopy, makeIt: () => {} })?.fix?.label).toBe("Make it and start");
  expect(startProblem("git worktree add: fatal: something", { copy: true, offCopy, makeIt: null })).toBeNull();
});

it("never asks an older Desk helper for a copy, which could take an existing branch: it says it needs an update", async () => {
  remember("local", "/work/atlas", { copy: true });
  const start = vi.fn(async () => ({ id: "s-4" }));
  hubWith(start, []);
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  expect(screen.getByText(/^Desk on .+ needs an update before it can make a separate copy\.$/)).toBeTruthy();
  const copy = screen.getByLabelText(/Work on a separate copy/) as HTMLInputElement;
  expect([copy.checked, copy.disabled]).toEqual([false, true]);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.not.objectContaining({ worktree: expect.anything() }));
});
