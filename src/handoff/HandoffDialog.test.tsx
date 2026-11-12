// Continue in another engine: the dialog's preview (asked with derive=1 once,
// as it opens), the group's ask before the brief leaves, the hub's
// refusals in its own words and the goal-only start, hand back, and the
// lineage chips on both sessions' cards, which never ask for a brief.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { HandoffPreview, Session } from "../hub/types";
import { sessionOf } from "../memory/testing";
import { clock } from "../floor/time";
import { HandoffDialog } from "./HandoffDialog";
import { LineageChips } from "./LineageChips";
import { useHandoff } from "./store";
import { useUpdates } from "../updates/store";
import { ENGINES, continuedLineage, handedLineage, previewOf } from "./testing";
import { backLine, defaultsLine } from "./words";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

type Fake = { [K in keyof DeskHub]: ReturnType<typeof vi.fn> };

const SOURCE = sessionOf({ id: "s1", name: "acme-api", cwd: "/dev/acme-api", live: true, state: "idle" });

const fakeHub = (preview: (q: Record<string, unknown>) => Promise<HandoffPreview> = async (q) => previewOf({ engine: (q.engine as "codex") ?? "codex" })): Fake =>
  ({
    engines: vi.fn(async () => ENGINES),
    accounts: vi.fn(async () => null),
    handoffPreview: vi.fn((_id: string, q: Record<string, unknown>) => preview(q)),
    handoff: vi.fn(async () => ({
      session: sessionOf({ id: "s2", name: "acme-api", engine: "codex" }),
      included: previewOf().included,
      said: "Handed over: the goal, 3 decisions, 2 open to-dos and the last 6 of 48 exchanges. The rest can be searched.",
      egress: "The brief goes to OpenAI, through Codex.",
      notes: [],
    })),
    lineage: vi.fn(async () => ({ work: "s1", from: null, handedTo: null, sessions: ["s1"] })),
  }) as unknown as Fake;

let hub: Fake;
const opened: (string | null)[] = [];

const use = (h: Fake, sessions: Session[] = [SOURCE]) => {
  hub = h;
  useDesk.setState({
    hub: h as unknown as DeskHub,
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    open: (id: string | null) => void opened.push(id),
  });
};

const openDialog = async (ask: { id: string; back?: boolean } = { id: "s1" }) => {
  render(<HandoffDialog />);
  act(() => useHandoff.getState().open(ask));
  await waitFor(() => expect(hub.handoffPreview).toHaveBeenCalled());
};

const dialog = () => screen.getByRole("dialog");
const button = (name: string | RegExp) => within(dialog()).getByRole("button", { name }) as HTMLButtonElement;
/** Shows the choices folded behind the line saying the defaults. */
const change = () => fireEvent.click(button("Change where it goes"));

