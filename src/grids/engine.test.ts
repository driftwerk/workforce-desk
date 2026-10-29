import { describe, expect, it } from "vitest";
import {
  applyPreset,
  blank,
  close,
  STEPS,
  moveSplitter,
  place,
  presetById,
  presetOf,
  PRESETS,
  replace,
  snap,
  unpark,
  snapRect,
  split,
  findSplitter,
  splitterKey,
  splitterRange,
  splitters,
  tiles,
  without,
  zoneAt,
  type Pane,
  type PaneContent,
} from "./engine";

const ids = () => {
  let n = 0;
  return () => `p${++n}`;
};

const term = (id: string): PaneContent => ({ kind: "terminal", terminalId: id });
const sess = (id: string): PaneContent => ({ kind: "session", sessionId: id });

/** The rects by pane id, for compact expectations. */
const rects = (panes: Pane[]) => Object.fromEntries(panes.map((p) => [p.id, p.rect && [p.rect.x, p.rect.y, p.rect.w, p.rect.h]]));

describe("twelfths", () => {
  it("snaps fractions to the nearest twelfth", () => {
    expect(snap(0)).toBe(0);
    expect(snap(0.5)).toBe(6);
    expect(snap(1 / 3)).toBe(4);
    expect(snap(0.3)).toBe(4);
    expect(snap(0.04)).toBe(0);
    expect(snap(1.4)).toBe(STEPS);
    expect(snap(-1)).toBe(0);
  });

  it("snaps a rectangle and never makes it smaller than a step", () => {
    expect(snapRect({ x: 0.49, y: 0, w: 0.52, h: 1 })).toEqual({ x: 6, y: 0, w: 6, h: 12 });
    expect(snapRect({ x: 0.99, y: 0.99, w: 0.001, h: 0.001 })).toEqual({ x: 11, y: 11, w: 1, h: 1 });
  });

  it("every preset tiles the grid and is recognised as itself", () => {
    for (const p of PRESETS) {
      const panes = p.rects.map((rect, i) => ({ id: String(i), rect, content: null }));
      expect(tiles(panes)).toBe(true);
      expect(presetOf(panes)).toBe(p.id);
    }
  });
});

describe("presets", () => {
  it("keeps content in reading order, adds empty panes, and keeps pane ids", () => {
    const next = ids();
    const one = replace(blank(next), "p1", term("a"));
    const quarters = applyPreset(one, presetById("quarters"), next);
    expect(tiles(quarters)).toBe(true);
    expect(quarters).toHaveLength(4);
    expect(quarters[0]).toMatchObject({ id: "p1", content: term("a"), rect: { x: 0, y: 0, w: 6, h: 6 } });
    expect(quarters.slice(1).every((p) => p.content === null)).toBe(true);
  });

  it("parks what doesn't fit and brings it back when a layout has room", () => {
    const next = ids();
    let panes = applyPreset(blank(next), presetById("quarters"), next);
    panes = panes.map((p, i) => ({ ...p, content: term(`t${i}`) }));
    const halves = applyPreset(panes, presetById("halves"), next);
    expect(tiles(halves)).toBe(true);
    expect(halves.filter((p) => p.rect)).toHaveLength(2);
    expect(halves.filter((p) => !p.rect).map((p) => p.content)).toEqual([term("t2"), term("t3")]);
    const back = applyPreset(halves, presetById("quarters"), next);
    expect(back.filter((p) => p.rect).map((p) => p.content)).toEqual([term("t0"), term("t1"), term("t2"), term("t3")]);
    // Same panes throughout: nothing remounts.
    expect(back.map((p) => p.id).sort()).toEqual(panes.map((p) => p.id).sort());
  });

  it("drops empty panes that don't fit rather than parking them", () => {
    const next = ids();
    const nine = applyPreset(blank(next), presetById("nine"), next);
    const one = applyPreset(nine, presetById("one"), next);
    expect(one).toHaveLength(1);
  });

  it("puts an inserted pane in the place it was dropped on", () => {
    const next = ids();
    const halves = applyPreset(blank(next), presetById("halves"), next).map((p, i) => ({ ...p, content: term(`t${i}`) }));
    const focus = applyPreset(halves, presetById("focus"), next, { slot: 0, pane: { id: "new", rect: null, content: sess("s") } });
    const at = (x: number, y: number) => focus.find((p) => p.rect?.x === x && p.rect?.y === y)?.content;
    expect(at(0, 0)).toEqual(sess("s"));
    expect(at(8, 0)).toEqual(term("t0"));
    expect(at(8, 6)).toEqual(term("t1"));
  });
});

