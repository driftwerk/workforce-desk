import type { Caps, Engine, EngineInfo, SignIn } from "../hub/types";

/** Every engine, in the hub's order. */
export const ENGINES: readonly Engine[] = ["claude", "codex", "gemini", "copilot", "opencode", "cursor", "devin", "custom"];

/** What the person calls each engine. */
export const ENGINE_TITLE: Record<Engine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  opencode: "OpenCode",
  cursor: "Cursor CLI",
  devin: "Devin",
  custom: "Custom command",
};

/** The shorter name, where space is tight (the sidebar). */
export const ENGINE_SHORT: Record<Engine, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  copilot: "Copilot",
  opencode: "OpenCode",
  cursor: "Cursor",
  devin: "Devin",
  custom: "Custom",
};

/** "Claude Code session", "Codex session". */
export const sessionOf = (engine: Engine): string => `${ENGINE_TITLE[engine]} session`;

/** The engines a hub starts sessions of. A hub that doesn't list its
 *  engines (an older one) starts Claude Code and Codex. */
export const startable = (engines: readonly EngineInfo[] | null): Engine[] =>
  engines === null ? ["claude", "codex"] : engines.filter((e) => e.views.length > 0 && e.installed !== false).map((e) => e.engine);

/** What an engine's caps are in its default view, when the hub says. */
export const defaultCaps = (info: EngineInfo | undefined): Caps | null => {
  const view = info?.views[0];
  return (view && info?.caps[view]) ?? null;
};

/** Whether a session of `engine` can have its approvals answered in Desk:
 *  as its caps say, else (an older hub) only Claude Code. */
export const answersInDesk = (engine: Engine, caps: Caps | null | undefined): boolean =>
  caps ? caps.approvals === "desk" : engine === "claude";

/** How an engine's sign-in reads in Settings → Engines. The plan's name is
 *  shown as the engine says it. */
export const signInText = (s: SignIn): string => {
  switch (s.state) {
    case "in": {
      const how = s.via === "plan" ? (s.plan ? `${s.plan} plan` : "a plan") : s.via === "key" ? "an API key" : "its own account";
      return s.who ? `Signed in as ${s.who}, on ${how}` : `Signed in, on ${how}`;
    }
    case "out":
      return "Not signed in";
    case "unknown":
      return "It says when you start it";
  }
};

/** Whether it's installed, and its version, in a few words. */
export const installedText = (e: EngineInfo): string =>
  e.installed === null ? "Not checked yet" : e.installed ? (e.version ? `Version ${e.version}` : "Installed") : "Not installed";

/** What Desk does with it, in a line. */
export const runsText = (e: EngineInfo): string =>
  e.views.length === 0
    ? `Desk can't start ${e.title} sessions yet.`
    : e.views[0] === "terminal"
      ? "Desk starts it in a terminal."
      : "Desk shows it in its own view.";
