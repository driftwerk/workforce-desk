// The update notice: what the restart does to the sessions, said before
// anything happens; Later, kept per version for this run of Desk; and a
// development build, which never looks for an update, shows nothing.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import * as platform from "../platform";
import { AWAY_MS, setLastInput, UpdateNotice, useRestartWhenIdle } from "./UpdateNotice";
import { isWorking, useUpdates } from "./store";
import { followInput, lastInputAt } from "./away";
import { useChat } from "../chat/store";
import { useVoiceStore } from "../voice/store";

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
  listen: vi.fn(async (event: string, f: (e: { payload: unknown }) => void) => {
    heard[event] = f;
    return () => {};
  }),
  subscribe: (p: Promise<() => void>) => () => void p.then((f) => f()),
}));
// Every window writes what it hasn't yet before the restart: noted, not waited for.
const flushed = vi.hoisted(() => ({ n: 0 }));
vi.mock("./away", async (original) => ({
  ...(await original<typeof import("./away")>()),
  flushEverywhere: vi.fn(async () => void flushed.n++),
}));
/** What each event this window listens for is handed to. */
const heard = vi.hoisted(() => ({}) as Record<string, (e: { payload: unknown }) => void>);

const how = (over: Partial<platform.Updating> = {}): platform.Updating => ({
  how: "itself",
  neverBecause: null,
  download: null,
  sessionsKept: true,
  ...over,
});

const session = (id: string, state: string, over: object = {}) =>
  ({ id, name: id, live: true, state, cwd: "/w", goal: "", lastPrompt: null, updatedAt: "", ...over }) as never;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(platform.updating).mockResolvedValue(how());
  vi.mocked(platform.updateCheck).mockResolvedValue("0.2.1");
  vi.mocked(platform.updateInstall).mockClear();
  vi.mocked(platform.updateDownload).mockClear();
  vi.mocked(platform.resumeLater).mockClear();
  useUpdates.setState({ state: { phase: "idle" }, waiting: false, later: null, never: null, sessionsKept: false });
  useDesk.setState({ sessions: { a: session("a", "working"), b: session("b", "idle") }, roomDrafts: {}, error: null });
  useChat.setState({ conversations: {} });
  useVoiceStore.setState({ status: { state: "off" }, waiting: {} });
});
afterEach(cleanup);

const ready = async () => {
  await act(() => useUpdates.getState().check());
  expect(useUpdates.getState().state).toEqual({ phase: "ready", version: "0.2.1" });
};

it("installs by itself by default, says so and what happens, and offers Not now and Update now", async () => {
  await ready();
  expect(useUpdates.getState().waiting).toBe(true);
  render(<UpdateNotice />);
  const notice = screen.getByRole("status");
  expect(notice.textContent).toContain("Desk 0.2.1 installs by itself once your sessions finish and you’ve stepped away.");
  expect(notice.textContent).toContain("Desk restarts to update. Your sessions keep running and are picked up again.");
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Not now", "Update now"]);
  // Nothing they're doing stops, so nothing is asked: it updates.
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  expect(platform.resumeLater).toHaveBeenCalledWith(["a", "b"]);
  expect(platform.updateInstall).toHaveBeenCalledWith("0.2.1");
  expect(flushed.n).toBeGreaterThan(0);
});

