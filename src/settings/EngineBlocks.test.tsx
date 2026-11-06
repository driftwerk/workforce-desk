// Signing in, the same on this computer and on every machine: one block
// (EngineBlocks, with Accounts and Codex's device sign-in), every wait with
// its limit, and every failure saying why with Try again. Rendered under
// StrictMode, as the app is in development: a sign-in once sat on "Opening
// Claude's sign-in page…" there for good.

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountsOn, useAccounts } from "../engines/accounts";
import { APPROVE_WITHIN_MS, CODE_WITHIN_MS, OPEN_WITHIN_MS, SIGN_IN_POLL_MS } from "../engines/signIn";
import { CONNECT_WITHIN_MS, ENGINES_WITHIN_MS } from "./EngineBlocks";
import type { DeskHub } from "../hub/client";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { AccountSignIn, AccountsInfo, EngineAccount, EngineSignIn } from "../hub/types";
import { fakeNative, noEngines, withEngine } from "../machines/testing";
import { openUrl } from "../platform";
import { useMachines } from "../hub/engines";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { EngineBlocks } from "./EngineBlocks";
import { Engines } from "./Engines";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: false,
  openUrl: vi.fn(),
}));

const reset = { accounts: [], store: null, signIns: {}, supported: null, needs: [], problems: [], autoSwitch: false, leftInTerminals: [] };

