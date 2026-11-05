import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { DeskTransport } from "../hub/transport";
import type { AccountSignIn, AccountsInfo } from "../hub/types";
import { openUrl } from "../platform";
import { useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import { useHost, DEFAULT_HOST } from "../shell/host";
import { AddMachine } from "./AddMachine";
import { SIGN_IN_POLL_MS } from "./SignIn";
import { fakeNative, noEngines, probeOf, withEngine } from "./testing";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null), inApp: false, openUrl: vi.fn() }));

const settle = () => act(async () => {});

beforeEach(() => {
  useHost.setState(DEFAULT_HOST);
  noEngines();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // A machine's page is never opened by the page itself: only through the
  // native side, which checks it.
  expect(openUrl).not.toHaveBeenCalled();
  vi.mocked(openUrl).mockClear();
});

/** The native side of the last card: the pages it was asked to open. */
let last: ReturnType<typeof fakeNative> | null = null;
const pages = () => last!.fake.openSignInPage.mock.calls;

const typeAndGo = async (target: string) => {
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: target } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await settle();
};

it("trusts a new machine by its fingerprint, sets it up step by step, and signs it in with this computer's account", async () => {
  const { native, fake, emit } = fakeNative();
  fake.probe
    .mockResolvedValueOnce(probeOf({ hostKey: { kind: "new", fingerprint: "SHA256:k3Vq9fXc", keyType: "ED25519" }, access: null }))
    .mockResolvedValueOnce(probeOf());
  const onClose = vi.fn();
  render(<AddMachine native={native} onClose={onClose} />);
  await typeAndGo("devbox");

  expect(fake.probe).toHaveBeenCalledWith("devbox");
  const box = screen.getByRole("group", { name: "New machine" });
  expect(box.textContent).toContain("Desk hasn’t connected to devbox before");
  expect(box.textContent).toContain("SHA256:k3Vq9fXc (ED25519)");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Trust this machine" })));
  await settle();
  expect(fake.trust).toHaveBeenCalledWith("devbox", "SHA256:k3Vq9fXc");
  expect(fake.probe).toHaveBeenCalledTimes(2);
  expect(fake.add).toHaveBeenCalledWith("devbox", "devbox");

  const list = screen.getByRole("group", { name: "Setting it up" });
  expect(list.textContent).toContain("Connected as dev · Ubuntu 24.04 · x86_64");
  expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);

  act(() => emit({ machine: "devbox", step: "install", state: "done", detail: "Desk 0.2.0 installed, and set to start when it boots" }));
  act(() => emit({ machine: "devbox", step: "engines", state: "running" }));
  expect(list.textContent).toContain("Desk 0.2.0 installed, and set to start when it boots");
  expect(list.textContent).toContain("Installing Claude Code and Codex…");
  expect(screen.queryByRole("group", { name: "Sign in on devbox" })).toBeNull();

  withEngine("devbox", fakeEngine().hub as unknown as DeskHub);
  act(() => emit({ machine: "devbox", step: "engines", state: "done" }));
  expect(list.textContent).toContain("Claude Code and Codex installed");
  expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(false);

  const signIn = screen.getByRole("group", { name: "Sign in on devbox" });
  expect(signIn.textContent).toContain("Optional, for Codex");
  expect(screen.getByRole("button", { name: "Sign in to Claude" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in to ChatGPT" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalled();
});

/** A machine's engine as a sign-in sees it: its accounts and sign-ins as
 *  the test sets them, read again on each poll. */
function fakeEngine(over: Record<string, unknown> = {}) {
  const state: { accounts: AccountsInfo } = { accounts: { accounts: [], store: "Desk's private file", signIns: [] } };
  const hub = {
    accounts: vi.fn(async () => state.accounts),
    engines: vi.fn(async () => [
      { engine: "claude", title: "Claude Code", installed: true, signIn: { state: "out" } },
      { engine: "codex", title: "Codex", installed: true, signIn: { state: "out" } },
    ]),
    addAccount: vi.fn(async (): Promise<unknown> => ({ kind: "signIn", signIn: { id: "si-1", engine: "claude", name: "Claude", state: "starting" } })),
    signInCode: vi.fn(async () => state.accounts.signIns[0]),
    cancelSignIn: vi.fn(async () => {}),
    ...over,
  };
  // Codex's sign-in: routes of the machine's hub alone, through its transport.
  const codex = {
    start: vi.fn(async (): Promise<Response> => Response.json({ id: "cx-1", engine: "codex", state: "starting" }, { status: 202 })),
    read: vi.fn(async (): Promise<unknown> => ({ id: "cx-1", engine: "codex", state: "starting" })),
  };
  const transport: DeskTransport = {
    fetch: async (method, path) => {
      if (method === "POST" && path === "/api/desk/engines/sign-ins") return codex.start();
      if (method === "GET" && path === "/api/desk/engines/sign-ins/cx-1") return Response.json(await codex.read());
      return new Response(null, { status: 404 });
    },
    socket: () => {
      throw new Error("no sockets here");
    },
  };
  const run = (signIn: Partial<AccountSignIn>) => {
    state.accounts = { ...state.accounts, signIns: [{ id: "si-1", engine: "claude", name: "Claude", state: "starting", ...signIn } as AccountSignIn] };
  };
  const signedIn = () => {
    state.accounts = {
      ...state.accounts,
      accounts: [{ id: "a-1", engine: "claude", name: "Claude", isDefault: true, signedIn: true, sessions: [], createdAt: "" }],
      signIns: [{ id: "si-1", engine: "claude", name: "Claude", state: "done", account: "a-1" }],
    };
  };
  return { hub, state, run, signedIn, codex, transport };
}

const MANUAL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)));

