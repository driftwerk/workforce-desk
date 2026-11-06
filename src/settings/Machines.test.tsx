// Settings → Machines and a machine's own page, against a fake native side
// and fake engines: every state says why with its way out on the row, the
// page says how Desk reaches it, its status in ssh's words, Desk there, its
// engines, both logs, and removing it.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountsOn } from "../engines/accounts";
import { useGrids } from "../grids/store";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { EngineInfo, Session } from "../hub/types";
import { useMachines, type Machine } from "../machines/engines";
import { fakeNative, machine, noEngines, withEngine } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { useUi } from "../shell/ui";
import { openUrl } from "../platform";
import { Machines } from "./Machines";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.1") }));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: true,
  openUrl: vi.fn(),
}));

const NOW = new Date("2026-11-06T09:41:30").getTime();

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

const hubWith = (claude: EngineInfo["signIn"]) =>
  ({
    engines: vi.fn(async () => [
      engine({ engine: "claude", title: "Claude Code", version: "2.1.318", signIn: claude }),
      engine({ engine: "codex", title: "Codex", signIn: { state: "in", via: "plan", who: null, plan: null } }),
    ]),
    accounts: vi.fn(async () => ({ accounts: [], store: "Desk's private file", signIns: [] })),
    startEngineSignIn: vi.fn(async () => ({ id: "cx-1", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "WXYZ-98765" })),
  }) as unknown as DeskHub;