beforeEach(() => {
  useHost.setState({ ...DEFAULT_HOST, platform: "macos" });
  useAccounts.setState(reset);
  accountsOn("devbox").setState(reset);
  useMachines.setState({ machines: [], listed: true });
  noEngines();
  vi.mocked(openUrl).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MANUAL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";

const engineInfo = (codex: "in" | "out" = "out") => [
  { engine: "claude", title: "Claude Code", installed: true, version: "2.1.318", views: ["terminal"], caps: { terminal: { accounts: "token", notes: [] } }, signIn: { state: "out" } },
  { engine: "codex", title: "Codex", installed: true, version: "0.166.0", views: ["terminal"], caps: { terminal: { accounts: "none", notes: [] } }, signIn: { state: codex } },
];

/** An engine's hub as sign-ins see it: its accounts and sign-ins as the
 *  test sets them, read again on each poll. */
function fakeHub(over: Record<string, unknown> = {}) {
  const state: { accounts: AccountsInfo; codex: EngineSignIn | null } = { accounts: { accounts: [], store: "Desk's private file", signIns: [] }, codex: null };
  const hub = {
    accounts: vi.fn(async () => state.accounts),
    engines: vi.fn(async () => engineInfo()),
    addAccount: vi.fn(async (): Promise<unknown> => ({ kind: "signIn", signIn: { id: "si-1", engine: "claude", name: "Claude", state: "starting" } })),
    signInCode: vi.fn(async (): Promise<AccountSignIn> => state.accounts.signIns[0]!),
    cancelSignIn: vi.fn(async (id: string) => {
      state.accounts = { ...state.accounts, signIns: state.accounts.signIns.filter((x) => x.id !== id) };
    }),
    startEngineSignIn: vi.fn(async (): Promise<EngineSignIn> => ({ id: "cx-1", engine: "codex", state: "starting" })),
    engineSignIn: vi.fn(async (): Promise<EngineSignIn> => state.codex ?? { id: "cx-1", engine: "codex", state: "starting" }),
    cancelEngineSignIn: vi.fn(async () => {}),
    ...over,
  };
  const run = (s: Partial<AccountSignIn>) => {
    state.accounts = { ...state.accounts, signIns: [{ id: "si-1", engine: "claude", name: "Claude", state: "starting", ...s } as AccountSignIn] };
  };
  const signedIn = (name = "Claude") => {
    const a: EngineAccount = { id: "a-1", engine: "claude", name, isDefault: true, signedIn: true, sessions: [], createdAt: "" };
    state.accounts = { ...state.accounts, accounts: [a], signIns: [{ id: "si-1", engine: "claude", name, state: "done", account: "a-1" }] };
  };
  return { hub, state, run, signedIn };
}

const tick = (ms = SIGN_IN_POLL_MS) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

const onDevbox = async (e = fakeHub(), n = fakeNative()) => {
  withEngine("devbox", e.hub as unknown as DeskHub);
  render(
    <StrictMode>
      <EngineBlocks machine="devbox" name="devbox" native={n.native} />
    </StrictMode>,
  );
  await act(async () => {});
  return { e, n };
};

const claudeBlock = () => screen.getByRole("listitem", { name: "Claude Code" });

it("signs Claude in on a machine at once, under StrictMode: its page opens here, comes back there, and nothing is pasted", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { e, n } = await onDevbox();
  expect(within(claudeBlock()).getByText("Not signed in")).toBeTruthy();
  expect(screen.getByText("Signed in once each, kept in devbox’s private file store.")).toBeTruthy();
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  expect(e.hub.addAccount).toHaveBeenCalledWith({ engine: "claude", name: "Claude", makeDefault: true, remote: true });
  expect(screen.getByText("Signing in to Claude")).toBeTruthy();
  expect(screen.getByText("Opening Claude’s sign-in page…")).toBeTruthy();
  expect(screen.getByText("If the page hasn’t opened in 30 s, Desk stops and says why.")).toBeTruthy();

  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(n.fake.signInForward).toHaveBeenCalledWith("devbox", "si-1");
  expect(screen.getByText("Finish signing in in your browser.")).toBeTruthy();
  expect(screen.getByText("Desk carries on by itself once you approve. It waits up to 10 minutes, then stops the sign-in.")).toBeTruthy();
  expect(screen.queryByPlaceholderText("Code from the page")).toBeNull();
  // The page is the native side's: the page itself opens nothing.
  expect(openUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open the sign-in page again" }));
  expect(n.fake.signInForward).toHaveBeenCalledTimes(2);

  e.signedIn();
  await tick();
  expect(e.hub.signInCode).not.toHaveBeenCalled();
  expect(n.fake.signInForwardStop).toHaveBeenCalledWith("devbox", "si-1");
  expect(screen.getByText("Claude is added.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText("Signing in to Claude")).toBeNull();
});

it("stops a sign-in whose page never opened within 30 s, says why, and tries again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { e } = await onDevbox();
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  // Begun there, but Claude Code there never makes its page.
  e.run({ state: "starting" });
  await tick(OPEN_WITHIN_MS - 1000);
  expect(screen.getByText("Opening Claude’s sign-in page…")).toBeTruthy();
  await tick(1000);
  expect(screen.getByRole("alert").textContent).toBe("Claude’s sign-in page didn’t open within 30 s: Claude Code on devbox didn’t answer.");
  expect(e.hub.cancelSignIn).toHaveBeenCalledWith("si-1");
  expect(screen.getByRole("button", { name: "Paste a token instead" })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(e.hub.addAccount).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Opening Claude’s sign-in page…")).toBeTruthy();
});

it("stops a sign-in nobody approved within 10 minutes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { e } = await onDevbox();
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(screen.getByText("Finish signing in in your browser.")).toBeTruthy();
  await tick(APPROVE_WITHIN_MS);
  expect(screen.getByRole("alert").textContent).toBe("Nobody approved the sign-in within 10 minutes, so Desk stopped it.");
  expect(e.hub.cancelSignIn).toHaveBeenCalledWith("si-1");
  // Paste a token instead: the form, with the token field.
  fireEvent.click(screen.getByRole("button", { name: "Paste a token instead" }));
  expect(screen.getByRole("radio", { name: "Paste a token" }).getAttribute("aria-checked")).toBe("true");
});

it("uses a code instead when asked, says a refused code in Claude's words, and keeps the field", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeHub();
  e.hub.signInCode.mockRejectedValueOnce(new HubError(400, "Claude says it has expired."));
  const { n } = await onDevbox(e);
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Use a code instead" }));
  expect(n.fake.openSignInPage).toHaveBeenCalledWith("claude", MANUAL);
  expect(screen.getByText("If the page shows a code, paste it here.")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("Code from the page"), { target: { value: " c0de " } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
  expect(e.hub.signInCode).toHaveBeenCalledWith("si-1", "c0de");
  expect(screen.getByText(/That code didn’t work: .*expired.*Open the page again for a new one\./)).toBeTruthy();
  expect(screen.getByPlaceholderText("Code from the page")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open the sign-in page again" }));
  expect(n.fake.openSignInPage).toHaveBeenCalledTimes(2);
});

it("falls back to the page with a code when the forward can't start, saying why", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const n = fakeNative();
  n.fake.signInForward.mockRejectedValueOnce(new Error("Another program on this computer is using port 45678, which the sign-in page comes back to."));
  const { e } = await onDevbox(fakeHub(), n);
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(screen.getByText(/using port 45678/)).toBeTruthy();
  expect(screen.getByPlaceholderText("Code from the page")).toBeTruthy();
  expect(n.fake.openSignInPage).toHaveBeenCalledWith("claude", MANUAL);
});

it("cancels a sign-in on its hub and ends its forward", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { e, n } = await onDevbox();
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(e.hub.cancelSignIn).toHaveBeenCalledWith("si-1");
  expect(n.fake.signInForwardStop).toHaveBeenCalledWith("devbox", "si-1");
  expect(screen.queryByText("Signing in to Claude")).toBeNull();
});

it("signs a named account in on this Mac the same way: its own CLI opens the page, and its code page opens here", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeHub();
  e.state.accounts = { ...e.state.accounts, store: "the keychain" };
  e.hub.addAccount.mockResolvedValueOnce({ kind: "signIn", signIn: { id: "si-1", engine: "claude", name: "Work", state: "starting" } });
  useDesk.setState({ hub: e.hub as unknown as DeskHub, fail: vi.fn() });
  const n = fakeNative();
  render(<EngineBlocks native={n.native} />);
  await act(async () => {});
  // This Mac's sessions run on its own sign-in until an account is added.
  expect(within(claudeBlock()).queryByRole("button", { name: "Sign in…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add account…" }));
  fireEvent.change(screen.getByPlaceholderText("Work"), { target: { value: "Work" } });
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  expect(e.hub.addAccount).toHaveBeenCalledWith({ engine: "claude", name: "Work", makeDefault: true });
  e.run({ name: "Work", state: "code", url: MANUAL });
  await tick();
  expect(screen.getByText("Finish signing in in your browser.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open the sign-in page again" }));
  expect(openUrl).toHaveBeenCalledWith(MANUAL);
  expect(n.fake.signInForward).not.toHaveBeenCalled();
});

it("signs ChatGPT in by Codex's device page on a machine, with the code to copy", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { e, n } = await onDevbox();
  const codex = screen.getByRole("listitem", { name: "Codex" });
  await act(async () => fireEvent.click(within(codex).getByRole("button", { name: "Sign in…" })));
  expect(e.hub.startEngineSignIn).toHaveBeenCalledWith("codex");
  expect(screen.getByText("Opening ChatGPT’s sign-in page…")).toBeTruthy();
  e.state.codex = { id: "cx-1", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "K7QF-2M9D" };
  await tick();
  expect(n.fake.openSignInPage).toHaveBeenCalledWith("codex", "https://auth.openai.com/codex/device");
  expect(screen.getByText("K7QF-2M9D")).toBeTruthy();
  expect(screen.getByText("The code works for 15 minutes. Desk carries on by itself once you’ve typed it, then stops the sign-in when it runs out.")).toBeTruthy();
  e.state.codex = { id: "cx-1", engine: "codex", state: "done" };
  e.hub.engines.mockResolvedValue(engineInfo("in"));
  await tick();
  expect(screen.getByText("ChatGPT is signed in.")).toBeTruthy();
});