/** The Add card at its sign-in, with `hub` as devbox's engine. */
const atSignIn = async (hub: unknown, native = fakeNative(), transport?: DeskTransport) => {
  last = native;
  withEngine("devbox", hub as DeskHub);
  if (transport) native.fake.transport.mockReturnValue(transport);
  const onClose = vi.fn();
  render(<AddMachine native={native.native} onClose={onClose} />);
  await typeAndGo("devbox");
  act(() => native.emit({ machine: "devbox", step: "install", state: "done" }));
  act(() => native.emit({ machine: "devbox", step: "engines", state: "done" }));
  await settle();
  return { ...native, onClose };
};

it("signs Claude in on the machine as on this computer: its page opens here and comes back there through a forward", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  const n = await atSignIn(e.hub);
  const signIn = screen.getByRole("group", { name: "Sign in on devbox" });
  expect(within(signIn).getByRole("group", { name: "Claude" }).textContent).toContain("Not signed in");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  expect(e.hub.addAccount).toHaveBeenCalledWith({ engine: "claude", name: "Claude", makeDefault: true, remote: true });
  expect(screen.getByText("Opening Claude’s sign-in page…")).toBeTruthy();

  // The machine's CLI made its page: the forward starts, and that page opens here.
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(n.fake.signInForward).toHaveBeenCalledWith("devbox", "si-1");
  // The native side opens the page that comes back by itself; no page with a code.
  expect(pages()).toEqual([]);
  expect(screen.getByText(/Desk carries on by itself once you approve/)).toBeTruthy();
  expect(screen.queryByPlaceholderText("Code from the page")).toBeNull();
  // A click beside the card or Esc, back from the browser, doesn't end it.
  fireEvent.mouseDown(document.querySelector(".sheet-backdrop")!);
  fireEvent.keyDown(screen.getByRole("form", { name: "Add a machine" }), { key: "Escape" });
  expect(n.onClose).not.toHaveBeenCalled();

  // Approved in the browser: done there, with nothing pasted.
  e.signedIn();
  await tick();
  expect(e.hub.signInCode).not.toHaveBeenCalled();
  expect(n.fake.signInForwardStop).toHaveBeenCalledWith("devbox", "si-1");
  expect(within(signIn).getByRole("group", { name: "Claude" }).textContent).toContain("Signed in");
  expect(screen.getByRole("group", { name: "Setting it up" }).textContent).toContain("Signed in to Claude");
  vi.useRealTimers();
});

