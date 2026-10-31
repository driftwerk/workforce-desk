import type { FloorEntry } from "./happening";
import { nameOf } from "./needs";

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const counted = (n: number): string => NUMBERS[n] ?? String(n);

/** "Scout", "Scout and Lens", "Scout, Lens and Atlas", "Scout, Lens, Atlas and 2 more". */
const listed = (names: string[]): string => {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
};

/** What needs the person, said as it is now: "Nothing needs you.",
 *  "Two things need you." */
export const needsLine = (n: number): string => (n === 0 ? "Nothing needs you." : `${counted(n)} ${n === 1 ? "thing needs" : "things need"} you.`);

/** Desk's own paragraph when no overseer or hub writes one: who is under
 *  way and who finished lately, from what's happening. `names`: the
 *  person's own names for sessions, by id. */
export const paragraphOf = (entries: readonly FloorEntry[], names: Readonly<Record<string, string>> = {}): string => {
  const under = entries.filter((e) => e.state === "working" || e.state === "waiting").map((e) => nameOf(e, names));
  const ended = entries.filter((e) => e.state === "done" || e.state === "failed").map((e) => nameOf(e, names));
  const parts = [
    under.length ? `${listed(under)} ${under.length === 1 ? "is" : "are"} under way.` : "Nothing is running right now.",
    ended.length ? `${listed(ended)} finished lately.` : null,
  ];
  return parts.filter(Boolean).join(" ");
};

/** How long the floor's paragraph stands before it may change. */
export const SUMMARY_EVERY_MS = 10 * 60_000;

/** The paragraph shown, and since when. */
export interface Held {
  text: string;
  at: number;
}

/** What the paragraph says at `now`: `next` when there is none yet, or once
 *  it differs from what's `held` and that is ten minutes old; else what's
 *  held. */
export const refreshed = (held: Held | null, next: string, now: number): Held =>
  !held || (held.text !== next && now - held.at >= SUMMARY_EVERY_MS) ? { text: next, at: now } : held;
