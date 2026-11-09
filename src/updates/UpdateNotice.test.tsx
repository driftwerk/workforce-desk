// The update notice: what the restart does to the sessions, said before
// anything happens; Later, kept per version for this run of Desk; and a
// development build, which never looks for an update, shows nothing.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import * as platform from "../platform";
import { UpdateNotice } from "./UpdateNotice";
import { useUpdates } from "./store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.0") }));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  machineHome: vi.fn(async () => "/home/dev"),
  inApp: true,
  openUrl: vi.fn(),
  updating: vi.fn(),
  updateCheck: vi.fn(),
  updateDownload: vi.fn(async () => {}),
  updateInstall: vi.fn(async () => {}),
  resumeLater: vi.fn(async () => {}),
  takeResume: vi.fn(async () => []),
}));

const how = (over: Partial<platform.Updating> = {}): platform.Updating => ({
  how: "itself",
  neverBecause: null,
  download: null,
  sessionsKept: true,
  started: 100,
  ...over,
});

const session = (id: string, state: string, over: object = {}) =>
  ({ id, name: id, live: true, state, cwd: "/w", goal: "", lastPrompt: null, updatedAt: "", ...over }) as never;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(platform.updating).mockResolvedValue(how());
  vi.mocked(platform.updateCheck).mockResolvedValue("0.2.1");
  vi.mocked(platform.updateInstall).mockClear();
  vi.mocked(platform.resumeLater).mockClear();
  useUpdates.setState({ state: { phase: "idle" }, waiting: false, later: null, started: null, never: null, sessionsKept: false });
  useDesk.setState({ sessions: { a: session("a", "working"), b: session("b", "idle") } });
});
afterEach(cleanup);

const ready = async () => {
  await act(() => useUpdates.getState().check({ launch: true }));
  expect(useUpdates.getState().state).toEqual({ phase: "ready", version: "0.2.1" });
};

it("says the sessions keep running when the PTY holder has them, with Later, When idle and Update now", async () => {
  await ready();
  render(<UpdateNotice />);
  const notice = screen.getByRole("status");
  expect(notice.textContent).toContain("Desk 0.2.1 is ready.");
  expect(notice.textContent).toContain("Desk restarts to update. Your sessions keep running and are picked up again.");
  for (const name of ["Later", "When idle", "Update now"]) screen.getByRole("button", { name });
  // Nothing they're doing stops, so nothing is asked: it updates.
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  expect(platform.resumeLater).toHaveBeenCalledWith(["a", "b"]);
  expect(platform.updateInstall).toHaveBeenCalledTimes(1);
});

it("says how many sessions stop, and which can't be picked up again, without the holder", async () => {
  vi.mocked(platform.updating).mockResolvedValue(how({ sessionsKept: false }));
  useDesk.setState({
    sessions: { a: session("a", "working"), b: session("b", "idle", { caps: { resume: "none" } }), c: session("c", "idle", { live: false }) },
  });
  await ready();
  render(<UpdateNotice />);
  expect(screen.getByRole("status").textContent).toContain(
    "Desk restarts to update. 2 sessions stop for the restart: 1 of them can’t be picked up again, the rest pick up where they left off.",
  );
  // One is working: Update now asks first.
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  expect(screen.getByRole("dialog").textContent).toContain("a is working right now.");
  expect(platform.updateInstall).not.toHaveBeenCalled();
});

it("waits for no session to be working on When idle", async () => {
  await ready();
  render(<UpdateNotice />);
  fireEvent.click(screen.getByRole("button", { name: "When idle" }));
  expect(screen.getByRole("status").textContent).toContain("Desk 0.2.1 installs when your sessions finish.");
  expect(platform.updateInstall).not.toHaveBeenCalled();
  act(() => useDesk.setState({ sessions: { a: session("a", "idle") } }));
  await act(async () => {});
  expect(platform.updateInstall).toHaveBeenCalledTimes(1);
});

it("hides on Later for this version and run, kept across a reload, until the next check or start", async () => {
  await ready();
  render(<UpdateNotice />);
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(JSON.parse(localStorage.getItem("desk.update.later")!)).toEqual({ version: "0.2.1", started: 100 });

  // A reload: the page starts over in the same run of Desk.
  cleanup();
  useUpdates.setState({ state: { phase: "idle" }, later: null, started: null });
  useUpdates.setState({ later: JSON.parse(localStorage.getItem("desk.update.later")!) });
  await ready();
  render(<UpdateNotice />);
  expect(screen.queryByRole("status")).toBeNull();

  // The next check shows it again.
  await act(() => useUpdates.getState().check());
  expect(screen.getByRole("status").textContent).toContain("Desk 0.2.1 is ready.");
  expect(localStorage.getItem("desk.update.later")).toBeNull();
});

it("shows it again after Desk restarts, though Later was kept", async () => {
  localStorage.setItem("desk.update.later", JSON.stringify({ version: "0.2.1", started: 99 }));
  useUpdates.setState({ later: { version: "0.2.1", started: 99 } });
  await ready();
  render(<UpdateNotice />);
  expect(screen.getByRole("status").textContent).toContain("Desk 0.2.1 is ready.");
});

it("shows a newer version at once, though an older one was put off", async () => {
  useUpdates.setState({ later: { version: "0.2.0", started: 100 } });
  await ready();
  render(<UpdateNotice />);
  screen.getByRole("status");
});

it("never looks for an update in a development build, and shows nothing", async () => {
  vi.mocked(platform.updating).mockResolvedValue(how({ how: "never", neverBecause: "a development build never updates itself" }));
  vi.mocked(platform.updateCheck).mockClear();
  await act(() => useUpdates.getState().check({ launch: true }));
  expect(platform.updateCheck).not.toHaveBeenCalled();
  expect(useUpdates.getState().state).toEqual({ phase: "idle" });
  expect(useUpdates.getState().never).toBe("a development build never updates itself");
  const { container } = render(<UpdateNotice />);
  expect(container.innerHTML).toBe("");
});