it("never opens the page of a sign-in cancelled while its listener was starting, and ends that listener", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  const native = fakeNative();
  let opened: () => void = () => {};
  native.fake.signInForward.mockImplementationOnce(() => new Promise<undefined>((r) => (opened = () => r(undefined))));
  await atSignIn(e.hub, native);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(native.fake.signInForward).toHaveBeenCalledWith("devbox", "si-1");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
  expect(e.hub.cancelSignIn).toHaveBeenCalledWith("si-1");
  expect(native.fake.signInForwardStop).toHaveBeenCalledWith("devbox", "si-1");
  await act(async () => opened());
  expect(screen.queryByText(/Desk carries on by itself/)).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in to Claude" })).toBeTruthy();
  expect(pages()).toEqual([]);
  vi.useRealTimers();
});

it("opens the page that comes back again through the native side", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  const n = await atSignIn(e.hub);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open the sign-in page again" })));
  expect(n.fake.signInForward).toHaveBeenCalledTimes(2);
  expect(pages()).toEqual([]);
  vi.useRealTimers();
});

it("falls back to the page with a code when the forward can't start, and says why plainly", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  const native = fakeNative();
  native.fake.signInForward.mockRejectedValueOnce(new Error("Another program on this computer is using port 46009, which the sign-in page comes back to."));
  await atSignIn(e.hub, native);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(pages()).toContainEqual(["claude", MANUAL]);
  expect(screen.getByText(/is using port 46009/)).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("Code from the page"), { target: { value: "abc-123" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
  expect(e.hub.signInCode).toHaveBeenCalledWith("si-1", "abc-123");
  vi.useRealTimers();
});

it("opens the page with a code once the machine shows it, when the forward failed before it did", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  const native = fakeNative();
  native.fake.signInForward.mockRejectedValueOnce(new Error("Desk couldn’t connect to devbox in time."));
  await atSignIn(e.hub, native);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  // The page that comes back is made before the page with a code is shown.
  e.run({ state: "starting", directReady: true });
  await tick();
  expect(screen.getByText("Desk couldn’t connect to devbox in time.")).toBeTruthy();
  expect(screen.getByText("Opening Claude’s sign-in page with a code…")).toBeTruthy();
  expect(pages()).toEqual([]);
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  expect(pages()).toContainEqual(["claude", MANUAL]);
  expect(native.fake.signInForward).toHaveBeenCalledTimes(1);
  // Its tab closed: it opens again from here.
  last!.fake.openSignInPage.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Open the sign-in page again" }));
  expect(pages()).toContainEqual(["claude", MANUAL]);
  await tick();
  expect(pages()).toHaveLength(1);
  vi.useRealTimers();
});

it("switches to the page with a code when asked, from a sign-in in the browser", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  await atSignIn(e.hub);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  e.run({ state: "code", url: MANUAL, directReady: true });
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Use a code instead" }));
  expect(pages().at(-1)).toEqual(["claude", MANUAL]);
  expect(screen.getByPlaceholderText("Code from the page")).toBeTruthy();
  vi.useRealTimers();
});

it("on a machine whose Desk can't give the page that comes back, opens the page with a code", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  const n = await atSignIn(e.hub);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  e.run({ state: "code", url: MANUAL });
  await tick();
  expect(n.fake.signInForward).not.toHaveBeenCalled();
  expect(pages()).toContainEqual(["claude", MANUAL]);
  fireEvent.keyDown(screen.getByPlaceholderText("Code from the page"), { key: "Enter" });
  expect(e.hub.signInCode).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText("Code from the page"), { target: { value: "abc-123" } });
  await act(async () => fireEvent.keyDown(screen.getByPlaceholderText("Code from the page"), { key: "Enter" }));
  expect(e.hub.signInCode).toHaveBeenCalledWith("si-1", "abc-123");
  vi.useRealTimers();
});

