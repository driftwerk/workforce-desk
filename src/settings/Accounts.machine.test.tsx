// A machine's accounts, in the block every machine shows: its own (never
// this computer's), "Use this Mac's accounts" (copied by the native side,
// after its own question), switching to another account by hand, and
// auto-switch there.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountsOn, useAccounts } from "../engines/accounts";
import type { DeskHub } from "../hub/client";
import { announce, stampEvent, useDesk } from "../hub/store";
import type { EngineAccount, EngineInfo } from "../hub/types";
import { fakeNative, noEngines, withEngine } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { Accounts, sharedText } from "./Accounts";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  inApp: false,
  openUrl: vi.fn(),
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  subscribe: (p: Promise<() => void>) => () => void p.then((f) => f()),
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

const claude: EngineInfo = {
  engine: "claude",
  title: "Claude Code",
  program: "claude",
  installed: true,
  version: "2.1.318",
  signIn: { state: "out" },
  views: ["terminal"],
  caps: { terminal: { accounts: "token" } as never },
};

const account = (id: string, name: string, more: Partial<EngineAccount> = {}): EngineAccount => ({
  id,
  engine: "claude",
  name,
  isDefault: false,
  signedIn: true,
  sessions: [],
  createdAt: "2026-11-03T09:00:00Z",
  ...more,
});

const reset = { accounts: [], store: null, signIns: {}, supported: null, needs: [], problems: [], autoSwitch: false, leftInTerminals: [] };

beforeEach(() => {
  useHost.setState({ ...DEFAULT_HOST, platform: "macos" });
  useAccounts.setState(reset);
  accountsOn("devbox").setState(reset);
  noEngines();
});
afterEach(cleanup);

/** This Mac with Work (default) and Personal, and devbox as the test sets it. */
const setUp = (theirs: EngineAccount[], over: Partial<Record<keyof DeskHub, unknown>> = {}) => {
  const mine = [account("m-w", "Work", { isDefault: true }), account("m-p", "Personal")];
  const local = { accounts: vi.fn(async () => ({ accounts: mine, store: "the keychain", signIns: [], autoSwitch: true })) };
  useDesk.setState({ hub: local as unknown as DeskHub, fail: vi.fn() });
  const state = { accounts: theirs };
  const devbox = {
    accounts: vi.fn(async () => ({ accounts: state.accounts, store: "Desk's private file", signIns: [] })),
    switchAll: vi.fn(async () => ({ inTerminals: [] })),
    updateAccount: vi.fn(async () => ({})),
    removeAccount: vi.fn(async () => {}),
    setAutoSwitch: vi.fn(async () => {}),
    ...over,
  };
  withEngine("devbox", devbox as unknown as DeskHub);
  return { local, devbox, state };
};

it("offers this Mac's accounts devbox hasn't got, copies them through the native side, and says what happened", async () => {
  const { devbox, state } = setUp([]);
  const n = fakeNative();
  n.fake.shareAccounts.mockImplementation(async () => {
    state.accounts = [account("d-w", "Work", { isDefault: true }), account("d-p", "Personal")];
    return { cancelled: false, copied: ["Work", "Personal"], already: [], failed: [], autoSwitch: true };
  });
  const onShared = vi.fn();
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={n.native} canAdd={false} onShared={onShared} />);
  await act(async () => {});
  expect(screen.getByText("Signed in once each, kept in devbox’s private file store.")).toBeTruthy();
  expect(screen.getByText(/This Mac has the accounts Work and Personal/)).toBeTruthy();
  // A machine's accounts are added through its own sign-in, beside this block.
  expect(screen.queryByRole("button", { name: "Add account…" })).toBeNull();

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this Mac’s accounts…" })));
  expect(n.fake.shareAccounts).toHaveBeenCalledWith("devbox");
  expect(screen.getByText("Work and Personal are on devbox now, copied from this Mac.")).toBeTruthy();
  expect(screen.getByText("devbox moves its sessions to another account at a limit by itself, as this Mac does.")).toBeTruthy();
  // Read again from devbox: both there, Work its default.
  expect(devbox.accounts).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Default")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use this Mac’s accounts…" })).toBeNull();
  expect(onShared).toHaveBeenCalledTimes(1);
});

