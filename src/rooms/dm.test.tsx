import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation } from "../chat/conversation";
import { useChat, type History } from "../chat/store";
import type { ChatMessage, Me } from "../chat/types";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { Rooms } from "./Rooms";
import { servePictures } from "../pictures/testing";

// The rich renderer is its own package (with its own React); plain text
// stands in for it here.
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

// jsdom doesn't lay anything out.
Element.prototype.scrollIntoView = () => {};

const msg = (id: string, role: ChatMessage["role"], content: string, at: string): ChatMessage => ({
  id,
  role,
  content,
  at,
  status: "complete",
  tools: [],
});

const history = (over: Partial<History>): History => ({
  state: "ready",
  messages: [],
  more: false,
  earlier: "idle",
  loadedAt: "2026-10-28T10:00:00.000Z",
  ...over,
});

const show = (h: History | undefined, live: ChatMessage[] = []) => {
  useChat.setState({
    hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw", local: false, token: "t" }],
    roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    activeAgent: "dw/allan",
    conversations: { "dw/allan": { ...emptyConversation(), connected: true, messages: live } },
    histories: h ? { "dw/allan": h } : {},
  });
  render(<Rooms />);
};

const texts = () => [...document.querySelectorAll(".msg-text")].map((e) => e.textContent?.trim());

beforeEach(() => useDesk.setState({ activeRoom: null, hub: null }));
afterEach(cleanup);