it("picks up a sign-in already under way there rather than starting one its name would refuse", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  e.run({ state: "code", url: MANUAL, directReady: true });
  const n = await atSignIn(e.hub);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  expect(e.hub.addAccount).not.toHaveBeenCalled();
  expect(n.fake.signInForward).toHaveBeenCalledWith("devbox", "si-1");
  vi.useRealTimers();
});

it("says a failed sign-in in plain words with Try again, and keeps the card open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  const n = await atSignIn(e.hub);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  e.run({ state: "failed", why: "the sign-in took too long: start it again" });
  await tick();
  expect(screen.getByRole("alert").textContent).toBe("the sign-in took too long: start it again");
  expect(n.fake.signInForwardStop).toHaveBeenCalled();
  fireEvent.mouseDown(document.querySelector(".sheet-backdrop")!);
  expect(n.onClose).not.toHaveBeenCalled();
  e.state.accounts = { ...e.state.accounts, signIns: [] };
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(e.hub.addAccount).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  vi.useRealTimers();
});

it("signs ChatGPT in for Codex by its device page: the page opens here and its code is shown to type there", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = fakeEngine();
  await atSignIn(e.hub, fakeNative(), e.transport);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to ChatGPT" })));
  expect(e.codex.start).toHaveBeenCalled();
  e.codex.read.mockResolvedValue({ id: "cx-1", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "WXYZ-98765" });
  await tick();
  expect(pages()).toContainEqual(["codex", "https://auth.openai.com/codex/device"]);
  expect(screen.getByText("WXYZ-98765")).toBeTruthy();
  await tick();
  expect(pages().filter(([, u]) => u === "https://auth.openai.com/codex/device")).toHaveLength(1);
  e.codex.read.mockResolvedValue({ id: "cx-1", engine: "codex", state: "done" });
  await tick();
  expect(screen.getByRole("group", { name: "ChatGPT" }).textContent).toContain("Signed in");
  expect(screen.getByRole("group", { name: "Setting it up" }).textContent).not.toContain("Signed in to Claude");
  vi.useRealTimers();
});

