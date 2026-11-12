import type { BudgetScope, BudgetUnit, NewBudget, OnExceed, SpendPeriod } from "../hub/types";
import { parseAmount } from "./budgets";

/** Who and what Desk can name in a sentence: agents, sessions and groups,
 *  by their names. */
export interface Known {
  agents: { id: string; name: string }[];
  sessions: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}

/** A budget said in a sentence, or what's missing from it. */
export type Heard = { budget: NewBudget } | { missing: string };

const PERIOD_WORDS: [RegExp, SpendPeriod][] = [
  [/\b(?:(?:a|per|every|each)\s+)?(?:5|five)[\s-]*hours?\b/, "five_hours"],
  [/\b(?:a|per|every|each)\s+day\b|\bdaily\b|\b(?:a|per)\s+24\s*h(?:ours)?\b|\btoday\b/, "day"],
  [/\b(?:a|per|every|each)\s+week\b|\bweekly\b|\bthis\s+week\b/, "week"],
  [/\b(?:a|per|every|each)\s+month\b|\bmonthly\b|\bthis\s+month\b/, "month"],
];

/** Every way of saying a name, longest first, so "Acme Web" wins over
 *  "Acme". */
const byName = <T extends { name: string }>(items: T[]): T[] => [...items].sort((a, b) => b.name.length - a.name.length);

const mentions = (text: string, name: string): boolean => {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  const at = text.indexOf(n);
  if (at < 0) return false;
  const before = at === 0 ? " " : text[at - 1]!;
  const after = text[at + n.length] ?? " ";
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
};

/** The amount and its unit: "$20", "20 dollars", "500k tokens", "1.5m tokens". */
const amountIn = (text: string): { unit: BudgetUnit; amount: number } | null => {
  const tokens = /([0-9][0-9,]*(?:\.[0-9]+)?\s*[kmb]?)\s*tokens?\b/.exec(text);
  if (tokens) {
    const amount = parseAmount(tokens[1]!, "tokens");
    return amount === null ? null : { unit: "tokens", amount };
  }
  const usd = /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?\s*[kmb]?)\b|([0-9][0-9,]*(?:\.[0-9]+)?\s*[kmb]?)\s*(?:dollars?|usd|bucks)\b/.exec(text);
  if (usd) {
    const amount = parseAmount(usd[1] ?? usd[2]!, "usd");
    return amount === null ? null : { unit: "usd", amount };
  }
  return null;
};

/** "keep me under $20 a day", "each session under 500k tokens a week",
 *  "Scout no more than $5 a day, just warn", "everything in Acme under $50
 *  a month, warn at 90%": a budget, or what the sentence leaves out.
 *  Unsaid, it's for everything together, warns at 80% and pauses after
 *  the turn when over. */
export const hearBudget = (said: string, known: Known): Heard => {
  const text = ` ${said.toLowerCase().replace(/\s+/g, " ").trim()} `;
  if (!text.trim()) return { missing: "Say how much, and how often: “keep me under $20 a day”." };

  const amount = amountIn(text);
  if (!amount) return { missing: "Say how much: “$20” or “500k tokens”." };

  const period = PERIOD_WORDS.find(([words]) => words.test(text))?.[1];
  if (!period) return { missing: "Say how often: a day, a week, a month or every five hours." };

  const group = byName(known.groups).find((g) => mentions(text, g.name)) ?? null;
  let scope: BudgetScope = { kind: "desk" };
  const agent = byName(known.agents).find((a) => mentions(text, a.name));
  const session = byName(known.sessions).find((s) => mentions(text, s.name));
  if (/\b(?:each|every|per|any)\s+session\b/.test(text)) scope = { kind: "each_session" };
  else if (/\b(?:each|every|per|any)\s+agent\b/.test(text)) scope = { kind: "each_agent" };
  else if (agent) scope = { kind: "agent", id: agent.id };
  else if (session) scope = { kind: "session", id: session.id };

  const onExceed: OnExceed = /\b(?:just|only)\s+warn\b|\bdon'?t\s+(?:stop|pause)\b|\bwarn\s+(?:me\s+)?only\b/.test(text) ? "warn" : "pause";
  const warn = /\bwarn(?:\s+me)?\s+at\s+([0-9]{1,2})\s*%/.exec(text);
  const warnAt = warn ? Number(warn[1]) / 100 : 0.8;
  if (!(warnAt > 0 && warnAt < 1)) return { missing: "Warn at a share between 1% and 99%." };

  // An item's own budget goes with the item, never a group.
  const inGroup = scope.kind === "desk" || scope.kind === "each_session" || scope.kind === "each_agent" ? (group?.id ?? null) : null;
  return { budget: { scope, group: inGroup, period, unit: amount.unit, amount: amount.amount, warnAt, onExceed } };
};
