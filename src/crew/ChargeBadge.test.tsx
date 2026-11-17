import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDesk } from "../hub/store";
import type { ChargeView, Session } from "../hub/types";
import { ChargeBadge } from "./ChargeBadge";
import { useCharges } from "./chargeStore";

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
  useCharges.setState({ released: {} });
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

  it("says you run a session you took back, and what that means, until it ends", () => {
    useDesk.setState({ sessions: { s1: asking() } });
    useCharges.setState({ released: { s1: { ...charge, releasedAt: "2026-11-03T11:00:00Z", releasedBy: "person" } } });
    const { rerender } = render(<ChargeBadge charge={undefined} session="s1" />);
    const badge = screen.getByText("You’re running this");
    expect(badge.className).toContain("charge-mine");
    expect(badge.getAttribute("title")).toBe("You took this back from Sarah. Sarah watches but won’t act on it until you hand it back.");
    rerender(<ChargeBadge charge={undefined} session="s1" short />);
    expect(screen.getByText("You run it")).toBeTruthy();
    useDesk.setState({ sessions: { s1: { ...asking(), state: "closed" } as Session } });
    rerender(<ChargeBadge charge={undefined} session="s1" short />);
    expect(screen.queryByText("You run it")).toBeNull();
  });
});
