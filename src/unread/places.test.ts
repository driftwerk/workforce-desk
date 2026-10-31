import { describe, expect, it } from "vitest";
import { parsePlace, placeKey, type Place } from "./places";

describe("a place's string form", () => {
  it("round-trips every kind of place", () => {
    const all: Place[] = [
      { kind: "dm", hub: "dw", agent: "allan" },
      { kind: "room", room: "r1" },
      { kind: "thread", room: "r1", thread: "m1" },
      { kind: "session", session: "s1" },
      { kind: "activity" },
      { kind: "brief" },
      { kind: "update" },
    ];
    for (const p of all) expect(parsePlace(placeKey(p))).toEqual(p);
    expect(placeKey({ kind: "thread", room: "r1", thread: "m1" })).toBe("thread:r1/m1");
  });

  it("knows nothing it can't read", () => {
    expect(parsePlace("floor")).toBeNull();
    expect(parsePlace("room:")).toBeNull();
    expect(parsePlace("thread:r1")).toBeNull();
    expect(parsePlace("nonsense:x/y/z")).toBeNull();
  });
});
