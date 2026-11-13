import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadChip } from "./DmThread";

afterEach(cleanup);

describe("a DM message's thread chip", () => {
  it("shows who replied, how many, and when last", () => {
    const { container } = render(
      <ThreadChip agent="dw/desk" hub="dw" name="Desk" thread={{ parent: "k4", replies: 4, lastAt: "2026-11-12T16:38:00Z", authors: ["agent", "user"], working: false }} />,
    );
    expect(container.querySelectorAll(".thread-marks .mark")).toHaveLength(2);
    expect(screen.getByRole("button").textContent).toMatch(/4 replies last /);
  });

  it("shows no faces when the hub names no authors", () => {
    const { container } = render(
      <ThreadChip agent="dw/desk" hub="dw" name="Desk" thread={{ parent: "k4", replies: 1, lastAt: "", authors: [], working: true }} />,
    );
    expect(container.querySelector(".thread-marks")).toBeNull();
    expect(screen.getByRole("button").textContent).toBe("1 reply· working");
  });
});
