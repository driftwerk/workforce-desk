import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { useMachines } from "./engines";
import { OnMachine } from "./OnMachine";
import { REFUSAL_MS, refuseAcross, SidebarMachines, ThisComputerHeading, useRefusal } from "./SidebarMachines";
import { machine } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const session = (key: string, name: string, more: Partial<Session> = {}): Session =>
  ({
    id: key.split("/").pop()!,
    engine: "claude",
    name,
    cwd: "/home/dev/src",
    state: "idle",
    live: true,
    updatedAt: "2026-11-05T09:00:00Z",
    ...more,
  }) as Session;

beforeEach(() => {
  useHost.setState(DEFAULT_HOST);
  useRefusal.setState({ text: null, n: 0 });
  useMachines.setState({
    listed: true,
    machines: [machine({ id: "devbox" }), machine({ id: "buildbox", state: { kind: "unreachable" } })],
  });
  useDesk.setState({
    openId: null,
    sessions: {
      here: session("here", "desk-core"),
      "devbox/s1": session("devbox/s1", "remote-work", { machine: "devbox", state: "working" }),
      "devbox/s2": session("devbox/s2", "migration", { machine: "devbox", state: "blocked" }),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("gives each machine a heading with its status dot, and its own sessions under it", () => {
  render(<SidebarMachines />);
  const devbox = screen.getByRole("region", { name: "devbox" });
  expect(devbox.querySelector(".side-machine-head .dot-done")).toBeTruthy();
  const rows = within(within(devbox).getByRole("list", { name: "Sessions on devbox" })).getAllByRole("button");
  expect(rows.map((r) => r.querySelector(".gi-name")?.textContent)).toEqual(["migration", "remote-work"]);
  expect(devbox.textContent).toContain("needs you");
  expect(devbox.textContent).not.toContain("desk-core");

  const buildbox = screen.getByRole("region", { name: "buildbox" });
  expect(buildbox.querySelector(".side-machine-head .dot-blocked")).toBeTruthy();
  expect(buildbox.textContent).toContain("offline");
  expect(buildbox.textContent).toContain("No sessions");

  fireEvent.click(rows[1]!);
  expect(useDesk.getState().openId).toBe("devbox/s1");
});

it("shows no machine headings, and no This Mac heading, until there's a machine", () => {
  useMachines.setState({ machines: [] });
  const { container } = render(
    <>
      <ThisComputerHeading />
      <SidebarMachines />
    </>,
  );
  expect(container.textContent).toBe("");
  act(() => useMachines.setState({ machines: [machine({ id: "devbox" })] }));
  expect(screen.getByText("This Mac")).toBeTruthy();
});

it("refuses a session dragged onto another machine's section, in plain words, for a while", () => {
  vi.useFakeTimers();
  render(<SidebarMachines />);
  const buildbox = screen.getByRole("region", { name: "buildbox" });
  // The dragged chip is on top, outside every section.
  const chip = document.createElement("div");
  document.elementsFromPoint = vi.fn(() => [chip, buildbox.querySelector(".side-machine-head")!, buildbox]);
  let refused = false;
  act(() => void (refused = refuseAcross("devbox", { x: 10, y: 10 })));
  expect(refused).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("devbox’s sessions stay with devbox. Groups don’t mix machines, so it can’t move to buildbox.");
  // From this computer's groups, onto a machine.
  act(() => refuseAcross("local", { x: 10, y: 10 }));
  expect(screen.getByRole("status").textContent).toBe("This Mac’s sessions stay with this Mac. Groups don’t mix machines, so it can’t move to buildbox.");
  act(() => vi.advanceTimersByTime(REFUSAL_MS));
  expect(useRefusal.getState().text).toBeNull();
  // Its own section takes it.
  document.elementsFromPoint = vi.fn(() => [chip, screen.getByRole("region", { name: "devbox" })]);
  expect(refuseAcross("devbox", { x: 1, y: 1 })).toBe(false);
});

it("says a pane's machine, and when it can't be reached or was removed", () => {
  const { rerender, container } = render(<OnMachine machine="devbox" />);
  expect(container.textContent).toBe("on devbox");
  rerender(<OnMachine machine="buildbox" />);
  expect(container.textContent).toBe("on buildbox · offline");
  rerender(<OnMachine machine="gone" />);
  expect(container.textContent).toBe("machine removed");
  rerender(<OnMachine machine="local" />);
  expect(container.textContent).toBe("");
});
