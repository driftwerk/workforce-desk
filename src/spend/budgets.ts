import type { BreakerView, Budget, BudgetScope, BudgetUnit, SpendPeriod, Standing } from "../hub/types";
import { tokensText, usdText } from "./spend";

export const PERIODS: readonly SpendPeriod[] = ["day", "week", "month", "five_hours"];

/** A period as a menu says it. */
export const PERIOD_LABEL: Record<SpendPeriod, string> = {
  five_hours: "Five hours",
  day: "Day",
  week: "Week",
  month: "Month",
};

/** "a day budget", "a five-hour budget". */
export const periodWord = (p: SpendPeriod): string => (p === "five_hours" ? "five-hour" : p);

/** When a period's spend is from: "today", "this week", "in the last five hours". */
export const periodWhen = (p: SpendPeriod): string =>
  p === "day" ? "today" : p === "week" ? "this week" : p === "month" ? "this month" : "in the last five hours";

/** "$11", "500k tokens". */
export const amountText = (unit: BudgetUnit, n: number): string =>
  unit === "tokens" ? `${tokensText(n)} tokens` : Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : usdText(n);

/** What it is used, floored past float noise: 1.15 of 1 is 115%. */
export const percentOf = (s: Pick<Standing, "used" | "of">): number => (s.of > 0 ? Math.floor((s.used / s.of) * 100 + 1e-6) : 0);

/** "$9.10 of $11 today · 83%". */
export const standingText = (s: Standing): string =>
  `${amountText(s.unit, s.used)} of ${amountText(s.unit, s.of)} ${periodWhen(s.period)} · ${percentOf(s)}%`;

/** How full the bar is drawn, 0 to 1. */
export const fillOf = (s: Pick<Standing, "used" | "of">): number => (s.of > 0 ? Math.min(1, Math.max(0, s.used / s.of)) : 0);

/** Who calls things what: sessions, agents and groups by id. */
export interface Names {
  session: (id: string) => string | undefined;
  agent: (id: string) => string | undefined;
  group: (id: string) => string | undefined;
}

/** What a budget is for: "Everything on Desk", "Each session in Acme", "auth-fix". */
export const scopeLabel = (scope: BudgetScope, group: string | null, names: Names): string => {
  const g = group ? (names.group(group) ?? "a group") : null;
  switch (scope.kind) {
    case "desk":
      return g ? `Everything in ${g}` : "Everything on Desk";
    case "each_session":
      return g ? `Each session in ${g}` : "Each session";
    case "each_agent":
      return g ? `Each agent in ${g}` : "Each agent";
    case "session":
      return names.session(scope.id) ?? "A session since forgotten";
    case "agent":
      return names.agent(scope.id) ?? scope.id;
  }
};

/** "A day budget of $11, warns at 80%, pauses when over". */
export const budgetLine = (b: Pick<Budget, "period" | "unit" | "amount" | "warnAt" | "onExceed">): string =>
  `${amountText(b.unit, b.amount)} a ${periodWord(b.period)} · warns at ${Math.round(b.warnAt * 100)}% · ${
    b.onExceed === "pause" ? "pauses when over" : "only warns"
  }`;

/** What a breaker subject names. */
export type Subject = { kind: "session"; id: string } | { kind: "agent"; id: string } | { kind: "pool"; group: string | null };

export const subjectOf = (subject: string): Subject | null => {
  const [kind, ...rest] = subject.split(":");
  const id = rest.join(":");
  if (kind === "session" && id) return { kind: "session", id };
  if (kind === "agent" && id) return { kind: "agent", id };
  if (kind === "pool" && id === "desk") return { kind: "pool", group: null };
  if (kind === "pool" && id.startsWith("group:") && id.length > 6) return { kind: "pool", group: id.slice(6) };
  return null;
};

/** The breaker holding a session, while one does. */
export const heldSession = (breakers: readonly BreakerView[], id: string): BreakerView | null =>
  breakers.find((b) => b.subject === `session:${id}` && b.level.level === "held") ?? null;

/** What a held breaker is held for, in a few words. */
export const heldFor = (b: BreakerView): string => {
  if (b.level.level !== "held") return "";
  switch (b.level.reason.kind) {
    case "budget":
      return "over its budget";
    case "loop":
      return "it kept repeating a tool call";
    case "errors":
      return "its tool calls kept failing";
  }
};

/** A budget amount typed in: a number above nothing, else null. Tokens
 *  are whole. */
export const parseAmount = (text: string, unit: BudgetUnit): number | null => {
  const n = Number(text.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "tokens" ? (Number.isInteger(n) ? n : null) : Math.round(n * 100) / 100;
};
