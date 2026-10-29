import type { Need, Work } from "../hub/types";
import { backgroundTasks } from "./background";
import type { Merged } from "./merge";

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const counted = (n: number): string => NUMBERS[n] ?? String(n);

/** The first three, then "and N more". */
const some = (parts: string[]): string => {
  const shown = parts.slice(0, 3).join("; ");
  return parts.length > 3 ? `${shown}; and ${parts.length - 3} more` : shown;
};

const quoted = (text: string): string => `“${text.replace(/[.?!]+$/, "")}”`;

const nameOf = (who: Need["who"], names: Readonly<Record<string, string>>): string =>
  (who.kind === "session" ? names[who.id] : undefined) ?? who.name;

/** "Run npm test?" as what someone wants: "wants to run npm test". */
const wants = (ask: string): string => `wants to ${ask.charAt(0).toLowerCase()}${ask.slice(1).replace(/\?+$/, "")}`;

const need = (n: Need, names: Readonly<Record<string, string>>): string =>
  `${nameOf(n.who, names)} ${n.kind === "approval" ? wants(n.ask) : `asks ${quoted(n.ask)}`}`;

const doing = (w: Work, names: Readonly<Record<string, string>>): string => {
  const who = nameOf(w.who, names);
  if (w.background) return `${who} is waiting on ${backgroundTasks(w.background)}`;
  return w.what.startsWith("● ") ? `${who} is running ${w.what.slice(2)}` : `${who} is working on ${quoted(w.what)}`;
};

const ended = (w: Work, names: Readonly<Record<string, string>>): string => {
  const who = nameOf(w.who, names);
  return w.outcome === "failed" ? `${who} failed on ${quoted(w.what)}` : w.outcome === "limit" ? `${who} hit its plan’s limit` : `${who} finished ${quoted(w.what)}`;
};

/** Desk's own line on the floor, when no overseer writes one: what waits on
 *  you, what's running, and what's done since midnight, three of each at
 *  most. `names`: the person's own names for sessions, by id. */
export const sentence = (m: Pick<Merged, "needs" | "working" | "done">, day: number, names: Readonly<Record<string, string>> = {}): string => {
  const today = m.done.filter((w) => w.endedAt !== null && Date.parse(w.endedAt) >= day);
  const parts = [
    m.needs.length === 0
      ? null
      : `${counted(m.needs.length)} ${m.needs.length === 1 ? "thing is" : "things are"} waiting on you: ${some(m.needs.map((n) => need(n, names)))}.`,
    m.working.length === 0 ? null : `${some(m.working.map((w) => doing(w, names)))}.`,
    today.length === 0 ? null : `Since this morning: ${some(today.map((w) => ended(w, names)))}.`,
  ];
  if (!parts[0] && !parts[1]) return ["Nothing needs you, and nothing is running.", parts[2]].filter(Boolean).join(" ");
  return [parts[0] ?? "Nothing needs you.", parts[1], parts[2]].filter(Boolean).join(" ");
};
