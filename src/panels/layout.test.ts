import { describe, expect, it } from "vitest";
import { clampWidth, DEFAULT_WIDTH, fitWidths, GUTTER, HANDLE, MAIN_MIN, maxWidth, MIN_WIDTH, spaceFor, wantedWidth } from "./layout";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("right-hand columns' widths", () => {
  it("are drawn as wanted while they leave the main area its share", () => {
    expect(fitWidths([420, 560], 2000)).toEqual([420, 560]);
    expect(fitWidths([420, 560], 420 + 980)).toEqual([420, 560]);
  });

  it("shrink in proportion when the window narrows, none under the minimum, never overflowing", () => {
    const w = fitWidths([400, 800], MAIN_MIN + 900);
    expect(w[1]! / w[0]!).toBeCloseTo(2, 1);
    expect(sum(w)).toBeLessThanOrEqual(900);
    // The narrow one stops at the minimum; the wide one gives the rest.
    const pinned = fitWidths([320, 900], MAIN_MIN + 700);
    expect(pinned[0]).toBe(MIN_WIDTH);
    expect(sum(pinned)).toBeLessThanOrEqual(700);
  });

  it("let the main area give way, then share what's left, when even the minimum doesn't fit", () => {
    expect(fitWidths([500, 500], 2 * MIN_WIDTH + 100)).toEqual([MIN_WIDTH, MIN_WIDTH]);
    expect(fitWidths([500, 500], 400)).toEqual([200, 200]);
    expect(fitWidths([500], 0)).toEqual([0]);
  });

  it("are dragged between the minimum and leaving the main area its share", () => {
    expect(maxWidth([420, 560], 1, 2000)).toBe(2000 - MAIN_MIN - 420);
    expect(maxWidth([420, 560], 0, 900)).toBe(MIN_WIDTH);
    expect(clampWidth(100, MIN_WIDTH, 900)).toBe(MIN_WIDTH);
    expect(clampWidth(5000, MIN_WIDTH, 900)).toBe(900);
  });

  it("are each kind's own, with a default until dragged", () => {
    expect(wantedWidth("session", {})).toBe(DEFAULT_WIDTH.session);
    expect(wantedWidth("thread", { thread: 333 })).toBe(333);
    expect(spaceFor(1400, 2)).toBe(1400 - GUTTER - 2 * HANDLE);
    expect(spaceFor(0, 2)).toBe(Infinity);
  });
});
