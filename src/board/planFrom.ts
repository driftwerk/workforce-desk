// Making a plan of tickets already on a board: the person picks them (or
// takes what the board shows), and they're handed to the board's boss as a
// message in its DM, for the person to read over and send. The boss takes
// each on as it is; only tickets not started yet can be.

import type { Board, Manager, Ticket } from "../hub/types";
import { bossOfGroup, isSealed } from "../groups/bosses";

/** The most tickets a plan has. */
export const PLAN_MAX = 30;

/** Whether `t` can be taken on by a plan: not started yet (in Backlog or To
 *  do, no one on it) and in no plan. */
export const adoptable = (t: Ticket, inPlan: ReadonlyMap<string, unknown> | ReadonlySet<string>): boolean =>
  (t.state === "backlog" || t.state === "todo") && !t.assignee && !inPlan.has(t.id) && !t.leftFilter;

/** Why `t` can't be taken on by a plan, in a few words; null when it can. */
export const whyNotAdoptable = (t: Ticket, inPlan: ReadonlyMap<string, unknown> | ReadonlySet<string>): string | null => {
  const who = t.key ?? "It";
  if (inPlan.has(t.id)) return `${who} is in a plan already`;
  if (t.state === "done" || t.state === "dropped") return `${who} is finished`;
  if (t.state === "doing" || t.state === "review" || t.assignee) return `${who} is started already`;
  if (t.leftFilter) return `${who} left the board's filter`;
  return null;
};

/** What a plan is handed of the tickets picked: those it can take on, up
 *  to PLAN_MAX, and how many were left out as started (or in a plan) and
 *  as over the most a plan has. */
export interface Handover {
  tickets: Ticket[];
  started: number;
  over: number;
}

export const handover = (picked: readonly Ticket[], inPlan: ReadonlyMap<string, unknown> | ReadonlySet<string>): Handover => {
  const can = picked.filter((t) => adoptable(t, inPlan));
  return { tickets: can.slice(0, PLAN_MAX), started: picked.length - can.length, over: Math.max(0, can.length - PLAN_MAX) };
};

/** How a message names the board: its name and its key's prefix (or its
 *  Jira, Linear or GitHub target), "Mantis (MAN)". */
export const boardNamed = (b: Pick<Board, "name" | "prefix" | "sync">): string => {
  const short = b.prefix ?? b.sync?.target ?? null;
  return short && short !== b.name ? `${b.name} (${short})` : b.name;
};

/** A ticket as the message names it: its key and title, or its title. */
const named = (t: Pick<Ticket, "key" | "title">): string => (t.key ? `${t.key} “${t.title}”` : `“${t.title}”`);

/** The message that asks the boss for a plan of `h`'s tickets on board `b`,
 *  as it's put in the boss's composer. */
export const planAsk = (b: Pick<Board, "name" | "prefix" | "sync">, h: Handover): string => {
  const n = h.tickets.length;
  const these = n === 1 ? "this ticket" : `these ${n} tickets`;
  const each = n === 1 ? "taking it on as it is" : "taking each on as it is";
  const lines = [`Make a plan for ${these} on ${boardNamed(b)}, ${each}: ${h.tickets.map(named).join(", ")}.`];
  if (h.over > 0) lines.push(`(${h.over} more were picked, but a plan has at most ${PLAN_MAX} tickets: they're left for another plan.)`);
  return lines.join("\n\n");
};

/** The boss who plans board `b`'s tickets: its group's own boss, else the
 *  main boss (`main`); none for a group closed to everyone but the person. */
export const bossOfBoard = <B extends { id: string; name: string }>(
  b: Pick<Board, "group"> | null,
  manager: Manager | null,
  main: B | null,
): { id: string; name: string } | null => {
  if (!b) return null;
  if (b.group) {
    const own = bossOfGroup(manager, b.group);
    if (own) return { id: own.agentId, name: own.name };
    if (isSealed(manager, b.group)) return null;
  }
  return main;
};

/** What the board's pick bar says of what's picked: how many, and what
 *  isn't handed over. */
export const pickedSaid = (h: Handover): string[] =>
  [
    h.started > 0 ? `${h.started === 1 ? "One picked ticket is" : `${h.started} picked tickets are`} started or in a plan already, and left out.` : null,
    h.over > 0 ? `A plan has at most ${PLAN_MAX} tickets: the first ${PLAN_MAX} are handed over, and ${h.over} left out.` : null,
  ].filter((s): s is string => s !== null);
