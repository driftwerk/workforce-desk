import type { BudgetScope, BudgetUnit, NewBudget, OnExceed, SpendPeriod } from "../hub/types";
import { parseAmount } from "./budgets";

/** Who and what Desk can name in a sentence: agents, sessions and groups,
 *  by their names. */
export interface Known {
  agents: { id: string; name: string }[];
  sessions: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}

/** A budget said in a sentence, or what's missing from it. Anything Desk
 *  isn't sure of is missing, with why: never a guess. */
export type Heard = { budget: NewBudget } | { missing: string };

const missing = (why: string): Heard => ({ missing: why });

/** The sentence as Desk reads it: lower case, single spaces, with each
 *  part it has understood blanked out, so what's left can be checked for
 *  anything it hasn't. */
class Reading {
  text: string;
  constructor(said: string) {
    this.text = ` ${said.toLowerCase().replace(/\s+/g, " ").trim()} `;
  }
  /** Every match of `re` (global), each blanked once read. */
  take(re: RegExp): RegExpExecArray[] {
    const found = [...this.text.matchAll(re)] as RegExpExecArray[];
    for (const m of found) this.text = this.text.slice(0, m.index) + " ".repeat(m[0].length) + this.text.slice(m.index + m[0].length);
    return found;
  }
  has(re: RegExp): boolean {
    return re.test(this.text);
  }
}

const PERIODS: [RegExp, SpendPeriod][] = [
  [/\b(?:(?:a|per|every|each)\s+)?(?:5|five)[\s-]*hours?\b/g, "five_hours"],
  [/\b(?:a|per|every|each)\s+day\b|\bdaily\b|\btoday\b/g, "day"],
  [/\b(?:a|per|every|each)\s+week\b|\bweekly\b|\bthis\s+week\b/g, "week"],
  [/\b(?:a|per|every|each)\s+month\b|\bmonthly\b|\bthis\s+month\b/g, "month"],
];

/** A number as people write money or tokens here: `20`, `12.50`, `1,000`,
 *  `1,000,000.25`, with `k` or `m` on tokens. */
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;

/** What a number says, or why it can't be read for sure. */
const numberOf = (raw: string, unit: BudgetUnit): number | string => {
  const n = raw.replace(/\s+/g, "");
  // "1.000": a thousand where the dot groups digits, one where it's a
  // decimal point; "1.5k" is fine.
  if (/^\d{1,3}\.\d{3}$/.test(n)) {
    const sign = unit === "usd" ? "$" : "";
    const [whole, part] = n.split(".") as [string, string];
    return `Desk can't tell whether “${sign}${n}” is ${sign}${whole},${part} or ${sign}${whole}: write it as one of those.`;
  }
  const value = parseAmount(n, unit);
  if (value === null) return `Desk can't read “${raw}” as an amount.`;
  if (unit === "usd" && /\.\d{3,}$/.test(n.replace(/,/g, ""))) return `Dollars go to the cent: “${raw}” has more places than that.`;
  return value;
};

/** "keep me under $20 a day", "each session under 500k tokens a week",
 *  "Scout no more than $5 a day, just warn", "everything in Acme under $50
 *  a month, warn at 90%": a budget, or what the sentence leaves out or
 *  leaves unclear. Unsaid, it's for everything together, warns at 80% and
 *  pauses after the turn when over. */
