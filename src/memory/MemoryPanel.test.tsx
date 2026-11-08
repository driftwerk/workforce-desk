import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFloor } from "../floor/store";
import { useHubLayout } from "../groups/hubLayout";
import type { DeskHub } from "../hub/client";
import type { MemorySettings, SessionMemory } from "../hub/types";
import { RESTORE_WINDOW } from "./ForgetMemory";
import { KEYWORD_ONLY, MemoryPanel, NO_RECORD } from "./MemoryPanel";
import { indexOf, note, notes, remembered, sessionOf, settingsOf } from "./testing";
import { clock } from "./words";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

type Fake = { [K in keyof DeskHub]: ReturnType<typeof vi.fn> };

/** A hub that answers the panel's reads with `memory`, and records the rest. */
const fakeHub = (memory: SessionMemory | null, settings: MemorySettings | null = settingsOf()): Fake =>
  ({
    sessionMemory: vi.fn(async () => memory),
    memorySettings: vi.fn(async () => settings),
    memoryIndex: vi.fn(async () => indexOf()),
    deriveMemory: vi.fn(async () => undefined),
    changeNote: vi.fn(async () => null),
    rememberSession: vi.fn(async () => undefined),
    forgetMemory: vi.fn(async () => undefined),
    pauseMemory: vi.fn(async () => settings),
    changeGroupMemory: vi.fn(async () => ({})),
    searchMemory: vi.fn(async () => ({ hits: [], keywordOnly: false, notice: null })),
  }) as unknown as Fake;

const show = async (hub: Fake, opts: { inGroup?: boolean } = {}) => {
  useHubLayout.setState({
    layout: {
      groups: [{ id: "g-acme", name: "Acme", collapsed: false, items: opts.inGroup ? ["session:s1"] : [] }],
      ungrouped: { collapsed: false, items: [] },
    },
  });
  render(<MemoryPanel session={sessionOf()} name="atlas-api" item="session:s1" hub={hub as unknown as DeskHub} />);
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
};

beforeEach(() => {
  useFloor.setState({ hubs: {} });
});
afterEach(() => {
  cleanup();
  useHubLayout.setState({ layout: null });
});

