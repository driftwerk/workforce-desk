// The Floor's sections at 360 px: nothing in them is wider than the window,
// so it never scrolls sideways. jsdom draws no layout, so this reads the rules
// that make it so: every row of a section wraps, every grid's column shrinks
// to the width there is, and long names break.

import { describe, expect, it } from "vitest";
import css from "../styles/overview.css?raw";

/** The declarations of `selector`'s own rule. */
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
};

describe("the Floor's sections at 360 px", () => {
  it("wrap every row they have", () => {
    for (const row of [".needs-jump", ".fsec-head", ".fsec-tools", ".fsec-plan-top", ".fsec-legend", ".fsec-tile-foot", ".activity-groups"])
      expect(rule(row), row).toMatch(/flex-wrap:\s*wrap/);
  });

  it("let their tiles' grid shrink to the width there is", () => {
    expect(rule(".fsec-tiles")).toMatch(/minmax\(min\(100%,\s*\d+px\),\s*1fr\)/);
  });

  it("let what holds text shrink below its content, and break long names", () => {
    for (const box of [".fsec", ".fsec-name", ".fsec-body", ".fsec-tile", ".fsec-plan", ".fsec-plan-name", ".fsec-need"]) expect(rule(box), box).toMatch(/min-width:\s*0/);
    for (const text of [".fsec-title", ".fsec-boss", ".fsec-plan-name", ".fsec-tile-gist"]) expect(rule(text), text).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".fsec-tile-title")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("draw every colour from the theme's tokens", () => {
    const start = css.indexOf("/* ── The Floor by group");
    const end = css.indexOf("/* ── The overseer's DM");
    const block = css.slice(start, end);
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  });
});
