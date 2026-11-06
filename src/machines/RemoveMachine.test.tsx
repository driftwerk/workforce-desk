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
  expect(dialog.textContent).toContain("Ends its 3 sessions, stops Desk’s service there and removes ~/.local/share/Desk with its sign-ins and memory. Your files, repos, Claude Code and Codex stay.");
  fireEvent.click(within(dialog).getByRole("radio", { name: /Also uninstall Desk from devbox/ }));
  let finish: () => void = () => {};
  fake.uninstall.mockImplementationOnce(() => new Promise<undefined>((r) => (finish = () => r(undefined))));
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Remove devbox" })));
  expect(fake.uninstall).toHaveBeenCalledWith("devbox");
  expect(fake.remove).not.toHaveBeenCalled();
  act(() => removed({ machine: "devbox", step: "stop", state: "done" }));
  act(() => removed({ machine: "devbox", step: "remove", state: "running" }));
  const checks = within(dialog).getByRole("list", { name: "Uninstalling Desk from devbox" });
  expect(within(checks).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
    "Stopped Desk’s service on devbox",
    "Removing ~/.local/share/Desk…",
    "Turn linger off",
    "Forget devbox here",
  ]);
  // Buttons wait while it runs.
  expect((within(dialog).getByRole("button", { name: "Remove devbox" }) as HTMLButtonElement).disabled).toBe(true);
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
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Try again" })));
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
