import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFloor } from "../floor/store";
import { announce } from "../hub/store";
import { useMachines } from "../machines/engines";
import type { DeskHub } from "../hub/client";
import type { MemorySettings, SessionMemory } from "../hub/types";
import { RESTORE_WINDOW } from "./ForgetMemory";
import { KEYWORD_ONLY, MemoryPanel, NO_RECORD, UNDO_MS } from "./MemoryPanel";
import { acme, indexOf, note, notes, remembered, sessionOf, settingsOf } from "./testing";
import { clock } from "./words";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

type Fake = { [K in keyof DeskHub]: ReturnType<typeof vi.fn> };

/** A hub that answers the panel's reads with `memory`, and records the rest. */
const fakeHub = (memory: SessionMemory | null, settings: MemorySettings | null = settingsOf()): Fake =>
  ({
    sessionMemory: vi.fn(async () => memory),
    memoryIndex: vi.fn(async () => indexOf()),
    deriveMemory: vi.fn(async () => undefined),
    changeNote: vi.fn(async () => null),
    rememberSession: vi.fn(async () => undefined),
    forgetMemory: vi.fn(async () => undefined),
    pauseMemory: vi.fn(async () => settings),
    changeGroupMemory: vi.fn(async () => ({})),
    searchMemory: vi.fn(async () => ({ hits: [], keywordOnly: false, notice: null })),
  }) as unknown as Fake;

const show = async (hub: Fake, session = sessionOf()) => {
  render(<MemoryPanel session={session} name="atlas-api" hub={hub as unknown as DeskHub} />);
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
};

