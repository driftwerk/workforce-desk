// Adding a machine end to end against a fake native side: picking a Host
// from the SSH config or typing one, its name (the same host as another
// user named apart), each step said with its progress, a failed step said in
// place with Retry and View log, and Cancel adding at any step.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMachines } from "./engines";
import { AddMachine } from "./AddMachine";
import { fakeNative, machine, noEngines, probeOf } from "./testing";
import { DEFAULT_HOST, useHost } from "../shell/host";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({ machinesList: vi.fn(async () => []), onMachinesChanged: vi.fn(async () => () => {}), machinePluginDir: vi.fn(async () => null), inApp: false, openUrl: vi.fn() }));

const HOSTS = [
  { host: "devbox-gpu", hostname: "2.29.244.77", user: "dev", port: null, jump: null, file: "~/.ssh/config" },
  { host: "devbox", hostname: "2.29.244.189", user: "dev", port: null, jump: null, file: "~/.ssh/config" },
  { host: "buildbox", hostname: "10.0.3.14", user: "ubuntu", port: null, jump: "bastion", file: "~/.ssh/config" },
];

beforeEach(() => {
  useHost.setState(DEFAULT_HOST);
  noEngines();
  useMachines.setState({ listed: true, machines: [machine({ id: "devbox", target: "devbox", reach: { user: "dev", hostname: "2.29.244.189", port: "22", via: null, entry: "devbox", file: null } })] });
});
afterEach(cleanup);

const open = async () => {
  const n = fakeNative();
  n.fake.sshHosts.mockResolvedValue(HOSTS);
  n.fake.add.mockResolvedValue("devbox-gpu");
  const onClose = vi.fn();
  render(<AddMachine native={n.native} onClose={onClose} />);
  await act(async () => {});
  return { ...n, onClose };
};

it("picks a Host from the SSH config, named after it; one already added can't be picked", async () => {
  const { fake } = await open();
  const list = screen.getByRole("radiogroup", { name: "From your SSH config" });
  const rows = within(list).getAllByRole("radio");
  expect(rows.map((r) => r.textContent)).toEqual([
    "devbox-gpudev@2.29.244.77",
    "devboxdev@2.29.244.189added",
    "buildboxubuntu@10.0.3.14Through bastion, as your SSH config saysvia bastion",
  ]);
  expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Read from ~/.ssh/config and the files it includes. Entries with wildcards aren’t listed.")).toBeTruthy();
  expect(screen.getByLabelText("Or type an address")).toBeTruthy();
  fireEvent.click(rows[0]!);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("devbox-gpu");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await act(async () => {});
  expect(fake.probe).toHaveBeenCalledWith("devbox-gpu");
  expect(fake.add).toHaveBeenCalledWith("devbox-gpu", "devbox-gpu");
});

