import { describe, expect, it, vi } from "vitest";
import { OVERLAY_PX, overlayFor } from "./icon";

/** A canvas that records what's drawn and answers blank pixels. */
const canvas = () => {
  const drawn: string[] = [];
  const g = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: (_x: number, _y: number, r: number) => drawn.push(`circle ${r}`),
    fill: vi.fn(),
    fillText: (t: string) => drawn.push(`text ${t}`),
    getImageData: () => ({ data: new Uint8ClampedArray(OVERLAY_PX * OVERLAY_PX * 4) }),
    set fillStyle(_v: string) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  };
  return { el: { width: 0, height: 0, getContext: () => g } as unknown as HTMLCanvasElement, drawn };
};

describe("the app's unread mark", () => {
  it("draws Windows' overlay for a count, 99+ or a dot, and none for nothing", () => {
    expect(overlayFor({ count: 0, dot: false }, "#f80", canvas().el)).toBeNull();
    for (const [count, label] of [
      [7, "7"],
      [120, "99+"],
    ] as const) {
      const c = canvas();
      expect(overlayFor({ count, dot: false }, "#f80", c.el)).toHaveLength(OVERLAY_PX * OVERLAY_PX * 4);
      expect(c.drawn).toEqual([`circle ${OVERLAY_PX / 2}`, `text ${label}`]);
    }
    const dot = canvas();
    expect(overlayFor({ count: 0, dot: true }, "#f80", dot.el)).toHaveLength(OVERLAY_PX * OVERLAY_PX * 4);
    expect(dot.drawn).toEqual([`circle ${OVERLAY_PX / 4}`]);
  });
});
