// "Remove devbox?": forget only, or uninstall Desk there too, step by step;
// a failure said in place with nothing forgotten (Try again, or remove it
// without uninstalling); and a machine Desk can't reach only forgotten, with
// the lines that uninstall it later.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { BY_HAND, RemoveMachine } from "./RemoveMachine";
import { fakeNative, machine } from "./testing";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({ machinesList: vi.fn(async () => []), onMachinesChanged: vi.fn(async () => () => {}), machinePluginDir: vi.fn(async () => null), inApp: false, openUrl: vi.fn() }));

beforeEach(() => {
  useHost.setState(DEFAULT_HOST);
  useDesk.setState({ sessions: Object.fromEntries(["a", "b", "c"].map((id) => [`devbox/${id}`, { id, machine: "devbox" } as never])) });
});
afterEach(cleanup);

const open = (m = machine({ id: "devbox" })) => {
  const n = fakeNative();
  const onRemoved = vi.fn();
  const onClose = vi.fn();
  render(<RemoveMachine machine={m} native={n.native} onClose={onClose} onRemoved={onRemoved} />);
  return { ...n, onRemoved, onClose };
};

it("uninstalls Desk there step by step, then forgets it", async () => {
  const { fake, removed, onRemoved } = open();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "Remove devbox?" })).toBeTruthy();
  expect(dialog.textContent).toContain(
    "Ends its 3 sessions, stops Desk’s service there and removes Desk’s folder with its memory and the Claude sign-ins Desk copied there. Your files, repos, Claude Code and Codex stay.",
  );
  // What staying there means for the copies of the person's sign-ins.
  expect(dialog.textContent).toContain("Its sessions keep running, and so do the copies of your accounts’ sign-ins there.");
  // Leaving Desk running there: its copies stay, and revoking is the way out.
  expect(dialog.textContent).toContain("If devbox is lost, or you no longer trust it, revoke them at claude.ai.");
  expect(dialog.textContent).not.toContain("codex logout");
  fireEvent.click(within(dialog).getByRole("radio", { name: /Also uninstall Desk from devbox/ }));
  // Removing the copies isn't revoking them: still said.
  expect(dialog.textContent).toContain("doesn’t revoke them");
  // Codex signed out too, unless the person unticks it.
  expect((within(dialog).getByRole("checkbox", { name: /Also sign Codex out on devbox/ }) as HTMLInputElement).checked).toBe(true);
  let finish: () => void = () => {};
  fake.uninstall.mockImplementationOnce(() => new Promise<boolean>((r) => (finish = () => r(true))));
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Remove devbox" })));
  expect(fake.uninstall).toHaveBeenCalledWith("devbox", { signOutCodex: true });
  expect(fake.remove).not.toHaveBeenCalled();
  act(() => removed({ machine: "devbox", step: "stop", state: "done" }));
  act(() => removed({ machine: "devbox", step: "sign_out", state: "done" }));
  act(() => removed({ machine: "devbox", step: "remove", state: "running" }));
  const checks = within(dialog).getByRole("list", { name: "Uninstalling Desk from devbox" });
  expect(within(checks).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
    "Stopped Desk’s service on devbox",
    "Signed Codex out on devbox",
    "Removing Desk’s folder and the Claude sign-ins Desk copied there…",
    "Turn linger off",
    "Forget devbox here",
  ]);
  // Buttons wait while it runs; Cancel too, once it removes; the limit is said.
  expect((within(dialog).getByRole("button", { name: "Remove devbox" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  expect(dialog.textContent).toContain("Each step stops after 3 minutes and says why.");
  act(() => removed({ machine: "devbox", step: "remove", state: "done" }));
  act(() => removed({ machine: "devbox", step: "linger", state: "blocked", message: "Linger stays on for dev: turning it off needs an administrator there.", line: "sudo loginctl disable-linger dev" }));
  expect(checks.textContent).toContain("sudo loginctl disable-linger dev");
  await act(async () => finish());
  expect(onRemoved).toHaveBeenCalled();
});

it("says a failed uninstall in place, forgets nothing, and tries again or removes it without uninstalling", async () => {
  const { fake, removed, onRemoved } = open();
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("radio", { name: /Also uninstall/ }));
  fake.uninstall.mockImplementationOnce(async () => {
    removed({ machine: "devbox", step: "stop", state: "done" });
    removed({ machine: "devbox", step: "remove", state: "failed", message: "Couldn't remove ~/.local/share/Desk. devbox said: “permission denied on Desk/pg/data”" });
    throw new Error("Couldn't remove ~/.local/share/Desk.");
  });
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Remove devbox" })));
  expect(onRemoved).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain("Couldn’t remove ~/.local/share/Desk: devbox said: “permission denied on Desk/pg/data”");
  expect(dialog.textContent).toContain("Nothing is forgotten yet. Try again, or remove it without uninstalling.");
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Try uninstalling again" })));
  expect(fake.uninstall).toHaveBeenCalledTimes(2);
  expect(onRemoved).toHaveBeenCalledTimes(1);
});

it("removes it without uninstalling after a failure", async () => {
  const { fake, removed, onRemoved } = open();
  fireEvent.click(screen.getByRole("radio", { name: /Also uninstall/ }));
  fake.uninstall.mockImplementationOnce(async () => {
    removed({ machine: "devbox", step: "stop", state: "failed", message: "Couldn't stop Desk's service on devbox. devbox said: “no”" });
    throw new Error("no");
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove devbox" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove without uninstalling" })));
  expect(fake.remove).toHaveBeenCalledWith("devbox");
  expect(onRemoved).toHaveBeenCalled();
});

