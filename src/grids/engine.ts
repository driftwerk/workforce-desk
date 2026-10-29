// A grid's layout as data: panes are rectangles on a grid of twelfths (so
// halves, thirds, quarters and sixths all land exactly), and every change —
// a preset, a split, a splitter dragged, a pane closed — is one of these
// functions, which never mutate what they're given. A pane keeps its id
// through every change, so the view (one flat, keyed list) never remounts
// it; a pane with no rectangle is parked: out of the layout, its content
// kept until a layout has room for it again.

/** Steps across and down: twelfths. */
export const STEPS = 12;

/** In twelfths of the grid. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PaneContent =
  | { kind: "session"; sessionId: string }
  /** A conversation with an agent, by agent key (`<hub>/<agent>`). */
  | { kind: "agent"; agent: string }
  /** A login shell the hub hosts; `terminalId` is null until the hub has
   *  opened it (or again after the hub lost it), `cwd` where it was last. */
  | { kind: "terminal"; terminalId: string | null; cwd?: string | null };

export interface Pane {
  id: string;
  /** Null: parked. */
  rect: Rect | null;
  content: PaneContent | null;
}

export type Side = "left" | "right" | "top" | "bottom";
export type Zone = Side | "center";

export type PresetId = "one" | "halves" | "thirds" | "quarters" | "nine" | "focus";

export interface Preset {
  id: PresetId;
  name: string;
  rects: Rect[];
}

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

const even = (cols: number, rows: number): Rect[] => {
  const out: Rect[] = [];
  const w = STEPS / cols;
  const h = STEPS / rows;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) out.push(r(col * w, row * h, w, h));
  return out;
};

export const PRESETS: readonly Preset[] = [
  { id: "one", name: "One pane", rects: even(1, 1) },
  { id: "halves", name: "Halves", rects: even(2, 1) },
  { id: "thirds", name: "Thirds", rects: even(3, 1) },
  { id: "quarters", name: "2 × 2", rects: even(2, 2) },
  { id: "nine", name: "3 × 3", rects: even(3, 3) },
  { id: "focus", name: "One large, two beside it", rects: [r(0, 0, 8, 12), r(8, 0, 4, 6), r(8, 6, 4, 6)] },
];

export const presetById = (id: PresetId): Preset => PRESETS.find((p) => p.id === id)!;

/** A fraction of the grid (0–1) to the nearest twelfth. */
export const snap = (fraction: number): number => Math.max(0, Math.min(STEPS, Math.round(fraction * STEPS)));

/** A rectangle in fractions of the grid, snapped; never smaller than one step. */
export const snapRect = (f: { x: number; y: number; w: number; h: number }): Rect => {
  const x = Math.min(snap(f.x), STEPS - 1);
  const y = Math.min(snap(f.y), STEPS - 1);
  return { x, y, w: Math.max(1, snap(f.x + f.w) - x), h: Math.max(1, snap(f.y + f.h) - y) };
};

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const laidOut = (panes: readonly Pane[]): (Pane & { rect: Rect })[] => panes.filter((p): p is Pane & { rect: Rect } => p.rect !== null);

/** Top to bottom, then left to right. */
export const reading = <T extends Pane & { rect: Rect }>(panes: readonly T[]): T[] =>
  [...panes].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

/** The preset the layout is exactly, if any. */
export const presetOf = (panes: readonly Pane[]): PresetId | null => {
  const shown = reading(laidOut(panes));
  return (
    PRESETS.find((p) => {
      const rects = reading(p.rects.map((rect, i) => ({ id: String(i), rect, content: null })));
      return rects.length === shown.length && rects.every((x, i) => sameRect(x.rect, shown[i]!.rect));
    })?.id ?? null
  );
};

/** What a pane holds, as one string: the same session, agent or terminal
 *  twice in a grid is one thing. */
export const contentKey = (c: PaneContent): string =>
  c.kind === "session" ? `session:${c.sessionId}` : c.kind === "agent" ? `agent:${c.agent}` : `terminal:${c.terminalId ?? "new"}`;

export const findContent = (panes: readonly Pane[], c: PaneContent): Pane | undefined =>
  c.kind === "terminal" && !c.terminalId ? undefined : panes.find((p) => p.content && contentKey(p.content) === contentKey(c));

