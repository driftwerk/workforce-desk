import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlans } from "../crew/planStore";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { BossPlanDetail, EngineInfo } from "../hub/types";
import { useMachines } from "../machines/engines";
import { fakeNative, foldersTransport, machine, noEngines, withEngine } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { useSettings } from "../settings/store";
import { ticket as planTicket } from "../crew/planTesting";
import { StartSession } from "./StartSession";
import { useBoard } from "./store";
import { ACME, ticket } from "./testing";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  machineHome: vi.fn(async () => "/home/dev"),
  inApp: false,
  pickFolder: vi.fn(async () => null),
  claudePluginDir: vi.fn(async () => null),
  programsUnder: vi.fn(async () => []),
  saveSettings: vi.fn(async () => {}),
}));

const t = ticket(7, { title: "Fix the flaky payment test on checkout" });
const engine = (e: Partial<EngineInfo> & Pick<EngineInfo, "engine" | "title">): EngineInfo => ({
  program: e.engine,
  installed: true,
  version: "1.0.0",
  signIn: { state: "unknown" },
  views: ["terminal"],
  caps: {},
  ...e,
});

const assign = vi.fn();
const ticketStartText = vi.fn();
const machineStart = vi.fn();
const machineName = vi.fn();
const localFeatures = vi.fn();
const folders = foldersTransport({ home: "/home/dev", folders: [{ path: "/home/dev/src/workforce", git: true }] }, []);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  useHost.setState(DEFAULT_HOST);
  assign.mockReset().mockImplementation(async () => ({ ...t, assignee: { kind: "session", id: "devbox/s-9", name: "ACM-7", engine: "claude" } }));
  ticketStartText.mockReset().mockResolvedValue({ name: "ACM-7", goal: "ACM-7 · Fix the flaky payment test on checkout", prompt: "ACM-7 is yours: Fix the flaky payment test on checkout\n\nnot on devbox" });
  machineStart.mockReset().mockResolvedValue({ id: "s-9", name: "ACM-7" });
  machineName.mockReset().mockResolvedValue({ id: "s-9", name: "ACM-7" });
  localFeatures.mockReset().mockResolvedValue(["session-model", "ticket-start-on"]);
  useSettings.setState({ groups: [], ungrouped: { collapsed: false, items: [] }, sessionNames: {} });
  useDesk.setState({
    hub: { engines: async () => [engine({ engine: "claude", title: "Claude Code" })], features: localFeatures, assignTicket: assign, ticketStartText } as unknown as DeskHub,
    sessions: {},
  });
  noEngines();
  withEngine("devbox", {
    start: machineStart,
    nameSession: machineName,
    features: async () => ["session-model"],
    engines: async () => [engine({ engine: "claude", title: "Claude Code" }), engine({ engine: "codex", title: "Codex", installed: false, views: [] })],
  } as unknown as DeskHub);
  useMachines.setState({ listed: true, machines: [machine({ id: "devbox" }), machine({ id: "buildbox", state: { kind: "unreachable" } })] });
  useBoard.setState({ boards: { [ACME.id]: { ...ACME, group: null } }, tickets: { [t.id]: t } });
  usePlans.setState({ details: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const open = async (native = fakeNative({ transport: vi.fn(() => folders) }).native) => {
  render(<StartSession ticket={t} onClose={() => {}} native={native} />);
  await act(async () => {});
};

describe("Start a session on a ticket: where it runs", () => {
  it("offers Run on once there's a machine, and an offline one can't be chosen", async () => {
    await open();
    const mac = screen.getByRole("radio", { name: "This Mac" });
    expect(mac.getAttribute("aria-checked")).toBe("true");
    const off = screen.getByRole("radio", { name: "buildbox · offline" });
    expect(off.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(off);
    expect(mac.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Choose…" })).toBeTruthy();
  });

  it("offers no Run on, and no model, to a hub that can't start a ticket's session there", async () => {
    localFeatures.mockResolvedValue([]);
    await open();
    expect(screen.queryByRole("radiogroup", { name: "Run on" })).toBeNull();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("hides Run on with no machines", async () => {
    useMachines.setState({ machines: [] });
    await open();
    expect(screen.queryByRole("radiogroup", { name: "Run on" })).toBeNull();
  });

  it("goes by the ticket's own machine, folder and model when its plan gave it them", async () => {
    const planned = planTicket(7, "Fix it", { id: t.id, machine: "devbox", folder: "/home/dev/src/workforce", model: "opus" });
    usePlans.setState({ details: { p1: { id: "p1", tickets: [planned] } as unknown as BossPlanDetail } });
    await open();
    expect(screen.getByRole("radio", { name: "devbox" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Folder on devbox") as HTMLInputElement).value).toBe("/home/dev/src/workforce");
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("opus");
  });

  it("goes by the board's last start, machine and model too, else this Mac", async () => {
    localStorage.setItem(`desk.board.start.${t.board}`, JSON.stringify({ cwd: "~/src/workforce", engine: "claude", machine: "devbox", model: "sonnet" }));
    await open();
    expect(screen.getByRole("radio", { name: "devbox" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet");
    cleanup();
    localStorage.clear();
    await open();
    expect(screen.getByRole("radio", { name: "This Mac" }).getAttribute("aria-checked")).toBe("true");
  });

  it("falls back to this Mac when the machine it went by can't take a session now", async () => {
    localStorage.setItem(`desk.board.start.${t.board}`, JSON.stringify({ cwd: "~", engine: "claude", machine: "buildbox" }));
    await open();
    expect(screen.getByRole("radio", { name: "This Mac" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Start a session on a ticket: on a machine", () => {
  it("starts it there with the folder, engine, model and ticket's words, then gives it the ticket", async () => {
    const { native, fake } = fakeNative({ transport: vi.fn(() => folders) });
    await open(native);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "devbox" })));
    expect(screen.queryByRole("button", { name: "Choose…" })).toBeNull();
    expect(screen.getByText("Codex isn’t installed on devbox.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Folder on devbox"), { target: { value: "~/src/workforce" } });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "opus" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start session" })));
    await waitFor(() => expect(assign).toHaveBeenCalled());

    expect(ticketStartText).toHaveBeenCalledWith("t7", "devbox");
    expect(machineStart).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "claude",
        cwd: "/home/dev/src/workforce",
        model: "opus",
        name: "ACM-7",
        goal: "ACM-7 · Fix the flaky payment test on checkout",
        prompt: expect.stringContaining("ACM-7 is yours"),
        env: { CLAUDE_CODE_PLUGIN_DIRS: "/home/dev/.local/share/Desk/bin/current/claude-plugin" },
      }),
    );
    expect(fake.pluginDir).toHaveBeenCalledWith("devbox");
    expect(assign).toHaveBeenCalledWith("t7", { machineSession: { machine: "devbox", id: "s-9", name: "ACM-7" } });
    expect(JSON.parse(localStorage.getItem(`desk.board.start.${t.board}`)!)).toEqual({ cwd: "~/src/workforce", engine: "claude", machine: "devbox", model: "opus" });
    // Named on its own machine, short, as a local one is.
    expect(machineName).toHaveBeenCalledWith("s-9", "ACM-7 Fix the flaky");
  });

  it("says plainly when the session started but the ticket couldn't be given to it", async () => {
    assign.mockRejectedValue(new Error("the hub went away"));
    await open();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "devbox" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start session" })));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("did start on devbox");
    expect(alert.textContent).toContain("don’t start another");
  });

  it("starts here with the model chosen, as before", async () => {
    await open();
    fireEvent.change(screen.getByPlaceholderText("Choose a folder, or type its path"), { target: { value: "/w/repo" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "haiku" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start session" })));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledWith("t7", { newSession: { path: "/w/repo", engine: "claude", model: "haiku" } });
    expect(machineStart).not.toHaveBeenCalled();
  });
});
