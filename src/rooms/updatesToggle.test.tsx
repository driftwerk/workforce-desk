import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation } from "../chat/conversation";
import { useChat } from "../chat/store";
import { UPDATES_CARD_KEY } from "../crew/updatesShown";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { Manager } from "../hub/types";
import { useOverview } from "../overview/store";
import { deskState } from "../restore/boot";
import { Rooms } from "./Rooms";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emitTo: vi.fn(() => Promise.resolve()),
}));
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));
// Both agents oversee, so the card would show for either.
vi.mock("../crew/agentBrain", () => {
  const CONFIG = '[oversight]\nenabled = true\nlevel = "full"\n';
  const state = { configs: { "local/desk": CONFIG, "local/other": CONFIG }, put: () => {}, load: async () => {} };
  return {
    useAgentBrain: () => ({ brain: null, provider: null }),
    useAgentConfigs: Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state }),
  };
});

Element.prototype.scrollIntoView = () => {};

const transport: DeskTransport = {
  fetch: async () => new Response("{}", { status: 404 }),
  socket: () => ({}) as DeskSocket,
};

const show = (agent: string, manager = agent.split("/")[1]) => {
  useOverview.setState({ manager: { agentId: manager, level: "full" } as unknown as Manager });
  useChat.setState({ activeAgent: agent });
};

beforeEach(() => {
  deskState.remove(UPDATES_CARD_KEY);
  useDesk.setState({ activeRoom: null, hub: new DeskHub(transport) });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [
      { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
      { hubId: "local", id: "other", name: "Other", model: null, provider: null, isDefault: false },
    ],
    conversations: { "local/desk": { ...emptyConversation(), connected: true }, "local/other": { ...emptyConversation(), connected: true } },
    histories: {
      "local/desk": { state: "ready", messages: [], more: false, earlier: "idle", loadedAt: "2026-11-14T10:00:00.000Z" },
      "local/other": { state: "ready", messages: [], more: false, earlier: "idle", loadedAt: "2026-11-14T10:00:00.000Z" },
    },
  });
  show("local/desk");
});
afterEach(() => {
  cleanup();
  deskState.remove(UPDATES_CARD_KEY);
  useDesk.setState({ hub: null });
});

const card = () => document.querySelector(".upd-card");
const headButton = () => screen.queryByRole("button", { name: "Updates" });

describe("the boss's Updates card, hidden or shown", () => {
  it("is hidden at first: the chat has the width, and the header has a way to show it", () => {
    render(<Rooms />);
    expect(card()).toBeNull();
    expect(headButton()).toBeTruthy();
    // The button sits beside the tabs, not among them.
    expect(headButton()!.closest("[role=tablist]")).toBeNull();
  });

  it("shows from the header, keeps that in Desk's store, and hides from the card", () => {
    render(<Rooms />);
    act(() => fireEvent.click(headButton()!));
    expect(card()).toBeTruthy();
    expect(headButton()).toBeNull();
    expect(deskState.get(UPDATES_CARD_KEY)).toEqual({ shown: { "local/desk": true } });
    const hide = screen.getByRole("button", { name: "Hide updates" });
    expect(document.activeElement).toBe(hide);

    act(() => fireEvent.click(hide));
    expect(card()).toBeNull();
    expect(deskState.get(UPDATES_CARD_KEY)).toEqual({ shown: {} });
    expect(document.activeElement).toBe(headButton());
  });

  it("comes back as it was kept", () => {
    deskState.set(UPDATES_CARD_KEY, { shown: { "local/desk": true } });
    render(<Rooms />);
    expect(card()).toBeTruthy();
    expect(headButton()).toBeNull();
  });

  it("is kept per agent", () => {
    deskState.set(UPDATES_CARD_KEY, { shown: { "local/desk": true } });
    render(<Rooms />);
    expect(card()).toBeTruthy();
    act(() => show("local/other"));
    expect(card()).toBeNull();
    expect(headButton()).toBeTruthy();
  });

  it("reads past what it can't make sense of as hidden", () => {
    deskState.set(UPDATES_CARD_KEY, { shown: { "local/desk": "yes" } });
    render(<Rooms />);
    expect(card()).toBeNull();
  });

  it("isn't offered to an agent that oversees nothing", () => {
    show("local/other", "desk");
    render(<Rooms />);
    expect(headButton()).toBeNull();
    expect(card()).toBeNull();
  });
});