/** Lays the grid out as `preset`. Panes with content keep it, in reading
 *  order (parked ones after), and fill the preset's places in its order;
 *  places left over get empty panes; panes left over park if they hold
 *  something and go if they don't. With `insert`, that pane takes place
 *  `insert.slot` and the rest move along. */
export const applyPreset = (
  panes: readonly Pane[],
  preset: Preset,
  newId: () => string,
  insert?: { slot: number; pane: Pane },
): Pane[] => {
  const full = [...reading(laidOut(panes)).filter((p) => p.content), ...panes.filter((p) => !p.rect && p.content)];
  if (insert) full.splice(Math.max(0, Math.min(insert.slot, full.length)), 0, insert.pane);
  const empty = reading(laidOut(panes)).filter((p) => !p.content);
  const queue = [...full, ...empty];
  const placed: Pane[] = preset.rects.map((rect) => {
    const p = queue.shift();
    return p ? { ...p, rect } : { id: newId(), rect, content: null };
  });
  const parked = queue.filter((p) => p.content).map((p) => ({ ...p, rect: null }));
  // The panes keep the order they were in, so the keyed list only grows at
  // its end and nothing is moved in the DOM.
  const order = new Map(panes.map((p, i) => [p.id, i]));
  const all = [...placed, ...parked];
  return all.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
};

/** Splits pane `id`, giving `side` of it to `pane` (half, rounded down);
 *  null when it's one step across in that direction. */
export const split = (panes: readonly Pane[], id: string, side: Side, pane: Omit<Pane, "rect">): Pane[] | null => {
  const target = panes.find((p) => p.id === id);
  if (!target?.rect) return null;
  const t = target.rect;
  const across = side === "left" || side === "right";
  const size = across ? t.w : t.h;
  if (size < 2) return null;
  const part = Math.floor(size / 2);
  let mine: Rect;
  let theirs: Rect;
  if (side === "left") [theirs, mine] = [r(t.x, t.y, part, t.h), r(t.x + part, t.y, t.w - part, t.h)];
  else if (side === "right") [mine, theirs] = [r(t.x, t.y, t.w - part, t.h), r(t.x + t.w - part, t.y, part, t.h)];
  else if (side === "top") [theirs, mine] = [r(t.x, t.y, t.w, part), r(t.x, t.y + part, t.w, t.h - part)];
  else [mine, theirs] = [r(t.x, t.y, t.w, t.h - part), r(t.x, t.y + t.h - part, t.w, part)];
  return [...panes.map((p) => (p.id === id ? { ...p, rect: mine } : p)), { ...pane, rect: theirs }];
};

/** Pane `id` holds `content` instead. */
export const replace = (panes: readonly Pane[], id: string, content: PaneContent | null): Pane[] =>
  panes.map((p) => (p.id === id ? { ...p, content } : p));

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/** The panes along `side` of `rect`, if they cover that edge exactly and
 *  lie within it (so they can take its room without changing shape). */
const coveringNeighbours = (shown: readonly (Pane & { rect: Rect })[], rect: Rect, side: Side): (Pane & { rect: Rect })[] | null => {
  const across = side === "left" || side === "right";
  const touching = shown.filter((p) => {
    const q = p.rect;
    if (side === "left") return q.x + q.w === rect.x && overlaps(q.y, q.y + q.h, rect.y, rect.y + rect.h);
    if (side === "right") return q.x === rect.x + rect.w && overlaps(q.y, q.y + q.h, rect.y, rect.y + rect.h);
    if (side === "top") return q.y + q.h === rect.y && overlaps(q.x, q.x + q.w, rect.x, rect.x + rect.w);
    return q.y === rect.y + rect.h && overlaps(q.x, q.x + q.w, rect.x, rect.x + rect.w);
  });
  if (!touching.length) return null;
  const [lo, hi] = across ? [rect.y, rect.y + rect.h] : [rect.x, rect.x + rect.w];
  const spans = touching.map((p) => (across ? [p.rect.y, p.rect.y + p.rect.h] : [p.rect.x, p.rect.x + p.rect.w]) as [number, number]);
  if (spans.some(([a, b]) => a < lo || b > hi)) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let at = lo;
  for (const [a, b] of spans) {
    if (a !== at) return null;
    at = b;
  }
  return at === hi ? touching : null;
};

/** Takes pane `id` out. Its neighbours on one side grow into its room — the
 *  side with the fewest of them, left before above before right before
 *  below; a pane no side can absorb is emptied instead. The last pane is
 *  emptied, never removed. */
