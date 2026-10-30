// The columns that open on the right of the main area — a session, a room's
// thread, a DM beside the Floor — and how wide each is. Each kind keeps the
// width it was dragged to (in `ui.main`, so it survives a restart); what's
// drawn is that width fitted into the window, so a narrower window shrinks
// the columns without losing the widths they come back to.

export const PANEL_KINDS = ["thread", "agent", "session", "search"] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

export const isPanelKind = (x: unknown): x is PanelKind => typeof x === "string" && (PANEL_KINDS as readonly string[]).includes(x);

/** Each kind's width until it's dragged, and again after a double-click. */
export const DEFAULT_WIDTH: Record<PanelKind, number> = { thread: 420, agent: 480, session: 560, search: 400 };

/** The narrowest a column is dragged to. */
export const MIN_WIDTH = 300;
/** What a column leaves the main area (or the focused panel), at least. */
export const MAIN_MIN = 420;
/** An arrow key moves a handle this far. */
export const STEP = 24;
/** A column's drag handle, on its left edge. */
export const HANDLE = 12;
/** The gap to the window's right edge while any column shows. */
export const GUTTER = 16;
/** Widths beyond this are a damaged value, not a choice. */
export const MAX_KEPT = 8000;

/** One kind's width: the one it was given, else its default. */
export const wantedWidth = (kind: PanelKind, kept: Partial<Record<PanelKind, number>>): number => kept[kind] ?? DEFAULT_WIDTH[kind];

/** The space the main area and `n` columns share in a row `row` px wide
 *  (unknown, 0, means unlimited: nothing is measured outside a window). */
export const spaceFor = (row: number, n: number): number => (row > 0 ? Math.max(0, row - (n ? GUTTER + n * HANDLE : 0)) : Infinity);

/** The columns' widths as drawn in `space` (what they and the main area
 *  share): as wanted while they fit beside `mainMin` of main area; else
 *  shrunk in proportion, none below `min`; and when even that doesn't fit,
 *  the main area gives way, then the columns share what's left equally.
 *  They never add up to more than `space`. */
export const fitWidths = (wanted: readonly number[], space: number, min = MIN_WIDTH, mainMin = MAIN_MIN): number[] => {
  const n = wanted.length;
  if (!n) return [];
  const cap = space - mainMin;
  const sum = wanted.reduce((a, b) => a + b, 0);
  if (sum <= cap) return [...wanted];
  if (cap < n * min) {
    if (space >= n * min) return wanted.map(() => min);
    return wanted.map(() => Math.max(0, Math.floor(space / n)));
  }
  // In proportion, pinning at `min` whichever would go below it.
  const out: (number | null)[] = wanted.map(() => null);
  for (;;) {
    const free = out.map((w, i) => (w === null ? i : -1)).filter((i) => i >= 0);
    const pinned = out.reduce<number>((a, w) => a + (w ?? 0), 0);
    const share = free.reduce((a, i) => a + wanted[i]!, 0);
    const scale = (cap - pinned) / share;
    const low = free.filter((i) => wanted[i]! * scale < min);
    if (!low.length) {
      for (const i of free) out[i] = Math.floor(wanted[i]! * scale);
      return out as number[];
    }
    for (const i of low) out[i] = min;
  }
};

/** How wide column `i` can be dragged while the others are drawn as
 *  `shown`: up to leaving the main area `mainMin`, and never under `min`. */
export const maxWidth = (shown: readonly number[], i: number, space: number, min = MIN_WIDTH, mainMin = MAIN_MIN): number => {
  const others = shown.reduce((a, w, j) => (j === i ? a : a + w), 0);
  return Math.max(min, space - mainMin - others);
};

export const clampWidth = (w: number, min: number, max: number): number => Math.round(Math.min(max, Math.max(min, w)));