describe("a DM with its history", () => {
  it("shows what the hub kept above what arrives live, each message once", () => {
    show(
      history({
        more: true,
        messages: [msg("h1", "user", "what's open?", "2026-10-27T10:00:00Z"), msg("h2", "assistant", "Two PRs.", "2026-10-27T10:00:05Z")],
      }),
      [
        msg("m-1", "assistant", "Two PRs.", "2026-10-28T10:05:00.000Z"),
        msg("m-2", "user", "merge them", "2026-10-28T10:06:00.000Z"),
      ],
    );
    expect(texts()).toEqual(["what's open?", "Two PRs.", "merge them"]);
    expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeTruthy();
  });

  it("starts quietly where the hub keeps nothing", () => {
    show(history({ state: "absent", loadedAt: null }));
    expect(screen.getByText("This is the start of your conversation with Allan.")).toBeTruthy();
    expect(screen.queryByText(/Couldn’t/)).toBeNull();
    expect(screen.queryByRole("button", { name: /earlier/ })).toBeNull();
  });

  it("offers to try again when it couldn't be read", () => {
    show(history({ state: "failed", loadedAt: null }));
    expect(screen.getByText(/Couldn’t load your earlier conversation/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

describe("a DM turn the overseer sent on", () => {
  const atlas = { hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: true };
  const scout = { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false };

  const showLocal = (messages: ChatMessage[], live: ChatMessage[] = [], me: Record<string, Me> = {}) => {
    useOverview.setState({ manager: { agentId: "atlas", level: "act" } });
    useChat.setState({
      hubs: [{ id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" }],
      roster: [atlas, scout],
      me,
      activeAgent: "local/scout",
      conversations: { "local/scout": { ...emptyConversation(), connected: true, messages: live } },
      histories: { "local/scout": history({ messages }) },
    });
    render(<Rooms />);
  };

  const heads = () => [...document.querySelectorAll(".msg-head b")].map((e) => e.textContent);

  it("shows as from the overseer, with what it asked and how it came", () => {
    showLocal([
      msg("h1", "user", "Atlas asks: How is the staging check going?", "2026-10-28T09:00:00Z"),
      msg("h2", "assistant", "Green.", "2026-10-28T09:00:05Z"),
      msg("h3", "user", "Atlas has a task for you: Update the release notes.", "2026-10-28T09:01:00Z"),
      msg("h4", "user", "thanks", "2026-10-28T09:02:00Z"),
    ]);
    expect(heads()).toEqual(["Atlas", "Scout", "Atlas", "You"]);
    expect(texts()).toEqual(["How is the staging check going?", "Green.", "Update the release notes.", "thanks"]);
    expect([...document.querySelectorAll(".msg-via")].map((e) => e.textContent)).toEqual(["via Atlas", "task via Atlas"]);
    expect(document.querySelectorAll(".msg-user")).toHaveLength(1);
  });

  it("shows a suggestion you said yes to as yours, through the overseer", () => {
    showLocal([msg("h1", "user", "You asks: Restart the stuck build.", "2026-10-28T09:00:00Z")]);
    expect(heads()).toEqual(["You"]);
    expect(texts()).toEqual(["Restart the stuck build."]);
    expect(screen.getByText("via Atlas")).toBeTruthy();
  });

  const byAtlas = { kind: "overseer" as const, id: "atlas", name: "Atlas" };
  const byYou = { kind: "you" as const, id: "you", name: "You" };

  it("shows as from the overseer the hub names, on any hub", () => {
    show(
      history({
        messages: [{ ...msg("h1", "user", "Atlas has a task for you: Update the notes.", "2026-10-28T09:00:00Z"), author: byAtlas }],
      }),
    );
    expect(heads()).toEqual(["Atlas"]);
    expect(texts()).toEqual(["Update the notes."]);
    expect(screen.getByText("task via Atlas")).toBeTruthy();
  });

  it("shows a suggestion you said yes to, worded with your name, as yours through the overseer", () => {
    showLocal([{ ...msg("h1", "user", "Sam asks: Restart the stuck build.", "2026-10-28T09:00:00Z"), author: byYou }], [], { local: { id: "u1", name: "Sam", picture: null } });
    expect(heads()).toEqual(["You"]);
    expect(texts()).toEqual(["Restart the stuck build."]);
    expect(screen.getByText("via Atlas")).toBeTruthy();
  });

  it("shows what the overseer sends on as it arrives in an open DM, and once when the hub has kept it", () => {
    const sent = { ...msg("h2", "user", "Atlas asks: How is staging?", "2026-10-28T10:05:00Z"), author: byAtlas, sentOn: true };
    showLocal([msg("h1", "assistant", "Hello.", "2026-10-28T09:00:00Z")], [sent]);
    expect(heads()).toEqual(["Scout", "Atlas"]);
    expect(texts()).toEqual(["Hello.", "How is staging?"]);
    cleanup();
    showLocal([msg("h1", "assistant", "Hello.", "2026-10-28T09:00:00Z"), { ...sent, sentOn: undefined }], [sent]);
    expect(texts()).toEqual(["Hello.", "How is staging?"]);
  });

  it("leaves what you typed as you typed it, though it reads like the overseer's wording", () => {
    showLocal([{ ...msg("h1", "user", "Sam asks: can you check staging?", "2026-10-28T09:00:00Z"), author: byYou }]);
    expect(heads()).toEqual(["You"]);
    expect(texts()).toEqual(["Sam asks: can you check staging?"]);
    expect(document.querySelectorAll(".msg-via")).toHaveLength(0);
  });

  it("is only looked for on this Mac, where the overseer is", () => {
    show(history({ messages: [msg("h1", "user", "Allan asks: is this you?", "2026-10-28T09:00:00Z")] }));
    expect(heads()).toEqual(["You"]);
    expect(texts()).toEqual(["Allan asks: is this you?"]);
  });
});
});

describe("what's delivered into a DM", () => {
  it("badges a reminder, shows a delivered file, and asks a prompt's choices", () => {
    show(
      history({
        messages: [
          { ...msg("h1", "assistant", "🔔 Reminder: stand-up", "2026-10-28T09:00:00Z"), delivery: "reminder" },
          {
            ...msg("h2", "assistant", "", "2026-10-28T09:01:00Z"),
            attachments: [{ artifact_id: "art_1", media_type: "application/zip", filename: "logs.zip", size: 2048 }],
          },
        ],
      }),
    );
    expect(screen.getByText("Reminder")).toBeTruthy();
    expect(screen.getByText("logs.zip")).toBeTruthy();
    const prompt = {
      requestId: "q1",
      tool: "slack.send",
      content: 'Posts outside Desk, to slack #ops: "deploy done"',
      options: { allow_once: true, deny_once: true, allow_always: true, deny_always: true },
      turnRef: "t1",
    };
    act(() => useChat.setState((s) => ({ conversations: { "dw/allan": { ...s.conversations["dw/allan"]!, prompts: [prompt] } } })));
    expect(screen.getByText('Posts outside Desk, to slack #ops: "deploy done"')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("offers a routed approval's choices on its hub", () => {
    show(history({ messages: [{ ...msg("h1", "assistant", "Run the deploy job?", "2026-10-28T09:00:00Z"), delivery: "approval", requestId: "q7" }] }));
    expect(screen.getByText("Approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});

describe("pictures in a DM", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("show the agent, and you as their workspace has you, round", async () => {
    const fetch = servePictures();
    const pic = (version: string) => ({ version, source: "chosen" as const, at: "" });
    useChat.setState({
      hubs: [
        { id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" },
        { id: "dw", label: "Driftwerk", url: "https://dw.example", local: false, token: "t-dw" },
      ],
      roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false, picture: pic("a1") }],
      me: { local: { id: "u-local", name: "Sam", picture: pic("l1") }, dw: { id: "u-dw", name: "Sam", picture: pic("d1") } },
      activeAgent: "dw/allan",
      conversations: { "dw/allan": { ...emptyConversation(), connected: true } },
      histories: { "dw/allan": history({ messages: [msg("h1", "user", "Status?", "2026-10-28T09:00:00Z"), msg("h2", "assistant", "Green.", "2026-10-28T09:00:05Z")] }) },
    });
    render(<Rooms />);
    const [mine, theirs] = [...document.querySelectorAll(".msg")];
    await vi.waitFor(() => expect(theirs!.querySelector(".mark img")).toBeTruthy());
    await vi.waitFor(() => expect(mine!.querySelector(".mark-person img")).toBeTruthy());
    expect(document.querySelector(".room-head .mark img")).toBeTruthy();
    const asked = fetch.mock.calls.map(([u]) => String(u));
    expect(asked).toContain("https://dw.example/api/me/picture");
    expect(asked).toContain("https://dw.example/api/agents/allan/picture");
    expect(asked).not.toContain("http://127.0.0.1:1/api/me/picture");
  });
});
