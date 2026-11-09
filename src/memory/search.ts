import { useEffect, useRef, useState } from "react";
import type { DeskHub } from "../hub/client";
import type { MemoryHit, MemorySearch } from "../hub/types";
import { ENGINE_TITLE } from "../engines/engines";
import { plainError } from "../ui/plainError";
import { HIT_KIND, clock } from "./words";

/** Said while the hub finds by keywords alone: its search index is down
 *  or not ready yet. */
export const KEYWORDS_ONLY = "Searching by keywords only right now.";

/** The fewest characters a search is made for. */
export const MIN_QUERY = 2;
/** How long after the last key a search is made. */
export const DEBOUNCE_MS = 250;
/** The most hits one search asks for. */
export const SEARCH_LIMIT = 20;

/** What a search may be narrowed to: the hub's own filters, no others. */
export interface MemoryFilters {
  /** A group's id, or `ungrouped`; none for every group. */
  group?: string;
  /** `decisions`, `todos`, `facts` or `exchanges`; none for all. */
  kind?: MemoryKindFilter;
}

export type MemoryKindFilter = "decisions" | "todos" | "facts" | "exchanges";

export const KIND_FILTERS: { value: MemoryKindFilter; label: string }[] = [
  { value: "decisions", label: "Decisions" },
  { value: "todos", label: "To-dos" },
  { value: "facts", label: "Facts" },
  { value: "exchanges", label: "Conversations" },
];

/** The line a search says of itself, if any: keywords only, or what else
 *  the hub says of it (that its index is catching up). */
export const searchNotice = (found: Pick<MemorySearch, "keywordOnly" | "notice"> | null): string | null =>
  !found ? null : found.keywordOnly ? KEYWORDS_ONLY : (found.notice ?? null);

const DAY = 24 * 60 * 60 * 1000;
const dayOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today 10:12", "yesterday", "3 Nov". */
export const whenOf = (iso: string, now = new Date()): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((dayOf(now) - dayOf(d)) / DAY);
  if (days === 0) return `today ${clock(iso, now)}`;
  if (days === 1) return "yesterday";
  return clock(iso, now);
};

/** The session a hit is from, as the person knows it. */
export const sessionOf = (h: MemoryHit): string => {
  const name = h.name ?? "A session Desk no longer has";
  return h.engine ? `${name} (${ENGINE_TITLE[h.engine]})` : name;
};

/** "Decision · atlas-api (Claude Code) · Acme · today 10:12". */
export const hitLine = (h: MemoryHit, now = new Date()): string => [HIT_KIND[h.kind], sessionOf(h), h.groupName, whenOf(h.at, now)].filter(Boolean).join(" · ");

/** A conversation's ask and answer, or a note's text, in one line. */
export const hitText = (h: MemoryHit): string => ((h.kind === "exchange" || h.kind === "compaction") && h.ask ? `“${h.ask}” … ${h.answer}` : h.answer);

/** What a hit adds to a message: a quote of it, saying where it's from.
 *  Plain words only: no ids. */
export const quoteOf = (h: MemoryHit, now = new Date()): string => {
  const from = `${HIT_KIND[h.kind]} from ${sessionOf(h)}, ${whenOf(h.at, now)}${h.notedByDesk && !h.confirmed ? " (noted by Desk, may be wrong)" : ""}:`;
  const said =
    h.kind === "exchange" || h.kind === "compaction" ? [h.ask && `Asked: ${h.ask}`, h.answer && `Answered: ${h.answer}`].filter(Boolean).join("\n") : h.answer;
  return [from, ...said.split("\n")].map((l) => `> ${l}`.trimEnd()).join("\n");
};

/** `/recall cookie` → "cookie"; null for anything else. */
export const recallQuery = (text: string): string | null => {
  const m = /^\/recall(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  return m ? (m[1] ?? "").trim() : null;
};

export interface SearchState {
  found: MemorySearch | null;
  /** A search is on its way. */
  busy: boolean;
  problem: string | null;
}

/** Searches what Desk remembers as `q` is typed: once it stops for a moment,
 *  never for fewer than two characters, and only the latest answer counts. */
export function useMemorySearch(hub: DeskHub | null, q: string, filters: MemoryFilters): SearchState {
  const [state, setState] = useState<SearchState>({ found: null, busy: false, problem: null });
  const asked = useRef(0);
  const query = q.trim();
  const { group, kind } = filters;
  useEffect(() => {
    const n = ++asked.current;
    if (!hub || query.length < MIN_QUERY) {
      setState({ found: null, busy: false, problem: null });
      return;
    }
    setState((s) => ({ ...s, busy: true }));
    const timer = setTimeout(() => {
      hub.searchMemory({ q: query, group, kind, limit: SEARCH_LIMIT }).then(
        (found) => n === asked.current && setState({ found, busy: false, problem: null }),
        (e: unknown) => n === asked.current && setState({ found: null, busy: false, problem: plainError(e) }),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [hub, query, group, kind]);
  return state;
}
