// A folder on a machine, browsed or typed: home always first and always
// working, browsing in and out, a folder that isn't there said with the one
// it most likely meant, a listing that takes more than 10 s said with Try
// again, and the terminal opening in the machine's own path.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import type { DeskTransport } from "../hub/transport";
import type { Session } from "../hub/types";
import { machineHome } from "../platform";
import { FOLDERS_DEBOUNCE_MS, FolderPicker } from "./FolderPicker";
import { HOME_WITHIN_MS, LIST_WITHIN_MS, shownPath } from "./folders";
import { OpenTerminal } from "./OpenTerminal";
import { fakeNative } from "./testing";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  machineHome: vi.fn(async () => "/home/dev"),
  inApp: false,
  openUrl: vi.fn(),
}));

/** devbox's folders, by the path asked; `slow` paths never answer. */
const TREE: Record<string, { path: string; git?: boolean }[]> = {
  "": [{ path: "/home/dev/src" }, { path: "/home/dev/notes" }],
  "~/src": [
    { path: "/home/dev/src/acme-web", git: true },
    { path: "/home/dev/src/acme-api", git: true },
    { path: "/home/dev/src/scratch" },
  ],
  "~/src/acme-api": [],
  "~/src/acme-web": [],
};

const transport = (asked: string[], slow = new Set<string>()): DeskTransport => ({
  fetch: async (_m, path) => {
    const p = new URL(`http://x${path}`).searchParams.get("path") ?? "";
    asked.push(p);
    if (slow.has(p)) return new Promise<Response>(() => {});
    if (p.startsWith("/etc")) return Response.json({ error: "that folder is outside the home folder and the running sessions' folders" }, { status: 403 });
    const folders = TREE[p];
    if (!folders) return Response.json({ error: "no such folder" }, { status: 404 });
    return Response.json({ path: p === "" ? "/home/dev" : p.replace("~", "/home/dev"), parent: null, truncated: false, folders: folders.map((f) => ({ name: f.path.split("/").pop(), hidden: false, git: !!f.git, path: f.path })) });
  },
  socket: () => {
    throw new Error("none");
  },
});

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(FOLDERS_DEBOUNCE_MS + 10)));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useDesk.setState({ sessions: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Picker({ t, initial = "~" }: { t: DeskTransport; initial?: string }) {
  const n = fakeNative();
  n.fake.transport.mockReturnValue(t);
  return <Controlled native={n.native} initial={initial} />;
}
function Controlled({ native, initial }: { native: ReturnType<typeof fakeNative>["native"]; initial: string }) {
  const [v, setV] = useStateLike(initial);
  return <FolderPicker machine="devbox" name="devbox" native={native} value={v} onChange={setV} always />;
}
import { useState as useStateLike } from "react";

const input = () => screen.getByLabelText("Folder on devbox") as HTMLInputElement;
const rows = () => within(screen.getByRole("list", { name: "Folders on devbox" })).getAllByRole("listitem").map((l) => l.textContent);

it("starts at home, always first and always there, and browses in with › and out with Up", async () => {
  const asked: string[] = [];
  render(<Picker t={transport(asked)} />);
  await settle();
  expect(rows()).toEqual(["⌂~· home folder, /home/dev, always there›", "~/notes›", "~/src›"]);
  fireEvent.click(screen.getByRole("button", { name: "Open ~/src" }));
  await settle();
  expect(input().value).toBe("~/src/");
  expect(asked.at(-1)).toBe("~/src");
  expect(rows()).toEqual(["⌂~· home folder, /home/dev, always there›", "~/src/acme-apigit›", "~/src/acme-webgit›", "~/src/scratch›"]);
  fireEvent.click(screen.getByRole("button", { name: /^~\/src\/acme-api/ }));
  expect(input().value).toBe("~/src/acme-api");
  fireEvent.click(screen.getByRole("button", { name: "Up" }));
  await settle();
  expect(input().value).toBe("~/");
  // Home is one click from anywhere.
  fireEvent.click(screen.getByRole("button", { name: /home folder/ }));
  expect(input().value).toBe("~");
});

it("says a folder isn't there, with the one it most likely meant", async () => {
  render(<Picker t={transport([])} initial="~/src/acme-wbe" />);
  await settle();
  expect(screen.getByRole("alert").textContent).toBe("devbox has no folder ~/src/acme-wbe.");
  fireEvent.click(screen.getByRole("button", { name: "Use it" }));
  expect(input().value).toBe("~/src/acme-web");
  // A folder above that isn't there: said, with what's beside it.
  fireEvent.change(input(), { target: { value: "~/scr/" } });
  await settle();
  await settle();
  expect(screen.getByRole("alert").textContent).toBe("devbox has no folder ~/scr.");
  expect(screen.getByText(/Did you mean ~\/src\?/)).toBeTruthy();
});

it("gives up on a listing after 10 s, says so, and tries again; typing still works", async () => {
  const slow = new Set(["~/src"]);
  render(<Picker t={transport([], slow)} initial="~/src/" />);
  await settle();
  expect(screen.getByText("Reading devbox’s folders… Desk gives up after 10 s and says why.")).toBeTruthy();
  await act(async () => void (await vi.advanceTimersByTimeAsync(LIST_WITHIN_MS)));
  expect(screen.getByRole("alert").textContent).toBe("Couldn’t list the folders in ~/src: devbox didn’t answer within 10 s.");
  expect(screen.getByText("Typing a path, or ~, still works.")).toBeTruthy();
  // Home stays a choice while it doesn't answer.
  expect(rows()[0]).toContain("home folder");
  slow.clear();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(rows()).toHaveLength(4);
});

it("says what a machine won't list, and that typing still works", async () => {
  render(<Picker t={transport([])} initial="/etc/" />);
  await settle();
  expect(screen.getByText("devbox lists folders only in its home and where its sessions run. A typed path there still works.")).toBeTruthy();
});

it("offers the folders sessions ran in there lately", async () => {
  const now = Date.now();
  useDesk.setState({
    sessions: {
      "devbox/a": { id: "a", machine: "devbox", cwd: "/home/dev/src/acme-web", updatedAt: new Date(now - 2 * 3600_000).toISOString() } as unknown as Session,
      "devbox/b": { id: "b", machine: "devbox", cwd: "/home/dev/src/desk", updatedAt: new Date(now - 30 * 3600_000).toISOString() } as unknown as Session,
      c: { id: "c", cwd: "/Users/me/x", updatedAt: new Date(now).toISOString() } as unknown as Session,
    },
  });
  render(<Picker t={transport([])} />);
  await settle();
  const recent = screen.getByText("Recent on devbox").parentElement!;
  expect(within(recent).getAllByRole("button").map((b) => b.textContent)).toEqual(["~/src/acme-web · 2 h ago", "~/src/desk · yesterday"]);
});

it("opens a terminal in the machine's own path; home always works; a folder that isn't there is said before anything opens", async () => {
  const n = fakeNative();
  n.fake.transport.mockReturnValue(transport([]));
  const opened = vi.fn();
  const onClose = vi.fn();
  render(<OpenTerminal machine="devbox" name="devbox" native={n.native} onClose={onClose} onOpened={opened} />);
  await settle();
  expect(screen.getByRole("heading", { name: "Open a terminal on devbox" })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in ~" })));
  expect(opened).toHaveBeenCalledWith("devbox", "/home/dev");
  expect(onClose).toHaveBeenCalled();

  opened.mockClear();
  fireEvent.change(input(), { target: { value: "~/src/nope" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in ~/src/nope" })));
  expect(opened).not.toHaveBeenCalled();
  expect(screen.getAllByRole("alert").some((a) => a.textContent === "devbox has no folder ~/src/nope.")).toBe(true);

  vi.mocked(machineHome).mockRejectedValueOnce(new Error("SSH couldn't reach devbox."));
  fireEvent.change(input(), { target: { value: "~/src/acme-api" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in ~/src/acme-api" })));
  expect(opened).not.toHaveBeenCalled();
  expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("SSH couldn't reach devbox"))).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in ~/src/acme-api" })));
  expect(opened).toHaveBeenCalledWith("devbox", "/home/dev/src/acme-api");
});

it("puts the new terminal pane in the folder chosen, on the machine", async () => {
  const n = fakeNative();
  n.fake.transport.mockReturnValue(transport([]));
  render(<OpenTerminal machine="devbox" name="devbox" native={n.native} onClose={() => {}} />);
  await settle();
  fireEvent.change(input(), { target: { value: "~/src/acme-web" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in ~/src/acme-web" })));
  const panes = Object.values(useGrids.getState().grids).flatMap((g) => g.panes);
  expect(panes.some((p) => p.content?.kind === "terminal" && p.content.machine === "devbox" && p.content.cwd === "/home/dev/src/acme-web")).toBe(true);
});

it("shows a folder's name without the characters that would make it read as another", async () => {
  expect(shownPath("~/src/acme\u202e\u200bbew")).toBe("~/src/acmebew");
  expect(shownPath("~/src/a\u0007b\u2066c")).toBe("~/src/abc");
  const t: DeskTransport = {
    fetch: async () => Response.json({ path: "/home/dev", folders: [{ name: "x", hidden: false, git: false, path: "/home/dev/evil\u202egnp.sh" }] }),
    socket: () => {
      throw new Error("none");
    },
  };
  render(<Picker t={t} />);
  await settle();
  expect(rows()[1]).toBe("~/evilgnp.sh›");
});

it("lets Cancel stop a terminal that's still asking the machine, and gives up on its home after 10 s", async () => {
  const n = fakeNative();
  n.fake.transport.mockReturnValue(transport([]));
  const opened = vi.fn();
  const waiting: ((h: string) => void)[] = [];
  vi.mocked(machineHome).mockImplementation(() => new Promise((r) => waiting.push(r)));
  render(<OpenTerminal machine="devbox" name="devbox" native={n.native} onClose={() => {}} onOpened={opened} />);
  await settle();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in ~" })));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => waiting.forEach((r) => r("/home/dev")));
  expect(opened).not.toHaveBeenCalled();
  cleanup();

  vi.mocked(machineHome).mockImplementation(() => new Promise(() => {}));
  render(<OpenTerminal machine="devbox" name="devbox" native={n.native} onClose={() => {}} onOpened={opened} />);
  await settle();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in ~" })));
  await act(async () => void (await vi.advanceTimersByTimeAsync(HOME_WITHIN_MS)));
  expect(screen.getAllByRole("alert").some((a) => a.textContent === "devbox didn’t say where its home is within 10 s.")).toBe(true);
  expect(opened).not.toHaveBeenCalled();
  vi.mocked(machineHome).mockImplementation(async () => "/home/dev");
});
