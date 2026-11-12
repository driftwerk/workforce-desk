import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalText } from "./GoalText";

const LONG = "Fix the sign-in loop on the machines page, ".repeat(12).trim();

/** jsdom lays nothing out: the goal is said to need `lines` lines of 20px,
 *  two showing. */
const lines = (n: number) => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(n * 20);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(Math.min(n, 2) * 20);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a session's goal", () => {
  it("takes two lines, with all of it in its tooltip and a way to read the rest", () => {
    lines(6);
    render(<GoalText goal={LONG} onEdit={() => {}} />);
    const text = screen.getByTitle(LONG);
    expect(text.className).toContain("goal-clamped");
    const more = screen.getByRole("button", { name: "more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(text.className).toContain("goal-open");
    fireEvent.click(screen.getByRole("button", { name: "less" }));
    expect(text.className).toContain("goal-clamped");
  });

  it("says no more when it fits", () => {
    lines(1);
    render(<GoalText goal="Fix the sign-in loop" onEdit={() => {}} />);
    expect(screen.queryByRole("button", { name: "more" })).toBeNull();
  });

  it("is edited by clicking it, as before", () => {
    lines(6);
    const onEdit = vi.fn();
    render(<GoalText goal={LONG} onEdit={onEdit} />);
    fireEvent.click(screen.getByTitle(LONG));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("asks for one when there's none", () => {
    render(<GoalText goal="" onEdit={() => {}} />);
    expect(screen.getByRole("button", { name: "Add a goal so you know what this one is for" })).toBeTruthy();
  });
});