it("asks once, in the notice, before Update now stops a session that's working", async () => {
  vi.mocked(platform.updating).mockResolvedValue(how({ sessionsKept: false }));
  useDesk.setState({
    sessions: { a: session("a", "working"), b: session("b", "idle", { caps: { resume: "none" } }), c: session("c", "idle", { live: false }) },
  });
  await ready();
  render(<UpdateNotice />);
  expect(screen.getByRole("status").textContent).toContain(
    "Desk restarts to update. 2 sessions stop for the restart: 1 of them can’t be picked up again, the rest pick up where they left off.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("a is working right now.");
  expect(platform.updateInstall).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Wait for them" }));
  expect(screen.getByRole("status").textContent).toContain("installs by itself");
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
  await act(async () => {});
  expect(platform.updateInstall).toHaveBeenCalledWith("0.2.1");
});

/** The shell: the notice, and the restart that waits for idle, which runs
 *  whatever view is open. */
function Shell({ notice = true }: { notice?: boolean }) {
  useRestartWhenIdle();
  return notice ? <UpdateNotice /> : null;
}

it("waits for no session working and the person away, with or without the notice on screen", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await ready();
    setLastInput(Date.now());
    const { rerender } = render(<Shell />);
    // Settings open: the stage, and the notice with it, is gone.
    rerender(<Shell notice={false} />);
    // Nothing working, but the person typed just now: not yet.
    act(() => useDesk.setState({ sessions: { a: session("a", "idle") } }));
    await act(async () => {});
    expect(platform.updateInstall).not.toHaveBeenCalled();
    // Away a while: the next look installs it.
    setLastInput(Date.now() - AWAY_MS - 1000);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {});
    expect(platform.updateInstall).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

/** Away long enough, and a look by the restart's timer. */
const awayAndLook = async () => {
  setLastInput(Date.now() - AWAY_MS - 1000);
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  await act(async () => {});
};

it("never restarts by itself during a voice call, or while an agent's turn in a DM or a room is on its way", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await ready();
    useDesk.setState({ sessions: { b: session("b", "idle") } });
    useVoiceStore.setState({ status: { state: "live", agent: "Atlas" } });
    render(<Shell />);
    await awayAndLook();
    expect(platform.updateInstall).not.toHaveBeenCalled();
    // The call ends as a room's turn starts.
    act(() => {
      useDesk.setState({ roomDrafts: { r1: [{ id: "d1", member: "local/scout", state: "live" } as never] } });
      useVoiceStore.setState({ status: { state: "off" } });
    });
    await awayAndLook();
    expect(platform.updateInstall).not.toHaveBeenCalled();
    // The room's turn ends as a DM's starts.
    act(() => {
      useChat.setState({ conversations: { "local/scout": { working: { since: 1 }, turns: {} } as never } });
      useDesk.setState({ roomDrafts: {} });
    });
    await awayAndLook();
    expect(platform.updateInstall).not.toHaveBeenCalled();
    act(() => useChat.setState({ conversations: {} }));
    await awayAndLook();
    expect(platform.updateInstall).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    useVoiceStore.setState({ status: { state: "off" } });
  }
});

