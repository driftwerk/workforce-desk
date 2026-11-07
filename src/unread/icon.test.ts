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
    set fillStyle(v: string) {
      drawn.push(`fill ${v}`);
    },
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  };
  return { el: { width: 0, height: 0, getContext: () => g } as unknown as HTMLCanvasElement, drawn };
};

describe("the app's unread mark", () => {
  it("draws Windows' overlay for a count, 99+ or a dot, and none for nothing", () => {
    expect(overlayFor({ count: 0, dot: false }, "#D4FF3A", "#161A05", canvas().el)).toBeNull();
    for (const [count, label] of [
      [7, "7"],
      [120, "99+"],
    ] as const) {
      const c = canvas();
      expect(overlayFor({ count, dot: false }, "#D4FF3A", "#161A05", c.el)).toHaveLength(OVERLAY_PX * OVERLAY_PX * 4);
      // The count is in the theme's text on its signal, not white (1.2:1 on Night's lime).
      expect(c.drawn).toEqual(["fill #D4FF3A", `circle ${OVERLAY_PX / 2}`, "fill #161A05", `text ${label}`]);
    }
    const dot = canvas();
    expect(overlayFor({ count: 0, dot: true }, "#D4FF3A", "#161A05", dot.el)).toHaveLength(OVERLAY_PX * OVERLAY_PX * 4);
    expect(dot.drawn).toEqual(["fill #D4FF3A", `circle ${OVERLAY_PX / 4}`]);
  });
});
