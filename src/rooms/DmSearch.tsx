import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { searchDm, termsOf, type Match } from "../chat/search";
import type { HubAccount } from "../chat/types";
import { clock, dayName } from "../floor/time";

// ⌘F in a DM: a bar over the chat, and the matches from its whole history
// beside it, newest first. ↑ ↓ or Enter step through them; choosing one
// shows the chat around it, the words found marked in place.

/** How long typing settles before the hub is asked. */
const SETTLE_MS = 250;

export interface DmSearchState {
  q: string;
  setQ: (q: string) => void;
  matches: Match[];
  more: boolean;
  /** The match chosen, by its place in `matches`; -1 for none yet. */
  current: number;
  loading: boolean;
  problem: string | null;
  /** Reads the next (older) page of matches. */
  older: () => void;
}

/** What a DM's search has found for what's typed. */
export function useDmSearch(hub: HubAccount | undefined, agentId: string): DmSearchState & { setCurrent: (i: number) => void } {
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [more, setMore] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    const words = q.trim();
    setProblem(null);
    setCurrent(-1);
    if (!hub || !words) {
      asked.current++;
      setLoading(false);
      setMatches([]);
      setMore(false);
      setCurrent(-1);
      return;
    }
    const n = ++asked.current;
    setLoading(true);
    const t = setTimeout(() => {
      searchDm(hub, agentId, words).then(
        (r) => {
          if (n !== asked.current) return;
          setMatches(r.matches);
          setMore(r.more);
          setCurrent(-1);
          setLoading(false);
        },
        (e: unknown) => {
          if (n !== asked.current) return;
          setProblem(e instanceof Error ? e.message : String(e));
          setLoading(false);
        },
      );
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [hub, agentId, q]);
  const older = useCallback(() => {
    const last = matches.at(-1);
    if (!hub || !last || !more || loading) return;
    const n = asked.current;
    setLoading(true);
    searchDm(hub, agentId, q.trim(), last.id).then(
      (r) => {
        if (n !== asked.current) return;
        setMatches((was) => [...was, ...r.matches.filter((m) => !was.some((w) => w.id === m.id))]);
        setMore(r.more);
        setLoading(false);
      },
      () => n === asked.current && setLoading(false),
    );
  }, [hub, agentId, q, matches, more, loading]);
  return { q, setQ, matches, more, current, setCurrent, loading, problem, older };
}

/** `text` with the words of `terms` marked. */
export const marked = (text: string, terms: string[]): ReactNode[] => {
  if (!terms.length) return [text];
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
};

/** The bar over the chat: what's searched for, where you are in the
 *  matches, the steps and Done. */
export function SearchBar({ s, name, onStep, onClose }: { s: DmSearchState; name: string; onStep: (by: 1 | -1) => void; onClose: () => void }) {
  const n = s.matches.length;
  return (
    <div
      className="dm-search"
      role="search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="dm-search-field">
        <span aria-hidden="true">⌕</span>
        <input
          autoFocus
          value={s.q}
          placeholder={`Search your chat with ${name}`}
          aria-label={`Search your chat with ${name}`}
          onChange={(e) => s.setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") return;
            if (e.key === "ArrowDown" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              onStep(1);
            } else if (e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey)) {
              e.preventDefault();
              onStep(-1);
            }
          }}
        />
      </label>
      <span className="dm-search-count" aria-live="polite">
        {!s.q.trim() ? "" : s.loading && !n ? "Searching…" : n ? `${s.current >= 0 ? s.current + 1 : 0} of ${n}${s.more ? "+" : ""}` : "No matches"}
      </span>
      <button type="button" className="icon-btn-sm" aria-label="Newer match" disabled={!n} onClick={() => onStep(-1)}>
        ↑
      </button>
      <button type="button" className="icon-btn-sm" aria-label="Older match" disabled={!n} onClick={() => onStep(1)}>
        ↓
      </button>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

/** The matches, beside the chat, newest first. */
export function SearchResults({ s, name, onPick }: { s: DmSearchState; name: string; onPick: (i: number) => void }) {
  const terms = termsOf(s.q);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView?.({ block: "nearest" });
  }, [s.current]);
  return (
    <aside className="dm-results" aria-label="Matches">
      <header className="dm-results-head">
        <span className="dm-results-title">{s.matches.length ? `${s.matches.length}${s.more ? "+" : ""} matches` : "Matches"}</span>
        <span className="faint small">whole history</span>
      </header>
      <div ref={list} className="dm-results-list">
        {s.problem && <p className="small state-blocked">{s.problem}</p>}
        {s.matches.map((m, i) => (
          <button
            key={m.id}
            type="button"
            className="dm-result"
            aria-current={i === s.current}
            onClick={() => onPick(i)}
          >
            <span className="dm-result-when">
              {dayName(m.at)} {clock(m.at)} · {m.from === "user" ? "You" : name}
            </span>
            <span className="dm-result-text">{marked(m.excerpt, terms)}</span>
          </button>
        ))}
        {s.more && (
          <button type="button" className="link small dm-results-more" disabled={s.loading} onClick={s.older}>
            {s.loading ? "Loading…" : "Older matches"}
          </button>
        )}
      </div>
    </aside>
  );
}

const HIGHLIGHTS = "CSS" in globalThis && "highlights" in CSS;

/** Marks the words of `terms` in `pane`'s messages, and those in message
 *  `current` as the one chosen, with the CSS Custom Highlight API (an
 *  engine without it marks nothing). Cleared when the search closes. */
export function useSearchMarks(pane: HTMLElement | null, terms: string[], current: string | null, version: unknown): void {
  const key = terms.join("\u0000");
  // Edits, deletes, a reply growing and markdown rendered late all change the
  // text under the marks, which `version` alone doesn't see.
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    if (!pane || !terms.length || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new MutationObserver(() => {
      // Settled, not per token of an answer streaming in.
      clearTimeout(timer);
      timer = setTimeout(() => setChanged((n) => n + 1), 150);
    });
    seen.observe(pane, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      seen.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, key]);
  useEffect(() => {
    if (!HIGHLIGHTS || !pane) return;
    const all: Range[] = [];
    const cur: Range[] = [];
    if (terms.length) {
      for (const row of pane.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const body = row.querySelector(".msg-body") ?? row;
        const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          const text = node.textContent?.toLowerCase() ?? "";
          for (const t of terms) {
            for (let at = text.indexOf(t); at >= 0; at = text.indexOf(t, at + t.length)) {
              const r = document.createRange();
              r.setStart(node, at);
              r.setEnd(node, at + t.length);
              (row.dataset.messageId === current ? cur : all).push(r);
            }
          }
        }
      }
    }
    const reg = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
    const H = (globalThis as unknown as { Highlight: new () => unknown }).Highlight;
    if (!terms.length) return;
    const add = (all: Range[]) => {
      const h = new H();
      for (const r of all) (h as unknown as { add: (r: Range) => void }).add(r);
      return h;
    };
    reg.set("dm-search", add(all));
    reg.set("dm-search-current", add(cur));
    return () => {
      reg.delete("dm-search");
      reg.delete("dm-search-current");
    };
    // `terms` is read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, key, current, version, changed]);
}
