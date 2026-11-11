import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { MemoryIndexStatus, MemorySettings } from "../hub/types";
import { GroupMemoryDialog } from "../memory/GroupMemory";
import { indexOf, settingsOf } from "../memory/testing";
import { Memory } from "./Memory";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const fakeHub = (settings: MemorySettings | null, index: MemoryIndexStatus | null = indexOf()) =>
  ({
    memorySettings: vi.fn(async () => settings),
    memoryIndex: vi.fn(async () => index),
    pauseMemory: vi.fn(async (paused: boolean) => ({ ...settings!, paused })),
    rebuildMemoryIndex: vi.fn(async () => 1234),
    changeGroupMemory: vi.fn(async (_id: string, change: object) => ({ ...settings!.groups[0]!, ...change, deriveDecided: true })),
  }) as unknown as { [K in keyof DeskHub]: ReturnType<typeof vi.fn> };

const show = async (hub: ReturnType<typeof fakeHub>) => {
  useDesk.setState({ hub: hub as unknown as DeskHub });
  render(<Memory />);
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
};

afterEach(cleanup);

describe("Settings → Memory", () => {
  it("shows what is kept, by group, and its size", async () => {
    await show(fakeHub(settingsOf()));
    expect(screen.getByText(/78 exchanges from 3 sessions · 7 notes · 3 secrets hidden · 120 MB of 4 096 MB/)).toBeTruthy();
    expect(screen.getByText("Ungrouped")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("48 exchanges from 1 session · 3 notes")).toBeTruthy();
  });

  it("pauses and resumes remembering", async () => {
    const hub = fakeHub(settingsOf());
    await show(hub);
    const pause = screen.getByRole("switch", { name: "Pause remembering" });
    expect(pause.getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(pause));
    expect(hub.pauseMemory).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch", { name: "Pause remembering" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Paused: nothing any session says now is kept/)).toBeTruthy();
  });

  it("says how search stands: its backlog, what failed and what was set aside", async () => {
    await show(fakeHub(settingsOf(), indexOf({ backlog: 12, setAside: 3, purgesSetAside: 1, failing: "connection refused" })));
    expect(screen.getByText("Desk Memory's search isn't answering, so Desk searches by keyword until it does.")).toBeTruthy();
    expect(screen.getByText("12 exchanges waiting to be added to search; until then they're found by keyword.")).toBeTruthy();
    expect(screen.getByText("3 exchanges search kept refusing, set aside: they're found by keyword.")).toBeTruthy();
    expect(screen.getByText(/still in its search\. Rebuild it to clear them/)).toBeTruthy();
    // Never the raw error.
    expect(screen.queryByText(/connection refused/)).toBeNull();
  });

  it("rebuilds search, and says how much it adds again", async () => {
    const hub = fakeHub(settingsOf());
    await show(hub);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rebuild search" })));
    expect(hub.rebuildMemoryIndex).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Rebuilding: 1 234 exchanges to add again.");
  });

  it("says search by meaning isn't set up, with nothing to rebuild", async () => {
    await show(fakeHub(settingsOf(), indexOf({ installed: false })));
    expect(screen.getByText(/isn't set up on this computer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rebuild search" })).toBeNull();
  });

  it("lists the install's limits, read only", async () => {
    await show(fakeHub(settingsOf()));
    const limits = screen.getByRole("region", { name: "Limits" });
    expect(limits.textContent).toContain("kept 180 days after they end");
    expect(limits.textContent).toContain("goes back 30 days");
    expect(limits.textContent).toContain("up to 4 096 MB");
    expect(limits.textContent).toContain("600 passages a minute");
    expect(limits.textContent).toContain("at most 200 times a day (12 so far today), on Anthropic");
    expect(limits.querySelector("input, button")).toBeNull();
  });

  it("shows what loaded when another part fails, and says why", async () => {
    const hub = fakeHub(settingsOf());
    hub.memoryIndex.mockRejectedValue(new Error("Desk didn't answer."));
    await show(hub);
    expect(screen.getByRole("alert").textContent).toContain("Desk didn't answer.");
    expect(screen.getByRole("switch", { name: "Pause remembering" })).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("says so on a hub that keeps no memory settings", async () => {
    await show(fakeHub(null, null));
    expect(screen.getByText("This computer's hub doesn't keep Desk Memory's settings yet.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("a group's memory", () => {
  it("shows its two switches and saves each as it is switched", async () => {
    const hub = fakeHub(settingsOf());
    render(<GroupMemoryDialog group={{ id: "g-acme", name: "Acme" }} hub={hub as unknown as DeskHub} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Memory for Acme" });
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    expect(screen.getByRole("switch", { name: "Remember its sessions" }).getAttribute("aria-checked")).toBe("true");
    const derive = screen.getByRole("switch", { name: "Let Desk's model note decisions" });
    expect(derive.getAttribute("aria-checked")).toBe("false");
    expect(dialog.textContent).toContain("sent to Anthropic");
    await act(async () => fireEvent.click(derive));
    expect(hub.changeGroupMemory).toHaveBeenCalledWith("g-acme", { derive: true });
    expect(screen.getByRole("switch", { name: "Let Desk's model note decisions" }).getAttribute("aria-checked")).toBe("true");
    // Handing work on doesn't exist yet: nothing to ask about.
    expect(screen.queryByRole("switch", { name: /handing its work on/ })).toBeNull();
  });

  it("names the fallback provider where the person agrees to the model reading", async () => {
    const hub = fakeHub(settingsOf({ limits: { ...settingsOf().limits, fallbackProviders: true } }));
    render(<GroupMemoryDialog group={{ id: "g-acme", name: "Acme" }} hub={hub as unknown as DeskHub} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Memory for Acme" });
    await waitFor(() => expect(dialog.textContent).toContain("another provider it's set up with"));
  });

  it("can't let the model note when noting is off for this Desk", async () => {
    const hub = fakeHub(settingsOf({ limits: { ...settingsOf().limits, derive: false } }));
    render(<GroupMemoryDialog group={{ id: "g-acme", name: "Acme" }} hub={hub as unknown as DeskHub} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    expect((screen.getByRole("switch", { name: "Let Desk's model note decisions" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Noting is turned off for this Desk.")).toBeTruthy();
  });
});
