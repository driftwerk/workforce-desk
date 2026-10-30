// A pane's header as it narrows: its name keeps its room longest. The rest
// gives way first, in this order: where a terminal is, then what the pane
// is and its state, then the Tracked badge. grids.css hides each with a
// container query on `.gpane-head` at the width given here (head.test.ts
// keeps the two in step), and the name, cut short at last, loses its
// middle, so its start and end both stay.

export type HeadPart = "cwd" | "meta" | "badge";

/** Each part, in the order it gives way, with the header width (px) at
 *  which it's hidden, and below. */
export const HEAD_DROPS: readonly { part: HeadPart; upTo: number }[] = [
  { part: "cwd", upTo: 560 },
  { part: "meta", upTo: 440 },
  { part: "badge", upTo: 340 },
];

/** The parts a header `width` wide shows besides its name. */
export const headParts = (width: number): HeadPart[] => HEAD_DROPS.filter((d) => width > d.upTo).map((d) => d.part);

/** How much of a name's end always shows. */
const END = 8;

/** A name as its header draws it: the start, which an ellipsis cuts short,
 *  and the end, which stays. A short name is all start. */
export const nameParts = (name: string): [start: string, end: string] => {
  const chars = [...name];
  return chars.length <= END + 6 ? [name, ""] : [chars.slice(0, -END).join(""), chars.slice(-END).join("")];
};