export const close = (panes: readonly Pane[], id: string): Pane[] => {
  const gone = panes.find((p) => p.id === id);
  if (!gone) return [...panes];
  if (!gone.rect) return panes.filter((p) => p.id !== id);
  const shown = laidOut(panes).filter((p) => p.id !== id);
  if (!shown.length) return replace(panes, id, null);
  const g = gone.rect;
  const options = (["left", "top", "right", "bottom"] as const)
    .map((side) => ({ side, by: coveringNeighbours(shown, g, side) }))
    .filter((o): o is { side: Side; by: (Pane & { rect: Rect })[] } => o.by !== null)
    .sort((a, b) => a.by.length - b.by.length);
  const best = options[0];
  if (!best) return replace(panes, id, null);
  const grow = new Set(best.by.map((p) => p.id));
  return panes
    .filter((p) => p.id !== id)
    .map((p) => {
      if (!grow.has(p.id) || !p.rect) return p;
      const q = p.rect;
      switch (best.side) {
        case "left":
          return { ...p, rect: { ...q, w: q.w + g.w } };
        case "right":
          return { ...p, rect: { ...q, x: g.x, w: q.w + g.w } };
        case "top":
          return { ...p, rect: { ...q, h: q.h + g.h } };
        case "bottom":
          return { ...p, rect: { ...q, y: g.y, h: q.h + g.h } };
      }
    });
};

/** A shared edge: the line `at` (x for a vertical splitter, y for a
 *  horizontal one) from `from` to `to`, with the panes before it (left or
 *  above) and after it, which move together. */
export interface Splitter {
  id: string;
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  before: string[];
  after: string[];
}

/** Every splitter: where panes meet along a line, joined wherever their
 *  edges overlap, so dragging one moves exactly the edges that meet there. */
export const splitters = (panes: readonly Pane[]): Splitter[] => {
  const shown = laidOut(panes);
  const out: Splitter[] = [];
  for (const axis of ["x", "y"] as const) {
    for (let at = 1; at < STEPS; at++) {
      const span = (p: Pane & { rect: Rect }): [number, number] => (axis === "x" ? [p.rect.y, p.rect.y + p.rect.h] : [p.rect.x, p.rect.x + p.rect.w]);
      const before = shown.filter((p) => (axis === "x" ? p.rect.x + p.rect.w : p.rect.y + p.rect.h) === at);
      const after = shown.filter((p) => (axis === "x" ? p.rect.x : p.rect.y) === at);
      if (!before.length || !after.length) continue;
      // Join every pane on either side into runs where spans overlap.
      const all = [...before.map((p) => ({ p, side: 0 })), ...after.map((p) => ({ p, side: 1 }))].sort((a, b) => span(a.p)[0] - span(b.p)[0]);
      let run: typeof all = [];
      let end = -1;
      const flush = () => {
        const b = run.filter((x) => x.side === 0).map((x) => x.p);
        const a = run.filter((x) => x.side === 1).map((x) => x.p);
        if (b.length && a.length) {
          const from = Math.min(...run.map((x) => span(x.p)[0]));
          out.push({ id: `${axis}:${at}:${from}`, axis, at, from, to: end, before: b.map((p) => p.id), after: a.map((p) => p.id) });
        }
        run = [];
      };
      for (const x of all) {
        const [s, e] = span(x.p);
        if (run.length && s >= end) flush();
        run.push(x);
        end = Math.max(end, e);
        if (run.length === 1) end = e;
      }
      if (run.length) flush();
    }
  }
  return out;
};

/** A splitter by the panes on either side of it, which stay the same while
 *  it moves (its line doesn't). */
export const splitterKey = (s: Pick<Splitter, "axis" | "before" | "after">): string =>
  `${s.axis}:${[...s.before].sort().join(",")}|${[...s.after].sort().join(",")}`;

/** Splitter `s` as the panes are now: the same panes on either side, else
 *  the edge between the same two first panes (after it met another edge). */
export const findSplitter = (panes: readonly Pane[], s: Pick<Splitter, "axis" | "before" | "after">): Splitter | undefined => {
  const all = splitters(panes).filter((x) => x.axis === s.axis);
  const key = splitterKey(s);
  return all.find((x) => splitterKey(x) === key) ?? all.find((x) => x.before.includes(s.before[0]!) && x.after.includes(s.after[0]!));
};

