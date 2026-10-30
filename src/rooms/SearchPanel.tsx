import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { dayClock } from "../floor/time";
import { useDesk } from "../hub/store";
import type { SearchHit } from "../hub/types";
import { SidePanel } from "../panels/Stage";
import { openTarget } from "../shell/navigate";
import { useUi } from "../shell/ui";
import { Menu, type MenuEntry } from "../ui/Menu";
import { handle } from "./mentions";
import { MemberMark } from "./MemberMark";
import { useAuthor } from "./names";
import { filtersText, isEmpty, parseSearch, type SearchFilters } from "./search";

/** How long typing settles before the hub is asked. */
export const SEARCH_DEBOUNCE_MS = 250;

/** The hub's snippet as text and matches; never HTML. */
const MATCH_START = "";
const MATCH_END = "";
export const snippetParts = (snippet: string): { text: string; match: boolean }[] => {
  const parts: { text: string; match: boolean }[] = [];
  for (const [i, chunk] of snippet.split(MATCH_START).entries()) {
    if (i === 0) {
      if (chunk) parts.push({ text: chunk, match: false });
      continue;
    }
    const [hit = "", ...rest] = chunk.split(MATCH_END);
    if (hit) parts.push({ text: hit, match: true });
    const after = rest.join("");
    if (after) parts.push({ text: after, match: false });
  }
  return parts;
};

type Result = { state: "idle" } | { state: "loading" } | { state: "done"; hits: SearchHit[] } | { state: "failed"; why: string };

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(new Date().setHours(0, 0, 0, 0) - n * DAY_MS).toISOString();

/** Search: what's typed, its filters, and what matches; a result opens where it is. */
export function SearchPanel() {
  const text = useUi((u) => u.search?.text ?? "");
  const setSearch = useUi((u) => u.setSearch);
  const roomsById = useDesk((s) => s.rooms);
  const rooms = useMemo(() => Object.values(roomsById), [roomsById]);
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const author = useAuthor();
  const { filters, problems } = useMemo(() => parseSearch(text, rooms, roster, hubs), [text, rooms, roster, hubs]);
  const [result, setResult] = useState<Result>({ state: "idle" });
  const [again, setAgain] = useState(0);
  const asked = useRef(0);
  const key = JSON.stringify(filters);
  useEffect(() => {
    const hub = useDesk.getState().hub;
    if (!hub || isEmpty(filters)) return setResult({ state: "idle" });
    const n = ++asked.current;
    const t = setTimeout(() => {
      setResult({ state: "loading" });
      hub.search(filters).then(
        (hits) => n === asked.current && setResult({ state: "done", hits }),
        (e: unknown) => n === asked.current && setResult({ state: "failed", why: e instanceof Error ? e.message : String(e) }),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // `key` stands for the filters.
  }, [key, again]);

  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const edit = (f: Partial<SearchFilters>) => setSearch(filtersText({ ...filters, ...f }, rooms, (k) => handle(author(k).name)));
  const [menu, setMenu] = useState<{ entries: MenuEntry[]; label: string; at: { x: number; y: number } } | null>(null);
  const open = (label: string, entries: MenuEntry[]) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ label, entries, at: { x: r.left, y: r.bottom + 4 } });
  };
  const item = (label: string, onSelect: () => void): MenuEntry => ({ kind: "item", label, onSelect });

  return (
    <SidePanel className="search-panel" label="Search" noun="search" onClose={() => setSearch(null)} title={<b className="display rpanel-name">Search</b>}>
      <div className="search-body">
        <input
          ref={field}
          className="search-field"
          aria-label="Search messages"
          placeholder="Search messages in your rooms"
          value={text}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            setSearch(null);
          }}
        />
        <div className="search-filters" role="group" aria-label="Filters">
          <button
            type="button"
            className={`chip-btn${filters.from ? " on" : ""}`}
            onClick={open("From", [
              item("Anyone", () => edit({ from: undefined })),
              item("You", () => edit({ from: "you" })),
              ...roster.map((a) => item(a.name, () => edit({ from: agentKey(a) }))),
            ])}
          >
            {filters.from ? `From ${author(filters.from).name}` : "From"} ▾
          </button>
          <button
            type="button"
            className={`chip-btn${filters.room ? " on" : ""}`}
            onClick={open("In", [item("Every room", () => edit({ room: undefined })), ...rooms.map((r) => item(r.name, () => edit({ room: r.id })))])}
          >
            {filters.room ? `In ${roomsById[filters.room]?.name ?? "a room"}` : "In"} ▾
          </button>
          <button
            type="button"
            className={`chip-btn${filters.has.length ? " on" : ""}`}
            onClick={open("Has", [
              item(`${filters.has.includes("file") ? "✓ " : ""}A file`, () =>
                edit({ has: filters.has.includes("file") ? filters.has.filter((h) => h !== "file") : [...filters.has, "file"] }),
              ),
              item(`${filters.has.includes("approval") ? "✓ " : ""}An approval`, () =>
                edit({ has: filters.has.includes("approval") ? filters.has.filter((h) => h !== "approval") : [...filters.has, "approval"] }),
              ),
            ])}
          >
            Has ▾
          </button>
          <button type="button" className={`chip-btn${filters.inThread ? " on" : ""}`} aria-pressed={filters.inThread} onClick={() => edit({ inThread: !filters.inThread })}>
            In a thread
          </button>
          <button
            type="button"
            className={`chip-btn${filters.after || filters.before ? " on" : ""}`}
            onClick={open("Date", [
              item("Any time", () => edit({ after: undefined, before: undefined })),
              item("Today", () => edit({ after: daysAgo(0), before: undefined })),
              item("The last 7 days", () => edit({ after: daysAgo(6), before: undefined })),
              item("The last 30 days", () => edit({ after: daysAgo(29), before: undefined })),
            ])}
          >
            Date ▾
          </button>
        </div>
        {problems.map((p) => (
          <p key={p} className="small state-blocked" role="alert">
            {p}
          </p>
        ))}
        <div className="search-results" role="list" aria-label="Results">
          {result.state === "idle" && <p className="faint small">Search messages in your rooms. Try from:@allan or has:file.</p>}
          {result.state === "loading" && <p className="faint small">Searching…</p>}
          {result.state === "failed" && (
            <p className="small state-blocked">
              Couldn’t search: {result.why}{" "}
              <button type="button" className="link small" onClick={() => setAgain((n) => n + 1)}>
                Try again
              </button>
            </p>
          )}
          {result.state === "done" && result.hits.length === 0 && <p className="faint small">Nothing matches.</p>}
          {result.state === "done" &&
            result.hits.map((h) => (
              <button
                key={h.message.id}
                type="button"
                role="listitem"
                className="search-hit"
                onClick={() => openTarget({ kind: "room", roomId: h.roomId, threadId: null, messageId: h.message.id })}
              >
                <MemberMark member={h.message.author} name={author(h.message.author).name} size="sm" />
                <span className="search-hit-body">
                  <span className="search-hit-head">
                    <b>{author(h.message.author).name}</b>
                    <span className="faint small">
                      {roomsById[h.roomId]?.name ?? "A room"}
                      {h.message.threadId ? " ▸ thread" : ""}
                    </span>
                    <span className="faint small">{dayClock(h.message.createdAt)}</span>
                  </span>
                  <span className="search-snippet small">
                    {snippetParts(h.snippet).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                  </span>
                </span>
              </button>
            ))}
        </div>
      </div>
      {menu && <Menu label={menu.label} at={menu.at} entries={menu.entries} onClose={() => setMenu(null)} />}
    </SidePanel>
  );
}
