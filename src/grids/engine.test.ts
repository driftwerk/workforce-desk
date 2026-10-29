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
  keepOrder,
  movePaneTo,
  parkedOrder,
  swapIn,
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

/** A layout with content in every place, ids a, b, c, …, in reading order. */
const filled = (preset: Parameters<typeof presetById>[0], at: (i: number) => number = () => 0): Pane[] =>
  presetById(preset).rects.map((rect, i) => ({ id: String.fromCharCode(97 + i), rect, content: term(`t${i}`), lastActive: at(i) }));

describe("moving a pane itself", () => {
  it("swaps two panes in the middle, both keeping their ids and their place in the list", () => {
    const q = filled("quarters");
    const moved = movePaneTo(q, "a", "d", "center", ids())!;
    expect(rects(moved)).toEqual({ a: [6, 6, 6, 6], b: [6, 0, 6, 6], c: [0, 6, 6, 6], d: [0, 0, 6, 6] });
    expect(moved.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(moved.find((p) => p.id === "a")!.content).toEqual(term("t0"));
    expect(tiles(moved)).toBe(true);
  });

  it("moves into an empty pane whatever part it's dropped on, leaving the empty pane where it was", () => {
    const q = filled("quarters").map((p) => (p.id === "d" ? { ...p, content: null } : p));
    for (const zone of ["left", "top", "center"] as const) {
      const moved = movePaneTo(q, "a", "d", zone, ids())!;
      expect(rects(moved)).toEqual({ a: [6, 6, 6, 6], b: [6, 0, 6, 6], c: [0, 6, 6, 6], d: [0, 0, 6, 6] });
      expect(moved.find((p) => p.id === "d")!.content).toBeNull();
    }
  });

  it("splits the target on a side, its old place going to its neighbours, without a new id", () => {
    const thirds = filled("thirds");
    const moved = movePaneTo(thirds, "a", "c", "bottom", ids())!;
    // a's place went to b (its only neighbour); c was split, a below it.
    expect(rects(moved)).toEqual({ a: [8, 6, 4, 6], b: [0, 0, 8, 12], c: [8, 0, 4, 6] });
    expect(moved.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(tiles(moved)).toBe(true);
  });

  it("leaves an empty pane, under a fresh id, where no neighbour can take its place", () => {
    // A pinwheel: the middle pane is bordered on every side by panes that
    // run past it, so closing it can only empty it.
    const pin: Pane[] = [
      { id: "n", rect: { x: 0, y: 0, w: 8, h: 4 }, content: sess("n") },
      { id: "e", rect: { x: 8, y: 0, w: 4, h: 8 }, content: sess("e") },
      { id: "s", rect: { x: 4, y: 8, w: 8, h: 4 }, content: sess("s") },
      { id: "w", rect: { x: 0, y: 4, w: 4, h: 8 }, content: sess("w") },
      { id: "m", rect: { x: 4, y: 4, w: 4, h: 4 }, content: term("m") },
    ];
    expect(tiles(pin)).toBe(true);
    const moved = movePaneTo(pin, "m", "e", "bottom", ids())!;
    expect(tiles(moved)).toBe(true);
    expect(moved.map((p) => p.id)).toEqual(["n", "e", "s", "w", "m", "p1"]);
    expect(moved.find((p) => p.id === "p1")).toEqual({ id: "p1", rect: { x: 4, y: 4, w: 4, h: 4 }, content: null });
    expect(rects(moved).m).toEqual([8, 4, 4, 4]);
  });

  it("does nothing onto itself, and nothing where the target is a single step", () => {
    const q = filled("quarters");
    expect(movePaneTo(q, "a", "a", "left", ids())).toBeNull();
    const thin: Pane[] = [
      { id: "a", rect: { x: 0, y: 0, w: 6, h: 12 }, content: sess("a") },
      { id: "b", rect: { x: 6, y: 0, w: 5, h: 12 }, content: sess("b") },
      { id: "c", rect: { x: 11, y: 0, w: 1, h: 12 }, content: sess("c") },
    ];
    expect(movePaneTo(thin, "a", "c", "left", ids())).toBeNull();
    expect(movePaneTo(thin, "a", "c", "top", ids())).not.toBeNull();
  });

  it("brings a parked pane in by its own id: a swap parks what it replaces, a side splits", () => {
    const halves = [...filled("halves"), { id: "z", rect: null, content: term("tz") }];
    const swapped = movePaneTo(halves, "z", "b", "center", ids())!;
    expect(rects(swapped)).toEqual({ a: [0, 0, 6, 12], b: null, z: [6, 0, 6, 12] });
    const split = movePaneTo(halves, "z", "b", "top", ids())!;
    expect(rects(split)).toEqual({ a: [0, 0, 6, 12], b: [6, 6, 6, 6], z: [6, 0, 6, 6] });
    expect(split.map((p) => p.id)).toEqual(["a", "b", "z"]);
  });
});

describe("a smaller layout", () => {
  it("keeps what needs you, then the focused pane, then the most recently active", () => {
    // Nine panes; e and g were active last, h needs you, b is focused.
    const nine = filled("nine", (i) => [0, 0, 0, 0, 50, 0, 40, 0, 0][i]!);
    expect(keepOrder(nine, { asking: ["h"], focused: "b" }).map((p) => p.id).slice(0, 4)).toEqual(["h", "b", "e", "g"]);
    const halves = applyPreset(nine, presetById("halves"), ids(), undefined, { asking: ["h"], focused: "b" });
    // What stays keeps reading order; the rest park, ids kept.
    expect(laidOutIds(halves)).toEqual(["b", "h"]);
    expect(halves.filter((p) => !p.rect).map((p) => p.id)).toEqual(["a", "c", "d", "e", "f", "g", "i"]);
    expect(halves.map((p) => p.id)).toEqual(nine.map((p) => p.id));
  });

  it("without any of that, keeps the first in reading order, as before", () => {
    const halves = applyPreset(filled("nine"), presetById("halves"), ids());
    expect(laidOutIds(halves)).toEqual(["a", "b"]);
  });

  it("refills from the parked panes, most recently active first, when a layout has room again", () => {
    const nine = filled("nine", (i) => i * 10);
    const one = applyPreset(nine, presetById("one"), ids());
    expect(laidOutIds(one)).toEqual(["i"]);
    expect(parkedOrder(one).map((p) => p.id)).toEqual(["h", "g", "f", "e", "d", "c", "b", "a"]);
    const quarters = applyPreset(one, presetById("quarters"), ids());
    expect(laidOutIds(quarters)).toEqual(["i", "h", "g", "f"]);
    expect(tiles(quarters)).toBe(true);
  });

  it("is undone exactly by putting the panes it had back", () => {
    const nine = filled("nine", (i) => i);
    const before = structuredClone(nine);
    const halves = applyPreset(nine, presetById("halves"), ids(), undefined, { focused: "a" });
    expect(halves.filter((p) => !p.rect)).toHaveLength(7);
    // The change never touched what it was given, which is the undo.
    expect(nine).toEqual(before);
    expect(presetOf(nine)).toBe("nine");
  });
});

describe("swapping a parked pane in", () => {
  it("fills an empty place first, else swaps with the least recently active pane that doesn't need you", () => {
    const parked = { id: "z", rect: null, content: term("tz") } as Pane;
    const withEmpty = [...filled("halves").map((p) => (p.id === "b" ? { ...p, content: null } : p)), parked];
    expect(rects(swapIn(withEmpty, "z")!)).toEqual({ a: [0, 0, 6, 12], z: [6, 0, 6, 12] });
    const busy = [...filled("thirds", (i) => [5, 1, 9][i]!), parked];
    expect(rects(swapIn(busy, "z")!)).toEqual({ a: [0, 0, 4, 12], b: null, c: [8, 0, 4, 12], z: [4, 0, 4, 12] });
    expect(rects(swapIn(busy, "z", ["b"])!)).toEqual({ a: null, b: [4, 0, 4, 12], c: [8, 0, 4, 12], z: [0, 0, 4, 12] });
  });
});

const laidOutIds = (panes: Pane[]) =>
  panes
    .filter((p) => p.rect)
    .sort((a, b) => a.rect!.y - b.rect!.y || a.rect!.x - b.rect!.x)
    .map((p) => p.id);