describe("splitting and replacing", () => {
  it("splits a pane on each side, the new pane taking that half", () => {
    const next = ids();
    const base = blank(next);
    expect(rects(split(base, "p1", "left", { id: "n", content: null })!)).toEqual({ p1: [6, 0, 6, 12], n: [0, 0, 6, 12] });
    expect(rects(split(base, "p1", "right", { id: "n", content: null })!)).toEqual({ p1: [0, 0, 6, 12], n: [6, 0, 6, 12] });
    expect(rects(split(base, "p1", "top", { id: "n", content: null })!)).toEqual({ p1: [0, 6, 12, 6], n: [0, 0, 12, 6] });
    expect(rects(split(base, "p1", "bottom", { id: "n", content: null })!)).toEqual({ p1: [0, 0, 12, 6], n: [0, 6, 12, 6] });
  });

  it("splits an odd width on twelfths and refuses a single step", () => {
    const thin: Pane[] = [
      { id: "a", rect: { x: 0, y: 0, w: 3, h: 12 }, content: null },
      { id: "b", rect: { x: 3, y: 0, w: 9, h: 12 }, content: null },
    ];
    const s = split(thin, "a", "right", { id: "n", content: null })!;
    expect(tiles(s)).toBe(true);
    expect(rects(s)).toMatchObject({ a: [0, 0, 2, 12], n: [2, 0, 1, 12] });
    expect(split(s, "n", "left", { id: "m", content: null })).toBeNull();
    expect(split(s, "n", "top", { id: "m", content: null })).not.toBeNull();
  });

  it("replaces a pane's content in place", () => {
    const panes = replace(blank(ids()), "p1", sess("s"));
    expect(panes).toEqual([{ id: "p1", rect: { x: 0, y: 0, w: 12, h: 12 }, content: sess("s") }]);
  });
});

describe("splitters", () => {
  it("finds the shared edges, joining panes that meet along a line", () => {
    const next = ids();
    const focus = applyPreset(blank(next), presetById("focus"), next);
    const all = splitters(focus);
    expect(all).toHaveLength(2);
    const v = all.find((s) => s.axis === "x")!;
    expect(v).toMatchObject({ at: 8, from: 0, to: 12 });
    expect(v.before).toHaveLength(1);
    expect(v.after).toHaveLength(2);
    expect(all.find((s) => s.axis === "y")).toMatchObject({ at: 6, from: 8, to: 12 });
  });

  it("splits a crossing into the edges that meet on each side", () => {
    const next = ids();
    const q = applyPreset(blank(next), presetById("quarters"), next);
    const vertical = splitters(q).filter((s) => s.axis === "x");
    expect(vertical.map((s) => [s.from, s.to])).toEqual([
      [0, 6],
      [6, 12],
    ]);
  });

  it("moves an edge, keeps every pane a step wide, and keeps the tiling", () => {
    const next = ids();
    const focus = applyPreset(blank(next), presetById("focus"), next);
    const v = splitters(focus).find((s) => s.axis === "x")!;
    expect(splitterRange(focus, v)).toEqual([1, 11]);
    const moved = moveSplitter(focus, v, 6);
    expect(tiles(moved)).toBe(true);
    expect(Object.values(rects(moved))).toEqual([
      [0, 0, 6, 12],
      [6, 0, 6, 6],
      [6, 6, 6, 6],
    ]);
    const clamped = moveSplitter(focus, v, 40);
    expect(clamped.find((p) => p.rect?.x === 0)!.rect!.w).toBe(11);
  });

  it("is the same splitter step after step, so a drag keeps going", () => {
    const next = ids();
    let panes = applyPreset(blank(next), presetById("focus"), next);
    const first = splitters(panes).find((s) => s.axis === "x")!;
    for (const to of [7, 6, 5]) {
      const live = findSplitter(panes, first)!;
      expect(splitterKey(live)).toBe(splitterKey(first));
      panes = moveSplitter(panes, live, to);
    }
    expect(tiles(panes)).toBe(true);
    expect(findSplitter(panes, first)!.at).toBe(5);
  });

  it("moves the top half of a crossing without the bottom", () => {
    const next = ids();
    const q = applyPreset(blank(next), presetById("quarters"), next);
    const top = splitters(q).find((s) => s.axis === "x" && s.from === 0)!;
    const moved = moveSplitter(q, top, 8);
    expect(tiles(moved)).toBe(true);
    expect(Object.values(rects(moved))).toEqual([
      [0, 0, 8, 6],
      [8, 0, 4, 6],
      [0, 6, 6, 6],
      [6, 6, 6, 6],
    ]);
  });
});

