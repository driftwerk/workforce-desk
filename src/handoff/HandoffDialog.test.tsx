// Continue in another engine: the dialog's preview (asked with derive=1 once,
// as it opens), the group's ask before the brief leaves, the hub's
// refusals in its own words and the goal-only start, hand back, and the
// lineage chips on both sessions' cards, which never ask for a brief.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { HandoffPreview, Session } from "../hub/types";
import { sessionOf } from "../memory/testing";
import { clock } from "../floor/time";
import { HandoffDialog } from "./HandoffDialog";
import { LineageChips } from "./LineageChips";
import { useHandoff } from "./store";
import { ENGINES, continuedLineage, handedLineage, previewOf } from "./testing";

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
    const elsewhere = within(within(dialog()).getByRole("radiogroup", { name: "This one" })).getAllByRole("radio");
    expect(elsewhere.map((r) => r.closest("label")!.textContent)).toEqual(["Keep it runningit runs in another terminal: end it there when you’re done"]);
    cleanup();
    use(fakeHub(), [{ ...SOURCE, state: "working" }]);
    await openDialog();
    expect((within(dialog()).getByRole("radio", { name: /Stop it after this turn/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("offers only Keep for a session in a Desk terminal, which the person ends", async () => {
    use(fakeHub(), [{ ...SOURCE, terminalId: "t1" }]);
    await openDialog();
    const options = within(within(dialog()).getByRole("radiogroup", { name: "This one" })).getAllByRole("radio");
    expect(options).toHaveLength(1);
    expect((options[0] as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(button("Continue in Codex").disabled).toBe(false));
    await act(async () => fireEvent.click(button("Continue in Codex")));
    expect(hub.handoff).toHaveBeenCalledWith("s1", expect.objectContaining({ source: "keep" }));
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
