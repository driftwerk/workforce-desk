import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { WorkUsageView } from "../hub/types";
import { useFloor } from "./store";
import { hub, ready, view } from "./testing";
import { WorkUsageCard } from "./WorkUsageCard";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const span = (turns: number, share?: number) => ({
  turns,
  tokens: 0,
  shares:
    share === undefined
      ? []
      : [{ plan: "claude" as const, windowMinutes: 10080, share }],
});
const data: WorkUsageView = {
  asOf: "2026-11-19T10:00:00Z",
  works: [
    {
      work: "job:1",
      label: "email check",
      agentId: "atlas",
      kind: "job",
      day: span(12, 0.8),
      week: span(80, 4.2),
    },
  ],
};
const show = (work: WorkUsageView | null) => {
  useChat.setState({ hubs: [hub("local")] });
  useFloor.setState({ hubs: { local: ready(view(), { work }) } });
};

afterEach(cleanup);

describe("the background work card", () => {
  it("says each work's use of the plan", () => {
    show(data);
    render(<WorkUsageCard />);
    const card = screen.getByRole("region", {
      name: "Background work on your plans",
    });
    expect(within(card).getByText("email check")).toBeTruthy();
    expect(within(card).getByText("job")).toBeTruthy();
    expect(
      within(card).getByText(
        "4.2% of your weekly Claude plan this week · 0.8% today · 80 turns",
      ),
    ).toBeTruthy();
  });
  it("is not there with no work in the week, or an older hub", () => {
    show({ ...data, works: [{ ...data.works[0]!, week: span(0) }] });
    const { container, rerender } = render(<WorkUsageCard />);
    expect(container.innerHTML).toBe("");
    show(null);
    rerender(<WorkUsageCard />);
    expect(container.innerHTML).toBe("");
  });
});
