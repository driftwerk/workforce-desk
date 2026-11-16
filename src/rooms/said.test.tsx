import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
const show = (m: ChatMessage) =>
  render(<Message message={m} author="Desk" onSubmitForm={() => true} />);

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
          headline:
            "The Rust build fix is done: both changes are merged and the tickets are closed.",
          body: "The getrandom 0.4 switch (#632) merged at 07:49, after the library updates (#631). I marked the ticket and its follow-up Done and closed the session.",
          ids: ["MAN-632", "MAN-637"],
          notChecked:
            "Staging hadn't deployed #632 or #640 yet when I closed the sessions, and nothing is watching them now.",
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
    expect(
      screen.getByText(
        "The Rust build fix is done: both changes are merged and the tickets are closed.",
      ),
    ).toBeTruthy();
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
    expect(
      screen.getByRole("button", { name: "Undo: Closed the session" }),
    ).toBeTruthy();
  });
});

describe("a roundup (shape C)", () => {
  const C: DeskExtras = {
    update: {
      headline:
        "Two Mantis fixes are finished and merged; Cufflink is still paused.",
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
                headline:
                  "Cufflink work has been paused since 21:10 last night, as you asked.",
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
                headline:
                  "I told the Cufflink session to delete rebuildable build files on the devbox if free space falls under 50 GB",
                body: "Because it follows your standing disk clean-up preference.",
                at: "2026-11-16T08:56:00Z",
                session: { sessionId: "s3", name: "Cufflink Migration" },
                did: [
                  {
                    id: "d9",
                    kind: "done",
                    action: "Told it to clear build files",
                    why: null,
                    detail: null,
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
                headline:
                  "A bad key file can no longer print the secret key into the logs.",
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
    expect(
      screen.getByText(
        "Two Mantis fixes are finished and merged; Cufflink is still paused.",
      ),
    ).toBeTruthy();
    for (const title of ["Up to you", "Decided without you", "Finished"])
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Worth knowing" })).toBeNull();
    const finished = screen.getByRole("region", { name: "Finished" });
    expect(within(finished).getByText("(MAN-636)")).toBeTruthy();
    fireEvent.click(
      within(finished).getByRole("button", { name: "MAN-636 ›" }),
    );
    expect(opened).toHaveBeenCalledWith("s2");
    expect(screen.getByText(/15 routine ones/)).toBeTruthy();
  });

  it("gives each decision its why on asking, and its Undo", () => {
    show(post(C));
    const decided = screen.getByRole("region", { name: "Decided without you" });
    expect(
      within(decided).queryByText(
        "Because it follows your standing disk clean-up preference.",
      ),
    ).toBeNull();
    fireEvent.click(within(decided).getByRole("button", { name: "Why?" }));
    expect(
      within(decided).getByText(/standing disk clean-up preference/),
    ).toBeTruthy();
    expect(
      within(decided).getByRole("button", { name: /^Undo: / }),
    ).toBeTruthy();
  });
});
