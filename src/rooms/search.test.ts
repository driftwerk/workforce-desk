import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Agent, HubAccount } from "../chat/types";
import type { Room } from "../hub/types";
import { filtersText, isEmpty, parseSearch } from "./search";
import { snippetParts } from "./SearchPanel";

beforeAll(() => void vi.stubEnv("TZ", "Europe/London"));
afterAll(() => void vi.unstubAllEnvs());

const room = (id: string, slug: string, name: string) => ({ id, slug, name, members: [], defaultMember: null, createdAt: "", updatedAt: "" }) as Room;
const rooms = [room("r1", "release", "Release"), room("r2", "acme-web", "acme-web")];
const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });
const roster = [agent("local", "allan", "Allan"), agent("dw", "sarah", "Sarah"), agent("local", "atlas", "Atlas"), agent("dw", "atlas", "Atlas")];
const hubs: HubAccount[] = [
  { id: "local", label: "This computer", url: "", local: true, token: "" },
  { id: "dw", label: "Acme", url: "", local: false, token: "" },
];
const parse = (text: string) => parseSearch(text, rooms, roster, hubs);

describe("reading a search", () => {
  it("takes each filter, and leaves the rest as the words to find", () => {
    expect(parse("from:@allan in:#release has:file has:approval is:thread rollback note").filters).toEqual({
      q: "rollback note",
      from: "local/allan",
      room: "r1",
      has: ["file", "approval"],
      inThread: true,
    });
    expect(parse("from:you in:acme-web").filters).toMatchObject({ from: "you", room: "r2", q: "" });
    expect(parse("ratio:16:9 note").filters.q).toBe("ratio:16:9 note");
  });

  it("says what a filter names nothing, and doesn't send it", () => {
    const p = parse("from:@bob in:#nowhere from:@atlas has:pictures");
    expect(p.problems).toEqual([
      "No one in your crew is called @bob",
      "No room is called #nowhere",
      "More than one of your crew is called @atlas: add its workspace, as @atlas@workspace",
      "has: takes file or approval",
    ]);
    expect(p.filters).toEqual({ q: "", has: [], inThread: false });
    expect(isEmpty(p.filters)).toBe(true);
  });

  it("reads days in this computer's time, across a change of the clocks", () => {
    expect(parse("on:2026-10-25").filters).toMatchObject({ after: "2026-10-24T23:00:00.000Z", before: "2026-10-26T00:00:00.000Z" });
    expect(parse("after:2026-10-24").filters.after).toBe("2026-10-24T23:00:00.000Z");
    expect(parse("before:2026-10-27").filters.before).toBe("2026-10-27T00:00:00.000Z");
    expect(parse("on:2026-02-30").problems).toEqual(["on: takes a day, as on:2026-10-27"]);
  });

  it("writes filters back as the text that reads as them", () => {
    for (const text of ["from:@allan in:#release has:file is:thread rollback", "on:2026-10-25 notes", "after:2026-10-24 before:2026-10-27", "from:you"]) {
      const { filters } = parse(text);
      const written = filtersText(filters, rooms, (key) => (key === "local/allan" ? "allan" : key));
      expect(parse(written).filters).toEqual(filters);
    }
  });
});

describe("a result's snippet", () => {
  it("is text and its matches, from the hub's markers", () => {
    expect(snippetParts("the rollback note and rollback")).toEqual([
      { text: "the ", match: false },
      { text: "rollback", match: true },
      { text: " note and ", match: false },
      { text: "rollback", match: true },
    ]);
    expect(snippetParts("<b>not html</b>")).toEqual([{ text: "<b>not html</b>", match: false }]);
  });
});
