// Fixtures for the handoff's dialog and chips: what the hub says of a
// handoff of acme-api from Claude Code to Codex.

import type { EngineInfo, HandoffPreview, Included, LineageView } from "../hub/types";

export const included = (more: Partial<Included> = {}): Included => ({
  goal: true,
  decisions: 3,
  ofDecisions: 3,
  todos: 2,
  ofTodos: 2,
  facts: 1,
  ofFacts: 1,
  exchanges: 6,
  ofExchanges: 48,
  files: 4,
  ofFiles: 4,
  flaggedLeftOut: 0,
  elsewhereLeftOut: 0,
  cut: 0,
  tokens: 9120,
  ...more,
});

export const BRIEF = `# Handoff brief
This work comes from a Claude Code session, "acme-api", in /dev/acme-api.
This brief holds the goal, 3 decisions, 2 open to-dos, 1 fact, 4 files and the last 6 of 48 exchanges.

## Goal
Make sign-in safe against a race when two tabs log in at once.

## State
The fix is in and the tests pass; it's tidying the cookie settings before review.
Branch fix/signin-race at 3f2a9c1; 2 files changed.

## Decisions
- Keep the session token in a secure cookie, not browser storage.
- Retry sign-in once, then show the error.
`;

/** What the hub previews of acme-api going on in `engine`. */
export const previewOf = (more: Partial<HandoffPreview> = {}): HandoffPreview => ({
  engine: "codex",
  content: "brief",
  brief: BRIEF,
  included: included(),
  gets: "Codex gets: what it's for, where it is, 3 decisions, 2 to-dos, the files changed, and the last 6 of 48 exchanges.",
  leavesOut: "42 older exchanges",
  tokens: 9120,
  budget: 13600,
  vendor: "OpenAI",
  egress: "The brief goes to OpenAI, through Codex.",
  ask: false,
  search: true,
  onlyBrief: null,
  notesPending: false,
  back: null,
  lineage: { work: "s1", from: null, handedTo: null, sessions: ["s1"] },
  ...more,
});

/** The engines this computer starts: Claude Code and Codex. */
export const ENGINES: EngineInfo[] = (["claude", "codex"] as const).map((engine) => ({
  engine,
  title: engine === "claude" ? "Claude Code" : "Codex",
  program: engine,
  installed: true,
  version: "1.0.0",
  signIn: { state: "in", via: "plan", who: null, plan: null },
  views: ["terminal"],
  caps: {},
}));

/** Codex's acme-api-codex, continued from Claude Code's acme-api at 10:42. */
export const continuedLineage = (more: Partial<LineageView> = {}): LineageView => ({
  work: "s1",
  from: { session: "s1", name: "acme-api", engine: "claude", at: "2026-11-09T10:42:00Z" },
  handedTo: null,
  sessions: ["s1", "s2"],
  ...more,
});

/** Claude Code's acme-api, its work handed to Codex at 10:42. */
export const handedLineage = (more: Partial<LineageView> = {}): LineageView => ({
  work: "s1",
  from: null,
  handedTo: { session: "s2", name: "acme-api-codex", engine: "codex", at: "2026-11-09T10:42:00Z" },
  sessions: ["s1", "s2"],
  ...more,
});
