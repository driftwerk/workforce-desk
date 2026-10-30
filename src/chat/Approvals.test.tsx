import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hubs/surface", () => ({ decideApproval: vi.fn() }));

const { decideApproval } = await import("../hubs/surface");
const { useChat } = await import("./store");
const { PromptCard, RoutedApproval } = await import("./Approvals");

beforeEach(() => {
  useChat.setState({ hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw.example", local: false, token: "t" }] });
  vi.mocked(decideApproval).mockReset();
});
afterEach(cleanup);

describe("an approval routed to a conversation", () => {
  it("says what became of it where focus was, in a region that announces it", async () => {
    vi.mocked(decideApproval).mockResolvedValue("approved");
    render(<RoutedApproval hubId="dw" requestId="q1" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Waiting for your answer");
    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    await act(async () => fireEvent.click(approve));
    expect(decideApproval).toHaveBeenCalledWith(expect.objectContaining({ id: "dw" }), "q1", "allow_once");
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("You approved this.");
    expect(document.activeElement).toBe(status);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("alerts you when the answer didn't go through, and keeps its buttons", async () => {
    vi.mocked(decideApproval).mockRejectedValue(new Error("The hub said no."));
    render(<RoutedApproval hubId="dw" requestId="q1" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deny" })));
    expect(screen.getByRole("alert").textContent).toBe("The hub said no.");
    expect(screen.getByRole("button", { name: "Deny" })).toHaveProperty("disabled", false);
  });
});

describe("a tool call waiting on you", () => {
  it("alerts you when the agent can't be reached to answer", () => {
    const prompt = { requestId: "q1", content: "Run npm test", tool: "bash", options: { allow_once: true, deny_once: true, allow_always: false, deny_always: false }, turnRef: null };
    render(<PromptCard prompt={prompt} onAnswer={() => false} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(screen.getByRole("alert").textContent).toMatch(/isn’t connected/);
  });
});
