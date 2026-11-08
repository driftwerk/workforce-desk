import type { GroupMemory, MemoryIndexStatus, MemoryNote, MemoryNotes, MemorySettings, Session, SessionMemory } from "../hub/types";

/** A note as the hub says it. */
export const note = (id: string, kind: MemoryNote["kind"], text: string, more: Partial<MemoryNote> = {}): MemoryNote => ({
  id,
  kind,
  text,
  state: kind === "todo" ? "open" : "held",
  at: "2026-11-08T09:00:00Z",
  notedByDesk: true,
  confirmed: false,
  sourceGone: false,
  ...more,
});

/** Notes as the hub says them, counted. */
export const notes = (list: MemoryNote[], more: Partial<MemoryNotes> = {}): MemoryNotes => {
  const of = (k: MemoryNote["kind"]) => list.filter((n) => n.kind === k);
  return {
    decisions: of("decision"),
    facts: of("fact"),
    todos: of("todo"),
    counts: { decisions: of("decision").length, facts: of("fact").length, todos: of("todo").length, openTodos: of("todo").filter((t) => t.state === "open").length },
    noting: "on",
    why: null,
    reason: null,
    unread: 0,
    provider: "anthropic",
    fallbackProviders: false,
    replaced: [],
    ...more,
  };
};

/** What Desk remembers of a session, as the hub says it. */
export const remembered = (more: Partial<SessionMemory> = {}): SessionMemory => ({
  exchanges: [
    {
      seq: 1,
      at: "2026-11-08T09:00:00Z",
      ended: "2026-11-08T09:01:00Z",
      asker: "person",
      ask: "Why does logout leave the cookie?",
      answer: "It cleared the server session only.",
      files: ["/dev/acme-web/src/auth/signin.ts", "/dev/acme-web/src/auth/session.ts"],
      commands: [],
      errors: [],
      compaction: false,
      redacted: 2,
    },
  ],
  counts: { exchanges: 48, open: 0, compactions: 0, secretsHidden: 2, pastCap: 0 },
  remembering: true,
  why: null,
  notice: null,
  notes: notes([
    note("d1", "decision", "Keep the session token in a secure cookie, not browser storage."),
    note("t1", "todo", "Check the logout path clears the cookie."),
    note("f1", "fact", "Sessions live in Postgres."),
  ]),
  memoryOn: true,
  noRecord: false,
  lastRead: "2026-11-08T10:41:00Z",
  cleared: false,
  switches: { paused: false, group: null },
  ...more,
});

export const settingsOf = (more: Partial<MemorySettings> = {}): MemorySettings => ({
  paused: false,
  groups: [{ id: "g-acme", name: "Acme", harvest: true, derive: false, handoffAsk: true, deriveDecided: false }],
  limits: {
    enabled: true,
    derive: true,
    backfillDays: 30,
    retainDays: 180,
    maxDiskMb: 4096,
    indexPerMinute: 600,
    deriveCallsPerDay: 200,
    deriveCallsToday: 12,
    provider: "anthropic",
  },
  totals: [
    { group: null, sessions: 2, exchanges: 30, secretsHidden: 1, notes: 4 },
    { group: "g-acme", sessions: 1, exchanges: 48, secretsHidden: 2, notes: 3 },
  ],
  ...more,
});

export const indexOf = (more: Partial<MemoryIndexStatus> = {}): MemoryIndexStatus => ({
  installed: true,
  backlog: 0,
  purges: 0,
  failing: null,
  caughtUp: "2026-11-08T10:40:00Z",
  reconciled: null,
  setAside: 0,
  purgesSetAside: 0,
  diskMb: 120,
  maxDiskMb: 4096,
  ...more,
});

export const sessionOf = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "claude",
  name: "atlas-api",
  goal: "",
  cwd: "/dev/acme-web",
  branch: null,
  origin: "desk",
  state: "idle",
  live: false,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "2026-11-08T08:00:00Z",
  updatedAt: "2026-11-08T08:00:00Z",
  ...more,
});

/** Acme's switches, as a session's memory carries them. */
export const acme = (more: Partial<GroupMemory> = {}) => ({ id: "g-acme", name: "Acme", harvest: true, derive: false, handoffAsk: true, deriveDecided: false, ...more });
