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

  it("has switches and numbers for what Desk remembers, never a config file", async () => {
    await show(fakeHub(settingsOf()));
    const part = screen.getByRole("region", { name: "What Desk remembers" });
    expect(part.textContent).not.toMatch(/config|\[desk\.memory\]|settings file/i);
    expect(screen.getByRole("switch", { name: "Remember conversations" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Note decisions, facts and to-dos" }).getAttribute("aria-checked")).toBe("true");
    expect(part.textContent).toContain("at most 200 times a day (12 so far today), on Anthropic");
    expect((screen.getByLabelText(/Keep conversations for/) as HTMLInputElement).value).toBe("180");
    expect((screen.getByLabelText(/Room for Desk Memory/) as HTMLInputElement).value).toBe("4096");
    expect(part.textContent).toContain("goes back 30 days");
    expect(part.textContent).toContain("600 passages a minute");
  });

  it("turns remembering and noting off and on, kept by the hub", async () => {
    const hub = fakeHub(settingsOf());
    hub.chooseMemory = vi.fn(async (c: object) => {
      const s = settingsOf();
      return { ...s, limits: { ...s.limits, ...c } };
    });
    await show(hub);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Note decisions, facts and to-dos" })));
    expect(hub.chooseMemory).toHaveBeenCalledWith({ derive: false });
    expect(screen.getByRole("switch", { name: "Note decisions, facts and to-dos" }).getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Remember conversations" })));
    expect(hub.chooseMemory).toHaveBeenCalledWith({ enabled: false });
    expect((screen.getByRole("switch", { name: "Note decisions, facts and to-dos" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a number once the person leaves the field, and only one that can work", async () => {
    const hub = fakeHub(settingsOf());
    hub.chooseMemory = vi.fn(async (c: object) => {
      const s = settingsOf();
      return { ...s, limits: { ...s.limits, ...c } };
    });
    await show(hub);
    const days = screen.getByLabelText(/Keep conversations for/) as HTMLInputElement;
    fireEvent.change(days, { target: { value: "0" } });
    expect(screen.getByText("Between 1 and 3 650 days.")).toBeTruthy();
    fireEvent.blur(days);
    expect(hub.chooseMemory).not.toHaveBeenCalled();
    expect(days.value).toBe("180");
    // More: kept at once, and Enter then leaving the field asks once.
    fireEvent.change(days, { target: { value: "365" } });
    await act(async () => fireEvent.keyDown(days, { key: "Enter" }));
    await act(async () => fireEvent.blur(days));
    expect(hub.chooseMemory).toHaveBeenCalledTimes(1);
    expect(hub.chooseMemory).toHaveBeenCalledWith({ retainDays: 365 });
  });

  it("asks before keeping conversations for less, saying how many go", async () => {
    const hub = fakeHub(settingsOf());
    hub.chooseMemory = vi.fn(async (c: object) => {
      const s = settingsOf();
      return { ...s, limits: { ...s.limits, ...c } };
    });
    hub.memoryRetainPreview = vi.fn(async (days: number) => ({ days, exchanges: 42, sessions: 3 }));
    await show(hub);
    const days = screen.getByLabelText(/Keep conversations for/) as HTMLInputElement;
    fireEvent.change(days, { target: { value: "30" } });
    await act(async () => fireEvent.keyDown(days, { key: "Enter" }));
    expect(hub.memoryRetainPreview).toHaveBeenCalledWith(30);
    expect(hub.chooseMemory).not.toHaveBeenCalled();
    const ask = screen.getByRole("alertdialog", { name: "Keep conversations for less" });
    expect(ask.textContent).toContain("This deletes conversations older than 30 days (about 42 exchanges)");
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(hub.chooseMemory).not.toHaveBeenCalled();
    fireEvent.change(days, { target: { value: "31" } });
    await act(async () => fireEvent.keyDown(days, { key: "Enter" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete them" })));
    expect(hub.chooseMemory).toHaveBeenCalledWith({ retainDays: 31 });
  });

  it("holds a switch while its change is saved", async () => {
    const hub = fakeHub(settingsOf());
    let done: (s: unknown) => void = () => {};
    hub.chooseMemory = vi.fn(() => new Promise((r) => (done = r)));
    await show(hub);
    const remember = screen.getByRole("switch", { name: "Remember conversations" }) as HTMLButtonElement;
    await act(async () => fireEvent.click(remember));
    expect(remember.disabled).toBe(true);
    fireEvent.click(remember);
    expect(hub.chooseMemory).toHaveBeenCalledTimes(1);
    await act(async () => done(settingsOf()));
    expect(remember.disabled).toBe(false);
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
    expect(screen.getByText("This version of Desk doesn't keep Desk Memory's settings yet. Update Desk to change them.")).toBeTruthy();
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

  it("turns noting on for the Desk and the group from there, when it's off", async () => {
    const off = settingsOf({ limits: { ...settingsOf().limits, derive: false } });
    const hub = fakeHub(off);
    hub.chooseMemory = vi.fn(async () => settingsOf());
    render(<GroupMemoryDialog group={{ id: "g-acme", name: "Acme" }} hub={hub as unknown as DeskHub} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    expect((screen.getByRole("switch", { name: "Let Desk's model note decisions" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Noting is turned off for this Desk\./)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on noting for the whole Desk and this group" })));
    expect(hub.chooseMemory).toHaveBeenCalledWith({ enabled: true, derive: true });
    expect(hub.changeGroupMemory).toHaveBeenCalledWith("g-acme", { derive: true });
    const derive = screen.getByRole("switch", { name: "Let Desk's model note decisions" }) as HTMLButtonElement;
    expect(derive.disabled).toBe(false);
    expect(derive.getAttribute("aria-checked")).toBe("true");
  });

  it("says so when noting came on for the Desk but not the group", async () => {
    const hub = fakeHub(settingsOf({ limits: { ...settingsOf().limits, derive: false } }));
    hub.chooseMemory = vi.fn(async () => settingsOf());
    hub.changeGroupMemory = vi.fn(async () => Promise.reject(new Error("Desk couldn't reach the group.")));
    render(<GroupMemoryDialog group={{ id: "g-acme", name: "Acme" }} hub={hub as unknown as DeskHub} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on noting for the whole Desk and this group" })));
    expect(screen.getByRole("alert").textContent).toMatch(/^Noting is on for the whole Desk now, but not for Acme yet/);
  });
});
