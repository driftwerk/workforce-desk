import { create } from "zustand";

/** The files that shape an agent, in the order Files lists them. */
export const AGENT_FILES = [
  { name: "SOUL.md", about: "Personality, values and what they’re for" },
  { name: "AGENTS.md", about: "How they work: rules, habits, what to avoid" },
  { name: "IDENTITY.md", about: "Their name and how they introduce themselves" },
  { name: "WELCOME.md", about: "What they say when you first open a chat" },
  { name: "HEARTBEAT.md", about: "Their check-in list: what they look over when they check in on their own" },
] as const;

/** One file being edited: what the agent has, and what's in the editor. */
export interface Draft {
  saved: string;
  text: string;
  /** When the saved text was written, if the history says. */
  savedAt: string | null;
  /** Saved in this sitting, and not changed since. */
  justSaved: boolean;
}

export const opened = (text: string, savedAt: string | null): Draft => ({ saved: text, text, savedAt, justSaved: false });

export const edited = (d: Draft, text: string): Draft => ({ ...d, text, justSaved: false });

/** After `written` was saved; typing since then stays unsaved. */
export const saved = (d: Draft, written: string, at: string): Draft => ({ ...d, saved: written, savedAt: at, justSaved: d.text === written });

export const discarded = (d: Draft): Draft => ({ ...d, text: d.saved, justSaved: false });

/** After an earlier version was put back: editor and agent both have it. */
export const restored = (text: string, at: string): Draft => ({ saved: text, text, savedAt: at, justSaved: true });

export const isDirty = (d: Draft | undefined): boolean => !!d && d.text !== d.saved;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 days ago", "yesterday", "just now". */
export const ago = (iso: string, now: Date = new Date()): string => {
  const seconds = (new Date(iso).getTime() - now.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return "";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
};

export type DraftTone = "dirty" | "saved" | "quiet";

/** What the editor's bar says about a file. */
export const draftStatus = (d: Draft | undefined, now: Date = new Date()): { text: string; tone: DraftTone } => {
  if (!d) return { text: "Opening…", tone: "quiet" };
  if (isDirty(d)) return { text: "Unsaved changes", tone: "dirty" };
  if (d.justSaved) return { text: "Saved", tone: "saved" };
  return { text: d.savedAt ? `Saved ${ago(d.savedAt, now)}` : "Saved", tone: "quiet" };
};

const keyOf = (agent: string, file: string) => `${agent}/${file}`;

interface DraftsState {
  /** By `hub/agent/FILE.md`; kept while you look elsewhere, so leaving
   *  Files never loses what you typed. */
  drafts: Record<string, Draft>;
  put: (agent: string, file: string, d: Draft) => void;
  /** Drops an agent's unchanged drafts, so they're read afresh. */
  refresh: (agent: string) => void;
  /** Drops all of an agent's drafts, changed or not. */
  drop: (agent: string) => void;
}

export const useDrafts = create<DraftsState>((set) => ({
  drafts: {},
  put: (agent, file, d) => set((s) => ({ drafts: { ...s.drafts, [keyOf(agent, file)]: d } })),
  refresh: (agent) =>
    set((s) => ({
      drafts: Object.fromEntries(Object.entries(s.drafts).filter(([k, d]) => !k.startsWith(`${agent}/`) || isDirty(d))),
    })),
  drop: (agent) => set((s) => ({ drafts: Object.fromEntries(Object.entries(s.drafts).filter(([k]) => !k.startsWith(`${agent}/`))) })),
}));

export const draftOf = (drafts: Record<string, Draft>, agent: string, file: string): Draft | undefined => drafts[keyOf(agent, file)];

/** The agent's files with unsaved changes. */
export const dirtyFiles = (drafts: Record<string, Draft>, agent: string): string[] =>
  AGENT_FILES.map((f) => f.name).filter((f) => isDirty(drafts[keyOf(agent, f)]));
