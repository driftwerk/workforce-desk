import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskExtras } from "../hub/types";
import { Message } from "./Message";
import { heardSettled, useSettled } from "./settled";
import { act } from "@testing-library/react";

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

const BRIEF: DeskExtras = {
  update: {
    // What an older Desk reads, kept beside it.
    sessions: [{ sessionId: "s1", name: "Cufflink Migration", text: "a long paragraph nobody should have to read." }],
    decisions: [{ id: "d1", text: "an old long line", why: "a long why" }],
    brief: [
      {
        sessionId: "s1",
        label: "Cufflink Migration",
        items: [
          { id: "d1", kind: "done", action: "Release 2 tonight, #571 held for daytime", why: "it removes user access.", detail: null, undo: "undo" },
          {
            id: "d2",
            kind: "done",
            action: "Stopped #571 shipping without your yes",
            why: "it was set to go out with the release",
            detail: "Told the session: “Hold #571 back from tonight’s release.”",
            undo: null,
          },
          { id: "d3", kind: "done", action: "Answered its question about the dry run", why: "it asked what to run", detail: null, settledBy: "session" },
          { id: "d4", kind: "done", action: "Let it wait", why: "CI was running", detail: null, settledBy: "session" },
        ],
      },
      {
        sessionId: null,
        label: "Credentials",
        items: [{ id: "i1", kind: "forYou", action: "Rotate graphql-pro, contribsys and GitHub Packages tokens", why: "they’re in a local transcript", detail: null }],
      },
    ],
  },
};

describe("a brief update", () => {
  it("is one line an item, under its session's label: done marked ✓, for you marked ●, why after a dash", () => {
    const { container } = show(said("Update.", BRIEF, "update"));
    const cufflink = screen.getByRole("region", { name: "Cufflink Migration" });
    const rows = within(cufflink).getAllByRole("listitem");
    expect(rows[0]!.textContent).toBe("✓Release 2 tonight, #571 held for daytime — it removes user accessUndo");
    expect(within(rows[0]!).getByRole("img", { name: "Done" })).toBeTruthy();
    const creds = screen.getByRole("region", { name: "Credentials" });
    expect(within(creds).getByRole("img", { name: "For you" }).textContent).toBe("●");
    // Only the brief: the old paragraphs and sections aren't drawn too.
    expect(container.textContent).not.toContain("a long paragraph");
    expect(container.querySelector(".needs, .did, .dm-action")).toBeNull();
  });

  it("keeps the longer part behind more, and folds what the session settled into one faint line", () => {
    const { container } = show(said("Update.", BRIEF, "update"));
    expect(container.textContent).not.toContain("Hold #571 back");
    fireEvent.click(screen.getByRole("button", { name: "More: Stopped #571 shipping without your yes" }));
    expect(container.querySelector(".brief-detail")?.textContent).toContain("Hold #571 back");
    expect(screen.queryByText("Answered its question about the dry run")).toBeNull();
    const fold = screen.getByRole("button", { name: "Settled in the session · 2" });
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Answered its question about the dry run")).toBeTruthy();
    // Settled, it offers nothing to press.
    expect(screen.queryByRole("button", { name: /^Undo: Let it wait/ })).toBeNull();
  });

  it("undoes through the hub, and marks what's for you Done", async () => {
    show(said("Update.", BRIEF, "update"));
    fireEvent.click(screen.getByRole("button", { name: "Undo: Release 2 tonight, #571 held for daytime" }));
    await screen.findByText(/^Undone/);
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/decisions/d1/undo", body: undefined });
    // For you: Done only, no answers to pick.
    const creds = screen.getByRole("region", { name: "Credentials" });
    expect(within(creds).getAllByRole("button").map((b) => b.textContent)).toEqual(["Done"]);
    fireEvent.click(within(creds).getByRole("button", { name: /^Done: Rotate/ }));
    await waitFor(() => expect(within(creds).getByRole("img", { name: "Done" })).toBeTruthy());
    expect(asked).toContainEqual({ method: "POST", path: "/api/desk/items/i1/done", body: undefined });
    expect(within(creds).queryByRole("button", { name: /^Done:/ })).toBeNull();
  });

  it("shows answers only for what the boss couldn't decide", () => {
    const undecided: DeskExtras = {
      update: {
        ...BRIEF.update,
        needsYou: [
          { itemId: "n1", question: "Ship #571 in daytime tomorrow?", items: [], recommendation: null, options: [{ label: "Yes", recommended: false }, { label: "Not yet", recommended: false }], notBlocking: null, age: "5 min" },
          { itemId: "n2", question: "Rotate the tokens?", items: [], recommendation: null, options: [], notBlocking: null, age: "5 min" },
        ],
      },
    };
    const { container } = show(said("Update.", undecided, "update"));
    expect(container.querySelectorAll(".needs")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Not yet" })).toBeTruthy();
  });

  it("is read as before by a hub that sends no brief", () => {
    const { brief: _, ...old } = BRIEF.update!;
    const { container } = show(said("Update.", { update: old }, "update"));
    expect(container.textContent).toContain("a long paragraph");
    expect(container.querySelector(".brief-group")).toBeNull();
  });
});

describe("a brief update, live", () => {
  afterEach(() => useSettled.setState({ by: {} }));

  it("heads with its line, counts the times it left a session alone and what more there is", () => {
    const extras: DeskExtras = {
      update: { ...BRIEF.update, headline: "Cufflink Migration released tonight's work", moreItems: 2, brief: [{ ...BRIEF.update!.brief![0]!, leftAlone: 3 }] },
    };
    const { container } = show(said("Update.", extras, "update"));
    expect(container.querySelector(".upd-line")?.textContent).toBe("Cufflink Migration released tonight's work");
    expect(screen.getByText("Left it alone 3 times")).toBeTruthy();
    expect(screen.getByText("2 more: ask “what else?”")).toBeTruthy();
  });

  it("folds an item as soon as the hub says it was settled, and only an item it names", () => {
    show(said("Update.", BRIEF, "update"));
    expect(screen.getByText("Release 2 tonight, #571 held for daytime")).toBeTruthy();
    const settled = (itemId: string, by: string) =>
      act(() =>
        heardSettled({ id: "e1", at: "", kind: "settled", actor: { kind: "user", id: "you" } as never, text: "", detail: { itemId, by: by as "you", messageId: "m1" } }),
      );
    settled("i1", "you");
    const creds = screen.getByRole("region", { name: "Credentials" });
    expect(within(creds).getByRole("button", { name: "Settled" })).toBeTruthy();
    expect(within(creds).queryByRole("button", { name: /^Done:/ })).toBeNull();
    settled("d1", "session");
    expect(screen.getByRole("button", { name: "Settled in the session · 3" })).toBeTruthy();
    // Something else's event changes nothing.
    act(() => heardSettled({ id: "e2", at: "", kind: "finished", actor: { kind: "session", id: "s1" } as never, text: "" }));
    expect(screen.getByRole("button", { name: "Settled in the session · 3" })).toBeTruthy();
  });

  it("folds a settled question to one faint line", () => {
    const extras: DeskExtras = {
      update: {
        ...BRIEF.update,
        needsYou: [{ itemId: "n1", question: "Ship #571 in daytime tomorrow?", items: [], recommendation: null, options: [{ label: "Yes", recommended: false }], notBlocking: null, age: "5 min", settledBy: "you" }],
      },
    };
    const { container } = show(said("Update.", extras, "update"));
    expect(container.querySelector(".needs")).toBeNull();
    expect(screen.getByText("✓ Ship #571 in daytime tomorrow — settled by you")).toBeTruthy();
  });
});