const realLoad = useFloor.getState().load;
beforeEach(() => {
  useFloor.setState({ hubs: {}, load: realLoad });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it("reads the Floor again after a forget, and says no summary once it has none", async () => {
    const floor = (gist: boolean) => ({
      state: "ready" as const,
      offset: 0,
      stale: false,
      at: null,
      usage: null,
      floor: {
        asOf: "2026-11-08T10:42:00Z",
        needs: [],
        working: [
          {
            who: { kind: "session" as const, id: "s1", name: "atlas-api", engine: "claude" as const },
            what: "",
            place: { kind: "session" } as never,
            since: "2026-11-08T10:00:00Z",
            heardAt: "2026-11-08T10:41:00Z",
            endedAt: null,
            outcome: null,
            gist: gist ? { purpose: "Making sign-in safe against a race.", now: "Tidying.", at: "2026-11-08T10:41:00Z" } : null,
          },
        ],
        done: [],
        lanes: [],
        counts: {} as never,
        more: { done: 0, lanes: 0 },
      },
    });
    const load = vi.fn(async (h: string) => useFloor.setState({ hubs: { [h]: floor(false) } }));
    useFloor.setState({ hubs: { local: floor(true) }, load });
    const hub = fakeHub(remembered());
    await show(hub);
    expect(screen.getByText("Making sign-in safe against a race.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget…" }));
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Forget" })));
    expect(load).toHaveBeenCalledWith("local");
    await waitFor(() => expect(screen.queryByText("Making sign-in safe against a race.")).toBeNull());
    expect(screen.getByText("Not said yet.")).toBeTruthy();
  });

  it("drops what waits to be dropped when the page goes", async () => {
    const hub = fakeHub(remembered());
    await show(hub);
    fireEvent.click(within(screen.getByText(/Sessions live in Postgres/).closest("li")!).getByRole("button", { name: "Drop" }));
    expect(hub.changeNote).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(hub.changeNote).toHaveBeenCalledWith("f1", { action: "drop" });
    fireEvent.click(within(screen.getByText(/Check the logout path/).closest("li")!).getByRole("button", { name: "Drop" }));
    window.dispatchEvent(new Event("beforeunload"));
    expect(hub.changeNote).toHaveBeenCalledWith("t1", { action: "drop" });
    // Once each.
    cleanup();
    expect(hub.changeNote).toHaveBeenCalledTimes(2);
  });

  it("never names a machine by its id", async () => {
    useMachines.setState({ machines: [] });
    const off = remembered({ notes: notes([], { noting: "off", reason: "group_off", why: "x" }), switches: { paused: false, group: acme() } });
    await show(fakeHub(off), sessionOf({ machine: "m-7f3a" }));
    expect(screen.getByText(/Memory settings for this machine's sessions come later\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain("m-7f3a");
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

    expect(hub.sessionMemory.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("drops a note only after a few seconds, and Undo keeps it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = fakeHub(remembered());
    await show(hub);
    const drop = (text: RegExp) => fireEvent.click(within(screen.getByText(text).closest("li")!).getByRole("button", { name: "Drop" }));
    drop(/Check the logout path/);
    expect(screen.getByText(/Dropped “Check the logout path/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Still to do (0)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("heading", { name: "Still to do (1)" })).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(UNDO_MS + 100));
    expect(hub.changeNote).not.toHaveBeenCalled();

    drop(/Sessions live in Postgres/);
    await act(async () => void vi.advanceTimersByTime(UNDO_MS + 100));
    expect(hub.changeNote).toHaveBeenCalledWith("f1", { action: "drop" });
  });

  it("drops what was waiting to be dropped when the panel closes", async () => {
    const hub = fakeHub(remembered());
    await show(hub);
    fireEvent.click(within(screen.getByText(/Sessions live in Postgres/).closest("li")!).getByRole("button", { name: "Drop" }));
    expect(hub.changeNote).not.toHaveBeenCalled();
    cleanup();
    expect(hub.changeNote).toHaveBeenCalledWith("f1", { action: "drop" });
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
    const hub = fakeHub(remembered({ remembering: false, why: "Remembering is paused for every session.", switches: { paused: true, group: null } }));
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
        fallbackProviders: true,
      }),
      switches: { paused: false, group: acme() },
    });
    const hub = fakeHub(off);
    await show(hub);
    const ask = screen.getByRole("group", { name: "Let Desk's model read Acme's sessions?" });
    expect(within(ask).getByText("Let Desk's model read Acme's sessions to note decisions?")).toBeTruthy();
    expect(ask.textContent).toContain("sent to Anthropic");
    expect(ask.textContent).toContain("another provider it's set up with");
    // Asked, not told twice.
    expect(screen.queryByText(/until you let its model read them/)).toBeNull();
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Let it read them" })));
    expect(hub.changeGroupMemory).toHaveBeenCalledWith("g-acme", { derive: true });
    // Let, its notes are made due again at once.
    expect(hub.deriveMemory).toHaveBeenCalledTimes(2);
  });

  it("once the group's answer was no, says why instead of asking again", async () => {
    const off = remembered({
      notes: notes([], { noting: "off", reason: "group_off", why: "Not for this group." }),
      switches: { paused: false, group: acme({ deriveDecided: true }) },
    });
    await show(fakeHub(off));
    expect(screen.queryByRole("group", { name: /Let Desk's model read/ })).toBeNull();
    expect(screen.getByText("Not for this group.")).toBeTruthy();
  });

  it("for a session on another machine, asks nothing of its group and says its settings come later", async () => {
    useMachines.setState({ machines: [{ id: "devbox", name: "devbox" } as never] });
    const off = remembered({
      notes: notes([], { noting: "off", reason: "group_off", why: "Desk doesn't note … in the group's settings." }),
      switches: { paused: false, group: acme() },
    });
    await show(fakeHub(off), sessionOf({ machine: "devbox" }));
    expect(screen.queryByRole("group", { name: /Let Desk's model read/ })).toBeNull();
    expect(screen.queryByText(/in the group's settings/)).toBeNull();
    expect(screen.getByText(/Memory settings for devbox's sessions come later\./)).toBeTruthy();
  });

  it("reads again when a setting changes on its hub", async () => {
    const hub = fakeHub(remembered());
    await show(hub);
    const before = hub.sessionMemory.mock.calls.length;
    await act(async () => announce({ type: "setting", key: "memory.paused" }));
    await waitFor(() => expect(hub.sessionMemory.mock.calls.length).toBe(before + 1));
    // Another machine's setting isn't this session's.
    await act(async () => announce({ type: "setting", key: "memory.paused", machine: "devbox" }));
    expect(hub.sessionMemory.mock.calls.length).toBe(before + 1);
  });

  it("leaves the switch out for a session Desk no longer has", async () => {
    await show(fakeHub(remembered({ cleared: true, memoryOn: false, remembering: false, why: "Desk no longer has this session." })));
    expect(screen.queryByRole("switch")).toBeNull();
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

  it("says when turning off couldn't keep what was said last", async () => {
    const hub = fakeHub(remembered());
    hub.rememberSession.mockResolvedValue("Remembering is off, but Desk couldn't read what this session said last, so some of it may not have been kept.");
    await show(hub);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Remember" })));
    expect(screen.getByRole("alert").textContent).toContain("some of it may not have been kept");
  });

  it("says why a switch couldn't be turned on, and keeps saying it after reading again", async () => {
    const hub = fakeHub(remembered({ memoryOn: false }));
    hub.rememberSession.mockRejectedValue(new Error("Desk couldn't turn remembering on just now; try again."));
    await show(hub);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Remember" })));
    expect(screen.getByRole("alert").textContent).toBe("Desk couldn't turn remembering on just now; try again.");
    expect(screen.getByRole("switch", { name: "Remember" }).getAttribute("aria-checked")).toBe("false");
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
    // Three held, and two replaced or dropped: all five go.
    const m = remembered();
    const hub = fakeHub({ ...m, notes: { ...m.notes, counts: { ...m.notes.counts, kept: 5 } } });
    await show(hub);
    fireEvent.click(screen.getByRole("button", { name: "Forget…" }));
    const dialog = screen.getByRole("dialog", { name: "Forget what Desk remembers of “atlas-api”?" });
    expect(dialog.textContent).toContain("This removes its 48 exchanges and 5 notes, and its summary, from Desk.");
    expect(dialog.textContent).toContain("Its cost history stays (numbers only).");
    expect(dialog.textContent).toContain(RESTORE_WINDOW);
    // The hub can't delete Claude Code's own record: not offered.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Forget" })));
    expect(hub.forgetMemory).toHaveBeenCalledWith("s1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says what the hub says of a forget whose work went on elsewhere before the dialog closes", async () => {
    const notice = "acme-api-codex was handed this work; its own conversation may still hold what it read.";
    const hub = fakeHub(remembered());
    hub.forgetMemory.mockResolvedValue(notice);
    // Once forgotten, nothing is remembered: the dialog stays to say it.
    hub.sessionMemory.mockResolvedValueOnce(remembered()).mockResolvedValue(null);
    await show(hub);
    fireEvent.click(screen.getByRole("button", { name: "Forget…" }));
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Forget" })));
    const told = await screen.findByRole("dialog", { name: "Desk forgot “atlas-api”" });
    expect(within(told).getByRole("status").textContent).toBe(notice);
    fireEvent.click(within(told).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
