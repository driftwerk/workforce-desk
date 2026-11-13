import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useFloor } from "../floor/store";
import { agent, need, ready, view } from "../floor/testing";
import { useDesk } from "../hub/store";
import type { Overview, Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { Dashboard, dayPart, SECTIONS } from "./Dashboard";

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

const session = (id: string, state: Session["state"]): Session =>
  ({ id, engine: "claude", name: id, goal: "", cwd: "/tmp", origin: "desk", state, live: true, createdAt: "", updatedAt: "" }) as Session;

const overview: Overview = {
  brief: null,
  counts: { working: 1, needsYou: 1, doneToday: 3 },
  items: [{ kind: "agent", id: "scout", name: "Scout", state: "needs_you", task: "Staging deploy", since: new Date().toISOString(), question: { text: "main or release?", options: [] } }],
};

beforeEach(() => {
  useOverview.setState({ overview: null, overviewSupport: "unknown", activitySupport: "no", feeds: {}, manager: null, managerSupport: "unknown" });
  useDesk.setState({ hub: null, sessions: { a: session("a", "working"), b: session("b", "working"), c: session("c", "idle") }, restore: [], openId: null, view: "floor" });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [] });
  useFloor.setState({ hubs: { local: ready(view({ needs: [need("q-1", agent("scout"))] })) } });
});
afterEach(() => {
  cleanup();
  useFloor.setState({ hubs: {} });
});

describe("the Dashboard", () => {
  it("is one page: its title and line, then the Floor as a section headed Floor", () => {
    render(<Dashboard onNewSession={() => {}} />);
    // One main landmark: the Floor in it is a part of the page, not a page.
    expect(screen.getAllByRole("main").map((m) => m.getAttribute("aria-label"))).toEqual(["Dashboard"]);
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
    expect(screen.getByText(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (morning|afternoon|evening|night)$/)).toBeTruthy();
    const floor = screen.getByRole("region", { name: "Floor" });
    expect(within(floor).getByRole("heading", { level: 2, name: "Floor" })).toBeTruthy();
    expect(within(floor).queryByRole("heading", { level: 1 })).toBeNull();
    // Its own headings sit under the section's: the Floor's groups are h3s.
    expect(within(floor).queryAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Floor"]);
    expect(within(floor).getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
    // What the Floor showed on its own page, it shows here.
    expect(within(floor).getByText("a")).toBeTruthy();
  });

  it("shows the crew's Floor under the same heading, with its counts and New session", () => {
    useOverview.setState({ overview });
    const onNewSession = vi.fn();
    render(<Dashboard onNewSession={onNewSession} />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const floor = screen.getByRole("region", { name: "Floor" });
    expect(within(floor).getByRole("heading", { level: 2, name: "Floor" })).toBeTruthy();
    expect(within(floor).getByText(/need(s)? you/, { selector: ".crew-floor-counts *" })).toBeTruthy();
    expect(within(floor).queryAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Floor"]);
    // It fills its card and scrolls inside it, as on its own page.
    expect(floor.querySelector(".crew-floor.floor-in")).toBeTruthy();
    fireEvent.click(within(floor).getByRole("button", { name: "New session" }));
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it("keeps a place for widgets: Add a widget is there, and says it's to come", () => {
    render(<Dashboard onNewSession={() => {}} />);
    const add = screen.getByRole("button", { name: /Add a widget/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.textContent).toContain("soon");
  });

  it("is a list of sections, the Floor first, each drawn under its own heading", () => {
    expect(SECTIONS.map((s) => [s.id, s.title])).toEqual([["floor", "Floor"]]);
    render(<Dashboard onNewSession={() => {}} />);
    const sections = [...document.querySelectorAll(".dashboard > section")];
    expect(sections.map((s) => s.getAttribute("data-section"))).toEqual(["floor"]);
    expect(sections.every((s) => s.getAttribute("aria-labelledby") && document.getElementById(s.getAttribute("aria-labelledby")!)?.tagName === "H2")).toBe(true);
  });
});

describe("the Dashboard's line", () => {
  it("names the day and its part", () => {
    expect(dayPart(new Date(2026, 10, 13, 15, 0).getTime())).toBe("Friday afternoon");
    expect(dayPart(new Date(2026, 10, 13, 8, 0).getTime())).toBe("Friday morning");
    expect(dayPart(new Date(2026, 10, 13, 21, 0).getTime())).toBe("Friday evening");
    expect(dayPart(new Date(2026, 10, 14, 2, 0).getTime())).toBe("Saturday night");
  });

});
