import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Steps } from "../rooms/ProgressCard";
import { ToolChips } from "./WorkingRow";
import type { ToolCall } from "./types";

afterEach(cleanup);
const tools = (n: number): ToolCall[] => Array.from({ length: n }, (_, i) => ({ name: `tool${i + 1}`, done: i < n - 1 }));

describe("a running turn's actions", () => {
  it("shows only the newest, earlier ones folded with a count", () => {
    render(<ToolChips tools={tools(8)} live />);
    expect(screen.getByText("tool8")).toBeTruthy();
    expect(screen.queryByText("tool7")).toBeNull();
    const b = screen.getByRole("button", { name: "+ 7 earlier steps" });
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });
  it("opens all of them and closes again", () => {
    render(<ToolChips tools={tools(8)} live />);
    fireEvent.click(screen.getByRole("button", { name: "+ 7 earlier steps" }));
    expect(screen.getByText("tool1")).toBeTruthy();
    expect(screen.getByText("tool8")).toBeTruthy();
    const b = screen.getByRole("button", { name: "Hide 7 earlier steps" });
    expect(b.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(b);
    expect(screen.queryByText("tool1")).toBeNull();
  });
  it("has no expander for one action, and says 1 earlier step in the singular", () => {
    const { rerender } = render(<ToolChips tools={tools(1)} live />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ToolChips tools={tools(2)} live />);
    expect(screen.getByRole("button", { name: "+ 1 earlier step" })).toBeTruthy();
  });
  it("folds the step list the same way", () => {
    const steps = tools(5).map((t) => ({ name: t.name, state: "done" as const, secs: 1 }));
    render(<Steps steps={steps} live />);
    expect(screen.getByText("tool5")).toBeTruthy();
    expect(screen.queryByText("tool4")).toBeNull();
    expect(screen.getByRole("button", { name: "+ 4 earlier steps" })).toBeTruthy();
  });
});

describe("a finished turn's actions", () => {
  it("folds them all behind the count", () => {
    render(<ToolChips tools={tools(3).map((t) => ({ ...t, done: true }))} live={false} />);
    expect(screen.queryByText("tool3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "3 steps" }));
    expect(screen.getByText("tool1")).toBeTruthy();
    expect(screen.getByText("tool3")).toBeTruthy();
  });
  it("shows nothing without actions", () => {
    const { container } = render(<ToolChips tools={[]} live={false} />);
    expect(container.textContent).toBe("");
  });
});