it("on a machine whose Desk can't sign Codex in itself, says how in a terminal there", async () => {
  // An older hub has no such route.
  const e = fakeEngine();
  e.codex.start.mockResolvedValue(new Response("not found", { status: 404 }));
  await atSignIn(e.hub, fakeNative(), e.transport);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to ChatGPT" })));
  expect(screen.getByText("codex login --device-auth")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open a terminal" }));
  const panes = Object.values(useGrids.getState().grids).flatMap((g) => g.panes);
  expect(panes.some((p) => p.content?.kind === "terminal" && p.content.machine === "devbox")).toBe(true);
  expect(useDesk.getState().view).toBe("grids");
});

it("refuses a machine whose key has changed, with no way to trust it", async () => {
  const { native, fake } = fakeNative();
  fake.probe.mockResolvedValueOnce(probeOf({ hostKey: { kind: "changed", fingerprint: "SHA256:other", keyType: "ED25519" }, access: null }));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  expect(screen.getByRole("alert", { name: "Its key has changed" }).textContent).toContain("Desk won’t connect to it");
  expect(screen.getByText("ssh-keygen -R devbox")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Trust this machine" })).toBeNull();
  expect(fake.trust).not.toHaveBeenCalled();
  expect(fake.add).not.toHaveBeenCalled();
});

it("helps put this computer's key on a machine that refuses it, then tries again", async () => {
  const { native, fake } = fakeNative();
  fake.probe
    .mockResolvedValueOnce(probeOf({ name: "203.0.113.7", access: { kind: "refused", user: "dev" } }))
    .mockResolvedValueOnce(probeOf({ name: "203.0.113.7" }));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("dev@203.0.113.7");
  const help = screen.getByRole("group", { name: "This computer’s key" });
  expect(help.textContent).toContain("203.0.113.7 didn’t take any of this computer’s SSH keys");
  expect(screen.getByText("ssh-copy-id dev@203.0.113.7")).toBeTruthy();
  expect(screen.getByText("ssh-ed25519 AAAAC3NzaExampleKey you@laptop")).toBeTruthy();
  expect(fake.add).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  await settle();
  expect(fake.probe).toHaveBeenCalledTimes(2);
  expect(fake.add).toHaveBeenCalledWith("dev@203.0.113.7", "203.0.113.7");
});

it("asks for a locked key to be unlocked", async () => {
  const { native, fake } = fakeNative();
  fake.probe.mockResolvedValueOnce(probeOf({ access: { kind: "locked" } }));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  expect(screen.getByText("Your SSH key is locked")).toBeTruthy();
  expect(screen.getByText("ssh-add")).toBeTruthy();
});

it("says why it can't reach a machine, and never asks the native side about a bad address", async () => {
  const { native, fake } = fakeNative();
  fake.probe.mockResolvedValueOnce(probeOf({ access: { kind: "unreachable", message: "Desk can’t reach devbox: no route to it." } }));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("-oProxyCommand=x");
  expect(screen.getByRole("alert").textContent).toBe("An address can’t start with a dash.");
  expect(fake.probe).not.toHaveBeenCalled();
  await typeAndGo("devbox");
  expect(screen.getByRole("alert", { name: "Desk can’t add it" }).textContent).toContain("Desk can’t reach devbox: no route to it.");
});

it("says plainly that an account running desktop Desk can't be a machine", async () => {
  const { native, fake } = fakeNative();
  const desktop = "This account already runs Desk as a desktop app; use another account for a machine. Desk won't change anything there.";
  fake.probe.mockResolvedValueOnce(probeOf({ access: { kind: "unreachable", message: desktop } }));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("me@laptop");
  const box = screen.getByRole("alert", { name: "Desk can’t add it" });
  expect(box.textContent).toContain(desktop);
  expect(box.textContent).toContain("Change the address above");
  expect(fake.add).not.toHaveBeenCalled();
  // The address can be changed again.
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "dev@devbox" } });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows a step that waits on the person with the line to run, and one that failed", async () => {
  const { native, emit } = fakeNative();
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  act(() =>
    emit({
      machine: "devbox",
      step: "install",
      state: "blocked",
      detail: "Desk 0.2.0 is installed. To start it when devbox boots, run this there:",
      message: "Until then Desk starts itself there each time it connects. Turning on linger for dev needs an administrator.",
      line: "sudo loginctl enable-linger dev",
    }),
  );
  const list = screen.getByRole("group", { name: "Setting it up" });
  expect(list.textContent).toContain("Desk 0.2.0 is installed. To start it when devbox boots, run this there:");
  expect(list.textContent).toContain("needs an administrator");
  expect(screen.getByText("sudo loginctl enable-linger dev")).toBeTruthy();
  expect(list.querySelector(".dot-blocked")).toBeTruthy();
  act(() => emit({ machine: "devbox", step: "engines", state: "failed", message: "npm isn’t on devbox" }));
  expect(list.textContent).toContain("npm isn’t on devbox");
  expect(screen.getByRole("alert").textContent).toContain("devbox stays in Settings → Machines");
});

it("finishes while linger waits on an administrator: Desk starts itself on each connect", async () => {
  const { native, emit } = fakeNative();
  withEngine("devbox", {} as DeskHub);
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  act(() => emit({ machine: "devbox", step: "install", state: "blocked", line: "sudo loginctl enable-linger dev" }));
  act(() => emit({ machine: "devbox", step: "engines", state: "done" }));
  expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("group", { name: "Sign in on devbox" })).toBeTruthy();
  expect(screen.getByText("sudo loginctl enable-linger dev")).toBeTruthy();
});

it("shows the desktop refusal as the connect step's failure when it's found while adding", async () => {
  const { native, emit } = fakeNative();
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  act(() => emit({ machine: "devbox", step: "connect", state: "failed", message: "This account already runs Desk as a desktop app; use another account for a machine." }));
  const list = screen.getByRole("group", { name: "Setting it up" });
  expect(list.querySelector(".dot-failed")).toBeTruthy();
  expect(list.textContent).toContain("already runs Desk as a desktop app");
});
