// The move dialog's states, against the hub's move routes as the person who
// holds the hub reaches them (over `fetch`, with the paired token): what a
// move does in the hub's words, the person's choices (each asked again),
// the handover note sent exactly as shown, a boss asked before it replaces
// another, a room refused across bosses, and a move that changed (409) or a
// note refused (400).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoard } from "../board/store";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { setDevToken } from "../hub/devTokens";
import type { MoveEffect } from "../hub/moves";
import type { Manager, Ticket } from "../hub/types";
import { useOverview } from "../overview/store";
import { useHubLayout } from "./hubLayout";
import type { Layout } from "./model";
import { useMove, type MoveSubject } from "./move";
import { MoveDialog, PREVIEW_AFTER_MS } from "./MoveDialog";
import { draftNote, movesHub, type MoveAnswer } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const agent = (id: string, name: string): Agent => ({ hubId: "local", id, name, model: null, provider: null, isDefault: id === "desk" });

const LAYOUT: Layout = {
  groups: [
    { id: "acme", name: "Acme", collapsed: false, items: ["session:s1", "agent:local/sarah", "agent:local/scout"] },
    { id: "globex", name: "Globex", collapsed: false, items: ["agent:local/mia"] },
    { id: "personal", name: "Personal", collapsed: false, items: [] },
  ],
  ungrouped: { collapsed: false, items: ["agent:local/desk"] },
};

const MANAGER: Manager = {
  agentId: "desk",
  level: "act",
  bosses: [
    { agentId: "sarah", name: "Sarah", group: "acme", level: "act" },
    { agentId: "mia", name: "Mia", group: "globex", level: "act" },
  ],
  sealed: [],
};

const SESSION: MoveSubject = { kind: "session", id: "s1", name: "acme-docs", from: "acme" };

/** What moving acme-docs from Acme (Sarah's) to Globex (Mia's) does. */
const sessionMove: MoveAnswer = ({ choices }) => ({
  effects: [
    choices.release ? { kind: "release", text: "Its boss lets acme-docs go: you run it on your own." } : { kind: "charge_to", boss: "mia", text: "Mia runs acme-docs from now on." },
    choices.ticketGoes
      ? { kind: "ticket_goes", text: "ACM-17 goes to Globex’s board with a new key; its history stays with Acme." }
      : { kind: "stays_unassigned", synced: false, text: "ACM-17 stays on Acme’s board, back in To do and unassigned." },
    { kind: "asks_withdrawn", text: "Its question to its boss is withdrawn." },
    { kind: "ledger_stays", text: "What it spent so far ($3.20) stays in Acme’s spend; what it spends from now on is Globex’s." },
    { kind: "handover", from: "sarah", to: "mia", text: "Mia receives only the note below from Sarah." },
    { kind: "tell", text: "acme-docs is told on its line that it moved." },
  ] satisfies MoveEffect[],
  handovers: [draftNote("session:s1", "sarah", "mia", "Handing over acme-docs.\nGoal: the checkout guide")],
});

let hub: ReturnType<typeof movesHub>;
const fetched: string[] = [];

const serve = (answer: MoveAnswer) => {
  hub = movesHub(answer);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      fetched.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return (await hub.fetch(url, init)) ?? new Response("Not Found", { status: 404 });
    }),
  );
};

const open = (subject: MoveSubject, to?: string, apply?: (to: string) => void) => {
  render(<MoveDialog />);
  act(() => useMove.getState().open({ subject, to, apply }));
};

const dialog = () => screen.getByRole("dialog");
const note = () => within(dialog()).getByRole("textbox", { name: "Handover note" }) as HTMLTextAreaElement;
const moveButton = (to: string) => within(dialog()).getByRole("button", { name: `Move to ${to}` }) as HTMLButtonElement;

