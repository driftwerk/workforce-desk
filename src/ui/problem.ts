import { HubError } from "../hub/client";
import { useUi, type SettingsSection } from "../shell/ui";
import { redact } from "./redact";

/** What the person can press to put it right. `ask` hands the problem to Desk's
 *  chat so the agent can act on it; otherwise `run` does the fix. */
export interface Fix {
  label: string;
  run?: () => void;
  ask?: true;
  /** What to offer when there's no Desk agent to ask. */
  alt?: Fix;
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

export const GENERIC = ["Desk couldn’t do that.", "Desk couldn’t finish that."] as const;

/** Opens a Settings section. A grid's window has no Settings of its own: it
 *  registers a way to open it in the main window. */
let opener: ((section: SettingsSection) => void) | null = null;
export const setSettingsOpener = (run: ((section: SettingsSection) => void) | null): void => {
  opener = run;
};
export const openSettingsAt = (section: SettingsSection): void => (opener ?? useUi.getState().openSettings)(section);

const settings = (label: string, section: SettingsSection): Fix => ({
  label,
  run: () => openSettingsAt(section),
});

/** Ask Desk, and where to go when Desk's agent isn't there to ask. */
const askOr = (alt: Fix): Fix => ({ label: "Ask Desk to fix it", ask: true, alt });
const ASK: Fix = askOr(settings("Open settings", "help"));

/** What starts Desk's helper on this computer. Only the main window can: it
 *  registers it, and a window without it hands the problem to Desk instead. */
let starter: (() => void) | null = null;
export const setStarter = (run: (() => void) | null): void => {
  starter = run;
};
const startIt = (): Fix => (starter ? { label: "Start it", run: starter } : ASK);

/** Words that belong to the machinery: a headline never carries them. */
const INTERNAL = /\bhubs?\b|desk-hubd|hubd|\b[45]\d\d\b|\[[a-z_.]+\]|[{}`]|\b[a-z]+_[a-z_]+\b|\bbody is\b|\bfields?\b|Error:|\bat \S+:\d+|\n|https?:\/\/|\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\b|(?:^|[\s(])(?:~|\.{1,2})?\/[\w.-]+\/|\b[A-Za-z]:\\/i;

/** The backend's own name for Desk's engine, in the person's words. */
const scrub = (text: string): string => text.replace(/\bhubs\b/gi, "workspaces").replace(/\b(?:this computer.s |the |this |a )?hub\b/gi, "Desk");

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
    plain: () => "That isn’t a folder Desk can open.",
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
    const out: Problem = { ...p, ...(o.what ? { what: redact(o.what) } : {}) };
    // The backstop: machinery words never reach the headline.
    if (!readable(out.plain)) {
      out.details ??= out.plain;
      out.plain = GENERIC[0];
      out.fix ??= withRetry(o);
    }
    if (raw.trim() && raw !== out.plain && out.details === undefined) out.details = raw;
    if (out.details !== undefined) out.details = redact(out.details);
    return out;
  };
  const known = KNOWN.find((k) => k.match.test(raw));
  if (e instanceof HubError) {
    const s = e.status;
    if (s === 401) return done({ plain: "You’re signed out of this workspace.", fix: settings("Sign in again", "hubs"), details: raw });
    if (s === 403) return done({ plain: "Desk wasn’t allowed to do that.", fix: askOr(settings("Open settings", "computer")), details: raw });
    if (s === 404) return done({ plain: "That isn’t there any more.", details: raw, ...(o.retry ? { fix: { label: "Retry", run: o.retry } } : {}) });
    if (s === 408 || s === 429) return done({ plain: "Desk is being asked for too much at once.", fix: withRetry(o), details: raw });
    if (s >= 500) return done({ plain: "Something broke while Desk was doing that.", fix: withRetry(o), details: raw });
    const m = known ? known.match.exec(raw) : null;
    if (known && m) return done({ plain: known.plain(m), fix: known.fix(o) });
    if (readable(scrub(raw))) return done({ plain: scrub(raw), ...(scrub(raw) !== raw ? { details: raw } : {}), ...(o.retry ? { fix: { label: "Retry", run: o.retry } } : {}) });
    return done({ plain: GENERIC[0], fix: ASK, details: raw });
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
  return done({ plain: GENERIC[1], fix: withRetry(o), details: raw });
}
