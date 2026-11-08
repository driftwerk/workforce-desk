import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { Message } from "../rooms/Message";
import { isCardText } from "./plan";

vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

const said = (content: string): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content,
  at: "",
  status: "complete",
  tools: [],
  desk: { plan: { id: "p1", revision: 1 } },
});

describe("a boss's message with its plan", () => {
  it("leaves out only the card's own header, which the card shows", () => {
    expect(isCardText("Sarah proposes a plan: Refunds\n\n1. ACM-20 Refunds endpoint")).toBe(true);
    expect(isCardText("Sarah changed the plan: Moved “A” after “B”")).toBe(true);
    expect(isCardText("Sarah proposes a change to the plan: Added “C”")).toBe(true);
    expect(isCardText("Refunds are done: all four tickets merged, the test is green in CI.")).toBe(false);
    const { container } = render(<Message message={said("Sarah proposes a plan: Refunds\n\n1. ACM-20 Refunds endpoint")} author="Sarah" onSubmitForm={() => true} />);
    expect(container.querySelector(".msg-text")).toBeNull();
  });

  it("keeps the boss's closing summary", () => {
    render(<Message message={said("Refunds are done: all four tickets merged, the test is green in CI.")} author="Sarah" onSubmitForm={() => true} />);
    expect(screen.getByText("Refunds are done: all four tickets merged, the test is green in CI.")).toBeTruthy();
  });
});
