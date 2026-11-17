import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskExtras } from "../hub/types";
import { Message } from "./Message";

vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emitTo: vi.fn(() => Promise.resolve()),
}));
const opened = vi.hoisted(() => vi.fn());
vi.mock("../overview/people", async (real) => ({
  ...(await real<object>()),
  openSession: opened,
}));

const transport: DeskTransport = {
  fetch: async () =>
    new Response(JSON.stringify({ done: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  socket: () => ({}) as DeskSocket,
};

beforeEach(() => {
  opened.mockReset();
  useDesk.setState({ hub: new DeskHub(transport) });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null });
});

const post = (desk: DeskExtras): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content: "the markdown an older Desk shows",
  at: "2026-11-16T09:00:00Z",
  status: "complete",
  tools: [],
  delivery: "update",
  desk,
});
const show = (m: ChatMessage) => render(<Message message={m} author="Desk" onSubmitForm={() => true} />);

describe("an update written like a teammate's (shape A)", () => {
  const A: DeskExtras = {
    update: {
      // What an older Desk reads, kept beside it.
      brief: [
        {
          sessionId: "s1",
          label: "MAN-632",
          items: [
            {
              id: "d0",
              kind: "done",
              action: "an old line",
              why: null,
              detail: null,
            },
          ],
        },
      ],
      said: [
        {
          kind: "finished",
          headline: "The Rust build fix is done: both changes are merged and the tickets are closed.",
          body: "The getrandom 0.4 switch (#632) merged at 07:49, after the library updates (#631). I marked the ticket and its follow-up Done and closed the session.",
          ids: ["MAN-632", "MAN-637"],
          notChecked: "Staging hadn't deployed #632 or #640 yet when I closed the sessions, and nothing is watching them now.",
          session: { sessionId: "s1", name: "MAN-632", closed: true },
          did: [
            {
              id: "d1",
              kind: "done",
              action: "Marked MAN-632 Done",
              why: "both changes merged",
              detail: null,
              undo: null,
            },
            {
              id: "d2",
              kind: "done",
              action: "Closed the session",
              why: "its work was merged",
              detail: null,
              undo: "undo",
            },
          ],
        },
      ],
    },
  };

  it("says the work in words, its ids in brackets after, what wasn't checked and its session", () => {
    show(post(A));
    expect(screen.getByText("The Rust build fix is done: both changes are merged and the tickets are closed.")).toBeTruthy();
    expect(screen.getByText("(MAN-632, MAN-637)")).toBeTruthy();
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.queryByText("an old line")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open the session (MAN-632, closed) ›",
      }),
    );
    expect(opened).toHaveBeenCalledWith("s1");
  });

  it("folds what the boss did, each with its Undo", () => {
    show(post(A));
    const did = screen.getByRole("button", { name: /What I did · 2/ });
    expect(screen.queryByText("Marked MAN-632 Done")).toBeNull();
    fireEvent.click(did);
    expect(screen.getByText("Marked MAN-632 Done")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo: Closed the session" })).toBeTruthy();
  });

  it("counts every decision in a folded run of what the boss did", () => {
    const work = A.update!.said![0]!;
    const run = {
      id: "d3",
      kind: "done" as const,
      action: "Allowed 16 edits and test runs",
      why: "the billing migration",
      detail: Array.from({ length: 16 }, (_, n) => `10:${String(n).padStart(2, "0")} Allowed an edit`).join("\n"),
      folded: 16,
    };
    show(post({ update: { ...A.update!, said: [{ ...work, did: [...work.did!, run] }] } }));
    expect(screen.getByRole("button", { name: /What I did · 18/ })).toBeTruthy();
  });
});

