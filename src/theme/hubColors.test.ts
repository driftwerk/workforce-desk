import { describe, expect, it } from "vitest";
import type { Session } from "../hub/types";
import { DAY, NIGHT } from "./builtin";
import { needsRestartForColors } from "./hubColors";
import { derive } from "./tokens";

const session = (s: Partial<Session>): Session => ({ live: true, ...s }) as Session;

describe("restart to apply new terminal colours", () => {
  it("is offered for a CLI drawn for the other ground than its terminal's now", () => {
    expect(needsRestartForColors(session({ fixedGround: "dark" }), derive(DAY))).toBe(true);
    expect(needsRestartForColors(session({ fixedGround: "light" }), derive(NIGHT))).toBe(true);
  });

  it("is not offered when it matches, follows the terminal itself, or isn't running", () => {
    expect(needsRestartForColors(session({ fixedGround: "light" }), derive(DAY))).toBe(false);
    expect(needsRestartForColors(session({ fixedGround: null }), derive(DAY))).toBe(false);
    expect(needsRestartForColors(session({}), derive(DAY))).toBe(false);
    expect(needsRestartForColors(session({ live: false, fixedGround: "dark" }), derive(DAY))).toBe(false);
  });

  it("goes by the terminal's ground, not the theme's name", () => {
    const darkTerminal = derive({ ...DAY, id: "x", overrides: { ...DAY.overrides, sunken: "#101010" } });
    expect(needsRestartForColors(session({ fixedGround: "dark" }), darkTerminal)).toBe(false);
  });
});
