// Machines updating to this Desk's version: each step on the row with its
// progress, Cancel update until the switch-over, a failed update held with
// Update to match and View log, a machine on a newer Desk with Check for
// updates, "Desk is now …" once after Desk updates, and the restart notice
// naming the machines that follow it.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readMachine } from "../hub/machines";
import { useDesk } from "../hub/store";
import { useMachines, type Machine } from "../machines/engines";
import { fakeNative, machine, noEngines } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { UpdateNotice } from "../updates/UpdateNotice";
import { useUpdates } from "../updates/store";
import { Machines } from "./Machines";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.1") }));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  machineHome: vi.fn(async () => "/home/dev"),
  inApp: true,
  openUrl: vi.fn(),
  updating: vi.fn(async () => ({ how: "itself", neverBecause: null, download: null, sessionsKept: true })),
  updateCheck: vi.fn(async () => null),
  updateDownload: vi.fn(),
  updateInstall: vi.fn(),
  resumeLater: vi.fn(),
  takeResume: vi.fn(async () => []),
}));

const updating: Partial<Machine> = {
  state: { kind: "updating" },
  version: "0.2.0",
  update: {
    to: "0.2.1",
    from: "0.2.0",
    steps: [
      { key: "download", state: "done", detail: "Desk 0.2.1 for Linux x86_64, signature checked" },
      { key: "copy", state: "running", detail: "Copying it to devbox… 38 of 61 MB" },
      { key: "switch", state: "waiting" },
      { key: "reconnect", state: "waiting" },
    ],
  },
};

const failed: Partial<Machine> = {
  state: { kind: "updateFailed", message: "~ on hel-1 has 180 MB free, and Desk needs 420 MB", from: "0.2.0" },
  version: "0.2.0",
  update: {
    to: "0.2.1",
    from: "0.2.0",
    steps: [
      { key: "download", state: "done", detail: "Desk 0.2.1 for Linux x86_64, signature checked" },
      { key: "copy", state: "failed", detail: "~ on hel-1 has 180 MB free, and Desk needs 420 MB" },
      { key: "switch", state: "waiting" },
      { key: "reconnect", state: "waiting" },
    ],
  },
};

beforeEach(() => {
  useHost.setState(DEFAULT_HOST);
  noEngines();
  useDesk.setState({ sessions: { "hel-1/s": { id: "s", machine: "hel-1", cwd: "/w", updatedAt: "" } as never } });
  useUpdates.setState({ state: { phase: "idle" }, waiting: false, later: null, sessionsKept: true });
  localStorage.clear();
  useMachines.setState({
    listed: true,
    machines: [
      machine({ id: "devbox", target: "dev@2.29.244.189", ...updating }),
      machine({ id: "hel-1", target: "james@hel-1", ...failed }),
      machine({ id: "buildbox", target: "ubuntu@buildbox", state: { kind: "newer" }, version: "0.2.2" }),
    ],
  });
});
afterEach(cleanup);

const row = (name: string) => screen.getByRole("listitem", { name });

it("reads an update as the native side lists it", () => {
  const m = readMachine({
    id: "hel-1",
    name: "hel-1",
    target: "hel-1",
    state: { update_failed: { message: "no room", from: "0.2.0" } },
    update: { to: "0.2.1", from: "0.2.0", steps: [{ key: "copy", state: "failed", detail: "no room" }, { key: "nope", state: "x" }] },
  })!;
  expect(m.state).toEqual({ kind: "updateFailed", message: "no room", from: "0.2.0" });
  expect(m.update).toEqual({ to: "0.2.1", from: "0.2.0", steps: [{ key: "copy", state: "failed", detail: "no room" }] });
});

it("shows an update step by step with its progress, and cancels it before the switch-over", async () => {
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  await act(async () => {});
  const devbox = row("devbox");
  expect(devbox.querySelector(".dot-working")).toBeTruthy();
  expect(devbox.textContent).toContain("Updating Desk to 0.2.1… its sessions carry on");
  const steps = within(devbox).getByRole("list", { name: "Updating devbox" });
  expect(within(steps).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
    "Desk 0.2.1 for Linux x86_64, signature checked",
    "Copying it to devbox… 38 of 61 MB",
    "Switch over: Desk restarts there in seconds; sessions stay open",
    "Reconnect",
  ]);
  expect(devbox.textContent).toContain("Works until the switch-over. Getting Desk stops after 10 minutes, each other step after 3, and says why.");
  expect(devbox.querySelector(".dot-top")).toBeTruthy();
  await act(async () => fireEvent.click(within(devbox).getByRole("button", { name: "Cancel update" })));
  expect(fake.cancelUpdate).toHaveBeenCalledWith("devbox");

  // Past the switch-over, no Cancel.
  act(() =>
    useMachines.setState((s) => ({
      machines: s.machines.map((m) =>
        m.id === "devbox" ? { ...m, update: { ...m.update!, steps: m.update!.steps.map((x) => (x.key === "switch" ? { ...x, state: "running" } : x.key === "copy" ? { ...x, state: "done" } : x)) } } : m,
      ),
    })),
  );
  expect(within(row("devbox")).queryByRole("button", { name: "Cancel update" })).toBeNull();
});

