// "Use this Mac's accounts" end to end on a machine's sign-in card: one
// action copies this Mac's Claude accounts (through the native side) and,
// when this Mac's Codex is signed in, starts ChatGPT's own sign-in there,
// since ChatGPT's sign-in can't be shared by two computers.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountsOn, useAccounts } from "../engines/accounts";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { EngineAccount } from "../hub/types";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { EngineBlocks } from "../settings/EngineBlocks";
import { fakeNative, noEngines, withEngine } from "./testing";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: false,
  openUrl: vi.fn(),
}));

const account = (id: string, name: string, isDefault = false): EngineAccount => ({ id, engine: "claude", name, isDefault, signedIn: true, sessions: [], createdAt: "" });
const engines = (codex: "in" | "out") => [
  { engine: "claude", title: "Claude Code", installed: true, views: ["terminal"], caps: { terminal: { accounts: "token" } }, signIn: { state: "out" } },
  { engine: "codex", title: "Codex", installed: true, views: ["terminal"], caps: { terminal: { accounts: "none" } }, signIn: { state: codex } },
];
const reset = { accounts: [], store: null, signIns: {}, supported: null, needs: [], problems: [], autoSwitch: false, leftInTerminals: [] };

beforeEach(() => {
  useHost.setState({ ...DEFAULT_HOST, platform: "macos" });
  useAccounts.setState(reset);
  accountsOn("devbox").setState(reset);
  noEngines();
});
afterEach(cleanup);

const run = async (macCodex: "in" | "out") => {
  const local = {
    accounts: vi.fn(async () => ({ accounts: [account("m-w", "Work", true), account("m-p", "Personal")], store: "the keychain", signIns: [], autoSwitch: true })),
    engines: vi.fn(async () => engines(macCodex)),
  };
  useDesk.setState({ hub: local as unknown as DeskHub, fail: vi.fn() });
  const state = { accounts: [] as EngineAccount[] };
  const codexStarted = vi.fn();
  const devbox = {
    accounts: vi.fn(async () => ({ accounts: state.accounts, store: "Desk's private file", signIns: [] })),
    engines: vi.fn(async () => engines("out")),
    startEngineSignIn: vi.fn(async () => {
      codexStarted();
      return { id: "cx-1", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "K7QF-2M9D" };
    }),
  };
  withEngine("devbox", devbox as unknown as DeskHub);
  const n = fakeNative();
  n.fake.shareAccounts.mockImplementation(async () => {
    state.accounts = [account("d-w", "Work", true), account("d-p", "Personal")];
    return { cancelled: false, copied: ["Work", "Personal"], already: [], failed: [], autoSwitch: true };
  });
  render(<EngineBlocks machine="devbox" name="devbox" native={n.native} />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this Mac’s accounts…" })));
  await act(async () => {});
  return { n, codexStarted };
};

it("copies this Mac's Claude accounts and starts ChatGPT's own sign-in on devbox in the same action", async () => {
  const { n, codexStarted } = await run("in");
  expect(n.fake.shareAccounts).toHaveBeenCalledWith("devbox");
  expect(screen.getByText("Work and Personal are on devbox now, copied from this Mac.")).toBeTruthy();
  expect(codexStarted).toHaveBeenCalledTimes(1);
  expect(n.fake.openSignInPage).toHaveBeenCalledWith("codex", "https://auth.openai.com/codex/device");
  expect(screen.getByText("K7QF-2M9D")).toBeTruthy();
});

it("leaves ChatGPT alone when this Mac's Codex isn't signed in either", async () => {
  const { codexStarted } = await run("out");
  expect(codexStarted).not.toHaveBeenCalled();
  expect(screen.getByRole("listitem", { name: "Codex" }).textContent).toContain("Sign in…");
});
