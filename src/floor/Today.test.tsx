import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Lane } from "../hub/types";
import { useFloor } from "./store";
import { NOW, agent, at, hub, need, ready, session, view } from "./testing";
import { clock } from "./time";
import { Today } from "./Today";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));

const DAY = new Date(NOW);
DAY.setHours(0, 0, 0, 0);

const show = (lanes: Lane[], needs = view().needs) => {
  useChat.setState({ hubs: [hub("local")] });
  useFloor.setState({ day: DAY.getTime(), hubs: { local: ready(view({ lanes, needs })) } });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Today", () => {
  it("draws a lane each, with what each stretch was and when, waiting on you first", () => {
    show(
      [
        { who: agent("ledger", "Ledger"), spans: [{ kind: "working", from: at(120), to: at(60) }] },
        {
          who: session("s-1", "acme-web"),
          spans: [
            { kind: "working", from: at(40), to: at(12) },
            { kind: "waiting", from: at(12), to: null },
          ],
        },
        { who: session("s-2", "repo"), spans: [{ kind: "background", from: at(6), to: null }] },
      ],
      [need("q", session("s-1", "acme-web"))],
    );
    render(<Today now={NOW} />);
    const lanes = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(lanes).toEqual(["acme-web", "repo", "Ledger"]);
    expect(screen.getByRole("img", { name: `working ${clock(at(120))}–${clock(at(60))}` })).toBeTruthy();
    expect(screen.getByRole("img", { name: `waited on you ${clock(at(12))}–now` }).getAttribute("title")).toBe(`waited on you ${clock(at(12))}–now`);
    expect(screen.getByRole("img", { name: `background work ${clock(at(6))}–now` }).className).toContain("span-background");
    expect(screen.getByText(`now ${clock(NOW)}`)).toBeTruthy();
    const waiting = screen.getByRole("img", { name: `waited on you ${clock(at(12))}–now` }) as HTMLElement;
    expect(parseFloat(waiting.style.left) + parseFloat(waiting.style.width)).toBeCloseTo(100);
  });

  it("shows eight lanes until asked for the rest", () => {
    show(Array.from({ length: 20 }, (_, i) => ({ who: agent(`a${i}`), spans: [{ kind: "working" as const, from: at(100 - i), to: at(50 - i) }] })));
    render(<Today now={NOW} />);
    expect(screen.getAllByRole("group")).toHaveLength(8);
    const more = screen.getByRole("button", { name: "Show 12 more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(screen.getAllByRole("group")).toHaveLength(20);
    expect(screen.getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
    act(() => useFloor.setState({ day: DAY.getTime() + 86_400_000 }));
    expect(screen.queryAllByRole("group").length).toBeLessThanOrEqual(8);
  });

  it("says when nothing has run yet", () => {
    show([]);
    render(<Today now={NOW} />);
    expect(screen.getByText("Nothing has run yet today.")).toBeTruthy();
  });
});
