import type { Background, Place, Who } from "../hub/types";
import { backgroundTasks } from "./background";
import type { FloorWork, Merged, Tagged } from "./merge";

/** How long an agent or session that finished stays in what's happening. */
export const DONE_FOR_MS = 2 * 60 * 60_000;

export type EntryState = "working" | "waiting" | "done" | "failed";

/** One agent or session working, waiting on its own background work, or
 *  finished lately: what it is for and what it is doing, in plain words. */
export interface FloorEntry extends Tagged {
  who: Who;
  place: Place;
  state: EntryState;
  background: Background | null;
  purpose: string | null;
  now: string;
  /** When what it says was last written. */
  at: string;
}

const RANK: Record<EntryState, number> = { working: 0, waiting: 1, done: 2, failed: 2 };

/** Words that only name the identifier after them. */
const NAMING = new Set(["pr", "prs", "issue", "issues", "commit", "commits", "pid", "branch", "ticket", "file", "path", "tool"]);
/** Words a clause can't end on. */
const DANGLING = new Set(["the", "a", "an", "in", "on", "at", "to", "of", "with", "for", "from", "into", "and", "or", "via", "as", "by"]);
const EXTENSIONS = /\.(rs|tsx?|jsx?|json|toml|md|sql|py|css|html|ya?ml|sh|lock|go|rb|kt|swift|txt|log)$/i;

/** Whether `word` (its punctuation off) is an identifier, not a word: an
 *  issue number, commit id, path, branch, file, code or tool mark. */
const identifier = (word: string): boolean =>
  /^[#●]/.test(word) ||
  /#\d/.test(word) ||
  /:\/\/|::|\(\)|=|[{}]|--|_/.test(word) ||
  EXTENSIONS.test(word) ||
  (word.includes("/") && (/^(\/|\.\/|\.\.\/|~\/)/.test(word) || (word.match(/\//g)?.length ?? 0) >= 2 || /[._-]/.test(word) || !/[A-Z]/.test(word))) ||
  (/^[0-9a-f]{7,40}$/i.test(word) && /\d/.test(word) && /[a-f]/i.test(word)) ||
  /^\d{5,}$/.test(word);

/** `text` without the identifiers it names (and the words that only name
 *  them), its clauses closed where one was cut; empty when nothing worth
 *  saying is left. The hub's own reading, for hubs that send no gist. */
export const plain = (text: string): string => {
  const words = text
    .replace(/[`*]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const [, lead = "", core = "", trail = ""] = /^([(["'“‘]*)(.*?)([.,;:!?)\]"'”’]*)$/u.exec(token) ?? [];
      return { lead, core, trail, dropped: core !== "" && identifier(core) };
    });
  words.forEach((w, i) => {
    const before = words[i - 1];
    if (w.dropped && before && before.trail === "" && NAMING.has(before.core.toLowerCase())) before.dropped = true;
  });
  const kept: string[] = [];
  for (const w of words) {
    if (!w.dropped) {
      kept.push(`${w.lead}${w.core}${w.trail}`);
      continue;
    }
    const stop = [...w.trail].find((c) => ".,;:!?".includes(c));
    if (!stop) continue;
    while (kept.length && DANGLING.has(kept[kept.length - 1]!.toLowerCase())) kept.pop();
    const last = kept.length - 1;
    if (last >= 0 && !/[.,;:!?]$/.test(kept[last]!)) kept[last] += stop;
  }
  while (kept.length && (DANGLING.has(kept[kept.length - 1]!.replace(/[.,;:!?)\]"'”’]+$/u, "").toLowerCase()) || !/[\p{L}\p{N}]/u.test(kept[kept.length - 1]!)))
    kept.pop();
  let out = kept.join(" ");
  if ((out.match(/\(/g)?.length ?? 0) !== (out.match(/\)/g)?.length ?? 0)) out = out.replace(/[()]/g, "");
  out = out.replace(/^[,;:. ]+/, "").trim();
  const worth = out.split(" ").some((w) => {
    const bare = w.replace(/[^\p{L}\p{N}]/gu, "");
    return (bare.match(/\p{L}/gu)?.length ?? 0) >= 2 && !DANGLING.has(bare.toLowerCase());
  });
  return worth ? out : "";
};

/** `text` as a sentence: its first letter up, closed with a full stop. */
const sentence = (text: string): string => {
  const t = text.trim().replace(/[,;:]+$/, "");
  const up = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(up) ? up : `${up}.`;
};

const stateOf = (w: FloorWork): EntryState =>
  w.endedAt === null ? (w.background ? "waiting" : "working") : w.outcome === "failed" || w.outcome === "limit" ? "failed" : "done";

/** What a turn says without a gist from its hub, plainly. */
const plainly = (w: FloorWork, state: EntryState): string => {
  const said = w.what.startsWith("● ") ? "" : plain(w.what.split("\n")[0] ?? "");
  switch (state) {
    case "working":
      return said ? `Now working on: ${sentence(said)}` : "Working on it now.";
    case "waiting":
      return `Its turn is done; it is waiting on ${backgroundTasks(w.background!)} it started.`;
    case "done":
      return said ? `Finished: ${sentence(said)}` : "Finished what it was asked.";
    case "failed":
      return w.outcome === "limit" ? "It stopped at its plan’s limit." : said ? `It stopped with an error: ${sentence(said)}` : "It stopped with an error.";
  }
};

const keyOf = (w: FloorWork, who: Who): string => `${w.hubId}/${who.kind}:${who.id}`;

const entryOf = (w: FloorWork, who: Who): FloorEntry => {
  const state = stateOf(w);
  return {
    hubId: w.hubId,
    local: w.local,
    stale: w.stale,
    key: keyOf(w, who),
    who,
    place: w.place,
    state,
    background: w.background ?? null,
    purpose: w.gist?.purpose ?? null,
    now: w.gist?.now ?? plainly(w, state),
    at: w.gist?.at ?? w.endedAt ?? w.heardAt,
  };
};

/** What's happening on every hub: one entry per agent or session working,
 *  waiting on its background work, or finished within the last two hours;
 *  working first, then waiting, then finished, each most recently written
 *  first. Of a subject's turns, the one furthest along that order, and of
 *  those the latest, speaks for it. `whoOf` says who a turn is, so a
 *  session an agent's turn ran as is that agent's entry. */
export const happening = (m: Pick<Merged, "working" | "done">, now: number, whoOf: (w: FloorWork) => Who = (w) => w.who): FloorEntry[] => {
  const lately = m.done.filter((w) => w.endedAt !== null && now - Date.parse(w.endedAt) <= DONE_FOR_MS);
  const when = (w: FloorWork): string => w.endedAt ?? w.since;
  const chosen = new Map<string, { w: FloorWork; who: Who }>();
  for (const w of [...m.working, ...lately]) {
    const who = whoOf(w);
    const key = keyOf(w, who);
    const have = chosen.get(key)?.w;
    const better =
      !have || RANK[stateOf(w)] < RANK[stateOf(have)] || (RANK[stateOf(w)] === RANK[stateOf(have)] && when(w) > when(have));
    if (better) chosen.set(key, { w, who });
  }
  return [...chosen.values()]
    .map(({ w, who }) => entryOf(w, who))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.at.localeCompare(a.at) || a.who.name.localeCompare(b.who.name));
};