const offline: Partial<Machine> = {
  state: { kind: "unreachable" },
  reason: "SSH couldn't reach buildbox: “ssh: connect to host 10.0.3.14 port 22: Connection timed out”",
  said: "ssh: connect to host 10.0.3.14 port 22: Connection timed out",
  lastConnected: new Date("2026-11-06T08:55:00").getTime(),
  lastTry: new Date("2026-11-06T09:41:12").getTime(),
  nextTry: NOW + 40_000,
  reach: { user: "ubuntu", hostname: "10.0.3.14", port: "22", via: "bastion", entry: "buildbox", file: "~/.ssh/config" },
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  useHost.setState(DEFAULT_HOST);
  useDesk.setState({
    sessions: Object.fromEntries(
      [session("a"), session("b"), session("devbox/c", "devbox"), session("devbox/d", "devbox"), session("buildbox/e", "buildbox"), session("buildbox/f", "buildbox")].map((s) => [s.id, s]),
    ),
  });
  noEngines();
  accountsOn("devbox").setState({ accounts: [] });
  accountsOn("devbox-root").setState({ accounts: [] });
  withEngine("devbox", hubWith({ state: "in", via: "plan", who: "kings@starmoire.dev", plan: "max" }));
  withEngine("devbox-root", hubWith({ state: "out" }));
  useMachines.setState({
    listed: true,
    machines: [
      machine({
        id: "devbox",
        target: "dev@2.29.244.189",
        version: "0.2.1",
        connectedSince: new Date("2026-11-06T09:12:00").getTime(),
        reach: { user: "dev", hostname: "2.29.244.189", port: "22", via: null, entry: "devbox", file: "~/.ssh/config" },
        hostKey: { kind: "ED25519", fingerprint: "SHA256:k3VqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9fXc", trustedAt: new Date("2026-11-05T10:00:00").getTime() },
        system: { os: "Ubuntu 24.04", arch: "x86_64", glibc: "2.39" },
        details: { freeKb: 1_700_000_000, linger: true, service: true, systemd: true, user: "dev" },
      }),
      machine({
        id: "devbox-root",
        name: "devbox (root)",
        target: "root@devbox",
        version: "0.2.1",
        hostKey: { kind: "ED25519", fingerprint: "SHA256:k3VqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9fXc", trustedAt: null },
        details: { freeKb: null, linger: false, service: true, systemd: true, user: "root", lingerLine: "sudo loginctl enable-linger root" },
      }),
      machine({ id: "buildbox", target: "ubuntu@buildbox", ...offline }),
      machine({ id: "scratch", target: "dev@scratch", state: { kind: "failed", message: "scratch turned your SSH key away, or it needs unlocking first (ssh-add)." } }),
      machine({
        id: "old-ci",
        target: "ci@old-ci",
        state: { kind: "failed", message: "old-ci's host key isn't the one your Mac knows. Desk won't connect until you've checked why and fixed known_hosts." },
        reach: { user: "ci", hostname: "10.0.9.9", port: "2222", via: null, entry: "old-ci", file: "~/.ssh/config", forgetKey: "ssh-keygen -R '[10.0.9.9]:2222'" },
        hostKey: { kind: "ED25519", fingerprint: "SHA256:k3VqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9fXc", trustedAt: null },
        shownKey: { kind: "ED25519", fingerprint: "SHA256:Zp4wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa1Qe", trustedAt: null },
      }),
      machine({ id: "shared", target: "dev@shared-box", state: { kind: "newer" }, version: "0.2.2" }),
      machine({ id: "gpu", target: "dev@gpu-1", state: { kind: "connecting" } }),
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const row = (name: string) => screen.getByRole("listitem", { name });
const shows = async () => {
  render(<Machines native={fakeNative().native} />);
  await act(async () => {});
};

it("says where each machine stands and why, its way out on its row", async () => {
  await shows();
  expect(row("This Mac").textContent).toContain("2 sessions · Desk 0.2.1");
  const devbox = row("devbox");
  expect(devbox.textContent).toContain("dev@2.29.244.189");
  expect(devbox.textContent).toContain("Connected · 2 sessions · Desk 0.2.1 · Linux x86_64");
  expect(devbox.textContent).toContain("Claude signed in as kings@starmoire.dev · Codex signed in");
  expect(devbox.querySelector(".dot-done")).toBeTruthy();
  expect(within(devbox).getByRole("button", { name: "Open a terminal…" })).toBeTruthy();
  expect(within(devbox).getByRole("button", { name: "New session…" })).toBeTruthy();

  // Connected, but nothing can start: it says so, with Sign in.
  const root = row("devbox (root)");
  expect(root.textContent).toContain("Needs sign-in: Claude isn’t signed in there yet, so sessions can’t start.");
  expect(root.querySelector(".dot-blocked")).toBeTruthy();
  // The same computer as devbox (its host key), reached as another account.
  expect(root.textContent).toContain("Connected · Desk 0.2.1 · same machine as devbox, as root");
  // Said of the one listed after it only.
  expect(devbox.textContent).not.toContain("same machine as");
  expect(within(root).getByRole("button", { name: "Sign in…" })).toBeTruthy();

  // Offline: ssh's own words, its sessions, when it was last reached and tries next.
  const bb = row("buildbox");
  expect(bb.textContent).toContain("via bastion");
  expect(bb.textContent).toContain("Offline: SSH couldn’t reach buildbox through bastion. Connection timed out after 15 s.");
  expect(bb.textContent).toContain("2 sessions keep running there · last connected 08:55 · next try in 40 s");
  expect(within(bb).getByRole("button", { name: "Reconnect" })).toBeTruthy();
  expect(within(bb).getByRole("button", { name: "View log" })).toBeTruthy();

  expect(row("scratch").textContent).toContain("your SSH key is locked, or scratch turned it away. Run ssh-add in a terminal, then Reconnect.");
  // A changed key: the line that removes the old one, with Copy.
  const ci = row("old-ci");
  expect(ci.textContent).toContain("old-ci shows a different host key from the one this computer knows");
  // By the name and port ssh looks its key up by, with both keys.
  expect(within(ci).getByText("ssh-keygen -R '[10.0.9.9]:2222'")).toBeTruthy();
  expect(ci.textContent).toContain("shows SHA256:Zp4w…a1Qe · Desk knew SHA256:k3Vq…9fXc");
  expect(within(ci).getByRole("button", { name: "Copy" })).toBeTruthy();
  expect(row("shared").textContent).toContain("It runs a newer Desk (0.2.2). Update Desk here to drive it; its sessions keep running.");
  expect(row("gpu").textContent).toContain("Connecting… Desk gives up after 15 s and says why.");
});

it("counts the next try down", async () => {
  await shows();
  expect(row("buildbox").textContent).toContain("next try in 40 s");
  await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
  expect(row("buildbox").textContent).toContain("next try in 30 s");
});

it("reconnects from the row", async () => {
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  fireEvent.click(within(row("buildbox")).getByRole("button", { name: "Reconnect" }));
  expect(fake.reconnect).toHaveBeenCalledWith("buildbox");
});

it("opens a machine's page: how Desk reaches it, Desk there, its engines and its log", async () => {
  const { native, fake } = fakeNative();
  fake.log.mockResolvedValue([
    { at: new Date("2026-11-06T08:12:03").getTime(), kind: "ok", text: "connected · Desk 0.2.1" },
    { at: new Date("2026-11-06T09:40:37").getTime(), kind: "info", text: "connecting to devbox" },
  ]);
  fake.remoteLog.mockResolvedValue("2026-11-06T09:41:27+0000 devbox desk-helper[12]: hub starting");
  render(<Machines native={native} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Open devbox" }));
  await act(async () => {});
  const page = screen.getByRole("region", { name: "devbox" });
  expect(within(page).getByRole("status").textContent).toContain("Connected2 sessions · connected since 09:12 · Desk checks the link every 5 s");
  const reach = within(page).getByRole("region", { name: "How Desk reaches it" });
  expect(reach.textContent).toContain("SSH config entrydevbox from ~/.ssh/config");
  expect(reach.textContent).toContain("Connects asdev@2.29.244.189, port 22, directly");
  expect(reach.textContent).toContain("Host keyED25519 · SHA256:k3Vq…9fXc · trusted from Desk on 5 Nov");
  const desk = within(page).getByRole("region", { name: "Desk on devbox" });
  expect(desk.textContent).toContain("Desk 0.2.1The same as this Mac");
  expect(desk.textContent).toContain("Linux x86_64Ubuntu 24.04 · glibc 2.39 · 1.7 TB free");
  expect(desk.textContent).toContain("Starts when devbox bootsIts own user service, kept on with linger");
  expect(within(page).getByRole("region", { name: "Engines on devbox" }).textContent).toContain("Signed in as kings@starmoire.dev, on max plan");

  const log = within(page).getByRole("log");
  // Newest first, to the second.
  expect(log.textContent).toMatch(/08:12:\d\dconnected · Desk 0\.2\.1$/);
  const times = [...log.querySelectorAll(".machine-log-line > .faint")].map((t) => t.textContent!);
  expect([...times].sort().reverse()).toEqual(times);
  expect(log.querySelector(".machine-log-ok")).toBeTruthy();
  await act(async () => fireEvent.click(within(page).getByRole("radio", { name: "Desk on devbox" })));
  expect(fake.remoteLog).toHaveBeenCalledWith("devbox");
  expect(within(page).getByRole("log").textContent).toContain("desk-helper[12]: hub starting");
  fireEvent.click(within(page).getByRole("button", { name: "Show in Finder" }));
  expect(fake.revealLog).toHaveBeenCalled();
  fireEvent.click(within(page).getByRole("button", { name: "‹ Machines" }));
  expect(screen.getByRole("region", { name: "Machines" })).toBeTruthy();
});

it("shows an offline machine's status in ssh's own words, and Reconnect now", async () => {
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Open buildbox" }));
  await act(async () => {});
  const page = screen.getByRole("region", { name: "buildbox" });
  const status = within(page).getByRole("status");
  expect(status.textContent).toContain("Offline");
  expect(status.textContent).toContain("SSH couldn’t reach buildbox through bastion:");
  expect(within(status).getByText("ssh: connect to host 10.0.3.14 port 22: Connection timed out").tagName).toBe("CODE");
  expect(status.textContent).toContain("Last connected today at 08:55 · tried at 09:41 and gave up after 15 s · next try in 40 s, then less often, up to every 5 minutes");
  expect(status.textContent).toContain("Its 2 sessions keep running on buildbox.");
  expect(status.textContent).toContain("If ssh buildbox works in a terminal on this Mac, Reconnect now.");
  fireEvent.click(within(status).getByRole("button", { name: "Reconnect now" }));
  expect(fake.reconnect).toHaveBeenCalledWith("buildbox");
  const reach = within(page).getByRole("region", { name: "How Desk reaches it" });
  expect(reach.textContent).toContain("Jump hostbastion (ProxyJump), as your SSH config says.");
  // Its own log there can't be read while it's offline: said, not tried.
  await act(async () => fireEvent.click(within(page).getByRole("radio", { name: "Desk on buildbox" })));
  expect(fake.remoteLog).not.toHaveBeenCalled();
  expect(within(page).getByRole("log").textContent).toContain("shows here once Desk reaches it");
  // Its engines stay on the page while it is away (a sign-in under way
  // there carries on), saying they wait for it.
  expect(within(page).getByRole("region", { name: "Engines on buildbox" }).textContent).toContain("Waiting for buildbox to connect…");
  // Its jump host has a row of its own: not said again under Connects as.
  expect(reach.textContent).toContain("Connects asubuntu@10.0.3.14, port 22");
  expect(reach.textContent).not.toContain("port 22, through bastion");
});

it("says this Mac's log of a machine couldn't be read, as an error with Try again", async () => {
  const { native, fake } = fakeNative();
  fake.log.mockRejectedValueOnce(new Error("Desk couldn't read its log."));
  render(<Machines native={native} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Open devbox" }));
  await act(async () => {});
  const alert = within(screen.getByRole("log")).getByRole("alert");
  expect(alert.textContent).toContain("Couldn’t read this Mac’s log of devbox: Desk couldn't read its log.");
  await act(async () => fireEvent.click(within(alert).getByRole("button", { name: "Try again" })));
  expect(within(screen.getByRole("log")).queryByRole("alert")).toBeNull();
});

it("says why Desk's log there couldn't be read, with Try again", async () => {
  const { native, fake } = fakeNative();
  fake.remoteLog.mockRejectedValueOnce(new Error("devbox didn't answer within 10 s.")).mockResolvedValueOnce("ok now");
  render(<Machines native={native} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Open devbox" }));
  await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Desk on devbox" })));
  expect(screen.getByRole("log").textContent).toContain("devbox didn't answer within 10 s.");
  await act(async () => fireEvent.click(within(screen.getByRole("log")).getByRole("button", { name: "Try again" })));
  expect(screen.getByRole("log").textContent).toContain("ok now");
});

it("removes a machine from its page only once asked", async () => {
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  fireEvent.click(screen.getByRole("button", { name: "Open devbox" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
  expect(screen.getByRole("dialog").textContent).toContain("Desk keeps running there, with its sessions");
  expect(fake.remove).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
  expect(fake.remove).toHaveBeenCalledWith("devbox");
});

it("opens a terminal on a machine in a grid, and shows it", () => {
  useUi.getState().openSettings("machines");
  render(<Machines native={fakeNative().native} />);
  fireEvent.click(within(row("devbox")).getByRole("button", { name: "Open a terminal…" }));
  const panes = Object.values(useGrids.getState().grids).flatMap((g) => g.panes);
  expect(panes.some((p) => p.content?.kind === "terminal" && (p.content as { machine?: string }).machine === "devbox")).toBe(true);
  expect(useUi.getState().settings).toBeNull();
  expect(useDesk.getState().view).toBe("grids");
  expect(openUrl).not.toHaveBeenCalled();
});

it("opens the add card", () => {
  render(<Machines native={fakeNative().native} />);
  fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
  expect(screen.getByRole("form", { name: "Add a machine" })).toBeTruthy();
});

it("shows the linger line as the native side made it, never one built here", async () => {
  await shows();
  fireEvent.click(screen.getByRole("button", { name: "Open devbox (root)" }));
  await act(async () => {});
  const desk = screen.getByRole("region", { name: "Desk on devbox (root)" });
  expect(within(desk).getByText("sudo loginctl enable-linger root").tagName).toBe("CODE");
});

it("shows a machine still being set up with its progress and Cancel adding", async () => {
  useMachines.setState({ machines: [machine({ id: "devbox-gpu", target: "devbox-gpu", state: { kind: "adding" } })] });
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  await act(async () => {});
  const gpu = row("devbox-gpu");
  await act(async () => fireEvent.click(within(gpu).getByRole("button", { name: "Cancel adding" })));
  expect(fake.cancelAdd).toHaveBeenCalledWith("devbox-gpu");
  fireEvent.click(within(gpu).getByRole("button", { name: "Show progress" }));
  const status = within(screen.getByRole("region", { name: "devbox-gpu" })).getByRole("status");
  expect(status.textContent).toContain("Being set up… Each step stops after 3 minutes and says why; its log is below.");
  expect(within(status).getByRole("button", { name: "Cancel adding" })).toBeTruthy();
});
