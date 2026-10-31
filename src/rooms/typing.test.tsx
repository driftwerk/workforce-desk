import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// How often a message renders: each an agent wrote is drawn by the rich
// renderer, and each from you (or sent on by the overseer) has your mark or
// the overseer's.
let drawn = 0;
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => {
    drawn++;
    return text;
  },
}));
vi.mock("../ui/Mark", async (real) => {
  const marks = await real<typeof import("../ui/Mark")>();
  return {
    ...marks,
    Mark: (props: Parameters<typeof marks.Mark>[0]) => {
      drawn++;
      return <marks.Mark {...props} />;
    },
    YouMark: (props: Parameters<typeof marks.YouMark>[0]) => {
      drawn++;
      return <marks.YouMark {...props} />;
    },
  };
});
vi.mock("./engine", () => ({
  say: vi.fn(async () => {}),
  prune: () => {},
  retry: () => {},
  dismiss: () => {},
  answerPrompt: () => true,
  answerForm: vi.fn(async () => {}),
}));

const { emptyConversation } = await import("../chat/conversation");
const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useOverview } = await import("../overview/store");
const { Rooms } = await import("./Rooms");
import type { ChatMessage } from "../chat/types";
import type { RoomDraft } from "../hub/store";
import type { RoomMessage } from "../hub/types";

// jsdom doesn't lay anything out.
Element.prototype.scrollIntoView = () => {};

/** A long conversation: 100 check-ins from the agent, each answered. */
const LONG = 100;
const long = (): ChatMessage[] =>
  Array.from({ length: LONG * 2 }, (_, i) => ({
    id: `h${i}`,
    role: i % 2 ? "user" : "assistant",
    content: i % 2 ? `thanks ${i}` : `## Check-in ${i}\n\n- all **green**`,
    at: `2026-10-28T09:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
    status: "complete",
    tools: [],
  }));

const type = (text: string) => {
  const box = document.querySelector("textarea")!;
  for (let i = 1; i <= text.length; i++) fireEvent.change(box, { target: { value: text.slice(0, i) } });
  return box;
};

beforeEach(() => {
  drawn = 0;
  useDesk.setState({ activeRoom: null, hub: null });
});
afterEach(cleanup);

describe("typing in a DM with a long history", () => {
  const show = () => {
    useChat.setState({
      hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw", local: false, token: "t" }],
      roster: [
        { hubId: "dw", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
        { hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false },
      ],
      activeAgent: "dw/desk",
      conversations: {
        "dw/desk": { ...emptyConversation(), connected: true },
        "dw/allan": { ...emptyConversation(), connected: true },
      },
      histories: {
        "dw/desk": { state: "ready", messages: long(), more: false, earlier: "idle", loadedAt: "2026-10-28T10:00:00.000Z" },
      },
    });
    render(<Rooms />);
    expect(drawn).toBe(LONG * 2);
    drawn = 0;
  };

  it("renders none of the messages again", () => {
    show();
    const box = type("hello");
    expect(box.value).toBe("hello");
    expect(drawn).toBe(0);
  });

  it("renders none of them for what happens in another conversation", () => {
    show();
    act(() =>
      useChat.setState((s) => ({
        conversations: { ...s.conversations, "dw/allan": { ...s.conversations["dw/allan"]!, typing: true } },
        dmUnread: { "dw/allan": 3 },
      })),
    );
    expect(drawn).toBe(0);
  });

  it("renders only the answer coming in as it streams", () => {
    show();
    const answer = (content: string): ChatMessage => ({ id: "live", role: "assistant", content, at: "2026-10-28T10:01:00Z", status: "streaming", tools: [] });
    act(() =>
      useChat.setState((s) => ({ conversations: { ...s.conversations, "dw/desk": { ...s.conversations["dw/desk"]!, messages: [answer("All")] } } })),
    );
    drawn = 0;
    for (const more of ["All green", "All green so", "All green so far"])
      act(() =>
        useChat.setState((s) => ({ conversations: { ...s.conversations, "dw/desk": { ...s.conversations["dw/desk"]!, messages: [answer(more)] } } })),
      );
    expect(drawn).toBe(3);
  });

  it("renders none of them on this computer, with turns the overseer sent on", () => {
    useOverview.setState({ manager: { agentId: "atlas", level: "act" } });
    useChat.setState({
      hubs: [{ id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" }],
      roster: [
        { hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: true },
        { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      ],
      activeAgent: "local/scout",
      conversations: { "local/scout": { ...emptyConversation(), connected: true } },
      histories: {
        "local/scout": {
          state: "ready",
          messages: long().map((m) => (m.role === "user" ? { ...m, content: `Atlas asks: ${m.content}` } : m)),
          more: false,
          earlier: "idle",
          loadedAt: "2026-10-28T10:00:00.000Z",
        },
      },
    });
    render(<Rooms />);
    expect(document.querySelectorAll(".msg-via")).toHaveLength(LONG);
    drawn = 0;
    type("hello");
    expect(drawn).toBe(0);
    useOverview.setState({ manager: null });
  });
});

describe("typing in a room with a long timeline", () => {
  const room = {
    id: "r1",
    slug: "release",
    name: "release",
    members: [{ hub: "dw", agent: "allan" }],
    defaultMember: "dw/allan",
    createdAt: "",
    updatedAt: "",
  };
  const timeline = (): RoomMessage[] =>
    Array.from({ length: LONG }, (_, i) => ({
      id: `m${i}`,
      roomId: "r1",
      threadId: null,
      author: "dw/allan",
      content: `## Check-in ${i}`,
      createdAt: `2026-10-29T09:00:00Z`,
      hop: 0,
    }));
  const show = () => {
    useChat.setState({
      hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw", local: false, token: "t" }],
      roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    });
    useDesk.setState({ activeRoom: "r1", rooms: { r1: room }, timelines: { r1: timeline() }, roomDrafts: {} });
    render(<Rooms />);
    expect(drawn).toBe(LONG);
    drawn = 0;
  };

  it("renders none of the messages again", () => {
    show();
    expect(type("hello").value).toBe("hello");
    expect(drawn).toBe(0);
  });

  it("renders only the answer coming in as it streams", () => {
    show();
    const draft = (text: string): RoomDraft => ({
      id: "d1",
      member: "dw/allan",
      threadId: null,
      asked: "m0",
      since: 0,
      text,
      working: null,
      tools: [],
      attachments: [],
      prompts: [],
      state: "live",
    });
    for (const text of ["All", "All green", "All green so far"]) act(() => useDesk.setState({ roomDrafts: { r1: [draft(text)] } }));
    expect(drawn).toBe(3);
  });
});
