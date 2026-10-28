import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation } from "../chat/conversation";
import { useChat, type History } from "../chat/store";
import type { ChatMessage } from "../chat/types";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { Rooms } from "./Rooms";

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

  const showLocal = (messages: ChatMessage[]) => {
    useOverview.setState({ manager: { agentId: "atlas", level: "act" } });
    useChat.setState({
      hubs: [{ id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" }],
      roster: [atlas, scout],
      activeAgent: "local/scout",
      conversations: { "local/scout": { ...emptyConversation(), connected: true } },
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

  it("is only looked for on this Mac, where the overseer is", () => {
    show(history({ messages: [msg("h1", "user", "Allan asks: is this you?", "2026-10-28T09:00:00Z")] }));
    expect(heads()).toEqual(["You"]);
    expect(texts()).toEqual(["Allan asks: is this you?"]);
  });
});
});
