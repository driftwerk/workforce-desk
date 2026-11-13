import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitchRow } from "./SwitchRow";

afterEach(cleanup);

describe("SwitchRow", () => {
  it("is a switch named by its label and described by its line", () => {
    render(<SwitchRow label="Watch for loops" sub="Desk tells it to stop." on={false} onChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Watch for loops" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-describedby")).toBe(screen.getByText("Desk tells it to stop.").id);
  });

  it("flips from the switch or its words, and not while disabled or saving", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SwitchRow label="Remember" on={true} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Remember" }));
    fireEvent.click(screen.getByText("Remember"));
    expect(onChange.mock.calls).toEqual([[false], [false]]);
    rerender(<SwitchRow label="Remember" on={true} saving onChange={onChange} />);
    const sw = screen.getByRole("switch", { name: "Remember" });
    expect(sw.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
