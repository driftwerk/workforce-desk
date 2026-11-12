import type { Prompt } from "./conversation";
import type { PermissionChoice } from "./types";

/** How many times the same call is allowed once before its card mentions
 *  that it could be allowed always. */
export const LEARN_AFTER = 2;

const KEY = "desk.approvals.allowed";
/** Calls remembered at most; the oldest go first. */
const MOST = 200;

/** A short digest of `text` (FNV-1a, 64 bits as hex): what a call is
 *  remembered by, so no command, path or argument (which may hold a
 *  secret) is ever kept. */
export const digest = (text: string): string => {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(text)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
};

/** Who a card's answers are counted for: the agent asking (`hub/agent`) and
 *  the person answering on that hub. */
export interface Scope {
  agent: string;
  person: string;
}

/** What a card's answer is remembered by: who asks and who answers, the
 *  tool, and exactly what it would do (the hub's facts, else its words),
 *  as a digest. Allowing `npm test` says nothing of `npm publish`. */
export const callKey = (p: Prompt, scope: Scope): string => {
  const f = p.options.facts;
  const what = f ? [f.effect, f.command ?? "", f.cwd ?? "", (f.paths ?? []).join("\n"), f.connector ?? ""].join("|") : p.content;
  return digest([scope.agent, scope.person, p.tool, what].join("\u0000"));
};

/** Tools whose call sends something to other people. */
const SENDS = /(^|[._])(send|post|reply|email|mail|message|publish|share|tweet|invite|comment)/i;
/** Tools that run anything they are given. */
const SHELL = /(^|[._])(exec|bash|shell|run|command|terminal)([._]|$)/i;

/** Whether a card may ever mention allowing its call always: never for a
 *  call that can't say what it does, can't be undone, runs a command,
 *  writes outside Desk (a connected service), or sends to other people. */
export const learnable = (p: Prompt): boolean => {
  const f = p.options.facts;
  if (f) return false;
  if (!p.content.trim() || !p.options.allow_always) return false;
  return !SENDS.test(p.tool) && !SHELL.test(p.tool);
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

/** How many times this call was allowed once before, for `scope`. */
export const allowedBefore = (p: Prompt, scope: Scope): number => read()[callKey(p, scope)] ?? 0;

/** Remembers the answer given: allowing once counts toward the mention;
 *  denying, or allowing always, forgets the count. Only learnable calls. */
export const remember = (p: Prompt, scope: Scope, choice: PermissionChoice): void => {
  if (!learnable(p)) return;
  const all = read();
  const key = callKey(p, scope);
  const { [key]: was = 0, ...rest } = all;
  if (choice === "allow_once") write({ ...rest, [key]: was + 1 });
  else write(rest);
};

/** Services and kinds of tool, as a person reads them. */
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

/** A tool's id as what the agent wants to do: "use GitHub: issue create",
 *  "run a command"; and, for an MCP server's tool, the server as it named
 *  itself, so a server calling itself "github" is seen for what it is. */
export const toolWants = (tool: string): { wants: string; server: string | null } => {
  const t = tool.trim();
  if (!t) return { wants: "use a tool", server: null };
  if (SHELL.test(t) && !t.includes("__")) return { wants: "run a command", server: null };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
  const [service, action] = mcp ? [mcp[1]!, mcp[2]!] : t.includes(".") ? [t.slice(0, t.indexOf(".")), t.slice(t.indexOf(".") + 1)] : ["", t];
  const words = (s: string) => s.replace(/[._-]+/g, " ").trim();
  const name = SERVICE[service.toLowerCase()] ?? (service ? words(service).replace(/^\w/, (c) => c.toUpperCase()) : "");
  return { wants: `use ${name ? `${name}: ${words(action)}` : words(action)}`, server: mcp ? mcp[1]! : null };
};