it("says why an update stopped, held until Update to match, with View log", async () => {
  const { native, fake } = fakeNative();
  render(<Machines native={native} />);
  await act(async () => {});
  const hel = row("hel-1");
  expect(hel.querySelector(".dot-failed")).toBeTruthy();
  expect(hel.textContent).toContain("Couldn’t update to 0.2.1: ~ on hel-1 has 180 MB free, and Desk needs 420 MB.");
  expect(hel.textContent).toContain("Still on 0.2.0, driven no further until it matches · its 1 session keeps running there");
  fireEvent.click(within(hel).getByRole("button", { name: "Update to match" }));
  expect(fake.reconnect).toHaveBeenCalledWith("hel-1");
  fireEvent.click(within(hel).getByRole("button", { name: "View log" }));
  const page = screen.getByRole("region", { name: "hel-1" });
  const status = within(page).getByRole("status");
  expect(status.textContent).toContain("Needs update");
  expect(status.textContent).toContain("It runs Desk 0.2.0 still, driven no further until it matches.");
  expect(within(status).getByRole("list", { name: "Updating hel-1" }).textContent).toContain("Copy it to hel-1: ~ on hel-1 has 180 MB free");
});

it("checks for a newer Desk for a machine on one, and says when there's none", async () => {
  render(<Machines native={fakeNative().native} />);
  await act(async () => {});
  const bb = row("buildbox");
  expect(bb.textContent).toContain("It runs a newer Desk (0.2.2). Update Desk here to drive it; its sessions keep running.");
  await act(async () => fireEvent.click(within(bb).getByRole("button", { name: "Check for updates" })));
  expect(bb.textContent).toContain("This Desk is up to date for now.");
  // Its own page has the same way out, on its status card.
  fireEvent.click(within(bb).getByRole("button", { name: "Open buildbox" }));
  const status = within(screen.getByRole("region", { name: "buildbox" })).getByRole("status");
  expect(within(status).getByRole("button", { name: "Check for updates" })).toBeTruthy();
});

it("says once that Desk updated and what its machines do about it", async () => {
  localStorage.setItem("desk.machines.version-seen", "0.2.0");
  render(<Machines native={fakeNative().native} />);
  await act(async () => {});
  const banner = screen.getByText("Desk is now 0.2.1").closest("[role=status]")!;
  expect(banner.textContent).toContain("Machines update to match when they connect: devbox is updating now, hel-1 couldn’t");
  fireEvent.click(within(banner as HTMLElement).getByRole("button", { name: "OK" }));
  expect(screen.queryByText("Desk is now 0.2.1")).toBeNull();
  cleanup();
  render(<Machines native={fakeNative().native} />);
  await act(async () => {});
  expect(screen.queryByText("Desk is now 0.2.1")).toBeNull();
});

it("names the machines that follow when Desk is ready to restart, and says their sessions don't stop", async () => {
  useUpdates.setState({ state: { phase: "ready", version: "0.2.1" }, sessionsKept: false });
  useDesk.setState({ sessions: { a: { id: "a", live: true, state: "working", name: "acme-api", cwd: "/w" } as never } });
  render(<UpdateNotice />);
  expect(screen.getByRole("status").textContent).toContain("Desk 0.2.1 is ready.");
  expect(screen.getByRole("status").textContent).toContain("devbox and hel-1 update to match after.");
  const { updating } = await import("../platform");
  vi.mocked(updating).mockResolvedValueOnce({ how: "itself", neverBecause: null, download: null, sessionsKept: false });
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await act(async () => {});
  expect(screen.getByRole("dialog").textContent).toContain("Your machines’ sessions don’t stop. Each machine updates to 0.2.1 when Desk reconnects to it.");
});
