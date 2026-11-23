import type { MenuEntry } from "../ui/Menu";
import { plural } from "../unread/rows";

/** One thing a row offers: what it's called, what doing it does, and how
 *  it's called for several ("Mark 3 read"; else "Stop 3 sessions"). */
export interface Choice {
  label: string;
  run: () => void;
  counted?: (n: number) => string;
}

/** The same choice offered by several rows: each row's way of doing it. */
export interface Tallied extends Omit<Choice, "run"> {
  runs: (() => void)[];
}

/** The rows' choices put together by label, in the order first offered. */
export const tally = (perRow: readonly (readonly Choice[])[]): Tallied[] => [
  ...perRow
    .flat()
    .reduce((by, { run, ...c }) => by.set(c.label, { ...c, runs: [...(by.get(c.label)?.runs ?? []), run] }), new Map<string, Tallied>())
    .values(),
];

/** "2 can't", or nothing when every row can. */
export const cannot = (fit: number, of: number, what = ""): string | undefined =>
  fit < of ? `${of - fit} can’t${what ? ` be ${what}` : ""}` : undefined;

/** A tallied choice as a menu item over `of` rows: "Stop 2 sessions". */
export const talliedEntry = (t: Tallied, of: number, noun = "session"): MenuEntry => ({
  kind: "item",
  label: t.counted?.(t.runs.length) ?? `${t.label} ${plural(t.runs.length, noun)}`,
  hint: cannot(t.runs.length, of),
  onSelect: () => t.runs.forEach((run) => run()),
});
