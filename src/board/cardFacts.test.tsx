// What a synced card draws of its issue: its type's and state's glyphs,
// priority bars by rank, the series an epic or label takes, its PR chip,
// and the board's own facets (epic, type, sprint; cycle, project, label).

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PriorityBars, prChip, seriesOf, shortDate, stateShape, typeShape } from "./cardFacts";
import { facetChoices, facetOf, pointsOf, shownByFacets, sprintName } from "./facets";
import { ticket } from "./testing";
import type { Ticket, TicketDetails } from "../hub/types";

afterEach(cleanup);

const synced = (number: number, details: TicketDetails, over: Partial<Ticket> = {}): Ticket =>
  ticket(number, {
    external: { system: "jira", key: `PLT-${number}`, url: `https://example.test/browse/PLT-${number}`, remoteUpdatedAt: "2026-11-01T09:00:00Z", synced: true, link: "l", details },
    ...over,
  });

describe("an issue's glyphs", () => {
  it("draws a type by its level first, then its name; one it doesn't know as a task", () => {
    expect(typeShape("Initiative", 1)).toBe("epic");
    expect(typeShape("Epic")).toBe("epic");
    expect(typeShape("Sub-task")).toBe("sub");
    expect(typeShape("Subtask", -1)).toBe("sub");
    expect(typeShape("Bug")).toBe("bug");
    expect(typeShape("Production incident")).toBe("bug");
    expect(typeShape("Story")).toBe("story");
    expect(typeShape("Spike")).toBe("task");
    expect(typeShape(undefined)).toBeNull();
  });

  it("draws a Linear state by its type, and In Review apart from In Progress", () => {
    expect(stateShape("triage")).toBe("backlog");
    expect(stateShape("unstarted", "Todo")).toBe("todo");
    expect(stateShape("started", "In Progress")).toBe("progress");
    expect(stateShape("started", "In Review")).toBe("review");
    expect(stateShape("completed")).toBe("done");
    expect(stateShape("canceled")).toBe("canceled");
    expect(stateShape(undefined)).toBeNull();
  });
});

describe("priority", () => {
  it("is a ! at the top rank, else as many bars as it is urgent, titled with the site's name", () => {
    const urgent = render(<PriorityBars rank={1} name="Now" />);
    expect(urgent.getByRole("img", { name: "Priority Now" }).textContent).toBe("!");
    urgent.unmount();
    const low = render(<PriorityBars rank={4} name="Later" />);
    const bars = low.getByRole("img", { name: "Priority Later" }).querySelectorAll("rect");
    expect([...bars].map((r) => r.getAttribute("fill-opacity"))).toEqual(["1", "0.35", "0.35"]);
    low.unmount();
    const high = render(<PriorityBars rank={2} />);
    expect(high.getByRole("img", { name: "Priority High" }).querySelectorAll('rect[fill-opacity="1"]')).toHaveLength(3);
  });
});

describe("an epic's, project's or label's colour", () => {
  it("is a chart series, the same for a name every time and whatever its case", () => {
    for (const n of ["Permissions", "Client summaries", "Edge cloud", "Bug", ""]) {
      expect(seriesOf(n)).toBeGreaterThanOrEqual(1);
      expect(seriesOf(n)).toBeLessThanOrEqual(8);
      expect(seriesOf(n)).toBe(seriesOf(n.toUpperCase()));
    }
  });
});

describe("the PR chip", () => {
  it("says the one PR's number, else how many, by the issue's summary or the session's links", () => {
    expect(prChip({ links: [] }, undefined)).toBeNull();
    expect(prChip({ links: [{ kind: "pr", number: 5897, url: "https://example.test/pull/5897" }] }, undefined)).toMatchObject({ look: "open", text: "#5897" });
    expect(prChip({ links: [] }, { count: 2, state: "review" })).toMatchObject({ look: "review", text: "2 PRs" });
    expect(prChip({ links: [] }, { count: 2, state: "merged" })).toMatchObject({ look: "merged", text: "2 merged" });
    expect(prChip({ links: [] }, { count: 1, state: "changes", number: 6012 })).toMatchObject({ look: "changes", text: "#6012" });
    // A declined PR is drawn as a draft is: not going anywhere.
    expect(prChip({ links: [] }, { count: 1, state: "declined" })?.look).toBe("draft");
  });

  it("says a date the way a card's foot does", () => {
    expect(shortDate("2026-09-27T09:00:00Z")).toBe("Sep 27");
    expect(shortDate("not a date")).toBe("");
  });
});

describe("a synced board's facets", () => {
  const a = synced(1, { kind: "Story", epic: { key: "PLT-9", title: "Permissions" }, sprint: { name: "Sprint 42" }, points: 3 });
  const b = synced(2, { kind: "Bug", epic: { key: "PLT-9", title: "Permissions" }, points: 2 });
  const c = synced(3, { kind: "Story", labels: ["Backend", "Feature"], sprint: { number: 41 } });
  const plain = ticket(4);

  it("are what each issue says it is, and none for a ticket without an issue", () => {
    expect(facetOf(a, "epic")).toEqual(["Permissions"]);
    expect(facetOf(c, "label")).toEqual(["Backend", "Feature"]);
    expect(facetOf(c, "sprint")).toEqual(["Cycle 41"]);
    expect(facetOf(plain, "type")).toEqual([]);
    expect(sprintName({})).toBe("");
  });

  it("offer their choices most used first, and show only what matches every one set", () => {
    expect(facetChoices([a, b, c, plain], "type")).toEqual(["Story", "Bug"]);
    expect(facetChoices([a, b, c], "epic")).toEqual(["Permissions"]);
    expect([a, b, c, plain].filter((t) => shownByFacets(t, { epic: "Permissions", type: "Story" }))).toEqual([a]);
    expect([a, b, c, plain].filter((t) => shownByFacets(t, { label: "Feature" }))).toEqual([c]);
    expect([a, b, c, plain].filter((t) => shownByFacets(t, {}))).toHaveLength(4);
    expect([a, b, c, plain].filter((t) => shownByFacets(t, { type: undefined }))).toHaveLength(4);
  });

  it("add a column's points up", () => {
    expect(pointsOf([a, b, c, plain])).toBe(5);
  });
});