beforeEach(() => {
  opened.length = 0;
  useHandoff.setState({ asking: null, lineage: {}, told: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("continuing a session in another engine", () => {
  it("previews the brief as it opens, with Desk's notes asked for that once, and continues as shown", async () => {
    use(fakeHub());
    await openDialog();
    expect(hub.handoffPreview).toHaveBeenCalledTimes(1);
    expect(hub.handoffPreview).toHaveBeenLastCalledWith("s1", { engine: "codex", account: undefined, place: "same_folder", back: false, goalOnly: false }, true);
    await waitFor(() => expect(dialog().textContent).toContain("Codex gets: what it's for"));
    const text = dialog().textContent!;
    expect(text).toContain("It leaves out 42 older exchanges.");
    expect(text).toContain("It can search the rest of this work.");
    expect(text).toContain(`About ${(9120).toLocaleString()} of ${(13600).toLocaleString()} tokens`);
    expect(text).toContain("The brief goes to OpenAI, through Codex.");
    // The brief itself is folded until asked for.
    expect(within(dialog()).queryByLabelText("The brief")).toBeNull();
    fireEvent.click(button("Preview brief"));
    expect(within(dialog()).getByLabelText("The brief").textContent).toContain("# Handoff brief");
    // An idle source stops now, by default; a group that doesn't ask has no checkbox.
    change();
    expect((within(dialog()).getByRole("radio", { name: /Stop it now/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();

    // Another choice is previewed again, never with derive.
    fireEvent.click(within(dialog()).getByRole("radio", { name: /New worktree from its branch/ }));
    await waitFor(() => expect(hub.handoffPreview).toHaveBeenCalledTimes(2));
    expect(hub.handoffPreview).toHaveBeenLastCalledWith("s1", expect.objectContaining({ place: "new_worktree" }), false);

    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", { engine: "codex", place: "new_worktree", source: "stop" });
    expect(opened).toEqual(["s2"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useHandoff.getState().told.s2?.said).toContain("Handed over:");
  });

  it("waits for the person's yes where the group asks before each handoff, and sends it", async () => {
    use(fakeHub(async () => previewOf({ ask: true })));
    await openDialog();
    const yes = await within(dialog()).findByRole("checkbox", { name: /Send this brief to OpenAI/ });
    expect(button("Continue in Codex").disabled).toBe(true);
    fireEvent.click(yes);
    expect(button("Continue in Codex").disabled).toBe(false);
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", expect.objectContaining({ engine: "codex", egressConfirmed: true }));
  });

  it("asks for the yes again once another engine, and so another vendor, is chosen", async () => {
    use(fakeHub(async (q) => (q.engine === "claude" ? previewOf({ ask: true, engine: "claude", vendor: "Anthropic", egress: "The brief goes to Anthropic, through Claude Code." }) : previewOf({ ask: true }))));
    await openDialog();
    fireEvent.click(await within(dialog()).findByRole("checkbox", { name: /Send this brief to OpenAI/ }));
    expect(button("Continue in Codex").disabled).toBe(false);
    change();
    fireEvent.click(within(dialog()).getByRole("radio", { name: "Claude Code" }));
    const yes = (await within(dialog()).findByRole("checkbox", { name: /Send this brief to Anthropic/ })) as HTMLInputElement;
    expect(yes.checked).toBe(false);
    expect(button("Continue in Claude Code").disabled).toBe(true);
    expect(hub.handoff).not.toHaveBeenCalled();
  });

  it("asks for the yes when the hub says the group started asking after the preview", async () => {
    use(fakeHub());
    hub.handoff.mockRejectedValueOnce(new HubError(409, "The brief goes to OpenAI, through Codex. This group asks before each handoff: confirm it to go on."));
    await openDialog();
    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(within(dialog()).getByRole("alert").textContent).toContain("This group asks before each handoff");
    expect(button("Continue in Codex").disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole("checkbox"));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenLastCalledWith("s1", expect.objectContaining({ egressConfirmed: true }));
  });

  it("says a refusal in the hub's words, and offers only the goal where the hub previews it", async () => {
    const noRecord = "Desk can't read Claude Code conversations, so it can't hand this one over. Start Codex here with only the goal instead.";
    use(fakeHub(async (q) => (q.goalOnly ? previewOf({ content: "goal_only", gets: "Codex gets: what it's for." }) : Promise.reject(new HubError(409, noRecord)))));
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByRole("alert").textContent).toBe(noRecord));
    expect(button("Continue in Codex").disabled).toBe(true);
    await act(async () => fireEvent.click(await within(dialog()).findByRole("button", { name: "Start Codex here with only the goal" })));
    await waitFor(() => expect(dialog().textContent).toContain("Codex gets: what it's for."));
    await act(async () => fireEvent.click(button("Start Codex with the goal")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", expect.objectContaining({ engine: "codex", goalOnly: true }));
  });

  it("offers no goal-only start where the refusal is about something else", async () => {
    const cross = "Work can't be handed to a session in another group.";
    use(fakeHub(async () => Promise.reject(new HubError(409, cross))));
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByRole("alert").textContent).toBe(cross));
    // The goal-only probe was asked, and refused too.
    await waitFor(() => expect(hub.handoffPreview).toHaveBeenCalledTimes(2));
    expect(within(dialog()).queryByRole("button", { name: /only the goal/ })).toBeNull();
  });

  it("hands the work back to the session it came from, with only what is new", async () => {
    const back = { session: "s0", name: "acme-api", engine: "claude" as const, at: null };
    const target = sessionOf({ id: "s2", name: "acme-api-codex", engine: "codex", live: true, state: "idle" });
    use(
      fakeHub(async (q) => previewOf({ engine: q.back ? "claude" : "codex", back, gets: q.back ? "Claude Code gets: what happened since." : previewOf().gets })),
      [target],
    );
    await openDialog({ id: "s2" });
    const handBack = await within(dialog()).findByRole("radio", { name: /Hand back to acme-api \(Claude Code\)/ });
    fireEvent.click(handBack);
    await waitFor(() => expect(hub.handoffPreview).toHaveBeenLastCalledWith("s2", expect.objectContaining({ back: true, engine: undefined }), false));
    await waitFor(() => expect(dialog().textContent).toContain("Claude Code gets: what happened since."));
    await act(async () => fireEvent.click(button("Hand back to acme-api")));
    expect(hub.handoff).toHaveBeenCalledWith("s2", { back: true, engine: "claude", source: "stop" });
  });

  it("keeps one running in another terminal, which Desk can't stop, and stops one in a turn after it", async () => {
    use(fakeHub(), [{ ...SOURCE, live: false, origin: "external", state: "working" }]);
    await openDialog();
    change();
    const elsewhere = within(within(dialog()).getByRole("radiogroup", { name: "This one" })).getAllByRole("radio");
    expect(elsewhere.map((r) => r.closest("label")!.textContent)).toEqual(["Keep it runningit runs in another terminal: end it there when you’re done"]);
    cleanup();
    use(fakeHub(), [{ ...SOURCE, state: "working" }]);
    await openDialog();
    change();
    expect((within(dialog()).getByRole("radio", { name: /Stop it after this turn/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("offers only Keep for a session in a Desk terminal, which the person ends", async () => {
    use(fakeHub(), [{ ...SOURCE, terminalId: "t1" }]);
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("this one keeps running"));
    change();
    const options = within(within(dialog()).getByRole("radiogroup", { name: "This one" })).getAllByRole("radio");
    expect(options).toHaveLength(1);
    expect((options[0] as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", expect.objectContaining({ source: "keep" }));
  });
});

describe("a handoff with a default", () => {
  it("says the defaults in plain words", () => {
    expect(defaultsLine({ engine: "Codex", account: "Work", place: "same_folder", source: "after_turn", running: true })).toBe(
      "Continues in Codex on Work, in this folder; this one stops after its turn.",
    );
    expect(defaultsLine({ engine: "Claude Code", place: "new_worktree", source: "stop", running: false })).toBe(
      "Continues in Claude Code, in a new worktree; this one stays stopped.",
    );
    expect(backLine({ to: "acme-api", source: "stop", running: true })).toBe("Hands the work back to acme-api; this one stops now.");
    expect(defaultsLine({ engine: "Codex", place: "same_folder", source: "stop", running: true, goalOnly: true })).toBe(
      "Starts Codex with the goal, in this folder; this one stops now.",
    );
  });

  it("says in one line how it goes, and continues so with no choice made", async () => {
    use(fakeHub());
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("Continues in Codex, in this folder; this one stops now."));
    // The choices are folded until asked for.
    expect(within(dialog()).queryByRole("radiogroup", { name: "Engine" })).toBeNull();
    expect(within(dialog()).queryByRole("radiogroup", { name: "Where" })).toBeNull();
    expect(within(dialog()).queryByRole("radiogroup", { name: "This one" })).toBeNull();
    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", { engine: "codex", place: "same_folder", source: "stop" });
  });

  it("shows the choices on Change, and the line follows what is chosen", async () => {
    use(fakeHub());
    await openDialog();
    change();
    const toggle = button("Hide the choices");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.hidden).toBe(false);
    fireEvent.click(within(dialog()).getByRole("radio", { name: /New worktree from its branch/ }));
    fireEvent.click(within(dialog()).getByRole("radio", { name: /Keep it running/ }));
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("Continues in Codex, in a new worktree; this one keeps running."));
  });

  it("offers to install an engine where this computer has none, and previews nothing until one is", async () => {
    const h = fakeHub();
    const none = ENGINES.map((e) => ({ ...e, installed: false }));
    h.engines.mockResolvedValue(none);
    use(h);
    render(<HandoffDialog />);
    act(() => useHandoff.getState().open({ id: "s1" }));
    const fix = await within(dialog()).findByRole("group", { name: "Nothing to start a session with" });
    expect(fix.textContent).toContain("Neither Claude Code nor Codex is installed");
    expect(within(fix).getAllByRole("button").length).toBeGreaterThan(0);
    expect(hub.handoffPreview).not.toHaveBeenCalled();
    expect(button("Continue in another engine").disabled).toBe(true);
  });

  it("can't make a worktree of a folder that isn't in a git repository, and says why", async () => {
    // Asked of this computer's hub, as New session asks.
    useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "" }] as never });
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        if (u.pathname !== "/api/desk/folders") return Response.json({}, { status: 404 });
        asked.push(u.searchParams.get("path") ?? "");
        return Response.json({ git: false });
      }),
    );
    try {
      use(fakeHub());
      await openDialog();
      change();
      const worktree = (await within(dialog()).findByRole("radio", { name: /New worktree from its branch/ })) as HTMLInputElement;
      await waitFor(() => expect(worktree.disabled).toBe(true));
      expect(worktree.closest("label")!.textContent).toContain("isn’t in a git repository");
      expect(asked).toEqual(["/dev/acme-api"]);
    } finally {
      vi.unstubAllGlobals();
      useChat.setState({ hubs: [] });
    }
  });

  it("offers Update Desk where this Desk is too old to hand over", async () => {
    use(fakeHub(async () => Promise.reject(new HubError(404, "not found"))));
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByRole("alert").textContent).toContain("Update Desk to use it."));
    const check = vi.fn(async () => {});
    useUpdates.setState({ check });
    fireEvent.click(button("Update Desk"));
    // Closed before Help opens over it, and a check for the update asked.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(check).toHaveBeenCalledWith({ asked: true });
    // A 404 in the hub's own words is its refusal, not a missing route.
    cleanup();
    use(fakeHub(async () => Promise.reject(new HubError(404, "There's no session s1 here any more."))));
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByRole("alert").textContent).not.toContain("Update Desk"));
    expect(within(dialog()).queryByRole("button", { name: "Update Desk" })).toBeNull();
  });

  it("follows the session as it is until the person picks: a turn starting while open stops it after that turn", async () => {
    use(fakeHub());
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("this one stops now"));
    act(() => useDesk.setState({ sessions: { s1: { ...SOURCE, state: "working" } } }));
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("this one stops after its turn"));
    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", expect.objectContaining({ source: "after_turn" }));
  });

  it("takes back a worktree picked before the folder was known not to be in git", async () => {
    useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "" }] as never });
    let answer: (git: boolean) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new URL(url).pathname === "/api/desk/folders"
          ? new Promise<Response>((done) => (answer = (git) => done(Response.json({ git }))))
          : Response.json({}, { status: 404 }),
      ),
    );
    try {
      use(fakeHub());
      await openDialog();
      change();
      fireEvent.click(within(dialog()).getByRole("radio", { name: /New worktree from its branch/ }));
      await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("in a new worktree"));
      await act(async () => answer(false));
      await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("in this folder"));
      expect((within(dialog()).getByRole("radio", { name: /Same folder/ }) as HTMLInputElement).checked).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      useChat.setState({ hubs: [] });
    }
  });

  it("says and sends this computer's own sign-in where that's the default, and an account once picked", async () => {
    const h = fakeHub();
    h.engines.mockResolvedValue(ENGINES.map((e) => (e.engine === "codex" ? { ...e, caps: { terminal: { accounts: "token" } } } : e) as never));
    h.accounts.mockResolvedValue({
      accounts: [{ id: "a1", engine: "codex", name: "Work", isDefault: false, signedIn: true, sessions: [], createdAt: "" }],
      store: "the keychain",
      signIns: [],
    });
    use(h);
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("Continues in Codex on this computer’s sign-in, in this folder"));
    change();
    const own = within(dialog()).getByRole("radio", { name: "This computer’s sign-in" });
    expect(own.getAttribute("aria-checked")).toBe("true");
    expect(own.tabIndex).toBe(0);
    const work = within(dialog()).getByRole("radio", { name: "Work" });
    expect(work.tabIndex).toBe(-1);
    fireEvent.click(work);
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("Continues in Codex on Work"));
    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", expect.objectContaining({ account: "a1" }));
  });

  it("leaves a stopped session in a Desk terminal stopped, rather than keeping what isn't running", async () => {
    use(fakeHub(), [{ ...SOURCE, live: false, state: "stopped", terminalId: "t1" }]);
    await openDialog();
    await waitFor(() => expect(within(dialog()).getByLabelText("As it goes").textContent).toContain("this one stays stopped"));
    change();
    const options = within(within(dialog()).getByRole("radiogroup", { name: "This one" })).getAllByRole("radio");
    expect(options.map((r) => r.closest("label")!.textContent)).toEqual(["Leave it stoppedit isn’t running"]);
    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", expect.objectContaining({ source: "stop" }));
  });

  it("says beside Continue what it waits on, where the group asks first", async () => {
    use(fakeHub(async () => previewOf({ ask: true })));
    await openDialog();
    const yes = await within(dialog()).findByRole("checkbox", { name: /Send this brief to OpenAI/ });
    expect(dialog().querySelector(".dialog-foot-note")!.textContent).toBe("Tick “Send this brief to OpenAI” above to go on.");
    fireEvent.click(yes);
    expect(dialog().querySelector(".dialog-foot-note")!.textContent).toBe("");
  });
});