describe("a roundup (shape C)", () => {
  const C: DeskExtras = {
    update: {
      headline: "Two Mantis fixes are finished and merged; Cufflink is still paused.",
      roundup: {
        since: "2026-11-16T07:00:00Z",
        routine: 15,
        sections: [
          {
            key: "upToYou",
            title: "Up to you",
            lines: [
              {
                kind: "needs_you",
                headline: "Cufflink work has been paused since 21:10 last night, as you asked.",
                body: "Lift it when you're ready; until then the session only watches.",
                session: { sessionId: "s3", name: "Cufflink Migration" },
              },
            ],
          },
          {
            key: "decided",
            title: "Decided without you",
            lines: [
              {
                headline: "I told the Cufflink session to delete rebuildable build files on the devbox if free space falls under 50 GB",
                body: "Because it follows your standing disk clean-up preference.",
                at: "2026-11-16T08:56:00Z",
                session: { sessionId: "s3", name: "Cufflink Migration" },
                did: [
                  {
                    id: "d9",
                    kind: "done",
                    action: "Told it to clear build files",
                    why: null,
                    detail: "Told the session: “If the devbox drops under 50 GB, delete target/ and node_modules/.”",
                    undo: "undo",
                  },
                ],
              },
            ],
          },
          {
            key: "finished",
            title: "Finished",
            lines: [
              {
                kind: "finished",
                headline: "A bad key file can no longer print the secret key into the logs.",
                body: "Its test change (#640) is merged.",
                ids: ["MAN-636"],
                session: { sessionId: "s2", name: "MAN-636", closed: true },
              },
            ],
          },
        ],
      },
    },
  };

  it("leads with what matters most, then each section with its lines", () => {
    show(post(C));
    expect(screen.getByText("Two Mantis fixes are finished and merged; Cufflink is still paused.")).toBeTruthy();
    for (const title of ["Up to you", "Decided without you", "Finished"]) expect(screen.getByRole("region", { name: title })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Worth knowing" })).toBeNull();
    const finished = screen.getByRole("region", { name: "Finished" });
    expect(within(finished).getByText("(MAN-636)")).toBeTruthy();
    fireEvent.click(within(finished).getByRole("button", { name: "MAN-636 ›" }));
    expect(opened).toHaveBeenCalledWith("s2");
    expect(screen.getByText(/15 routine ones/)).toBeTruthy();
  });

  it("gives each decision its because, its words on asking, and its Undo", () => {
    show(post(C));
    const decided = screen.getByRole("region", { name: "Decided without you" });
    expect(within(decided).getByText(/standing disk clean-up preference/)).toBeTruthy();
    expect(within(decided).queryByText(/delete target/)).toBeNull();
    fireEvent.click(within(decided).getByRole("button", { name: "Why?" }));
    expect(within(decided).getByText(/delete target/)).toBeTruthy();
    expect(within(decided).getByRole("button", { name: /^Undo: / })).toBeTruthy();
  });

  it("leaves out a section with nothing in it", () => {
    const empty: DeskExtras = { update: { roundup: { since: "2026-11-16T07:00:00Z", sections: [{ key: "stillGoing", title: "Still going", lines: [] }] } } };
    show(post(empty));
    expect(screen.queryByRole("region", { name: "Still going" })).toBeNull();
  });

  // An hour of ordinary approvals in one session: one line behind "16
  // routine things · Show", each of them behind its "Show all".
  const allowed = (n: number) => ({
    id: `r${n}`,
    kind: "done" as const,
    action: "Allowed Billing Migration",
    why: `test edit ${n} in its worktree`,
    detail: null,
    undo: null,
    at: `2026-11-17T09:${String(5 + (n % 10)).padStart(2, "0")}:00Z`,
  });
  const run = {
    kind: "routine" as const,
    headline: "Allowed Billing Migration 16 times, 09:05–09:15: test and fixture edits, and local test runs, all in its worktree.",
    session: { sessionId: "s3", name: "Billing Migration" },
    did: Array.from({ length: 16 }, (_, n) => allowed(n)),
    at: "2026-11-17T09:05:00Z",
  };
  const hour: DeskExtras = {
    update: {
      headline: "One fix merged; sixteen ordinary steps allowed.",
      roundup: { ...C.update!.roundup!, routine: 16, runs: [run] },
    },
  };

  it("folds the routine into one line a run, behind Show", () => {
    show(post(hour));
    expect(screen.queryByText(/routine ones/)).toBeNull();
    expect(screen.queryByText(run.headline)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show ›" }));
    expect(screen.getByText(/16 routine things/)).toBeTruthy();
    expect(screen.getByText(run.headline)).toBeTruthy();
    expect(screen.queryByText(/test edit 3 in its worktree/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all ›" }));
    expect(screen.getAllByText("Allowed Billing Migration")).toHaveLength(16);
    expect(screen.getByText(/test edit 3 in its worktree/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Billing Migration ›" }));
    expect(opened).toHaveBeenCalledWith("s3");
  });

  it("keeps a routine piece of work in Still going as a line of its own", () => {
    const going: DeskExtras = {
      update: {
        roundup: {
          since: "2026-11-17T09:00:00Z",
          sections: [
            {
              key: "stillGoing",
              title: "Still going",
              lines: [{ kind: "routine", headline: "The nightly check ran again.", body: "Nothing changed since 08:00.", ids: ["MAN-650"], session: { sessionId: "s4", name: "Nightly" } }],
            },
          ],
        },
      },
    };
    show(post(going));
    const still = screen.getByRole("region", { name: "Still going" });
    expect(within(still).getByText(/Nothing changed since 08:00/)).toBeTruthy();
    expect(within(still).getByText("(MAN-650)")).toBeTruthy();
    expect(within(still).queryByRole("button", { name: "Show all ›" })).toBeNull();
  });

  // The 17:00 hour, its names changed: one entry a session, its decisions
  // under it, the notable ones always shown.
  const message = (n: number, notable = false) => ({
    id: `b${n}`,
    kind: "done" as const,
    action: notable ? "Started it again in manual mode" : "Sent it a message",
    why: `step ${n} of the merge plan`,
    detail: null,
    undo: "undo" as const,
    at: `2026-11-17T17:${String(56 - n).padStart(2, "0")}:00Z`,
    ...(notable ? { notable: true } : {}),
  });
  const billing = {
    kind: "routine" as const,
    headline: "Billing Migration · 14 decisions, 17:05–17:56",
    session: { sessionId: "s3", name: "Billing Migration" },
    // The notable one ninth, behind the four newest messages.
    did: Array.from({ length: 14 }, (_, n) => message(n, n === 8)),
    at: "2026-11-17T17:56:00Z",
    decisions: 14,
  };
  const lockdown = {
    kind: "routine" as const,
    headline: "Access Lockdown · 1 decision at 17:33",
    session: { sessionId: "s5", name: "Access Lockdown" },
    did: [{ id: "l1", kind: "done" as const, action: "Stopped it", why: "you asked", detail: null, undo: "undo" as const, notable: true }],
    decisions: 1,
  };
  const grouped: DeskExtras = {
    update: {
      headline: "15 decided without you.",
      roundup: { since: "2026-11-17T17:00:00Z", sections: [{ key: "decided", title: "Decided without you", lines: [billing, lockdown] }] },
    },
  };

  it("says what it decided as one entry a session, the notable ones always shown", () => {
    show(post(grouped));
    const decided = screen.getByRole("region", { name: "Decided without you" });
    expect(within(decided).getByText(billing.headline)).toBeTruthy();
    expect(within(decided).getByText(lockdown.headline)).toBeTruthy();
    // Three newest messages and the notable one; ten more behind Show.
    expect(within(decided).getAllByText("Sent it a message")).toHaveLength(3);
    expect(within(decided).getByText("Started it again in manual mode")).toBeTruthy();
    expect(within(decided).getAllByRole("button", { name: /^Undo: / })).toHaveLength(5);
    fireEvent.click(within(decided).getByRole("button", { name: "10 more · Show ›" }));
    expect(within(decided).getAllByText("Sent it a message")).toHaveLength(13);
    expect(within(decided).getAllByRole("button", { name: /^Undo: / })).toHaveLength(15);
    fireEvent.click(within(decided).getByRole("button", { name: "Billing Migration ›" }));
    expect(opened).toHaveBeenCalledWith("s3");
  });

  it("keeps the notable ones of what the boss did shown in a message right away", () => {
    const work = { kind: "progress" as const, headline: "The migration is waiting on CI.", session: billing.session, did: billing.did };
    show(post({ update: { said: [work] } }));
    fireEvent.click(screen.getByRole("button", { name: /What I did · 14/ }));
    expect(screen.getAllByText("Sent it a message")).toHaveLength(3);
    expect(screen.getByText("Started it again in manual mode")).toBeTruthy();
    expect(screen.getByRole("button", { name: "10 more · Show ›" })).toBeTruthy();
  });

  it("lists a run as one line when you asked for every decision", () => {
    const every: DeskExtras = {
      update: { roundup: { since: "2026-11-17T09:00:00Z", sections: [{ key: "decided", title: "Decided without you", lines: [run] }] } },
    };
    show(post(every));
    const decided = screen.getByRole("region", { name: "Decided without you" });
    expect(within(decided).getByText(run.headline)).toBeTruthy();
    expect(within(decided).queryByRole("button", { name: "Why?" })).toBeNull();
    expect(within(decided).getByRole("button", { name: "Show all ›" })).toBeTruthy();
  });
});