it("names the same host as another user apart, warns about root, and says what it looks at", async () => {
  const { fake } = await open();
  let looked: (p: ReturnType<typeof probeOf>) => void = () => {};
  fake.probe.mockImplementationOnce(() => new Promise((r) => (looked = r)));
  fireEvent.change(screen.getByLabelText("Or type an address"), { target: { value: "root@devbox" } });
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("devbox (root)");
  expect(screen.getByText("devbox is already added as dev. This adds root on the same machine as its own machine.")).toBeTruthy();
  const warn = screen.getByRole("note", { name: "Sessions would run as root" });
  expect(warn.textContent).toContain("Anything you start there runs as root, with full control of devbox. A normal user is safer.");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  expect(screen.getByText("Looking at root@devbox…")).toBeTruthy();
  expect(screen.getByText(/Desk gives up after 15 s and says why/)).toBeTruthy();
  // Cancel while it looks: back at the address, the name kept.
  fireEvent.click(within(screen.getByText("Looking at root@devbox…").closest("li")!).getByRole("button", { name: "Cancel" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("devbox (root)");
  act(() => looked(probeOf()));
});

it("keeps a typed name, and never one another machine has", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Or type an address"), { target: { value: "dev@203.0.113.9" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "DEVBOX" } });
  fireEvent.change(screen.getByLabelText("Or type an address"), { target: { value: "dev@203.0.113.10" } });
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("DEVBOX");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  expect(screen.getByRole("alert").textContent).toBe("Another machine is called DEVBOX already. Two machines can’t share a name.");
});

it("says each step as it goes, a failure in place with Retry and View log, and cancels adding at once", async () => {
  const { fake, emit, onClose } = await open();
  fake.log.mockResolvedValue([{ at: Date.now(), kind: "error", text: "~ on devbox-gpu has 180 MB free, and Desk needs 420 MB." }]);
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await act(async () => {});
  const list = screen.getByRole("group", { name: "Setting it up" });
  act(() => emit({ machine: "devbox-gpu", step: "install", state: "running", detail: "Copying Desk 0.2.1 to devbox-gpu… 22 of 61 MB" }));
  expect(list.textContent).toContain("Copying Desk 0.2.1 to devbox-gpu… 22 of 61 MB");
  expect(list.textContent).toContain("Each step stops after 3 minutes and says why.");

  act(() => emit({ machine: "devbox-gpu", step: "install", state: "failed", message: "~ on devbox-gpu has 180 MB free, and Desk needs 420 MB." }));
  expect(list.textContent).toContain("Desk couldn’t be installed: ~ on devbox-gpu has 180 MB free, and Desk needs 420 MB.");
  expect(list.textContent).toContain("Free some space there, then Retry.");
  await act(async () => fireEvent.click(within(list).getByRole("button", { name: "View log" })));
  expect(fake.log).toHaveBeenCalledWith("devbox-gpu");
  expect(within(list).getByRole("log").textContent).toContain("180 MB free");
  fireEvent.click(within(list).getByRole("button", { name: "Retry" }));
  expect(fake.reconnect).toHaveBeenCalledWith("devbox-gpu");
  expect(list.textContent).toContain("Install Desk, and start it when it boots");

  // Cancel adding: asked of the native side, and once it says so the card goes.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel adding" })));
  expect(fake.cancelAdd).toHaveBeenCalledWith("devbox-gpu");
  expect((screen.getByRole("button", { name: "Cancel adding" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  act(() => emit({ machine: "devbox-gpu", step: "connect", state: "failed", message: "Adding it was cancelled." }));
  expect(onClose).toHaveBeenCalled();
});

it("says why cancelling failed, and keeps the card", async () => {
  const { fake, onClose } = await open();
  fake.cancelAdd.mockRejectedValueOnce(new Error("devbox-gpu is added already: remove it instead."));
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel adding" })));
  expect(onClose).not.toHaveBeenCalled();
  // Said, and Cancel adding works again.
  expect(screen.getByRole("alert").textContent).toBe("devbox-gpu is added already: remove it instead.");
  expect((screen.getByRole("button", { name: "Cancel adding" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/^Stopping…/)).toBeNull();
});

it("gives up on Stopping… after 15 s, says so, and lets Cancel adding be tried again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { fake } = await open();
    fake.cancelAdd.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel adding" })));
    expect(screen.getByText(/Stopping… whatever runs there now is ended\. Desk gives up after 15 s/)).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(screen.getByRole("alert").textContent).toContain("Desk couldn’t stop it within 15 s.");
    expect((screen.getByRole("button", { name: "Cancel adding" }) as HTMLButtonElement).disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("cancels adding while its question is still open, by its address, and adds nothing", async () => {
  const { fake, onClose } = await open();
  let answer: (v: unknown) => void = () => {};
  fake.add.mockImplementationOnce(() => new Promise((_, no) => (answer = no)) as never);
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel adding" })));
  expect(fake.cancelAdd).toHaveBeenCalledWith("devbox-gpu");
  expect(onClose).not.toHaveBeenCalled();
  // The person answers the native question; the native side stops it.
  await act(async () => answer(new Error("Adding it was cancelled.")));
  expect(onClose).toHaveBeenCalled();
});

it("says a machine on a newer Desk is kept, without Retry or Cancel adding", async () => {
  const { emit } = await open();
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await act(async () => {});
  act(() => {
    useMachines.setState({ machines: [...useMachines.getState().machines, machine({ id: "devbox-gpu", target: "devbox-gpu", state: { kind: "newer" }, version: "0.3.0" })] });
    emit({ machine: "devbox-gpu", step: "install", state: "failed", message: "devbox-gpu has a newer Desk (0.3.0) than this one (0.2.1). Update Desk on this Mac, then try again." });
  });
  const list = screen.getByRole("group", { name: "Setting it up" });
  expect(list.textContent).toContain("It runs a newer Desk than this Mac. Update Desk on this Mac: devbox-gpu stays in Settings → Machines and connects once they match.");
  expect(within(list).queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel adding" })).toBeNull();
});

it("gives the line that removes a changed key by the name and port ssh looks it up by", async () => {
  const { fake } = await open();
  fake.probe.mockResolvedValueOnce(
    probeOf({ hostKey: { kind: "changed", fingerprint: "SHA256:Zp4w", keyType: "ED25519" }, access: null, forgetKey: "ssh-keygen -R '[2.29.244.77]:2222'" }),
  );
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await act(async () => {});
  expect(screen.getByText("ssh-keygen -R '[2.29.244.77]:2222'")).toBeTruthy();
});

it("retries a failed engines step on its own, as the machine is added already, and says it as it goes", async () => {
  const { fake, emit } = await open();
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await act(async () => {});
  act(() => {
    emit({ machine: "devbox-gpu", step: "install", state: "done", detail: "Desk 0.2.1 installed, and set to start when it boots" });
    emit({ machine: "devbox-gpu", step: "engines", state: "failed", message: "Claude Code could not be installed" });
  });
  const list = screen.getByRole("group", { name: "Setting it up" });
  await act(async () => fireEvent.click(within(list).getByRole("button", { name: "Retry" })));
  expect(fake.retryEngines).toHaveBeenCalledWith("devbox-gpu");
  expect(fake.reconnect).not.toHaveBeenCalled();
  expect(list.textContent).toContain("Installing Claude Code and Codex…");
  expect(list.textContent).toContain("Desk 0.2.1 installed, and set to start when it boots");
  act(() => emit({ machine: "devbox-gpu", step: "engines", state: "done", detail: "Claude Code 2.1.0 and Codex 0.170.0 installed" }));
  expect(list.textContent).toContain("Claude Code 2.1.0 and Codex 0.170.0 installed");
});

it("shows no focus on the address field once an SSH config entry is picked", async () => {
  await open();
  const field = screen.getByLabelText("Or type an address") as HTMLInputElement;
  field.focus();
  expect(document.activeElement).toBe(field);
  fireEvent.click(screen.getAllByRole("radio")[0]!);
  expect(document.activeElement).not.toBe(field);
});
