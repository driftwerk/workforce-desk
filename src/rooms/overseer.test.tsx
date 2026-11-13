import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskExtras } from "../hub/types";
import { Message } from "./Message";
import { answerOptions, closest, decisionParts, firstSentence, readNeed, readNeedsPost, recommended } from "./Overseer";

vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

/** What Desk asked the hub, and what it answers: each route its own. */
let asked: { method: string; path: string; body?: unknown }[];
let answer: (path: string) => Response;
const transport: DeskTransport = {
  fetch: async (method, path, body) => {
    asked.push({ method, path, body: body ? JSON.parse(String(body.data)) : undefined });
    return answer(path);
  },
  socket: () => ({}) as DeskSocket,
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  asked = [];
  answer = () => ok({ done: "ok" });
  useDesk.setState({ hub: new DeskHub(transport) });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null });
});

const said = (content: string, desk: DeskExtras, delivery?: ChatMessage["delivery"]): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content,
  at: "2026-11-12T19:40:00Z",
  status: "complete",
  tools: [],
  delivery,
  desk,
});

const show = (m: ChatMessage) => render(<Message message={m} author="Desk" onSubmitForm={() => true} />);

const UPDATE: DeskExtras = {
  update: {
    sessions: [
      {
        sessionId: "s1",
        name: "Billing migration",
        purpose: "moving billing onto the new ledger.",
        text: "found why the export crashes. The fix's tests pass and it's opening the pull request now.",
        refs: [
          { kind: "pr", id: "#622", url: "https://example.test/pr/622" },
          { kind: "ticket", id: "MAN-5" },
        ],
      },
    ],
    decisions: [
      { id: "d1", text: "told it to wait for green CI", why: "red main blocks everyone's deploys", undo: "undo" },
      { id: "d2", text: "let it wait", why: "it was working and nothing waited on you", undo: null },
      { id: "d3", text: "let it wait", why: "It was working and nothing waited on you.", undo: null },
    ],
    waiting: [
      {
        itemId: "i1",
        text: "Should saved emails get the new wording too?",
        age: "40 min",
        holdingUp: "Billing migration is paused on this",
        recommendation: "I'd rewrite saved copies, so nobody gets resent the old wording.",
        options: ["Rewrite saved copies", "Only new ones"],
      },
    ],
  },
};