it("never stops an open session by itself unless it's kept through the restart; only Update now may, after asking", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    vi.mocked(platform.updating).mockResolvedValue(how({ sessionsKept: false }));
    await ready();
    useDesk.setState({ sessions: { b: session("b", "idle") } });
    render(<Shell />);
    await awayAndLook();
    expect(platform.updateInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toContain("1 session is open.");
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await act(async () => {});
    expect(platform.updateInstall).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("counts as busy what Desk can't tell is idle, and leaves a machine's sessions out", async () => {
  expect(isWorking(session("a", "asking"))).toBe(true);
  expect(isWorking(session("a", "done", { background: { count: 2, since: "" } }))).toBe(true);
  expect(isWorking(session("a", "idle", { caps: { state: "none" } }))).toBe(true);
  expect(isWorking(session("a", "idle", { origin: "external" }))).toBe(true);
  expect(isWorking(session("a", "idle", { origin: "desk", caps: { state: "hooks" } }))).toBe(false);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await ready();
    // A machine's session, working: it runs on, and isn't resumed here.
    useDesk.setState({ sessions: { b: session("b", "idle"), "devbox/c": session("c", "working", { machine: "devbox" }) } });
    render(<Shell />);
    await awayAndLook();
    expect(platform.updateInstall).toHaveBeenCalledTimes(1);
    expect(platform.resumeLater).toHaveBeenCalledWith(["b"]);
  } finally {
    vi.useRealTimers();
  }
});

it("counts the person's input in every Desk window, moving the pointer and focusing one included", () => {
  const stop = followInput();
  try {
    setLastInput(0);
    window.dispatchEvent(new Event("pointermove"));
    expect(lastInputAt()).toBeGreaterThan(0);
    setLastInput(0);
    window.dispatchEvent(new Event("focus"));
    expect(lastInputAt()).toBeGreaterThan(0);
    // Another window (a detached grid's) says the person was there.
    setLastInput(0);
    heard["desk-input"]?.({ payload: { at: 12345 } });
    expect(lastInputAt()).toBe(12345);
  } finally {
    stop();
  }
});

it("starts one restart however often it's asked, and a failed one by itself offers Retry", async () => {
  await ready();
  useDesk.setState({ sessions: {} });
  await act(async () => {
    await Promise.all([useUpdates.getState().restart([]), useUpdates.getState().restart([])]);
  });
  expect(platform.updateInstall).toHaveBeenCalledTimes(1);
  // Ready again, and failing when it restarts by itself.
  useUpdates.setState({ state: { phase: "ready", version: "0.2.1" }, waiting: true });
  vi.mocked(platform.updateInstall).mockRejectedValueOnce(new Error("the bundle was moved"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    render(<Shell notice={false} />);
    await awayAndLook();
    await act(async () => {});
    const problem = useDesk.getState().error;
    expect(problem?.what).toBe("restarting into the update");
    expect(problem?.fix?.label).toBe("Retry");
  } finally {
    vi.useRealTimers();
  }
});

it("says a restart that failed in the shared problem shape, with Retry", async () => {
  await ready();
  vi.mocked(platform.updateInstall).mockRejectedValueOnce(new Error("the bundle was moved"));
  render(<UpdateNotice />);
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  const problem = useDesk.getState().error;
  expect(problem?.what).toBe("restarting into the update");
  expect(problem?.fix?.label).toBe("Retry");
});

it("waits, too, for a machine being set up or updated, and an account signing in", async () => {
  const { useMachines } = await import("../hub/engines");
  const { accountsOn } = await import("../engines/accounts");
  await ready();
  act(() => useDesk.setState({ sessions: {} }));
  act(() =>
    useMachines.setState({ listed: true, machines: [{ id: "devbox", name: "devbox", target: "devbox", version: "0.2.0", state: { kind: "updating" }, system: null }] as never }),
  );
  act(() => accountsOn("devbox").setState({ signIns: { s1: { id: "s1", engine: "claude", name: "Work", state: "open", url: null } } }));
  render(<Shell notice={false} />);
  act(() => useUpdates.getState().wait(true));
  await act(async () => {});
  expect(platform.updateInstall).not.toHaveBeenCalled();
  act(() => useMachines.setState({ machines: [] }));
  await act(async () => {});
  expect(platform.updateInstall).not.toHaveBeenCalled();
  act(() => accountsOn("devbox").setState({ signIns: {} }));
  act(() => accountsOn("local").setState({ signIns: {} }));
  await act(async () => void (await new Promise((r) => setTimeout(r, 2100))));
  expect(platform.updateInstall).toHaveBeenCalledTimes(1);
});

it("hides on Later until a newer version is out, through restarts and the checks every few hours", async () => {
  await ready();
  render(<UpdateNotice />);
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(JSON.parse(localStorage.getItem("desk.update.later")!)).toEqual({ version: "0.2.1" });

  // Desk restarts: the page starts over, Later read back from storage.
  cleanup();
  useUpdates.setState({ state: { phase: "idle" }, later: JSON.parse(localStorage.getItem("desk.update.later")!) });
  await ready();
  render(<UpdateNotice />);
  expect(screen.queryByRole("status")).toBeNull();

  // The check every few hours finds the same version: still hidden.
  await act(() => useUpdates.getState().check());
  expect(screen.queryByRole("status")).toBeNull();

  // A newer one is out: shown, and downloaded.
  vi.mocked(platform.updateCheck).mockResolvedValue("0.2.2");
  await act(() => useUpdates.getState().check());
  expect(screen.getByRole("status").textContent).toContain("Desk 0.2.2 installs by itself");
  expect(localStorage.getItem("desk.update.later")).toBeNull();
});

it("shows a version put off again when the person checks for updates", async () => {
  await ready();
  render(<UpdateNotice />);
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("status")).toBeNull();
  await act(() => useUpdates.getState().check({ asked: true }));
  expect(screen.getByRole("status").textContent).toContain("Desk 0.2.1 installs by itself");
  expect(localStorage.getItem("desk.update.later")).toBeNull();
});

it("keeps checking while a version is ready, and installs only the newest", async () => {
  await ready();
  render(<UpdateNotice />);
  expect(platform.updateDownload).toHaveBeenCalledTimes(1);
  vi.mocked(platform.updateCheck).mockResolvedValue("0.2.2");
  await act(() => useUpdates.getState().check());
  expect(platform.updateDownload).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toContain("Desk 0.2.2 installs by itself");
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  expect(platform.updateInstall).toHaveBeenCalledWith("0.2.2");
  expect(platform.updateInstall).not.toHaveBeenCalledWith("0.2.1");
});

it("asks again whether the holder keeps the sessions before Update now restarts", async () => {
  await ready();
  render(<UpdateNotice />);
  expect(screen.getByRole("status").textContent).toContain("Your sessions keep running");
  // The holder went away since the check: a working session would stop.
  vi.mocked(platform.updating).mockResolvedValue(how({ sessionsKept: false }));
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toContain("a is working right now.");
  expect(screen.getByRole("status").textContent).toContain("2 sessions stop for the restart");
  expect(platform.updateInstall).not.toHaveBeenCalled();
});

it("never looks for an update in a development build, and shows nothing", async () => {
  vi.mocked(platform.updating).mockResolvedValue(how({ how: "never", neverBecause: "a development build never updates itself" }));
  vi.mocked(platform.updateCheck).mockClear();
  await act(() => useUpdates.getState().check());
  expect(platform.updateCheck).not.toHaveBeenCalled();
  expect(useUpdates.getState().state).toEqual({ phase: "idle" });
  expect(useUpdates.getState().never).toBe("a development build never updates itself");
  const { container } = render(<UpdateNotice />);
  expect(container.innerHTML).toBe("");
});