it("leaves this Mac's Codex as it was: no sign-in of Desk's for it", async () => {
  const e = fakeHub();
  useDesk.setState({ hub: e.hub as unknown as DeskHub, fail: vi.fn() });
  render(<EngineBlocks native={fakeNative().native} />);
  await act(async () => {});
  const codex = screen.getByRole("listitem", { name: "Codex" });
  expect(within(codex).getByText("Not signed in")).toBeTruthy();
  expect(within(codex).queryByRole("button", { name: "Sign in…" })).toBeNull();
  expect(e.hub.startEngineSignIn).not.toHaveBeenCalled();
});

it("stops a Codex sign-in cancelled before its id was known, and never opens its page", async () => {
  let started: (s: EngineSignIn) => void = () => {};
  const e = fakeHub({ startEngineSignIn: vi.fn(() => new Promise<EngineSignIn>((r) => (started = r))) });
  const { n } = await onDevbox(e);
  const codex = () => screen.getByRole("listitem", { name: "Codex" });
  await act(async () => fireEvent.click(within(codex()).getByRole("button", { name: "Sign in…" })));
  await act(async () => fireEvent.click(within(codex()).getByRole("button", { name: "Cancel" })));
  await act(async () => started({ id: "cx-9", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "AAAA-BBBB" }));
  expect(e.hub.cancelEngineSignIn).toHaveBeenCalledWith("cx-9");
  expect(n.fake.openSignInPage).not.toHaveBeenCalled();
  expect(screen.queryByText("AAAA-BBBB")).toBeNull();
});

