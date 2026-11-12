import type { Prompt } from "./conversation";
import type { PermissionChoice } from "./types";

/** How many times the same call is allowed once before its card offers to
 *  allow it always, first. */
export const LEARN_AFTER = 2;

const KEY = "desk.approvals.allowed";
/** Calls remembered at most; the oldest go first. */
const MOST = 200;

/** What a card's answer is remembered by: the tool, and on this computer
 *  what it would do there (its command, or its folder), so allowing
 *  `npm test` says nothing of `rm -rf`. */
export const callKey = (p: Prompt): string => {
  const f = p.options.facts;
  if (!f) return `tool:${p.tool}`;
  return [f.effect, f.command ?? "", f.cwd ?? p.options.allow_in_folder ?? "", f.connector ?? ""].join("|");
};

const read = (): Record<string, number> => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
};

const write = (all: Record<string, number>): void => {
  try {
    const kept = Object.entries(all).slice(-MOST);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* a convenience only: the card still asks */
  }
};

/** How many times this call was allowed once before. */
export const allowedBefore = (p: Prompt): number => read()[callKey(p)] ?? 0;

/** Remembers the answer given: allowing once counts toward offering
 *  "always"; denying, or allowing always, forgets the count. */
export const remember = (p: Prompt, choice: PermissionChoice): void => {
  const all = read();
  const key = callKey(p);
  const { [key]: was = 0, ...rest } = all;
  if (choice === "allow_once" || choice === "allow_session") write({ ...rest, [key]: was + 1 });
  else write(rest);
};

/** A tool's id as a person reads it: `github.issue_create` → "GitHub:
 *  issue create". */
const SERVICE: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  linear: "Linear",
  slack: "Slack",
  notion: "Notion",
  google: "Google",
  datadog: "Datadog",
  metabase: "Metabase",
  hubspot: "HubSpot",
  exec: "Run a command",
  filesystem: "Files",
  fs: "Files",
  web: "The web",
  browser: "The browser",
  memory: "Memory",
  vault: "Saved keys",
  crew: "The crew",
  messaging: "Messages",
  email: "Email",
};

export const toolTitle = (tool: string): string => {
  const t = tool.trim();
  if (!t) return "a tool";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(t);
  const [service, action] = mcp ? [mcp[1]!, mcp[2]!] : t.includes(".") ? [t.slice(0, t.indexOf(".")), t.slice(t.indexOf(".") + 1)] : ["", t];
  const words = (s: string) => s.replace(/[._-]+/g, " ").trim();
  const name = SERVICE[service.toLowerCase()] ?? (service ? words(service).replace(/^\w/, (c) => c.toUpperCase()) : "");
  return name ? `${name}: ${words(action)}` : words(action);
};
