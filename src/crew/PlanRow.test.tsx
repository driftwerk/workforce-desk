import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanRow } from "./PlanRow";
import { PlanHub } from "./planTesting";

afterEach(cleanup);

describe("a plan in a line", () => {
  it("says, on its chip, why the plan limit pauses it and until when", () => {
    const hub = new PlanHub();
    Object.assign(hub.plan, {
      state: "paused",
      paused: "plan_limit",
      pausedWhy: "by plan limit until Fri 09:00: your weekly ChatGPT plan is at 88%, over your 80% limit",
    });
    render(<PlanRow plan={hub.summary()} onToggle={() => {}} />);
    const row = screen.getByRole("group", { name: /^Plan: / });
    expect(row.querySelector(".chip")?.getAttribute("title")).toBe(
      "Paused by plan limit until Fri 09:00: your weekly ChatGPT plan is at 88%, over your 80% limit",
    );
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
});
