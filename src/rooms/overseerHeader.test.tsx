import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation } from "../chat/conversation";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import type { Manager } from "../hub/types";
import { Rooms } from "./Rooms";

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));
vi.mock("../crew/agentBrain", () => ({
  useAgentBrain: () => ({
    brain: { provider: "claude-code", model: "sonnet", effort: "medium" },
    provider: { id: "claude-code", name: "Claude plan", models: [{ id: "sonnet", name: "Sonnet 5.5", description: "", default: true }], efforts: ["medium"] },
  }),
}));

Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  useDesk.setState({ activeRoom: null, hub: null });
  useOverview.setState({ manager: { agentId: "desk", level: "full" } as unknown as Manager });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true }],
    activeAgent: "local/desk",
    conversations: { "local/desk": { ...emptyConversation(), connected: true } },
    histories: { "local/desk": { state: "ready", messages: [], more: false, earlier: "idle", loadedAt: "2026-11-14T10:00:00.000Z" } },
  });
});
afterEach(cleanup);

describe("the overseer's chat header", () => {
  it("says the model it thinks with after what it oversees", () => {
    render(<Rooms />);
    const line = document.querySelector(".room-head .room-title .faint")?.textContent ?? "";
    expect(line).toMatch(/^Overseeing 0 crew and 0 sessions · Act fully · Sonnet 5\.5 · Medium effort/);
  });
});
