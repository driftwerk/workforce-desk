import { HubError } from "../hub/client";
import { useUi } from "../shell/ui";

/** What the person can press to put it right. `ask` hands the problem to Desk's
 *  chat so the agent can act on it; otherwise `run` does the fix. */
export interface Fix {
  label: string;
  run?: () => void;
  ask?: true;
}

/** An error as the person sees it, one shape everywhere: what went wrong in
 *  plain words, the likely fix, and the raw text for whoever wants it. */
export interface Problem {
  /** The headline: never a route, a status code, a config key or an internal name. */
  plain: string;
  fix?: Fix;
  /** The backend's own words, shown only under "Details". */
  details?: string;
  /** What Desk was doing, for the agent: "starting a session". */
  what?: string;
}

/** What the caller knows that the error doesn't. */
export interface ExplainOptions {
  /** What was being done, in a few words. */
  what?: string;
  /** Does the same thing again. */
  retry?: () => void;
  /** This computer's helper isn't answering. */
  localDown?: boolean;
}

const ASK: Fix = { label: "Ask Desk to fix it", ask: true };

const settings = (label: string, section: Parameters<ReturnType<typeof useUi.getState>["openSettings"]>[0]): Fix => ({
  label,
  run: () => useUi.getState().openSettings(section),
});

/** What starts Desk's helper on this computer. Only the main window can: it
 *  registers it, and a window without it hands the problem to Desk instead. */
let starter: (() => void) | null = null;
export const setStarter = (run: (() => void) | null): void => {
  starter = run;
};
const startIt = (): Fix => (starter ? { label: "Start it", run: starter } : ASK);

/** Words that belong to the machinery: a headline never carries them. */
const INTERNAL = /\bhubs?\b|desk-hubd|hubd|\b[45]\d\d\b|\[[a-z_.]+\]|[{}`]|\b[a-z]+_[a-z_]+\b|\bbody is\b|\bfields?\b|Error:|\bat \S+:\d+|\n|https?:\/\//i;

/** The backend's own name for Desk's engine, in the person's words. */
const scrub = (text: string): string => text.replace(/\b(?:this computer.s |the |this |a )?hub\b/gi, "Desk");

/** Whether the backend's text can stand as a headline as it is. */
export const readable = (text: string): boolean => {
  const t = text.trim();
  return t.length > 0 && t.length <= 200 && !INTERNAL.test(t);
};

/** Known texts (Desk's app, its helper, git, the sign-in CLIs), by what they
 *  mean to the person. */
const KNOWN: { match: RegExp; plain: (m: RegExpExecArray) => string; fix: (o: ExplainOptions) => Fix }[] = [
  {
    match: /Claude sign-in ended without a token/i,
    plain: () => "Claude sign-in didn’t finish.",
    fix: () => settings("Sign in again", "providers"),
  },
  {
    match: /ChatGPT sign-in didn.t finish/i,
    plain: () => "ChatGPT sign-in didn’t finish.",
    fix: () => settings("Sign in again", "providers"),
  },
  {
    match: /sign-in (?:timed out|expired|was cancelled)/i,
    plain: () => "The sign-in ran out of time.",
    fix: () => settings("Sign in again", "providers"),
  },
  {
    match: /(?:this computer.s hub|desk-hubd|helper) (?:isn.t|is not) running/i,
    plain: () => "Desk’s helper on this computer isn’t running.",
    fix: () => startIt(),
  },
  {
    match: /doesn.t have that yet/i,
    plain: () => "That part of Desk is older than this feature.",
    fix: () => ASK,
  },
  {
    match: /(.+) is not a folder/i,
    plain: (m) => `${m[1]!.trim()} isn’t a folder Desk can open.`,
    fix: () => ASK,
  },
  {
    match: /a branch called (\S+) already exists/i,
    plain: (m) => `A branch called ${m[1]} already exists. Pick another name.`,
    fix: () => ASK,
  },
  {
    match: /git worktree|fatal: /i,
    plain: () => "Desk couldn’t set up a separate copy of the project to work in.",
    fix: () => ASK,
  },
  {
    match: /no space left|disk (?:is )?full/i,
    plain: () => "There isn’t enough space on the disk.",
    fix: () => ASK,
  },
  {
    match: /permission denied|operation not permitted/i,
    plain: () => "This computer wouldn’t let Desk do that.",
    fix: () => settings("Open settings", "computer"),
  },
];

const withRetry = (o: ExplainOptions): Fix => (o.retry ? { label: "Retry", run: o.retry } : ASK);

/** Turns whatever was thrown into a `Problem`: a headline in plain words, the
 *  button most likely to help, and the raw text kept for Details. */
export function explain(e: unknown, o: ExplainOptions = {}): Problem {
  const raw = e instanceof Error ? e.message : String(e);
  const done = (p: Problem): Problem => {
    const out: Problem = { ...p, ...(o.what ? { what: o.what } : {}) };
    // The backstop: machinery words never reach the headline.
    if (!readable(out.plain)) {
      out.details ??= out.plain;
      out.plain = "Desk couldn’t do that.";
      out.fix ??= withRetry(o);
    }
    if (raw.trim() && raw !== out.plain && out.details === undefined) out.details = raw;
    return out;
  };
  const known = KNOWN.find((k) => k.match.test(raw));
  if (e instanceof HubError) {
    const s = e.status;
    if (s === 401) return done({ plain: "You’re signed out of this workspace.", fix: settings("Sign in again", "hubs"), details: raw });
    if (s === 403) return done({ plain: "Desk wasn’t allowed to do that.", fix: ASK, details: raw });
    if (s === 404) return done({ plain: "That isn’t there any more.", details: raw, ...(o.retry ? { fix: { label: "Retry", run: o.retry } } : {}) });
    if (s === 408 || s === 429) return done({ plain: "Desk is being asked for too much at once.", fix: withRetry(o), details: raw });
    if (s >= 500) return done({ plain: "Something broke while Desk was doing that.", fix: withRetry(o), details: raw });
    const m = known ? known.match.exec(raw) : null;
    if (known && m) return done({ plain: known.plain(m), fix: known.fix(o) });
    if (readable(scrub(raw))) return done({ plain: scrub(raw), ...(scrub(raw) !== raw ? { details: raw } : {}) });
    return done({ plain: "Desk couldn’t do that.", fix: ASK, details: raw });
  }
  if (e instanceof TypeError) {
    return done({
      plain: "Desk can’t reach your agents right now.",
      fix: o.localDown ? startIt() : withRetry(o),
      details: raw,
    });
  }
  const m = known ? known.match.exec(raw) : null;
  if (known && m) return done({ plain: known.plain(m), fix: known.fix(o) });
  if (readable(scrub(raw))) return done({ plain: scrub(raw), ...(scrub(raw) !== raw ? { details: raw } : {}), ...(o.retry ? { fix: { label: "Retry", run: o.retry } } : {}) });
  // Several lines (a CLI's tail, git's stderr): the first sentence leads.
  return done({ plain: "Desk couldn’t finish that.", fix: withRetry(o), details: raw });
}