it("stops Codex's sign-in on its hub when its page won't open here", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const n = fakeNative();
  n.fake.openSignInPage.mockRejectedValue(new Error("That isn't ChatGPT's sign-in page."));
  const { e } = await onDevbox(fakeHub(), n);
  e.state.codex = { id: "cx-1", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "K7QF-2M9D" };
  await act(async () => fireEvent.click(within(screen.getByRole("listitem", { name: "Codex" })).getByRole("button", { name: "Sign in…" })));
  await tick();
  expect(e.hub.cancelEngineSignIn).toHaveBeenCalledWith("cx-1");
  expect(screen.getByRole("alert").textContent).toBe("That isn't ChatGPT's sign-in page.");
});

it("stops Codex's sign-in when its page doesn't open in 30 s, or its code runs out after 15 minutes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { e } = await onDevbox();
  const codex = () => screen.getByRole("listitem", { name: "Codex" });
  await act(async () => fireEvent.click(within(codex()).getByRole("button", { name: "Sign in…" })));
  await tick(OPEN_WITHIN_MS - 1000);
  expect(screen.getByText("Opening ChatGPT’s sign-in page…")).toBeTruthy();
  await tick(1000);
  expect(within(codex()).getByRole("alert").textContent).toBe("ChatGPT’s sign-in page didn’t open within 30 s: Codex on devbox didn’t answer.");
  expect(e.hub.cancelEngineSignIn).toHaveBeenCalledWith("cx-1");

  e.state.codex = { id: "cx-1", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "K7QF-2M9D" };
  await act(async () => fireEvent.click(within(codex()).getByRole("button", { name: "Try again" })));
  await tick();
  expect(screen.getByText("K7QF-2M9D")).toBeTruthy();
  await tick(CODE_WITHIN_MS);
  expect(within(codex()).getByRole("alert").textContent).toBe("The code ran out after 15 minutes, so Desk stopped the sign-in.");
  expect(e.hub.cancelEngineSignIn).toHaveBeenCalledTimes(2);
});

it("says how to sign ChatGPT in in a terminal on a machine whose Desk can't do it itself", async () => {
  const e = fakeHub({ startEngineSignIn: vi.fn(async () => Promise.reject(new HubError(404, "not found"))) });
  await onDevbox(e);
  await act(async () => fireEvent.click(within(screen.getByRole("listitem", { name: "Codex" })).getByRole("button", { name: "Sign in…" })));
  expect(screen.getByText("codex login --device-auth")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open a terminal" })).toBeTruthy();
});

it("Settings → Engines shows any computer's engines, chosen by On; one that can't be driven now can't be chosen", async () => {
  const local = fakeHub();
  local.hub.engines.mockResolvedValue([{ ...engineInfo()[0]!, version: "2.1.400" }, engineInfo()[1]!] as never);
  useDesk.setState({ hub: local.hub as unknown as DeskHub, fail: vi.fn() });
  const devbox = fakeHub();
  withEngine("devbox", devbox.hub as unknown as DeskHub);
  useMachines.setState({
    machines: [
      { id: "devbox", name: "devbox", target: "devbox", version: "0.2.1", state: { kind: "ready" } },
      { id: "buildbox", name: "buildbox", target: "buildbox", version: "0.2.1", state: { kind: "unreachable" } },
    ],
    listed: true,
  });
  render(<Engines native={fakeNative().native} />);
  await act(async () => {});
  const on = screen.getByRole("radiogroup", { name: "On" });
  expect(within(on).getAllByRole("radio").map((b) => b.textContent)).toEqual(["This Mac", "devbox", "buildbox · offline"]);
  expect(screen.getByText("Version 2.1.400")).toBeTruthy();
  await act(async () => fireEvent.click(within(on).getByRole("radio", { name: "devbox" })));
  expect(screen.getByText("Version 2.1.318")).toBeTruthy();
  expect(screen.getByRole("list", { name: "Engines on devbox" })).toBeTruthy();
  fireEvent.click(within(on).getByRole("radio", { name: "buildbox · offline" }));
  expect(screen.getByRole("list", { name: "Engines on devbox" })).toBeTruthy();
});

it("stops a Claude sign-in cancelled before its id was known, and opens nothing of it", async () => {
  let added: (v: unknown) => void = () => {};
  const e = fakeHub({ addAccount: vi.fn(() => new Promise((r) => (added = r))) });
  const { n } = await onDevbox(e);
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Cancel" })));
  await act(async () => added({ kind: "signIn", signIn: { id: "si-7", engine: "claude", name: "Claude", state: "code", url: MANUAL, directReady: true } }));
  expect(e.hub.cancelSignIn).toHaveBeenCalledWith("si-7");
  expect(n.fake.signInForward).not.toHaveBeenCalled();
  expect(screen.queryByText("Signing in to Claude")).toBeNull();
});

it("tries a failed sign-in again with the same choice of default", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { e } = await onDevbox();
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  await tick(OPEN_WITHIN_MS);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(e.hub.addAccount).toHaveBeenLastCalledWith({ engine: "claude", name: "Claude", makeDefault: true, remote: true });
});

