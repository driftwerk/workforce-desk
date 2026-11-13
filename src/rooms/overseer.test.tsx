import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskExtras } from "../hub/types";
import { Message } from "./Message";
import { led, recommended } from "./Overseer";

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
        purpose: "moving billing onto the new ledger",
        text: "found why the export crashes; the fix's tests pass and it's opening the pull request now.",
        refs: [{ kind: "pr", id: "#622", url: "https://example.test/pr/622" }],
      },
    ],
    decisions: [{ id: "d1", text: "told it to wait for green CI", why: "red main blocks everyone's deploys", undo: "undo" }],
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

describe("a boss's update in your chat", () => {
  it("reads as plain text in Desk's tokens: no box, its kind a word after the time", () => {
    const { container } = show(said("**Billing migration** — …", UPDATE, "update"));
    expect(container.querySelector(".msg-kind")?.textContent?.trim()).toBe("update");
    expect(container.querySelector(".chip.msg-delivery")).toBeNull();
    // Each session named in semibold, what it's for faint, its ref a faint mono id.
    expect(container.querySelector("strong")?.textContent).toBe("Billing migration");
    expect(container.querySelector(".overseer .faint")?.textContent).toContain("(moving billing onto the new ledger)");
    expect(container.querySelector("a.ref")?.textContent).toBe("#622");
    // Nothing boxed.
    expect(container.querySelector(".dm-action")).toBeNull();
    expect(container.querySelector(".dm-inline")).toBeTruthy();
    // "I decided:" muted, with Undo as a small link; "Still waiting on you:" in the blocked colour.
    expect(screen.getByText("I decided:").closest("p")?.className).toBe("muted");
    expect(screen.getByRole("button", { name: /^Undo/ }).className).toContain("link");
    expect(screen.getByText("Still waiting on you:").className).toContain("state-blocked");
    // The recommended answer in the signal colour, the other plain.
    expect(screen.getByRole("button", { name: "Rewrite saved copies" }).className).toContain("btn-signal");
    expect(screen.getByRole("button", { name: "Only new ones" }).className).not.toContain("btn-signal");
  });

  it("undoes a decision through the hub, and shows it undone", async () => {
    answer = () => ok({ done: "told Billing migration to go ahead" });
    show(said("…", UPDATE, "update"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: told it to wait for green CI" }));
    await waitFor(() => expect(screen.getByText("Undone: told Billing migration to go ahead.")).toBeTruthy());
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/decisions/d1/undo", body: undefined });
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(screen.getByText(/told it to wait for green CI/).className).toBe("dec-undone");
  });

  it("shows a decision undone elsewhere, or gone, as undone; one that can't be has no button left", async () => {
    const one = (id: string, extra: object = {}) =>
      said("…", { decisions: [{ id, text: `chose ${id}`, why: "a reason", undo: "undo", ...extra }] }, "notice");
    answer = () => new Response(JSON.stringify({ error: "That decision was already undone." }), { status: 409 });
    let r = show(one("e409"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: chose e409" }));
    await waitFor(() => expect(screen.getByText("undone")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    r.unmount();
    answer = () => new Response(JSON.stringify({ error: "That decision isn’t there." }), { status: 404 });
    r = show(one("e404"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: chose e404" }));
    await waitFor(() => expect(screen.getByText("undone")).toBeTruthy());
    r.unmount();
    answer = () => new Response(JSON.stringify({ error: "What ran is fixed forward." }), { status: 400 });
    r = show(one("e400"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: chose e400" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("fixed forward"));
    expect(screen.queryByRole("button", { name: "Undo: chose e400" })).toBeNull();
    r.unmount();
    // The hub says it's undone: no button.
    show(one("gone", { undone: true }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("undone")).toBeTruthy();
  });

  it("remembers what you settled when the row is drawn again", async () => {
    const m = said("…", { update: { waiting: [{ itemId: "again", text: "Ship it?", options: ["Yes", "No"] }] } }, "update");
    const r = show(m);
    expect(screen.getByRole("group", { name: "Your answer: Ship it?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByText("You answered: Yes")).toBeTruthy());
    r.unmount();
    show(m);
    expect(screen.getByText("You answered: Yes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("links only a web address", () => {
    const { container } = show(
      said("…", { update: { sessions: [{ sessionId: "x", name: "X", text: "did it", refs: [{ kind: "pr", id: "#1", url: "javascript:alert(1)" }] }] } }, "update"),
    );
    expect(container.querySelector("a.ref")).toBeNull();
    expect(container.querySelector("span.ref")?.textContent).toBe("#1");
  });

  it("answers what waits through the hub, which settles it", async () => {
    show(said("…", UPDATE, "update"));
    fireEvent.click(screen.getByRole("button", { name: "Only new ones" }));
    await waitFor(() => expect(screen.getByText("You answered: Only new ones")).toBeTruthy());
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/items/i1/answer", body: { answer: "Only new ones" } });
    expect(screen.queryByRole("button", { name: "Rewrite saved copies" })).toBeNull();
  });

  it("says one settled elsewhere is settled, and a failure in plain words", async () => {
    answer = () => new Response(JSON.stringify({ error: "That was already settled." }), { status: 409 });
    show(said("…", { update: { waiting: [{ ...UPDATE.update!.waiting![0]!, itemId: "i1b" }] } }, "update"));
    fireEvent.click(screen.getByRole("button", { name: "Only new ones" }));
    await waitFor(() => expect(screen.getByText("Already settled.")).toBeTruthy());
  });

  it("shows a decision's own button by its kind, and none where it can't be undone", () => {
    show(
      said("…", {
        update: {
          decisions: [
            { id: "a", text: "started Lead picker", why: "you asked at 20:07", undo: "stop" },
            { id: "b", text: "answered Eden", why: "its plan says staging", undo: "correct" },
            { id: "c", text: "approved the deploy", why: "CI was green", undo: null },
          ],
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Stop it: started Lead picker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Correct: answered Eden" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});

describe("what needs you", () => {
  it("leads in the blocked colour, its recommendation muted, answers only where one is wanted", () => {
    const { container, unmount } = show(
      said(
        "**Needs you.** Should saved copies get the new wording too?\n\nHolding up: Billing is paused on this\n\nI'd say: Rewrite saved copies",
        { item: { itemId: "i2", recommendation: "Rewrite saved copies", options: ["Rewrite saved copies", "Only new ones"] } },
        "question",
      ),
    );
    // Its words through the rich renderer, the lead first, the recommendation muted.
    const body = container.querySelector(".needs-you")!;
    expect(body.firstElementChild?.textContent).toMatch(/^\*\*Needs you\.\*\* Should saved copies/);
    expect(screen.getByText("I'd say: Rewrite saved copies").className).toContain("muted");
    expect(screen.getByText("Holding up: Billing is paused on this").className).toContain("faint");
    expect(container.querySelector(".dm-action")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    unmount();
    // Asked with nothing to press: no buttons.
    show(said("**Needs you.** Tell me which repo the export lives in.", { item: { itemId: "i3" } }, "question"));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("says what still waits, and drops one set aside", async () => {
    show(
      said(
        "Still waiting on you: Rename the export? · 2 h\n\nI won't bring this up again: it stays in what's open, where you can answer or drop it.",
        { item: { itemId: "i4", options: ["Yes", "No"], parked: true } },
        "question",
      ),
    );
    expect(screen.getByText(/^\*\*Still waiting on you:\*\* Rename the export\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Drop it" }));
    await waitFor(() => expect(screen.getByText("Dropped.")).toBeTruthy());
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/items/i4/drop", body: undefined });
  });
});

describe("a decision posted on its own", () => {
  it("reads as an I decided line with its Undo", () => {
    show(said("I decided: let acme-web wait — CI is red.", { decisions: [{ id: "d9", text: "let acme-web wait", why: "CI is red.", undo: "undo" }] }, "notice"));
    expect(screen.getByText("I decided:").closest("p")?.className).toBe("muted");
    expect(screen.getByRole("button", { name: "Undo: let acme-web wait" })).toBeTruthy();
  });
});

describe("a session's question in the chat", () => {
  it("is needs-you, said once and unboxed: the message says it, its answers follow", () => {
    const { container } = show(
      said("acme-web asks: “Ship it?”\n\nCI is green and it wants to merge.", {
        questions: [{ messageId: "q1", sessionId: "s9", session: "acme-web", ask: "Ship it?", why: "CI is green and it wants to merge.", options: ["Yes"] }],
      }, "question"),
    );
    expect(container.querySelector(".needs-you")?.firstElementChild?.textContent).toBe("**Needs you.** acme-web asks: “Ship it?”");
    expect(container.querySelector(".dm-question")?.className).toContain("dm-inline");
    // The question and its why aren't said again under it.
    expect(container.textContent?.match(/Ship it\?/g)).toHaveLength(1);
    expect(container.textContent?.match(/CI is green/g)).toHaveLength(1);
    expect(container.querySelector(".dm-action")).toBeNull();
  });
});

describe("cards in the boss's posts", () => {
  it("a request it gives you, and the suggestions an update carries, are inline too", () => {
    const { container, unmount } = show(
      said("**Needs you.** acme-web waits on your answer to a request: run the migration", {
        item: { itemId: "i5" },
        approvals: [{ sessionId: "s9", approvalId: "a1", summary: "run the migration" }],
      }, "question"),
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
});

describe("the recommended answer", () => {
  it("is the one the recommendation is, or the only one its words name", () => {
    const opts = ["Rewrite saved copies", "Only new ones"];
    expect(recommended(opts, "rewrite saved copies")).toBe("Rewrite saved copies");
    expect(recommended(opts, "I'd rewrite saved copies, so nobody gets resent the old wording.")).toBe("Rewrite saved copies");
    expect(recommended(["Yes", "No"], "Yes, no question")).toBeNull();
    expect(recommended(["Yes", "Not now"], "I'd say not now: it's an hour's work")).toBe("Not now");
    expect(recommended(opts, "")).toBeNull();
    expect(recommended(opts, null)).toBeNull();
    // Not part of a word.
    expect(recommended(["No"], "Nothing to add")).toBeNull();
  });
});

describe("the needs-you lead", () => {
  it("is added once, bold either way", () => {
    expect(led("Ship it?")).toBe("**Needs you.** Ship it?");
    expect(led("**Needs you.** Ship it?")).toBe("**Needs you.** Ship it?");
    expect(led("Needs you. Ship it?")).toBe("**Needs you.** Ship it?");
    expect(led("Still waiting on you: Ship it? · 2 h")).toBe("**Still waiting on you:** Ship it? · 2 h");
  });
});

