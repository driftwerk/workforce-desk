// What the handoff's dialog, chips and tiles say, in plain words.

import { ENGINE_TITLE } from "../engines/engines";
import { clock } from "../floor/time";
import type { Continued, Engine, HandoffPreview, Hop, Session } from "../hub/types";

/** "Claude Code · 10:42", or the engine alone when the time isn't known. */
const engineAt = (engine: Engine | null, at: string | null): string =>
  [engine ? ENGINE_TITLE[engine] : "another engine", at ? clock(at) : ""].filter(Boolean).join(" · ");

/** On the session the work went on in: "continued from Claude Code · 10:42". */
export const continuedFrom = (from: Pick<Hop, "engine" | "at"> | Continued): string => `continued from ${engineAt(from.engine, from.at)}`;

/** On a Floor tile, where there's less room: "from Claude Code · 10:42". */
export const fromShort = (from: Continued): string => `from ${engineAt(from.engine, from.at)}`;

/** On the session the work left: "continued in Codex · 10:42". */
export const continuedIn = (to: Hop): string => `continued in ${engineAt(to.engine, to.at)}`;

/** "About 9,000 of 14,000 tokens". */
export const tokensLine = (p: Pick<HandoffPreview, "tokens" | "budget">): string =>
  `About ${p.tokens.toLocaleString()} of ${p.budget.toLocaleString()} tokens`;

/** The engines a dialog offers: the startable ones, the source's own last
 *  (continuing in the same engine starts a fresh session of it). */
export const enginesFor = (offered: readonly Engine[], source: Engine): Engine[] => [
  ...offered.filter((e) => e !== source),
  ...offered.filter((e) => e === source),
];

/** Whether a session is in a turn now, as the hub decides what stopping it
 *  waits for. */
export const busyNow = (s: Pick<Session, "state" | "live">): boolean =>
  s.live && (s.state === "working" || s.state === "starting" || s.state === "blocked" || s.state === "asking");

/** What happens to the source when the person picks nothing: a session in a
 *  Desk terminal is the person's to end, one in a turn stops after it, an
 *  idle one now. */
export const defaultSource = (s: Pick<Session, "terminalId" | "state" | "live">): "stop" | "after_turn" | "keep" =>
  s.terminalId ? "keep" : busyNow(s) ? "after_turn" : "stop";

/** "across Claude Code and Codex", or "in Codex" for one engine. */
export const acrossText = (engines: readonly (Engine | null | undefined)[]): string => {
  const titles = [...new Set(engines.filter((e): e is Engine => !!e).map((e) => ENGINE_TITLE[e]))];
  if (titles.length === 0) return "";
  if (titles.length === 1) return `in ${titles[0]}`;
  return `across ${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
};