describe("what Desk remembers of a session", () => {
  it("asks for notes as it opens, and shows what it's for, its notes, the files it changed and how much is kept", async () => {
    useFloor.setState({
      hubs: {
        local: {
          state: "ready",
          offset: 0,
          stale: false,
          at: null,
          usage: null,
          floor: {
            asOf: "2026-11-08T10:42:00Z",
            needs: [],
            working: [
              {
                who: { kind: "session", id: "s1", name: "atlas-api", engine: "claude" },
                what: "",
                place: { kind: "session" } as never,
                since: "2026-11-08T10:00:00Z",
                heardAt: "2026-11-08T10:41:00Z",
                endedAt: null,
                outcome: null,
                gist: { purpose: "Making sign-in safe against a race.", now: "The fix is in and the tests pass.", at: "2026-11-08T10:41:00Z" },
              },
            ],
            done: [],
            lanes: [],
            counts: {} as never,
            more: { done: 0, lanes: 0 },
          },
        },
      },
    });
    const hub = fakeHub(remembered());
    await show(hub);
    expect(hub.deriveMemory).toHaveBeenCalledWith("s1");
    expect(screen.getByText("Making sign-in safe against a race.")).toBeTruthy();
    expect(screen.getByText("The fix is in and the tests pass.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Decisions (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Still to do (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Facts (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /auth\/signin\.ts, auth\/session\.ts/ })).toBeTruthy();
    expect(screen.getByText(`Remembered: 48 exchanges · 2 secrets hidden · last read ${clock("2026-11-08T10:41:00Z")}`)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Remember" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says what a note is for when asked, naming whose model wrote it", async () => {
    await show(fakeHub(remembered()));
    fireEvent.click(screen.getByRole("button", { name: /noted by Desk/ }));
    expect(screen.getByText(/may be wrong/).textContent).toContain("sent to Anthropic, under the hub's own account");
  });

  it("confirms, corrects inline and drops a note, and reads again after each", async () => {
    const hub = fakeHub(remembered());
    await show(hub);
    const decision = screen.getByText(/Keep the session token/).closest("li")!;
    await act(async () => fireEvent.click(within(decision).getByRole("button", { name: "Confirm" })));
    expect(hub.changeNote).toHaveBeenLastCalledWith("d1", { action: "confirm" });

    fireEvent.click(within(screen.getByText(/Sessions live in Postgres/).closest("li")!).getByRole("button", { name: "Correct" }));
    const box = screen.getByRole("textbox", { name: "What the note should say" });
    fireEvent.change(box, { target: { value: "Sessions live in Redis." } });
    await act(async () => fireEvent.submit(box.closest("form")!));
    expect(hub.changeNote).toHaveBeenLastCalledWith("f1", { action: "correct", text: "Sessions live in Redis." });

    await act(async () => fireEvent.click(within(screen.getByText(/Check the logout path/).closest("li")!).getByRole("button", { name: "Drop" })));
    expect(hub.changeNote).toHaveBeenLastCalledWith("t1", { action: "drop" });
    expect(hub.sessionMemory.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("shows a replaced note as replaced, with its time, and a confirmed one as confirmed", async () => {
    const m = remembered({
      notes: notes([note("d2", "decision", "Retry sign-in once, then show the error.", { confirmed: true })], {
        replaced: [{ id: "d0", kind: "decision", text: "Retry sign-in three times.", replacedAt: "2026-11-08T10:20:00Z" }],
      }),
    });
    await show(fakeHub(m));
    expect(screen.getByText("Retry sign-in three times.").tagName).toBe("S");
    expect(screen.getByText(`(replaced ${clock("2026-11-08T10:20:00Z")})`)).toBeTruthy();
    const kept = screen.getByText(/Retry sign-in once/).closest("li")!;
    expect(within(kept).getByText("confirmed")).toBeTruthy();
    expect(within(kept).queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("says when the engine keeps no record Desk can read, and shows nothing else", async () => {
    await show(fakeHub(remembered({ noRecord: true, counts: { exchanges: 0, open: 0, compactions: 0, secretsHidden: 0, pastCap: 0 } })));
    expect(screen.getByText(NO_RECORD)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Forget…" })).toBeNull();
  });

  it("says when it remembers nothing of the session", async () => {
    await show(fakeHub(null));
    expect(screen.getByText("Desk hasn't remembered anything of this session yet.")).toBeTruthy();
  });

  it("while paused, says so and resumes from here", async () => {
    const hub = fakeHub(remembered({ remembering: false, why: "Remembering is paused for every session." }), settingsOf({ paused: true }));
    await show(hub);
    expect(screen.getByRole("status").textContent).toContain("Remembering is paused for every session.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resume remembering" })));
    expect(hub.pauseMemory).toHaveBeenCalledWith(false);
  });

  it("asks once whether Desk's model may read the group's sessions, and writes the answer to the group", async () => {
    const off = remembered({
      notes: notes([], {
        noting: "off",
        reason: "group_off",
        why: "Desk doesn't note decisions, facts or to-dos from this group's sessions until you let its model read them, in the group's settings.",
      }),
    });
    const hub = fakeHub(off);
    await show(hub, { inGroup: true });
    const ask = screen.getByRole("group", { name: "Let Desk's model read Acme's sessions?" });
    expect(within(ask).getByText("Let Desk's model read Acme's sessions to note decisions?")).toBeTruthy();
    expect(ask.textContent).toContain("sent to Anthropic");
    // Asked, not told twice.
    expect(screen.queryByText(/until you let its model read them/)).toBeNull();
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Let it read them" })));
    expect(hub.changeGroupMemory).toHaveBeenCalledWith("g-acme", { derive: true });
    // Let, its notes are made due again at once.
    expect(hub.deriveMemory).toHaveBeenCalledTimes(2);
  });

  it("once the group's answer was no, says why instead of asking again", async () => {
    const off = remembered({ notes: notes([], { noting: "off", reason: "group_off", why: "Not for this group." }) });
    const hub = fakeHub(off, settingsOf({ groups: [{ id: "g-acme", name: "Acme", harvest: true, derive: false, handoffAsk: true, deriveDecided: true }] }));
    await show(hub, { inGroup: true });
    expect(screen.queryByRole("group", { name: /Let Desk's model read/ })).toBeNull();
    expect(screen.getByText("Not for this group.")).toBeTruthy();
  });

  it("says when the day's notes are spent", async () => {
    const capped = remembered({ notes: notes([], { noting: "paused", reason: "day_cap", why: "Desk has noted as much as it may today, so noting is paused until tomorrow." }) });
    await show(fakeHub(capped));
    expect(screen.getByText("Desk has noted as much as it may today, so noting is paused until tomorrow.")).toBeTruthy();
  });

  it("turns remembering off for this session", async () => {
    const hub = fakeHub(remembered());
    await show(hub);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Remember" })));
    expect(hub.rememberSession).toHaveBeenCalledWith("s1", false);
  });

  it("leaves the switch out for a hub that can't set it", async () => {
    await show(fakeHub(remembered({ memoryOn: undefined })));
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("searches this work, and says when only by keyword", async () => {
    const hub = fakeHub(remembered());
    hub.memoryIndex.mockResolvedValue(indexOf({ installed: false }));
    hub.searchMemory.mockResolvedValue({
      hits: [{ kind: "decision", answer: "Keep the token in a secure cookie.", ask: "", at: "2026-11-08T10:12:00Z" }],
      keywordOnly: true,
      notice: KEYWORD_ONLY,
    });
    await show(hub);
    fireEvent.click(screen.getByRole("button", { name: "Search this work" }));
    expect(screen.getByText(KEYWORD_ONLY)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cookie" } });
    await act(async () => fireEvent.submit(screen.getByRole("search")));
    expect(hub.searchMemory).toHaveBeenCalledWith({ q: "cookie", session: "s1", limit: 20 });
    expect(screen.getByText("Keep the token in a secure cookie.")).toBeTruthy();
  });

  it("forgets after saying exactly what goes, what stays, and the restore window", async () => {
    const hub = fakeHub(remembered());
    await show(hub);
    fireEvent.click(screen.getByRole("button", { name: "Forget…" }));
    const dialog = screen.getByRole("dialog", { name: "Forget what Desk remembers of “atlas-api”?" });
    expect(dialog.textContent).toContain("This removes its 48 exchanges and 3 notes from Desk.");
    expect(dialog.textContent).toContain("Its cost history stays (numbers only).");
    expect(dialog.textContent).toContain(RESTORE_WINDOW);
    // The hub can't delete Claude Code's own record: not offered.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Forget" })));
    expect(hub.forgetMemory).toHaveBeenCalledWith("s1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