it("says nothing when the person says no, and says each account that wasn't copied and why", async () => {
  setUp([]);
  const n = fakeNative();
  n.fake.shareAccounts.mockResolvedValueOnce({ cancelled: true, copied: [], already: [], failed: [], autoSwitch: false });
  const onShared = vi.fn();
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={n.native} canAdd={false} onShared={onShared} />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this Mac’s accounts…" })));
  expect(screen.queryByRole("status")).toBeNull();
  expect(onShared).not.toHaveBeenCalled();

  n.fake.shareAccounts.mockResolvedValueOnce({
    cancelled: false,
    copied: ["Personal"],
    already: [],
    failed: [{ name: "Work", why: "Desk on this Mac didn't give its sign-in: its sign-in is no longer in the keychain" }],
    autoSwitch: false,
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this Mac’s accounts…" })));
  expect(screen.getByText("Personal is on devbox now, copied from this Mac.")).toBeTruthy();
  expect(screen.getByText(/Work wasn’t copied: .*no longer in the keychain/).className).toContain("state-blocked");
  expect(onShared).not.toHaveBeenCalled();

  n.fake.shareAccounts.mockRejectedValueOnce(new Error("Desk is already asking about copying accounts."));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this Mac’s accounts…" })));
  expect(screen.getByText("Desk is already asking about copying accounts.").className).toContain("state-blocked");
});

it("offers only what devbox hasn't got, by name", async () => {
  setUp([account("d-w", "work", { isDefault: true })]);
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={fakeNative().native} canAdd={false} />);
  await act(async () => {});
  expect(screen.getByText(/This Mac has the account Personal\./)).toBeTruthy();
});

it("switches devbox's sessions to another of its accounts by hand, which becomes the default", async () => {
  const { devbox } = setUp([account("d-w", "Work", { isDefault: true, sessions: ["s1", "s2"] }), account("d-p", "Personal")]);
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={fakeNative().native} canAdd={false} />);
  await act(async () => {});
  // Work runs them: only Personal offers a switch.
  expect(screen.queryByRole("button", { name: "Switch to Work" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch to Personal" })));
  expect(devbox.switchAll).toHaveBeenCalledWith("d-w", "d-p");
  expect(devbox.updateAccount).toHaveBeenCalledWith("d-p", { isDefault: true });
});

it("turns auto-switch on devbox, not on this Mac, and removes an account from devbox alone", async () => {
  const { devbox, local } = setUp([account("d-w", "Work", { isDefault: true }), account("d-p", "Personal")]);
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={fakeNative().native} canAdd={false} />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Switch automatically/ })));
  expect(devbox.setAutoSwitch).toHaveBeenCalledWith(true);
  expect(accountsOn("devbox").getState().autoSwitch).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "Remove…" })[1]!);
  expect(screen.getByText(/Desk forgets its sign-in there; this computer’s own copy stays/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove account" })));
  expect(devbox.removeAccount).toHaveBeenCalledWith("d-p");
  expect(Object.keys(local)).toEqual(["accounts"]);
});

it("keeps each engine's accounts apart: devbox's events never reach this Mac's, nor this Mac's devbox's", () => {
  useAccounts.setState({ accounts: [account("m-w", "Work")] });
  announce(stampEvent({ type: "accounts", accounts: [account("d-x", "Spare")], autoSwitch: true } as never, "devbox"));
  expect(useAccounts.getState().accounts.map((a) => a.name)).toEqual(["Work"]);
  expect(useAccounts.getState().autoSwitch).toBe(false);
  expect(accountsOn("devbox").getState().accounts.map((a) => a.name)).toEqual(["Spare"]);
  expect(accountsOn("devbox").getState().autoSwitch).toBe(true);
  announce({ type: "accounts", accounts: [account("m-p", "Personal")] } as never);
  expect(accountsOn("devbox").getState().accounts.map((a) => a.name)).toEqual(["Spare"]);
  expect(useAccounts.getState().accounts.map((a) => a.name)).toEqual(["Personal"]);
});

it("words what copying did", () => {
  expect(sharedText({ cancelled: false, copied: ["Work"], already: ["Personal"], failed: [], autoSwitch: false }, "devbox", "this Mac")).toEqual([
    "Work is on devbox now, copied from this Mac.",
    "Personal was on devbox already.",
  ]);
  expect(sharedText({ cancelled: false, copied: ["Work", "Personal"], already: [], failed: [], autoSwitch: true, madeDefault: "Work" }, "devbox", "this Mac")).toEqual([
    "Work and Personal are on devbox now, copied from this Mac.",
    "New sessions on devbox start on Work: Claude Code isn’t signed in there by itself.",
    "devbox moves its sessions to another account at a limit by itself, as this Mac does.",
  ]);
});

it("offers to make its first account the default on a machine an earlier copy left without one", async () => {
  // Both copied already, neither the default, and Claude Code logged out there.
  let there: { accounts: EngineAccount[] } | null = null;
  const updateAccount = vi.fn(async () => {
    there!.accounts = [account("d-p", "Personal"), account("d-w", "Work", { isDefault: true, createdAt: "2026-11-02T09:00:00Z" })];
    return {};
  });
  // Work copied first.
  const { devbox, state } = setUp([account("d-p", "Personal"), account("d-w", "Work", { createdAt: "2026-11-02T09:00:00Z" })], { updateAccount });
  there = state;
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={fakeNative().native} canAdd={false} />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Use this Mac’s accounts…" })).toBeNull();
  expect(screen.getByText(/Claude Code isn’t signed in on devbox, and none of its accounts is the default\./)).toBeTruthy();
  expect(screen.getByText("New sessions there start on Work until one is.")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make Work the default" })));
  expect(updateAccount).toHaveBeenCalledWith("d-w", { isDefault: true });
  expect(devbox.accounts).toHaveBeenCalled();
  expect(screen.getByText("New sessions on devbox start on Work.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Make Work the default" })).toBeNull();
});

it("names the account the machine's hub starts sessions on, its oldest, and counts only a default that signs in", async () => {
  // devbox has Personal first; this Mac's default, Work, came later.
  setUp([account("d-w", "Work", { createdAt: "2026-11-05T09:00:00Z" }), account("d-p", "Personal", { createdAt: "2026-11-04T09:00:00Z" })]);
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={fakeNative().native} canAdd={false} />);
  await act(async () => {});
  expect(screen.getByText("New sessions there start on Personal until one is.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Make Personal the default" })).toBeTruthy();
  cleanup();

  setUp([account("d-w", "Work", { isDefault: true, signedIn: false }), account("d-p", "Personal")]);
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={fakeNative().native} canAdd={false} />);
  await act(async () => {});
  expect(screen.getByText(/its default, Work, can’t sign in\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Make Personal the default" })).toBeTruthy();
});

it("offers no default where Claude Code is signed in by itself", async () => {
  setUp([account("d-p", "Personal"), account("d-w", "Work")]);
  render(<Accounts engine={{ ...claude, signIn: { state: "in", via: "plan", who: null, plan: null } }} machine="devbox" name="devbox" native={fakeNative().native} canAdd={false} />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /the default$/ })).toBeNull();
});