describe("closing", () => {
  it("gives the room to the neighbour on the left", () => {
    const next = ids();
    const thirds = applyPreset(blank(next), presetById("thirds"), next);
    const [, middle] = thirds;
    const after = close(thirds, middle!.id);
    expect(tiles(after)).toBe(true);
    expect(Object.values(rects(after))).toEqual([
      [0, 0, 8, 12],
      [8, 0, 4, 12],
    ]);
  });

  it("prefers the side one pane can fill alone", () => {
    const next = ids();
    const focus = applyPreset(blank(next), presetById("focus"), next);
    const topRight = focus.find((p) => p.rect?.x === 8 && p.rect?.y === 0)!;
    const after = close(focus, topRight.id);
    expect(tiles(after)).toBe(true);
    // The pane below takes it (one pane), not the large one (which is taller).
    expect(Object.values(rects(after))).toEqual([
      [0, 0, 8, 12],
      [8, 0, 4, 12],
    ]);
  });

  it("reflows a 3 × 3 pane by pane down to one", () => {
    const next = ids();
    let panes = applyPreset(blank(next), presetById("nine"), next);
    while (panes.length > 1) {
      panes = close(panes, panes[Math.floor(panes.length / 2)]!.id);
      expect(tiles(panes)).toBe(true);
    }
    expect(panes[0]!.rect).toEqual({ x: 0, y: 0, w: 12, h: 12 });
  });

  it("empties the last pane instead of removing it, and drops a parked one", () => {
    const panes = replace(blank(ids()), "p1", term("a"));
    expect(close(panes, "p1")).toEqual([{ ...panes[0]!, content: null }]);
    const withParked: Pane[] = [...panes, { id: "x", rect: null, content: term("b") }];
    expect(close(withParked, "x")).toEqual(panes);
  });

  it("takes content out wherever it is", () => {
    const next = ids();
    const halves = applyPreset(blank(next), presetById("halves"), next).map((p, i) => ({ ...p, content: sess(`s${i}`) }));
    const after = without(halves, sess("s1"));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ content: sess("s0"), rect: { x: 0, y: 0, w: 12, h: 12 } });
  });
});

describe("dropping", () => {
  const box = { left: 100, top: 100, width: 400, height: 200 };
  it("splits near an edge and replaces in the middle", () => {
    expect(zoneAt(box, 110, 200)).toBe("left");
    expect(zoneAt(box, 490, 200)).toBe("right");
    expect(zoneAt(box, 300, 110)).toBe("top");
    expect(zoneAt(box, 300, 290)).toBe("bottom");
    expect(zoneAt(box, 300, 200)).toBe("center");
  });

  it("places without snapping in the first empty pane, else splits the largest", () => {
    const next = ids();
    const halves = applyPreset(blank(next), presetById("halves"), next);
    const first = place(halves, { id: "n", content: sess("s") })!;
    expect(first.find((p) => p.content)?.id).toBe(halves[0]!.id);
    const full = first.map((p) => ({ ...p, content: p.content ?? sess("t") }));
    const more = place(full, { id: "n", content: sess("u") })!;
    expect(tiles(more)).toBe(true);
    expect(more).toHaveLength(3);
    expect(more.find((p) => p.id === "n")!.rect).toEqual({ x: 0, y: 6, w: 6, h: 6 });
  });
});

describe("parked panes", () => {
  it("come back under their own id: into an empty pane's place, else beside the largest", () => {
    const next = ids();
    const halves = applyPreset(blank(next), presetById("halves"), next);
    const withParked: Pane[] = [...replace(halves, halves[0]!.id, term("a")), { id: "x", rect: null, content: term("b") }];
    const back = unpark(withParked, "x")!;
    expect(tiles(back)).toBe(true);
    expect(back.find((p) => p.id === "x")!.rect).toEqual({ x: 6, y: 0, w: 6, h: 12 });
    expect(back).toHaveLength(2);
    const full = back.map((p) => ({ ...p, content: p.content ?? term("c") }));
    const crowded: Pane[] = [...full, { id: "y", rect: null, content: term("d") }];
    const beside = unpark(crowded, "y")!;
    expect(tiles(beside)).toBe(true);
    expect(beside.find((p) => p.id === "y")!.rect).not.toBeNull();
    expect(unpark(beside, "y")).toBeNull();
  });
});