it('picks up a sign-in under way under its name rather than starting "Claude 2"', async () => {
  const e = fakeHub();
  e.run({ state: "starting" });
  accountsOn("devbox").setState({ signIns: { "si-1": e.state.accounts.signIns[0]! } });
  await onDevbox(e);
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  expect(e.hub.addAccount).not.toHaveBeenCalled();
  expect(screen.getByText("Signing in to Claude")).toBeTruthy();
});

it("gives up reading the engines after 15 s, says so, and tries again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeHub({ engines: vi.fn(() => new Promise(() => {})) });
  await onDevbox(e);
  expect(screen.getByText("Reading… Desk gives up after 15 s and says why.")).toBeTruthy();
  await tick(ENGINES_WITHIN_MS);
  expect(screen.getByText(/Couldn’t ask devbox about its engines just now: devbox didn’t answer within 15 s\./)).toBeTruthy();
  e.hub.engines.mockResolvedValue(engineInfo());
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(screen.getByRole("list", { name: "Engines on devbox" })).toBeTruthy();
});

it("says a machine that hasn't connected in a minute, and connects it again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const n = fakeNative();
  render(<EngineBlocks machine="devbox" name="devbox" native={n.native} />);
  expect(screen.getByText(/Waiting for devbox to connect…/)).toBeTruthy();
  await tick(CONNECT_WITHIN_MS);
  expect(screen.getByText(/devbox hasn’t connected in a minute\./)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(n.fake.reconnect).toHaveBeenCalledWith("devbox");
});

it("keeps a sign-in under way, and the machine chosen, through a brief reconnect", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeHub();
  withEngine("devbox", e.hub as unknown as DeskHub);
  useDesk.setState({ hub: fakeHub().hub as unknown as DeskHub, fail: vi.fn() });
  const ready = { id: "devbox", name: "devbox", target: "devbox", version: "0.2.1", state: { kind: "ready" } } as const;
  useMachines.setState({ machines: [ready], listed: true });
  const n = fakeNative();
  render(
    <StrictMode>
      <Engines native={n.native} on="devbox" />
    </StrictMode>,
  );
  await act(async () => {});
  await act(async () => fireEvent.click(within(claudeBlock()).getByRole("button", { name: "Sign in…" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(screen.getByText("Finish signing in in your browser.")).toBeTruthy();
  // devbox drops for a moment: its hub goes, and comes back as a new one.
  await act(async () => {
    useMachines.setState({ machines: [{ ...ready, state: { kind: "unreachable" } }] as never });
    noEngines();
  });
  expect(screen.getByRole("list", { name: "Engines on devbox" })).toBeTruthy();
  expect(screen.getByText(/devbox is offline right now/)).toBeTruthy();
  expect(screen.getByText("Finish signing in in your browser.")).toBeTruthy();
  expect(n.fake.signInForwardStop).not.toHaveBeenCalled();
  expect(screen.queryByText(/^Reading/)).toBeNull();
  await act(async () => {
    useMachines.setState({ machines: [ready] });
    withEngine("devbox", e.hub as unknown as DeskHub);
  });
  e.signedIn();
  await tick();
  expect(screen.getByText("Claude is added.")).toBeTruthy();
});
