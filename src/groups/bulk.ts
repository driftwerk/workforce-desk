import type { MenuEntry } from "../ui/Menu";
import { plural } from "../unread/rows";

/** One thing a row offers: what it's called and what doing it does. */
export interface Choice {
  label: string;
  run: () => void;
}

/** The same choice offered by several rows: how many, and each row's way
 *  of doing it. */
export interface Tallied {
  label: string;
  runs: (() => void)[];
}

/** The rows' choices put together by label, in the order first offered. */
export const tally = (perRow: readonly (readonly Choice[])[]): Tallied[] =>
  [
    ...perRow
      .flat()
      .reduce((by, c) => by.set(c.label, [...(by.get(c.label) ?? []), c.run]), new Map<string, (() => void)[]>())
      .entries(),
  ].map(([label, runs]) => ({ label, runs }));

/** "2 can't", or nothing when every row can. */
export const cannot = (fit: number, of: number, what = ""): string | undefined =>
  fit < of ? `${of - fit} can’t${what ? ` be ${what}` : ""}` : undefined;

/** A tallied choice as a menu item over `of` rows: "Stop 2 sessions". */
export const talliedEntry = (t: Tallied, of: number, noun = "session"): MenuEntry => ({
  kind: "item",
  label: `${t.label} ${plural(t.runs.length, noun)}`,
  hint: cannot(t.runs.length, of),
  onSelect: () => t.runs.forEach((run) => run()),
});