beforeEach(() => {
  fetched.length = 0;
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" }],
    roster: [agent("desk", "Desk"), agent("sarah", "Sarah"), agent("mia", "Mia"), agent("scout", "Scout")],
  });
  setDevToken("local", "holder");
  useHubLayout.setState({ layout: LAYOUT, kept: true });
  useOverview.setState({ manager: MANAGER, managerSupport: "yes", overviewSupport: "no" });
  useBoard.setState({
    tickets: {
      t1: { id: "t1", board: "b1", key: "ACM-17", title: "Checkout guide", state: "doing", assignee: { kind: "session", id: "s1", name: "acme-docs" }, links: [], updatedAt: "2026-11-08T10:00:00Z" } as unknown as Ticket,
    },
  });
  useMove.setState({ asking: null });
  serve(sessionMove);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("moving a session to another boss's group", () => {
  it("says what it does in the hub's words, who gets the note, and what the new boss sees", async () => {
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    expect(hub.asked).toEqual([{ item: { kind: "session", id: "s1" }, to: "globex", choices: { ticketGoes: true, release: false, replace: false } }]);
    expect(within(dialog()).getByRole("heading", { name: "Move acme-docs" })).toBeTruthy();
    expect(screen.getByText("Now in Acme, run by Sarah")).toBeTruthy();
    expect(screen.getByText("What it spent so far ($3.20) stays in Acme’s spend; what it spends from now on is Globex’s.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Its ticket, ACM-17" })).toBeTruthy();
    expect(note().value).toBe("Handing over acme-docs.\nGoal: the checkout guide");
    expect(screen.getByText(/Mia receives only this note/)).toBeTruthy();
    expect(screen.getByText("Written by Desk from what it knows", { exact: false })).toBeTruthy();
    expect(screen.getByText(/Globex is another client\. This note is all Mia gets from Acme/)).toBeTruthy();
    expect(screen.getByText(/Mia sees acme-docs as it is: its goal, its last reply and its terminal/)).toBeTruthy();
    expect(screen.getByText(/Mia sees ACM-17’s title, description and links\s+from now on\./)).toBeTruthy();
    // Where it is now can't be chosen; Ungrouped can.
    expect((screen.getByRole("radio", { name: /^Acme/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("radio", { name: /^Ungrouped/ })).toBeTruthy();
  });

  it("sends the note exactly as the person edited it, and only on Move", async () => {
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    const edited = "Only the Stripe section is left.\n  Sam wants one example each.  ";
    fireEvent.change(note(), { target: { value: edited } });
    expect(screen.getByText(/Edited by you/)).toBeTruthy();
    expect(hub.commits).toEqual([]);
    fireEvent.click(moveButton("Globex"));
    await waitFor(() => expect(hub.commits).toHaveLength(1));
    expect(hub.commits[0]).toEqual({ preview: "p1", choices: { ticketGoes: true, release: false, replace: false }, note: edited, notes: [] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks again when its ticket stays or nobody runs it, and sends those choices", async () => {
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    fireEvent.click(screen.getByRole("radio", { name: /Stays on Acme’s board/ }));
    await screen.findByText("ACM-17 stays on Acme’s board, back in To do and unassigned.");
    fireEvent.click(screen.getByRole("radio", { name: /You run it on your own/ }));
    await screen.findByText("Its boss lets acme-docs go: you run it on your own.");
    expect(hub.asked.map((a) => a.choices)).toEqual([
      { ticketGoes: true, release: false, replace: false },
      { ticketGoes: false, release: false, replace: false },
      { ticketGoes: false, release: true, replace: false },
    ]);
    fireEvent.click(moveButton("Globex"));
    await waitFor(() => expect(hub.commits).toHaveLength(1));
    expect(hub.commits[0]!.preview).toBe("p3");
    expect(hub.commits[0]!.choices).toEqual({ ticketGoes: false, release: true, replace: false });
  });

  it("won't send an empty note", async () => {
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    fireEvent.change(note(), { target: { value: "   " } });
    expect(moveButton("Globex").disabled).toBe(true);
  });

  it("sends nothing when cancelled", async () => {
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    fireEvent.change(note(), { target: { value: "never sent" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetched.filter((r) => r === "POST /api/desk/moves")).toEqual([]);
  });

  it("looks again when what it does changed (409), keeping the person's note, and sends with the new preview", async () => {
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    fireEvent.change(note(), { target: { value: "My own words for Mia." } });
    hub.stale = true;
    fireEvent.click(moveButton("Globex"));
    await screen.findByText("What this move does has changed since you looked; look at it again.");
    await waitFor(() => expect(hub.asked).toHaveLength(2));
    await waitFor(() => expect(moveButton("Globex").disabled).toBe(false));
    expect(note().value).toBe("My own words for Mia.");
    expect(hub.commits).toEqual([]);
    fireEvent.click(moveButton("Globex"));
    await waitFor(() => expect(hub.commits).toHaveLength(1));
    expect(hub.commits[0]).toMatchObject({ preview: "p2", note: "My own words for Mia." });
  });

  it("says why a note was refused (400) and doesn't look again", async () => {
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    hub.refuse = "The handover note has what looks like a secret in it (a key, token or password); take it out first.";
    fireEvent.click(moveButton("Globex"));
    await screen.findByText(/looks like a secret in it/);
    expect(hub.asked).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("waits for the old boss's draft, offers it when it comes, and never puts it in place of what's shown", async () => {
    serve((ask) => ({ ...sessionMove(ask), handovers: [draftNote("session:s1", "sarah", "mia", "Desk's facts.", { drafting: true })] }));
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    expect(screen.getByText(/Sarah is writing a draft/)).toBeTruthy();
    expect(screen.getByText("Waiting for Sarah’s draft…")).toBeTruthy();
    expect(moveButton("Globex").disabled).toBe(true);
    // The draft comes just before the person presses Move.
    hub.handovers.set("p1-h0", { ...hub.handovers.get("p1-h0")!, note: "Sarah's note: the guide needs its last section.", drafting: false, draftedBy: { kind: "agent", id: "sarah", name: "Sarah" } });
    const use = await screen.findByRole("button", { name: "Use Sarah’s draft" }, { timeout: 4000 });
    // Offered, not swapped in: what's shown is still what the person read.
    expect(note().value).toBe("Desk's facts.");
    expect(screen.getByText(/Written by Desk from what it knows/)).toBeTruthy();
    expect(moveButton("Globex").disabled).toBe(false);
    fireEvent.click(moveButton("Globex"));
    await waitFor(() => expect(hub.commits).toHaveLength(1));
    expect(hub.commits[0]!.note).toBe("Desk's facts.");
    expect(use).toBeTruthy();
  });

  it("puts the old boss's draft in only when the person chooses it", async () => {
    serve((ask) => ({ ...sessionMove(ask), handovers: [draftNote("session:s1", "sarah", "mia", "Desk's facts.", { drafting: true })] }));
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    fireEvent.change(note(), { target: { value: "Mine." } });
    hub.handovers.set("p1-h0", { ...hub.handovers.get("p1-h0")!, note: "Sarah's draft.", drafting: false, draftedBy: { kind: "agent", id: "sarah", name: "Sarah" } });
    const use = await screen.findByRole("button", { name: "Use Sarah’s draft" }, { timeout: 4000 });
    expect(note().value).toBe("Mine.");
    fireEvent.click(use);
    expect(note().value).toBe("Sarah's draft.");
    expect(screen.getByText(/Drafted by Sarah/)).toBeTruthy();
    fireEvent.click(moveButton("Globex"));
    await waitFor(() => expect(hub.commits[0]?.note).toBe("Sarah's draft."));
  });

  it("sends Desk's facts without waiting once the person says so", async () => {
    serve((ask) => ({ ...sessionMove(ask), handovers: [draftNote("session:s1", "sarah", "mia", "Desk's facts.", { drafting: true })] }));
    open(SESSION, "globex");
    await screen.findByText("Mia runs acme-docs from now on.");
    expect(moveButton("Globex").disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send Desk’s facts now" }));
    expect(moveButton("Globex").disabled).toBe(false);
    // A draft that comes after is no longer read, nor offered.
    hub.handovers.set("p1-h0", { ...hub.handovers.get("p1-h0")!, note: "Late.", drafting: false });
    fireEvent.click(moveButton("Globex"));
    await waitFor(() => expect(hub.commits).toHaveLength(1));
    expect(hub.commits[0]!.note).toBe("Desk's facts.");
    expect(screen.queryByRole("button", { name: "Use Sarah’s draft" })).toBeNull();
  });

  it("previews only once a target is picked, and says only the holder may move", async () => {
    setDevToken("local", "someone-else");
    open(SESSION);
    expect(hub.asked).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: /^Globex/ }));
    await screen.findByText("Only the person who holds this computer’s hub can move things between groups.", {}, { timeout: PREVIEW_AFTER_MS + 2000 });
    expect(moveButton("Globex").disabled).toBe(true);
  });
});

describe("moving the other kinds", () => {
  it("asks before a boss replaces another, then sends each plan's note", async () => {
    serve(({ choices }) =>
      choices.replace
        ? {
            effects: [
              { kind: "replaces", boss: "mia", text: "Mia stops overseeing Globex." },
              { kind: "passes_to_main", text: "Acme has no boss after this: its 2 sessions and 1 plan pass to the main boss, and each plan waits until you've read its note." },
              { kind: "handover", from: "sarah", to: "desk", text: "Desk receives only the note below from Sarah." },
              { kind: "memory_stays", text: "Sarah keeps what they learned in Acme, but won't recall it while they run Globex." },
            ],
            handovers: [draftNote("plan:pl1", "sarah", "desk", "Handing over a plan.")],
          }
        : {
            effects: [{ kind: "asks_to_replace", boss: "mia", text: "Globex already has Mia. Replace them with Sarah? Mia stops overseeing." }],
            blocked: "The group already has mia; say whether to replace them first.",
          },
    );
    open({ kind: "boss", id: "sarah", name: "Sarah", from: "acme" }, "globex");
    await screen.findByText("Globex already has Mia. Replace them with Sarah? Mia stops overseeing.");
    // A boss oversees a group: Ungrouped is the main boss's.
    expect(screen.queryByRole("radio", { name: /^Ungrouped/ })).toBeNull();
    expect(moveButton("Globex").disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Replace Mia" }));
    await screen.findByText("Mia stops overseeing Globex.");
    expect(hub.asked[1]!.choices.replace).toBe(true);
    const plan = screen.getByRole("textbox", { name: "Note on one of its plans" }) as HTMLTextAreaElement;
    expect(plan.value).toBe("Handing over a plan.");
    expect(screen.getByText(/Desk receives only this note/)).toBeTruthy();
    fireEvent.click(moveButton("Globex"));
    await waitFor(() => expect(hub.commits).toHaveLength(1));
    expect(hub.commits[0]).toEqual({ preview: "p2", choices: { ticketGoes: false, release: false, replace: true }, notes: [{ id: "p2-h0", note: "Handing over a plan." }] });
  });

  it("refuses a room across bosses and says why", async () => {
    const why = "A room keeps its conversation, so it can't move to a group another boss oversees. Start a new room in Globex instead.";
    serve(() => ({ effects: [{ kind: "refused", text: why }], blocked: why }));
    open({ kind: "room", id: "r1", name: "launch", from: "acme" }, "globex");
    expect((await screen.findByRole("alert")).textContent).toBe(why);
    expect(moveButton("Globex").disabled).toBe(true);
  });

  it("moves a ticket to another group's board as previewed", async () => {
    serve(() => ({
      effects: [
        { kind: "unassigned", text: "ACM-17 is taken off the session working on it." },
        { kind: "ticket_goes", text: "ACM-17 goes to Personal’s board with a new key; its history stays with Acme." },
      ],
    }));
    open({ kind: "ticket", id: "t1", name: "ACM-17", from: "acme" }, "personal");
    await screen.findByText("ACM-17 is taken off the session working on it.");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Desk sees ACM-17’s title, description and links\s+from now on\./)).toBeTruthy();
    fireEvent.click(moveButton("Personal"));
    await waitFor(() => expect(hub.commits).toEqual([{ preview: "p1", choices: { ticketGoes: false, release: false, replace: false }, notes: [] }]));
  });

  it("says an agent leaving a boss's group no longer answers in its rooms", () => {
    open({ kind: "agent", agent: agent("scout", "Scout"), name: "Scout", from: "acme" }, "personal", vi.fn());
    expect(screen.getByText("Desk oversees Scout from now on, not Sarah.")).toBeTruthy();
    expect(screen.getByText("It no longer answers in Acme’s rooms.")).toBeTruthy();
  });

  it("says it can't tell what an agent's move changes before Desk knows who oversees what", () => {
    useOverview.setState({ manager: null });
    open({ kind: "agent", agent: agent("scout", "Scout"), name: "Scout", from: "acme" }, "globex", vi.fn());
    expect(screen.getByText("Desk hasn’t heard yet who oversees each group, so it can’t say what else moving Scout changes.")).toBeTruthy();
  });

  it("moves an agent's row in the sidebar, saying who oversees it from now on", async () => {
    const apply = vi.fn();
    open({ kind: "agent", agent: agent("scout", "Scout"), name: "Scout", from: "acme" }, "globex", apply);
    expect(screen.getByText("Mia oversees Scout from now on, not Sarah.")).toBeTruthy();
    expect(screen.getByText("From now on it answers only in Globex’s rooms.")).toBeTruthy();
    fireEvent.click(moveButton("Globex"));
    expect(apply).toHaveBeenCalledWith("globex");
    expect(fetched).toEqual([]);
  });
});
