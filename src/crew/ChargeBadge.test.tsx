import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDesk } from "../hub/store";
import type { ChargeView, Session } from "../hub/types";
import { ChargeBadge } from "./ChargeBadge";

const charge: ChargeView = {
  session: "s1",
  group: null,
  boss: "sarah",
  bossName: "Sarah",
  how: "handed",
  wheel: "boss",
  wheelSince: null,
  since: "2026-11-03T10:00:00Z",
  releasedAt: null,
};

const asking = (waitsOnYou?: string) => ({ id: "s1", waitsOnYou }) as unknown as Session;

afterEach(() => {
  cleanup();
  useDesk.setState({ sessions: {} });
});

describe("ChargeBadge", () => {
  it("says the session waits on you, and why, by the session's own key", () => {
    // A local session with the same id has no reason: the badge reads the
    // session it is given, a machine's here.
    useDesk.setState({ sessions: { s1: asking(), "devbox/s1": asking("Sarah left this to you") } });
    render(<ChargeBadge charge={charge} session="devbox/s1" />);
    const badge = screen.getByText("Waiting on you");
    expect(badge.getAttribute("title")).toMatch(/^Waiting on you: Sarah left this to you\. /);
  });

  it("says the boss has it while nothing waits on you", () => {
    useDesk.setState({ sessions: { s1: asking() } });
    render(<ChargeBadge charge={charge} session="s1" />);
    expect(screen.getByText("Sarah has it")).toBeTruthy();
  });
});