it("only forgets a machine Desk can't reach, with the lines that uninstall it later", async () => {
  const { fake, onRemoved } = open(machine({ id: "buildbox", state: { kind: "unreachable" } }));
  const dialog = screen.getByRole("dialog");
  const uninstall = within(dialog).getByRole("radio", { name: /Also uninstall Desk from buildbox/ }) as HTMLButtonElement;
  expect(uninstall.disabled).toBe(true);
  expect(uninstall.textContent).toContain("Desk can’t reach buildbox right now, so it can only forget it here.");
  // Only where Desk can't reach it is revoking left to the person.
  expect(screen.getByRole("dialog").textContent).toContain("If buildbox is lost, or you no longer trust it, revoke them at claude.ai.");
  expect(dialog.textContent).toContain("To uninstall it later, run these on buildbox:");
  for (const line of BY_HAND) expect(within(dialog).getByText(line)).toBeTruthy();
  expect(within(dialog).getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Remove buildbox" })));
  expect(fake.uninstall).not.toHaveBeenCalled();
  expect(fake.remove).toHaveBeenCalledWith("buildbox");
  expect(onRemoved).toHaveBeenCalled();
});

it("says why forgetting failed, and keeps the dialog", async () => {
  const { fake, onRemoved } = open();
  fake.remove.mockRejectedValueOnce(new Error("That machine isn't in Desk any more."));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove devbox" })));
  expect(screen.getByRole("alert").textContent).toBe("That machine isn't in Desk any more.");
  expect(onRemoved).not.toHaveBeenCalled();
});

it("cancels an uninstall while it stops Desk, before anything is removed, and says nothing changed", async () => {
  const { fake, removed, onRemoved, onClose } = open();
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("radio", { name: /Also uninstall/ }));
  let finish: (v: boolean) => void = () => {};
  fake.uninstall.mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Remove devbox" })));
  act(() => removed({ machine: "devbox", step: "stop", state: "running" }));
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
  expect(fake.cancelUninstall).toHaveBeenCalledWith("devbox");
  expect(onClose).not.toHaveBeenCalled();
  act(() => removed({ machine: "devbox", step: "stop", state: "done" }));
  await act(async () => finish(false));
  expect(onRemoved).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("status").textContent).toBe("Nothing was uninstalled: Desk on devbox is as it was.");
});

it("never says its 0 sessions", () => {
  useDesk.setState({ sessions: {} });
  open();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).not.toContain("0 sessions");
  expect(dialog.textContent).toContain("Desk on this Mac forgets devbox.");
});

it("offers uninstalling again for a machine held after an uninstall stopped partway", async () => {
  const { fake, onRemoved } = open(
    machine({ id: "devbox", state: { kind: "failed", message: "Uninstalling stopped partway: Desk on devbox is stopped, and ~/.local/share/Desk may be partly gone. Try again, or remove it without uninstalling." } }),
  );
  const dialog = screen.getByRole("dialog");
  const again = within(dialog).getByRole("radio", { name: /Also uninstall Desk from devbox/ }) as HTMLButtonElement;
  expect(again.disabled).toBe(false);
  expect(again.getAttribute("aria-checked")).toBe("true");
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Try uninstalling again" })));
  expect(fake.uninstall).toHaveBeenCalledWith("devbox", { signOutCodex: true });
  expect(onRemoved).toHaveBeenCalled();
});

it("leaves Codex signed in there when the person unticks it", async () => {
  const { fake } = open();
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("radio", { name: /Also uninstall Desk from devbox/ }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /Also sign Codex out on devbox/ }));
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Remove devbox" })));
  expect(fake.uninstall).toHaveBeenCalledWith("devbox", { signOutCodex: false });
});
