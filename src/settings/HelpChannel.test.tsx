// Help's Updates choice: Stable by default, Nightly sets the channel
// natively and checks again, what was found on the channel left is let go,
// and a nightly build back on Stable is told it waits for the next stable.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as platform from "../platform";
import { useUpdates } from "../updates/store";
import { Help } from "./Help";
import { useSettings } from "./store";

const version = vi.hoisted(() => ({ now: "0.2.10" }));

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => version.now) }));
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  inApp: true,
  helperStatus: vi.fn(async () => ({ state: "running" })),
  openUrl: vi.fn(),
  setUpdateChannel: vi.fn(async () => {}),
  updating: vi.fn(async () => ({ how: "itself", neverBecause: null, download: null, releases: null, sessionsKept: true })),
  updateCheck: vi.fn(async () => null),
  updateDownload: vi.fn(async () => {}),
  updateInstall: vi.fn(),
  resumeLater: vi.fn(),
  takeResume: vi.fn(async () => []),
  saveSettings: vi.fn(),
  loadSettings: vi.fn(),
}));

beforeEach(() => {
  version.now = "0.2.10";
  vi.mocked(platform.setUpdateChannel).mockClear();
  vi.mocked(platform.updateCheck).mockReset().mockResolvedValue(null);
  vi.mocked(platform.updateDownload).mockReset().mockResolvedValue(undefined);
  useSettings.setState({ updateChannel: "stable" });
  useUpdates.setState({ state: { phase: "idle" }, waiting: false, later: null, never: null });
});
afterEach(cleanup);

const choice = (name: string) => screen.getByRole("radio", { name });

it("is Stable by default, and Nightly sets the channel and checks again", async () => {
  render(<Help />);
  expect(screen.getByRole("radiogroup", { name: "Updates" })).toBeTruthy();
  expect(choice("Stable").getAttribute("aria-checked")).toBe("true");
  expect(choice("Nightly").getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("The releases everyone gets.")).toBeTruthy();

  vi.mocked(platform.updateCheck).mockResolvedValueOnce("0.2.11-nightly.20261120.42");
  await act(async () => {
    fireEvent.click(choice("Nightly"));
  });
  expect(platform.setUpdateChannel).toHaveBeenCalledWith("nightly");
  expect(useSettings.getState().updateChannel).toBe("nightly");
  expect(choice("Nightly").getAttribute("aria-checked")).toBe("true");
  expect(useUpdates.getState().state).toEqual({ phase: "ready", version: "0.2.11-nightly.20261120.42" });
  expect(screen.getByText(/each day’s changes/)).toBeTruthy();
});

it("lets go of a nightly found before switching back to Stable", async () => {
  useSettings.setState({ updateChannel: "nightly" });
  useUpdates.setState({ state: { phase: "ready", version: "0.2.11-nightly.20261120.42" }, waiting: true });
  render(<Help />);
  await act(async () => {
    fireEvent.click(choice("Stable"));
  });
  expect(platform.setUpdateChannel).toHaveBeenCalledWith("stable");
  expect(useUpdates.getState().state).toEqual({ phase: "idle" });
  expect(useUpdates.getState().waiting).toBe(false);
  expect(screen.getByText("Desk is up to date.")).toBeTruthy();
});

it("drops a download from the channel left once it ends, and looks again", async () => {
  let finish!: () => void;
  vi.mocked(platform.updateCheck).mockResolvedValueOnce("0.2.11-nightly.20261120.42").mockResolvedValue(null);
  vi.mocked(platform.updateDownload).mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
  useSettings.setState({ updateChannel: "nightly" });
  let checking!: Promise<void>;
  await act(async () => {
    checking = useUpdates.getState().check();
    await vi.waitFor(() => expect(useUpdates.getState().state.phase).toBe("downloading"));
  });
  await act(async () => {
    await useUpdates.getState().switchChannel("stable");
  });
  // Still downloading: it ends first.
  expect(useUpdates.getState().state.phase).toBe("downloading");
  await act(async () => {
    finish();
    await checking;
    await vi.waitFor(() => expect(platform.updateCheck).toHaveBeenCalledTimes(2));
  });
  expect(useUpdates.getState().state).toEqual({ phase: "idle" });
  expect(useUpdates.getState().waiting).toBe(false);
});

it("tells a nightly build back on Stable that it waits for the next stable", async () => {
  version.now = "0.2.11-nightly.20261120.42";
  render(<Help />);
  expect(await screen.findByText(/stays on this one until Stable reaches Desk 0\.2\.11 or newer/)).toBeTruthy();
});