describe("a boss's update, laid out", () => {
  it("says what happened first, then what needs you, then what it did: no box, its kind a word after the time", () => {
    const { container } = show(said("**Billing migration** — …", UPDATE, "update"));
    expect(container.querySelector(".msg-kind")?.textContent?.trim()).toBe("update");
    const parts = [...container.querySelector(".msg-text.overseer")!.children].map((e) => e.className);
    expect(parts).toEqual(["upd-head", "needs", "did"]);
    expect(container.querySelector(".dm-action")).toBeNull();
    // One line per session, its dot first and its first sentence; the rest muted; purpose and refs faint under it.
    const line = container.querySelector(".upd-line")!;
    expect(line.querySelector(".dot")).toBeTruthy();
    expect(line.textContent).toBe("Billing migration found why the export crashes.");
    expect(container.querySelector(".upd-rest")?.textContent).toBe("The fix's tests pass and it's opening the pull request now.");
    expect(container.querySelector(".upd-sub")?.className).toContain("faint");
    expect(container.querySelector(".upd-sub")?.textContent).toBe("moving billing onto the new ledger · #622 · MAN-5");
    expect(container.querySelector("a.ref")?.textContent).toBe("#622");
  });

  it("dots a session by its own state", () => {
    useDesk.setState((d) => ({ sessions: { ...d.sessions, s1: { id: "s1", state: "working" } as never } }));
    const { container } = show(said("…", UPDATE, "update"));
    expect(container.querySelector(".upd-line .dot")?.className).toContain("dot-working");
    useDesk.setState((d) => {
      const { s1: _gone, ...rest } = d.sessions;
      return { sessions: rest };
    });
  });

  it("sets what needs you apart: its label with the wait, one bold question, I'd say, the recommended answer filled, Hold plain", () => {
    const { container } = show(said("…", UPDATE, "update"));
    const needs = container.querySelector("section.needs")!;
    expect(needs.querySelector(".sec-label")?.textContent).toBe("Needs you · waiting 40 min");
    expect(needs.querySelector(".needs-q")?.textContent).toBe("Should saved emails get the new wording too?");
    expect(needs.querySelector(".needs-rec")?.textContent).toBe("I'd say:");
    expect(screen.getByRole("button", { name: "Rewrite saved copies" }).className).toContain("btn-blocked");
    expect(screen.getByRole("button", { name: "Only new ones" }).className).not.toContain("btn-blocked");
    expect(screen.getByRole("button", { name: "Hold, I'll look" }).className).toContain("link");
    expect(screen.getByText("Billing migration is paused on this").className).toContain("faint");
  });

  it("holds what needs you without asking the hub, and offers it again", () => {
    show(said("…", UPDATE, "update"));
    fireEvent.click(screen.getByRole("button", { name: "Hold, I'll look" }));
    expect(screen.getByText(/Left open\. Nothing was sent\./)).toBeTruthy();
    expect(asked).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Answer now" }));
    expect(screen.getByRole("button", { name: "Only new ones" })).toBeTruthy();
  });

  it("keeps what you held held when drawn again", () => {
    const m = said("…", { update: { waiting: [{ itemId: "held1", text: "Ship it?", options: ["Yes", "No"] }] } }, "update");
    const r = show(m);
    fireEvent.click(screen.getByRole("button", { name: "Hold, I'll look" }));
    r.unmount();
    show(m);
    expect(screen.getByText(/Left open/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("answers what waits through the hub, which settles it", async () => {
    show(said("…", UPDATE, "update"));
    fireEvent.click(screen.getByRole("button", { name: "Only new ones" }));
    await waitFor(() => expect(screen.getByText("You answered: Only new ones")).toBeTruthy());
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/items/i1/answer", body: { answer: "Only new ones" } });
    expect(screen.queryByRole("button", { name: "Rewrite saved copies" })).toBeNull();
  });

  it("says one settled elsewhere is settled, and remembers what you settled when drawn again", async () => {
    answer = () => new Response(JSON.stringify({ error: "That was already settled." }), { status: 409 });
    const m = said("…", { update: { waiting: [{ itemId: "i1b", text: "Ship it?", options: ["Yes", "No"] }] } }, "update");
    const r = show(m);
    expect(screen.getByRole("group", { name: "Your answer: Ship it?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByText("Already settled.")).toBeTruthy());
    r.unmount();
    show(m);
    expect(screen.getByText("Already settled.")).toBeTruthy();
  });

  it("takes the question, its items, its options and what isn't blocked as the hub says them", () => {
    const { container } = show(
      said(
        "…",
        {
          update: {
            waiting: [
              {
                itemId: "i9",
                text: "Two staging records need a decision. (long form)",
                question: "Two staging records need a decision before PR 3 can go for approval.",
                items: [{ text: "A user with no organisation.", detail: "Which organisation do they belong to?" }, "An id with roles but no user. Make those roles inactive?"],
                options: [{ label: "Deactivate · leave the user empty", recommended: true }, { label: "Leave both as they are" }],
                recommendation: "deactivate the roles",
                notBlocking: "Not blocking: #566 and #567 don't depend on it.",
              },
            ],
          },
        },
        "update",
      ),
    );
    expect(container.querySelector(".needs-q")?.textContent).toBe("Two staging records need a decision before PR 3 can go for approval.");
    const items = [...container.querySelectorAll(".needs-items li")];
    expect(items.map((li) => li.querySelector(".needs-lead")?.textContent)).toEqual(["A user with no organisation.", "An id with roles but no user."]);
    expect(items[0]!.textContent).toBe("A user with no organisation. Which organisation do they belong to?");
    expect(screen.getByRole("button", { name: "Deactivate · leave the user empty" }).className).toContain("btn-blocked");
    expect(screen.getByText("Not blocking: #566 and #567 don't depend on it.").className).toContain("faint");
    expect(container.textContent).not.toContain("(long form)");
  });
});

describe("what I did", () => {
  it("is one line per decision: what it did, then why muted, Undo at the right", () => {
    const { container } = show(said("…", UPDATE, "update"));
    const did = container.querySelector("section.did")!;
    expect(did.querySelector(".sec-label")?.textContent).toBe("What I did");
    const row = did.querySelector(".dec-row")!;
    expect(row.querySelector(".dec-action")?.textContent).toBe("Told it to wait for green CI.");
    expect(row.querySelector(".dec-text .muted")?.textContent?.trim()).toBe("Red main blocks everyone's deploys.");
    expect(screen.getByRole("button", { name: "Undo: Told it to wait for green CI" }).className).toContain("dec-undo");
    // No times from this hub: no empty column.
    expect(did.querySelector(".did-list")?.className).toContain("untimed");
    expect(did.querySelector(".dec-time")).toBeNull();
  });

  it("folds the times it did nothing into one line that opens", () => {
    const { container } = show(said("…", UPDATE, "update"));
    const fold = screen.getByRole("button", { name: /I left it alone/ });
    expect(fold.textContent).toBe("+ 2 times I left it alone, since it was working and nothing waited on you");
    expect(container.querySelectorAll(".dec-row .dec-action")).toHaveLength(1);
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect([...container.querySelectorAll(".dec-action")].map((e) => e.textContent)).toEqual(["Told it to wait for green CI.", "Let it wait.", "Let it wait."]);
  });

  it("says why it left it alone only when every time was for the same reason", () => {
    show(
      said(
        "…",
        {
          update: {
            decisions: [
              { id: "f1", text: "let it wait", why: "it was working" },
              { id: "f2", text: "sent nothing", why: "CI was still running" },
            ],
          },
        },
        "update",
      ),
    );
    expect(screen.getByRole("button", { name: /I left it alone/ }).textContent).toBe("+ 2 times I left it alone");
  });

  it("keeps the message it sent behind Message, and shows its time when the hub says it", () => {
    const quote = "Disregard my earlier answer about the key: use the staging key from the vault, not the production one.";
    const { container } = show(
      said(
        "…",
        {
          update: {
            decisions: [
              { id: "m1", text: `answered Partner sync: “${quote}”`, why: "its plan says staging only", undo: "correct", at: "2026-11-12T20:31:00Z" },
              { id: "m2", text: "sent a long note", action: "Asked it about its plan for production", message: "What is your plan for production?", why: "it had set aside its rule", kind: "acted", at: "2026-11-12T20:33:00Z" },
            ],
          },
        },
        "update",
      ),
    );
    expect(container.querySelector(".did-list")?.className).not.toContain("untimed");
    expect(container.querySelector(".dec-time")?.textContent).toMatch(/\d/);
    expect(container.querySelector(".dec-action")?.textContent).toBe("Answered Partner sync.");
    expect(container.textContent).not.toContain("Disregard my earlier");
    fireEvent.click(screen.getByRole("button", { name: "The message: Answered Partner sync" }));
    expect(container.querySelector(".dec-message")?.textContent).toBe(quote);
    expect(screen.getByRole("button", { name: "Correct: Answered Partner sync" })).toBeTruthy();
    expect(screen.getByText("Asked it about its plan for production.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "The message: Asked it about its plan for production" }));
    expect(screen.getByText("What is your plan for production?")).toBeTruthy();
  });

  it("undoes through the hub, and shows it undone", async () => {
    answer = () => ok({ done: "told Billing migration to go ahead" });
    show(said("…", UPDATE, "update"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: Told it to wait for green CI" }));
    await waitFor(() => expect(screen.getByText("Undone: told Billing migration to go ahead.")).toBeTruthy());
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/decisions/d1/undo", body: undefined });
    expect(screen.getByText("Told it to wait for green CI.").className).toContain("dec-undone");
  });

  it("reads undone elsewhere or gone as undone; one that can't be loses its button", async () => {
    const one = (id: string, extra: object = {}) => said("…", { decisions: [{ id, text: `chose ${id}`, why: "a reason", undo: "undo", ...extra }] }, "notice");
    answer = () => new Response(JSON.stringify({ error: "That decision was already undone." }), { status: 409 });
    let r = show(one("e409"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: Chose e409" }));
    await waitFor(() => expect(screen.getByText("Undone.")).toBeTruthy());
    r.unmount();
    answer = () => new Response(JSON.stringify({ error: "That decision isn’t there." }), { status: 404 });
    r = show(one("e404"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: Chose e404" }));
    await waitFor(() => expect(screen.getByText("Undone.")).toBeTruthy());
    r.unmount();
    answer = () => new Response(JSON.stringify({ error: "What ran is fixed forward." }), { status: 400 });
    r = show(one("e400"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: Chose e400" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("fixed forward"));
    expect(screen.queryByRole("button", { name: "Undo: Chose e400" })).toBeNull();
    r.unmount();
    const g = show(one("gone", { undone: true }));
    expect(g.container.querySelector(".dec-undo")).toBeNull();
    expect(screen.getByText("Undone.")).toBeTruthy();
  });

  it("names each decision's own button by its kind, none where it can't be undone; a lone decision has no label", () => {
    const { container } = show(
      said(
        "…",
        {
          decisions: [
            { id: "a", text: "started Lead picker", why: "you asked at 20:07", undo: "stop" },
            { id: "b", text: "interrupted Eden", why: "it was looping", undo: "resume" },
            { id: "c", text: "approved the deploy", why: "CI was green", undo: null },
          ],
        },
        "notice",
      ),
    );
    expect(screen.getByRole("button", { name: "Stop it: Started Lead picker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume: Interrupted Eden" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(container.querySelector(".sec-label")).toBeNull();
  });
});

describe("a needs-you message", () => {
  it("is set apart as the update's is, its notes faint", () => {
    const { container } = show(
      said(
        "**Needs you.** Should saved copies get the new wording too?\n\nHolding up: Billing is paused on this\n\nI'd say: Rewrite saved copies",
        { item: { itemId: "i2", recommendation: "Rewrite saved copies", options: ["Rewrite saved copies", "Only new ones"] } },
        "question",
      ),
    );
    expect(container.querySelector(".needs .sec-label")?.textContent).toBe("Needs you");
    expect(container.querySelector(".needs-q")?.textContent).toBe("Should saved copies get the new wording too?");
    expect(screen.getByText("Billing is paused on this").className).toContain("faint");
    expect(screen.getByRole("button", { name: "Rewrite saved copies" }).className).toContain("btn-blocked");
    expect(container.querySelector(".dm-action")).toBeNull();
  });

  it("has nothing to press when it asked nothing with answers", () => {
    show(said("**Needs you.** Tell me which repo the export lives in.", { item: { itemId: "i3" } }, "question"));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Answer in this chat.")).toBeTruthy();
  });

  it("says how long a still-waiting one has waited, and drops one set aside", async () => {
    const { container } = show(
      said(
        "Still waiting on you: Rename the export? · 2 h · Reports is paused on this\n\nI won't bring this up again: it stays in what's open, where you can answer or drop it.",
        { item: { itemId: "i4", options: ["Yes", "No"], parked: true } },
        "question",
      ),
    );
    expect(container.querySelector(".needs .sec-label")?.textContent).toBe("Needs you · waiting 2 h");
    expect(container.querySelector(".needs-q")?.textContent).toBe("Rename the export?");
    expect(screen.getByText("Reports is paused on this").className).toContain("faint");
    fireEvent.click(screen.getByRole("button", { name: "Drop: Rename the export?" }));
    await waitFor(() => expect(screen.getByText("Dropped.")).toBeTruthy());
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/items/i4/drop", body: undefined });
  });
});

describe("a session's question in the chat", () => {
  it("is needs-you, said once and unboxed: the message says it, its answers follow", () => {
    const { container } = show(
      said(
        "acme-web asks: “Ship it?”\n\nCI is green and it wants to merge.",
        { questions: [{ messageId: "q1", sessionId: "s9", session: "acme-web", ask: "Ship it?", why: "CI is green and it wants to merge.", options: ["Yes"] }] },
        "question",
      ),
    );
    expect(container.querySelector(".needs .sec-label")?.textContent).toBe("Needs you");
    expect(container.querySelector(".needs-q")?.textContent).toBe("acme-web asks: “Ship it?”");
    expect(container.querySelector(".dm-question")?.className).toContain("dm-inline");
    expect(container.textContent?.match(/Ship it\?/g)).toHaveLength(1);
    expect(container.textContent?.match(/CI is green/g)).toHaveLength(1);
    expect(container.querySelector(".dm-action")).toBeNull();
  });
});

describe("cards in the boss's posts", () => {
  it("a request it gives you, and the suggestions an update carries, are inline too", () => {
    const { container, unmount } = show(
      said(
        "**Needs you.** acme-web waits on your answer to a request: run the migration",
        { item: { itemId: "i5" }, approvals: [{ sessionId: "s9", approvalId: "a1", summary: "run the migration" }] },
        "question",
      ),
    );
    expect(container.querySelector(".dm-approval")?.className).toContain("dm-inline");
    expect(container.querySelector(".dm-action")).toBeNull();
    unmount();
    const u = show(said("…", { ...UPDATE, suggestions: [{ id: "g1", text: "Restart acme-web", state: "open" }] }, "update"));
    expect(u.container.querySelector(".dm-suggestion")?.className).toContain("dm-inline");
    expect(u.container.querySelector(".dm-action")).toBeNull();
  });

  it("an ordinary reply's cards stay as they are", () => {
    const { container } = show(said("Here's where things are.", { approvals: [{ sessionId: "s9", approvalId: "a1", summary: "run the migration" }] }));
    expect(container.querySelector(".dm-approval")?.className).toContain("dm-action");
  });

  it("links only a web address", () => {
    const { container } = show(said("…", { update: { sessions: [{ sessionId: "x", name: "X", text: "did it", refs: [{ kind: "pr", id: "#1", url: "javascript:alert(1)" }] }] } }, "update"));
    expect(container.querySelector("a.ref")).toBeNull();
    expect(container.querySelector("span.ref")?.textContent).toBe("#1");
  });
});

describe("reading the parts out of the words", () => {
  it("finds the recommended answer by the recommendation's words, or as the hub flags it", () => {
    const opts = ["Rewrite saved copies", "Only new ones"];
    expect(recommended(opts, "rewrite saved copies")).toBe("Rewrite saved copies");
    expect(recommended(opts, "I'd rewrite saved copies, so nobody gets resent the old wording.")).toBe("Rewrite saved copies");
    expect(recommended(["Yes", "No"], "Yes, no question")).toBeNull();
    expect(recommended(["No"], "Nothing to add")).toBeNull();
    expect(recommended(opts, null)).toBeNull();
    // Most of one option's words, clearly ahead of the rest.
    expect(closest(["Rewrite saved copies", "Only new ones"], "I'd rewrite the saved copies first")).toBe("Rewrite saved copies");
    // Close between two: none lit rather than the wrong one.
    expect(
      closest(
        ["Deactivate · leave the user empty", "Deactivate · I'll name the organisation", "Leave both as they are"],
        "deactivate the roles in (2). For (1), name the organisation if you know it, or leave it empty on staging for now.",
      ),
    ).toBeNull();
    expect(closest(["Yes", "No"], "")).toBeNull();
    expect(answerOptions(["A", { label: "B", recommended: true }], "A")).toEqual([
      { label: "A", recommended: false },
      { label: "B", recommended: true },
    ]);
  });

  it("splits a first sentence, a question's list, and a needs-you post", () => {
    expect(firstSentence("Done with code. Both PRs merged.")).toEqual(["Done with code.", "Both PRs merged."]);
    expect(firstSentence("no stop")).toEqual(["no stop", ""]);
    expect(readNeed("**Needs you.** Two records need a decision.\n1. A user with no org.\n2. An id with no user.")).toEqual({
      question: "Two records need a decision.",
      items: ["A user with no org.", "An id with no user."],
      rest: "",
    });
    expect(readNeedsPost("**Needs you.** Ship?\n\nHolding up: X\n\nI'd say: Yes\n\nAnd 2 more: say what's open?")).toEqual({
      text: "Ship?",
      age: null,
      holdingUp: "X",
      recommendation: "Yes",
      notes: ["And 2 more: say what's open?"],
    });
  });

  it("reads a decision's action, message and doing-nothing out of its line", () => {
    expect(decisionParts({ id: "1", text: "let acme-web wait", why: "CI is red" })).toMatchObject({ action: "Let acme-web wait.", why: "CI is red.", leftAlone: true, message: null });
    expect(decisionParts({ id: "1", text: "sent nothing", why: "" })).toMatchObject({ leftAlone: true, why: "" });
    expect(decisionParts({ id: "1", text: "let it wait", why: "x", kind: "acted" }).leftAlone).toBe(false);
    expect(decisionParts({ id: "1", text: "told it: “short”", why: "x" }).message).toBeNull();
    expect(decisionParts({ id: "1", text: "let the deploy wait", why: "x" }).leftAlone).toBe(true);
    expect(decisionParts({ id: "1", text: "left acme-web alone", why: "x" }).leftAlone).toBe(true);
    // Mentions waiting, but did something.
    expect(decisionParts({ id: "1", text: "Let it go ahead, then wait for review", why: "x" }).leftAlone).toBe(false);
    expect(decisionParts({ id: "1", text: "told it to wait for green CI", why: "x" }).leftAlone).toBe(false);
  });
});
