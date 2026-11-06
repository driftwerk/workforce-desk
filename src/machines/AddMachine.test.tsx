import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { AccountsInfo } from "../hub/types";
import { openUrl } from "../platform";
import { useHost, DEFAULT_HOST } from "../shell/host";
import { AddMachine } from "./AddMachine";
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

  // The same sign-in block as Settings → Engines, Claude Code and Codex alone.
  await settle();
  const signIn = screen.getByRole("group", { name: "Sign in on devbox" });
  expect(within(signIn).getAllByRole("listitem").map((l) => l.getAttribute("aria-label"))).toEqual(["Claude Code", "Codex"]);
  expect(signIn.textContent).toContain("optional, for Codex sessions");
  expect(within(within(signIn).getByRole("listitem", { name: "Claude Code" })).getByRole("button", { name: "Sign in…" })).toBeTruthy();
  expect(within(within(signIn).getByRole("listitem", { name: "Codex" })).getByRole("button", { name: "Sign in…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalled();
});

/** A machine's engine as the Add card's sign-in sees it. */
function fakeEngine() {
  const accounts: AccountsInfo = { accounts: [], store: "Desk's private file", signIns: [] };
  const hub = {
    accounts: vi.fn(async () => accounts),
    engines: vi.fn(async () => [
      { engine: "claude", title: "Claude Code", installed: true, version: "2.1.318", views: ["terminal"], caps: { terminal: { accounts: "token", notes: [] } }, signIn: { state: "out" } },
      { engine: "codex", title: "Codex", installed: true, version: "0.166.0", views: ["terminal"], caps: { terminal: { accounts: "none", notes: [] } }, signIn: { state: "out" } },
      { engine: "gemini", title: "Gemini CLI", installed: false, views: [], caps: {}, signIn: { state: "out" } },
    ]),
  };
  return { hub };
}

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

it("offers the spelling the SSH config knows when a name didn't resolve, and puts it in the address", async () => {
  const { native, fake } = fakeNative();
  fake.probe.mockResolvedValueOnce(
    probeOf({ access: { kind: "unreachable", message: "SSH couldn’t reach Devbox: “Could not resolve hostname Devbox”", suggest: "devbox" } }),
  );
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("Devbox");
  const box = screen.getByRole("alert", { name: "Desk can’t add it" });
  expect(box.textContent).toContain("Did you mean devbox?");
  expect(box.textContent).toContain("SSH couldn’t reach Devbox");
  fireEvent.click(screen.getByRole("button", { name: "Use devbox" }));
  expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("devbox");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(fake.probe).toHaveBeenCalledTimes(1);
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
  expect(list.textContent).toContain("devbox stays in Settings → Machines until it’s set up");
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