describe("where a session's work came from and went", () => {
  it("says on the session it went on in where from, and offers Hand back while that one can resume, never asking for a brief", async () => {
    const source = sessionOf({ id: "s1", name: "acme-api", live: false, state: "stopped", cliSessionId: "c1", caps: { resume: "byId" } as Session["caps"] });
    const target = sessionOf({ id: "s2", name: "acme-api-codex", engine: "codex", live: true, state: "idle" });
    const h = fakeHub();
    h.lineage.mockResolvedValue(continuedLineage());
    use(h, [source, target]);
    render(
      <>
        <LineageChips session={target} />
        <HandoffDialog />
      </>,
    );
    const chip = await screen.findByRole("button", { name: `continued from Claude Code · ${clock("2026-11-09T10:42:00Z")}` });
    expect(hub.lineage).toHaveBeenCalledWith("s2");
    expect(hub.handoffPreview).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(opened).toEqual(["s1"]);
    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    expect(useHandoff.getState().asking).toEqual({ id: "s2", back: true });
  });

  it("offers no Hand back while the session it came from runs", async () => {
    const source = sessionOf({ id: "s1", live: true, state: "idle", cliSessionId: "c1" });
    const target = sessionOf({ id: "s2", engine: "codex", live: true });
    const h = fakeHub();
    h.lineage.mockResolvedValue(continuedLineage());
    use(h, [source, target]);
    render(<LineageChips session={target} />);
    await screen.findByText(/continued from Claude Code/);
    expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
  });

  it("says on the session it left where it went on, to open it", async () => {
    const h = fakeHub();
    h.lineage.mockResolvedValue(handedLineage());
    use(h);
    render(<LineageChips session={SOURCE} />);
    expect(await screen.findByText(`continued in Codex · ${clock("2026-11-09T10:42:00Z")}`)).toBeTruthy();
    expect(screen.getByText("This work continues in Codex.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open acme-api-codex →" }));
    expect(opened).toEqual(["s2"]);
    expect(hub.handoffPreview).not.toHaveBeenCalled();
  });

  it("shows nothing for a work of one session, nor for a machine's session", async () => {
    use(fakeHub());
    const { container } = render(<LineageChips session={SOURCE} />);
    await waitFor(() => expect(hub.lineage).toHaveBeenCalledWith("s1"));
    expect(container.textContent).toBe("");
    cleanup();
    const away = render(<LineageChips session={{ ...SOURCE, machine: "devbox" }} />);
    expect(away.container.textContent).toBe("");
    expect(hub.lineage).toHaveBeenCalledTimes(1);
  });
});