export const hearBudget = (said: string, known: Known): Heard => {
  const r = new Reading(said);
  if (!r.text.trim()) return missing("Say how much, and how often: “keep me under $20 a day”.");
  if (r.has(/\b(?:except|but\s+not|not|without|apart\s+from|excluding)\b/))
    return missing("Desk can't set a budget that leaves something out. Say who it's for: everything, each session, each agent, or one by name.");
  if (r.has(/\d\s*e\s*\d|\b(?:million|billion|thousand|hundred|grand)\b/))
    return missing("Write the amount in figures, like $20, $1,000 or 500k tokens.");

  // How much: one amount, in one unit.
  const tokens = r.take(new RegExp(String.raw`(${NUMBER})\s*([km])?\s*tokens?\b`, "g"));
  const dollars = r.take(new RegExp(String.raw`\$\s*(${NUMBER})|(${NUMBER})\s*(?:dollars?|usd|bucks)\b`, "g"));
  if (tokens.length + dollars.length === 0) {
    if (r.has(/\d/)) return missing("Say what the amount is in: “$20” or “500k tokens”.");
    return missing("Say how much: “$20” or “500k tokens”.");
  }
  if (tokens.length + dollars.length > 1) return missing("Desk heard more than one amount: say just one.");
  const unit: BudgetUnit = tokens.length ? "tokens" : "usd";
  const raw = tokens.length ? `${tokens[0]![1]}${tokens[0]![2] ?? ""}` : (dollars[0]![1] ?? dollars[0]![2]!);
  const amount = numberOf(raw, unit);
  if (typeof amount === "string") return missing(amount);

  // How often: one period.
  const periods = [...new Set(PERIODS.filter(([re]) => r.take(re).length > 0).map(([, p]) => p))];
  if (periods.length === 0) return missing("Say how often: a day, a week, a month or every five hours.");
  if (periods.length > 1) return missing("Desk heard more than one period: say just one, like “a day” or “a week”.");
  const period = periods[0]!;

  // What happens when over, and when to warn.
  let onExceed: OnExceed = "pause";
  if (r.take(/\b(?:don'?t|do not|never|no)\s+warn(?:ing|ings)?\b|\bwithout\s+(?:a\s+)?warning\b/g).length)
    return missing("Desk always warns before a budget is reached. Say when, like “warn at 90%”, or leave it at 80%.");
  if (r.take(/\b(?:just|only)\s+warn(?:\s+me)?\b|\bwarn\s+(?:me\s+)?only\b|\b(?:don'?t|do not|never|no)\s+(?:stop|pause|pausing|stopping)\b/g).length) onExceed = "warn";
  const warns = r.take(/\bwarn(?:\s+me)?\s+(?:at|when\s+(?:it'?s\s+|i'?m\s+)?(?:at\s+)?)\s*(\d{1,3})\s*(?:%|percent\b)(?:\s+(?:used|spent|in))?/g);
  if (warns.length > 1) return missing("Desk heard more than one warning: say just one, like “warn at 90%”.");
  let warnAt = 0.8;
  if (warns.length === 1) {
    const pct = Number(warns[0]![1]);
    if (!(pct >= 1 && pct <= 99)) return missing("Warn at a share between 1% and 99%.");
    warnAt = pct / 100;
  }
  if (r.has(/\b(?:warn\w*|alert\w*|notify|tell\s+me|remind\w*|percent)\b|%|\b(?:pause|stop)\b/))
    return missing("Desk didn't follow the part about warning or pausing. Say “warn at 90%”, “just warn”, or leave it out.");

  // Who: everything (unsaid), each session or agent, or one by name; in a
  // group, by name. Names are read only in what's left, on whole words.
  const each = r.take(/\b(?:each|every|per|any)\s+(session|agent)s?\b/g);
  const named = (items: { id: string; name: string }[]) =>
    items.filter((i) => {
      const name = i.name.trim().toLowerCase();
      if (!name) return false;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(r.text);
    });
  const groups = named(known.groups);
  // A name inside a longer name is that name ("Acme" in "Acme Web").
  const longest = <T extends { name: string }>(items: T[]): T[] =>
    items.filter((a) => !items.some((b) => b !== a && b.name.toLowerCase().includes(a.name.toLowerCase())));
  const ingroups = longest(groups);
  const items = longest([...named(known.agents).map((a) => ({ ...a, kind: "agent" as const })), ...named(known.sessions).map((s) => ({ ...s, kind: "session" as const }))]);
  if (each.length > 1 || (each.length && new Set(each.map((e) => e[1])).size > 1)) return missing("Say one of each session or each agent, not both.");
  if (items.length > 1) return missing(`Desk heard more than one name (${items.map((i) => i.name).join(", ")}): a budget is for one of them, or for everything.`);
  if (ingroups.length > 1) return missing(`Desk heard more than one group (${ingroups.map((g) => g.name).join(", ")}): say just one.`);
  if (items.length && each.length) return missing(`Say whether it's for ${items[0]!.name} or for each ${each[0]![1]}.`);
  if (items.length && ingroups.length)
    return missing(`${items[0]!.name}'s own budget is for ${items[0]!.name} wherever it is: leave out ${ingroups[0]!.name}, or say each session or each agent in it.`);

  // Anything else that's a number is one Desk couldn't place ("$1,5").
  for (const i of [...items, ...ingroups]) r.take(new RegExp(`(?<![a-z0-9])${i.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "g"));
  if (r.has(/\d/)) return missing("Desk heard a number it couldn't place. Write the amount like $20, $12.50, $1,000 or 500k tokens.");

  let scope: BudgetScope = { kind: "desk" };
  if (each.length) scope = { kind: each[0]![1] === "session" ? "each_session" : "each_agent" };
  else if (items.length) scope = { kind: items[0]!.kind, id: items[0]!.id };
  if (amount <= 0) return missing("The amount is more than nothing.");

  return {
    budget: { scope, group: scope.kind === "agent" || scope.kind === "session" ? null : (ingroups[0]?.id ?? null), period, unit, amount, warnAt, onExceed },
  };
};