/** How far a splitter can go: every pane keeps at least one step. */
export const splitterRange = (panes: readonly Pane[], s: Splitter): [number, number] => {
  const byId = new Map(laidOut(panes).map((p) => [p.id, p.rect]));
  const lo = Math.max(...s.before.map((id) => (s.axis === "x" ? byId.get(id)!.x : byId.get(id)!.y) + 1));
  const hi = Math.min(...s.after.map((id) => {
    const q = byId.get(id)!;
    return (s.axis === "x" ? q.x + q.w : q.y + q.h) - 1;
  }));
  return [lo, hi];
};

/** Moves splitter `s` to line `to` (kept in range). */
export const moveSplitter = (panes: readonly Pane[], s: Splitter, to: number): Pane[] => {
  const [lo, hi] = splitterRange(panes, s);
  const at = Math.max(lo, Math.min(hi, Math.round(to)));
  if (at === s.at) return [...panes];
  const before = new Set(s.before);
  const after = new Set(s.after);
  return panes.map((p) => {
    if (!p.rect) return p;
    const q = p.rect;
    if (before.has(p.id)) return { ...p, rect: s.axis === "x" ? { ...q, w: at - q.x } : { ...q, h: at - q.y } };
    if (after.has(p.id)) return { ...p, rect: s.axis === "x" ? { ...q, x: at, w: q.x + q.w - at } : { ...q, y: at, h: q.y + q.h - at } };
    return p;
  });
};

/** Which part of a pane a point is over while something is dragged onto
 *  it: a band along each side splits it, the middle replaces it. */
export const zoneAt = (box: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone => {
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  const EDGE = 0.25;
  // The nearest edge, if the point is in its band.
  const near = [
    { zone: "left" as const, d: fx },
    { zone: "right" as const, d: 1 - fx },
    { zone: "top" as const, d: fy },
    { zone: "bottom" as const, d: 1 - fy },
  ].sort((a, b) => a.d - b.d)[0]!;
  return near.d < EDGE ? near.zone : "center";
};

/** Where something dropped without snapping goes: the first empty pane, else
 *  a split of the largest pane along its longer side. Null when every pane
 *  is a single step. */
export const place = (panes: readonly Pane[], pane: Omit<Pane, "rect">): Pane[] | null => {
  const shown = reading(laidOut(panes));
  const empty = shown.find((p) => !p.content);
  if (empty) return panes.map((p) => (p.id === empty.id ? { ...p, content: pane.content } : p));
  const largest = [...shown].sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h || a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0];
  if (!largest) return null;
  const wide = largest.rect.w * 1.2 >= largest.rect.h;
  return split(panes, largest.id, wide ? "right" : "bottom", pane) ?? split(panes, largest.id, wide ? "bottom" : "right", pane);
};

/** Brings parked pane `id` back into the layout, keeping its id (so what it
 *  shows isn't started again): in the first empty pane's place, else beside
 *  the largest. Null when there's no room. */
export const unpark = (panes: readonly Pane[], id: string): Pane[] | null => {
  const parked = panes.find((p) => p.id === id && !p.rect);
  if (!parked) return null;
  const rest = panes.filter((p) => p.id !== id);
  const empty = reading(laidOut(rest)).find((p) => !p.content);
  if (empty) return [...rest.filter((p) => p.id !== empty.id), { ...parked, rect: empty.rect }];
  return place(rest, parked);
};

/** Takes `content` out of the grid wherever it is (a pane laid out closes,
 *  a parked one goes), so it can be put somewhere else. */
export const without = (panes: readonly Pane[], content: PaneContent): Pane[] => {
  const there = findContent(panes, content);
  return there ? close(panes, there.id) : [...panes];
};

/** A grid that's a single empty pane. */
export const blank = (newId: () => string): Pane[] => [{ id: newId(), rect: r(0, 0, STEPS, STEPS), content: null }];

/** Whether the laid-out panes tile the grid exactly (no gaps, no
 *  overlaps): what every change above keeps true. */
export const tiles = (panes: readonly Pane[]): boolean => {
  const cells = new Array<number>(STEPS * STEPS).fill(0);
  for (const { rect } of laidOut(panes)) {
    if (rect.w < 1 || rect.h < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > STEPS || rect.y + rect.h > STEPS) return false;
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) cells[y * STEPS + x]! += 1;
  }
  return cells.every((c) => c === 1);
};
