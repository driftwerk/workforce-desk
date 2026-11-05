import type { PlanKind } from "../hub/types";
import { dayClock } from "../floor/time";

/** An error a turn ended with, said in plain words. */
export interface ReadableError {
  /** What to show. */
  text: string;
  /** The plan signing in to helps, when that's what would. */
  signIn: PlanKind | null;
  /** What the hub said, word for word, when `text` isn't it. */
  details: string | null;
}

const PLAN_NAME: Record<PlanKind, string> = { claude: "Claude", chatgpt: "ChatGPT" };

/** What the hub puts before an error a turn ended with. */
const TURN_FAILED = /^Agent (?:error|task failed):\s*/;

/** "2026-11-06 16:00:00 UTC", as the hub says a time, else ISO. */
const UNTIL = /usage limit until (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(?:UTC|Z|\+00:00)?/;

/** Ids and other machine names a person needn't read. */
const IDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The plan the hub's words are about, if they say. */
const planOf = (raw: string): PlanKind | null => {
  const login = /no (Claude|ChatGPT) login/i.exec(raw);
  if (login) return login[1]!.toLowerCase() === "claude" ? "claude" : "chatgpt";
  if (/\bclaude\b|claude-code/i.test(raw)) return "claude";
  if (/chatgpt|codex/i.test(raw)) return "chatgpt";
  return null;
};

/** The earliest time the hub says a login is at its usage limit until. */
const limitUntil = (raw: string): number | null => {
  const times = [...raw.matchAll(new RegExp(UNTIL.source, "g"))]
    .map((m) => Date.parse(`${m[1]}T${m[2]}Z`))
    .filter((t) => !Number.isNaN(t));
  return times.length ? Math.min(...times) : null;
};

/** `raw`, an error a turn ended with, as a person reads it: why it couldn't
 *  answer and what to do, with no ids. A plan at its usage limit or with no
 *  login says so and offers to sign in; anything else shows its first line,
 *  and the whole of it folded away. */
export const readableError = (raw: string, now = Date.now()): ReadableError => {
  const said = raw.trim();
  const failed = TURN_FAILED.test(said);
  const plan = /subscription unavailable/i.test(said) ? planOf(said) : null;
  if (plan) {
    const name = PLAN_NAME[plan];
    const until = limitUntil(said);
    if (until !== null) {
      return {
        text: `Couldn’t answer: the ${name} plan Desk uses is at its usage limit until ${dayClock(until, now)}. Sign in another ${name} account, or wait.`,
        signIn: plan,
        details: said,
      };
    }
    if (/no (?:Claude|ChatGPT) login/i.test(said)) {
      return { text: `Couldn’t answer: no ${name} account is signed in for this agent. Sign in to ${name} to go on.`, signIn: plan, details: said };
    }
  }
  const first = (said.split("\n")[0] ?? "").replace(TURN_FAILED, "").replace(IDS, "").replace(/\s+/g, " ").replace(/ ([:;,])/g, "$1").trim();
  const text = failed ? `Couldn’t answer: ${first}` : first;
  return { text, signIn: null, details: text === said ? null : said };
};
