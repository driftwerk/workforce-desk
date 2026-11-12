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
  // Its fingerprint in a fold; no second question in a system dialog.
  expect(box.textContent).toContain("SHA256:k3Vq9fXc (ED25519)");
  expect(screen.queryByText(/asks you once more/)).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Trust and continue" })));
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

it("forgets a changed machine's old key only through the native question, then looks again", async () => {
  const { native, fake } = fakeNative();
  fake.probe
    .mockResolvedValueOnce(probeOf({ hostKey: { kind: "changed", fingerprint: "SHA256:other", keyType: "ED25519" }, access: null, forgetKey: "ssh-keygen -R devbox" }))
    .mockResolvedValueOnce(probeOf());
  fake.forgetKey.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("devbox's old key is also in a known hosts file of this computer's own")).mockResolvedValueOnce(true);
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  const box = screen.getByRole("alert", { name: "Its key has changed" });
  expect(box.textContent).toContain("Desk won’t connect yet");
  expect(box.textContent).toContain("SHA256:other");
  expect(screen.queryByRole("button", { name: "Trust and continue" })).toBeNull();
  // The line by hand, folded.
  expect(screen.getByText("ssh-keygen -R devbox")).toBeTruthy();
  const forget = () => screen.getByRole("button", { name: "Forget the old key and trust the new one" });
  // No to the native question: as it was.
  await act(async () => fireEvent.click(forget()));
  await settle();
  expect(fake.forgetKey).toHaveBeenCalledWith("devbox", "SHA256:other");
  expect(fake.add).not.toHaveBeenCalled();
  // Refused: said in place.
  await act(async () => fireEvent.click(forget()));
  await settle();
  expect(screen.getByRole("alert", { name: "Its key has changed" }).textContent).toContain("also in a known hosts file");
  // Yes: it looks again and goes on.
  await act(async () => fireEvent.click(forget()));
  await settle();
  expect(fake.probe).toHaveBeenCalledTimes(2);
  expect(fake.trust).not.toHaveBeenCalled();
  expect(fake.add).toHaveBeenCalledWith("devbox", "devbox");
});

it("signs in to a machine that refuses this computer's key with its password once, in Desk's own field", async () => {
  const { native, fake } = fakeNative();
  fake.probe
    .mockResolvedValueOnce(probeOf({ name: "203.0.113.7", access: { kind: "refused", user: "dev" } }))
    .mockResolvedValueOnce(probeOf({ name: "203.0.113.7" }));
  fake.installKey.mockResolvedValueOnce({ kind: "cancelled" }).mockRejectedValueOnce(new Error("203.0.113.7 only lets keys sign in, not passwords.")).mockResolvedValueOnce({ kind: "done", linger: true });
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("dev@203.0.113.7");
  const help = screen.getByRole("group", { name: "Sign in to 203.0.113.7" });
  expect(help.textContent).toMatch(/203\.0\.113\.7 doesn’t know this (Mac|computer) yet/);
  expect(help.textContent).toContain("dev’s password there once, in its own window");
  // No terminal: the line by hand only in a fold.
  expect(screen.getByText("ssh-copy-id dev@203.0.113.7").closest("details")).toBeTruthy();
  // The page never has a password field of its own.
  expect(document.querySelector("input[type=password]")).toBeNull();
  const signIn = () => screen.getByRole("button", { name: "Sign in with 203.0.113.7’s password" });
  // Closed the field: back as it was, nothing added.
  await act(async () => fireEvent.click(signIn()));
  await settle();
  expect(fake.installKey).toHaveBeenCalledWith("dev@203.0.113.7");
  expect(fake.add).not.toHaveBeenCalled();
  // Refused: said in place.
  await act(async () => fireEvent.click(signIn()));
  await settle();
  expect(screen.getByRole("group", { name: "Sign in to 203.0.113.7" }).textContent).toContain("only lets keys sign in");
  // Done: it looks again and is added.
  await act(async () => fireEvent.click(signIn()));
  await settle();
  expect(fake.probe).toHaveBeenCalledTimes(2);
  expect(fake.add).toHaveBeenCalledWith("dev@203.0.113.7", "203.0.113.7");
});

it("unlocks a locked key with its passphrase in Desk's own field, or uses the machine's password instead", async () => {
  const { native, fake } = fakeNative();
  fake.probe.mockResolvedValueOnce(probeOf({ access: { kind: "locked" } })).mockResolvedValueOnce(probeOf());
  fake.unlockKey.mockRejectedValueOnce(new Error("No SSH agent is running for Desk to unlock your key in."));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  expect(screen.getByText("Your SSH key is locked")).toBeTruthy();
  expect(screen.queryByText("ssh-add")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock your key" })));
  await settle();
  expect(fake.unlockKey).toHaveBeenCalledWith("devbox");
  expect(screen.getByRole("alert").textContent).toContain("No SSH agent");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use devbox’s password instead" })));
  await settle();
  expect(fake.installKey).toHaveBeenCalledWith("devbox");
  expect(fake.add).toHaveBeenCalledWith("devbox", "devbox");
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

it("gives Desk its own SSH entry for a machine whose config forwards ports, then looks at it by that name", async () => {
  const { native, fake } = fakeNative();
  const refused = "Your SSH config forwards ports for devbox (localforward). Desk keeps its connection open all the time, so it won't carry them.";
  fake.probe.mockRejectedValueOnce(new Error(refused));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  const box = screen.getByRole("alert", { name: "Desk can’t add it" });
  expect(box.textContent).toContain("forwards ports for devbox");
  // One primary button: Continue steps back while the offer stands.
  expect(screen.getByRole("button", { name: "Continue" }).className).not.toContain("btn-signal");
  await act(async () => fireEvent.click(within(box).getByRole("button", { name: "Give Desk its own entry" })));
  expect(fake.deskEntry).toHaveBeenCalledWith("devbox");
  // Looked at again, by Desk's entry.
  expect(fake.probe).toHaveBeenLastCalledWith("desk-m-devbox-a1b2c3");
  expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("desk-m-devbox-a1b2c3");
});

it("never offers Desk's entry again for one of its own", async () => {
  const { native, fake } = fakeNative();
  fake.probe.mockRejectedValue(new Error("Your SSH config forwards ports for desk-m-devbox-a1b2c3 (localforward). Desk keeps its connection open all the time, so it won't carry them."));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("desk-m-devbox-a1b2c3");
  expect(screen.getByRole("alert", { name: "Desk can’t add it" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Give Desk its own entry" })).toBeNull();
});

it("leaves it as it was when the person says no to Desk's entry, and says why one can't help", async () => {
  const { native, fake } = fakeNative();
  fake.probe.mockRejectedValue(new Error("Your SSH config forwards ports for devbox (localforward). Give Desk a Host entry without forwards."));
  render(<AddMachine native={native} onClose={() => {}} />);
  await typeAndGo("devbox");
  fake.deskEntry.mockResolvedValueOnce(null);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Give Desk its own entry" })));
  expect(fake.probe).toHaveBeenCalledTimes(1);
  fake.deskEntry.mockRejectedValueOnce(new Error("Your SSH config forwards ports for every host it reaches (under Host * or a pattern), so an entry of Desk's would carry them too."));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Give Desk its own entry" })));
  expect(screen.getByText(/for every host it reaches/)).toBeTruthy();
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
  expect(list.textContent).not.toContain("stays in Settings → Machines until");
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
