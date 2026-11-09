import { useEffect, useId, useRef, useState } from "react";
import type { DeskHub } from "../hub/client";
import { LOCAL, sessionKey } from "../hub/machines";
import { useDesk, useHubOf } from "../hub/store";
import type { KeptExchange, MemoryHit } from "../hub/types";
import { openTarget } from "../shell/navigate";
import { useModal } from "../ui/Dialog";
import { listboxKey } from "../ui/listbox";
import { plainError } from "../ui/plainError";
import { KIND_FILTERS, MIN_QUERY, hitLine, hitText, searchNotice, sessionOf, useMemorySearch, whenOf, type MemoryFilters, type MemoryKindFilter } from "./search";
import { HIT_KIND, shortFile } from "./words";

/** The groups a search may be narrowed to, as the hub knows them: each of
 *  the person's, and Ungrouped. */
export function useMemoryGroups(hub: DeskHub | null): { id: string; name: string }[] {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!hub) return;
    let live = true;
    hub.memorySettings().then(
      (s) => live && setGroups((s?.groups ?? []).map(({ id, name }) => ({ id, name }))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [hub]);
  return groups;
}

/** The Group and Kind filters: only those the hub's search takes. */
export function SearchFilters({
  groups,
  filters,
  onChange,
}: {
  groups: { id: string; name: string }[];
  filters: MemoryFilters;
  onChange: (f: MemoryFilters) => void;
}) {
  return (
    <span className="memory-filters small">
      <label>
        <span className="faint">Group</span>
        <select className="pc-engine" value={filters.group ?? ""} onChange={(e) => onChange({ ...filters, group: e.target.value || undefined })}>
          <option value="">All</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value="ungrouped">Ungrouped</option>
        </select>
      </label>
      <label>
        <span className="faint">Kind</span>
        <select className="pc-engine" value={filters.kind ?? ""} onChange={(e) => onChange({ ...filters, kind: (e.target.value || undefined) as MemoryKindFilter | undefined })}>
          <option value="">All</option>
          {KIND_FILTERS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
    </span>
  );
}

/** One hit, as a list shows it: what it is, where from and when, and what
 *  it says. */
export function HitRow({ hit }: { hit: MemoryHit }) {
  return (
    <>
      <span className="faint small memory-result-line">
        {hitLine(hit)}
        {hit.superseded && " · replaced"}
      </span>
      <span className="memory-result-text">{hitText(hit)}</span>
    </>
  );
}

/** ⌘K: "Search what Desk remembers". Typing searches every session this
 *  computer's Desk kept, narrowed by group or kind; a hit opens to read, and
 *  from there its session. */
export function SearchMemory({ onClose }: { onClose: () => void }) {
  const hub = useHubOf(LOCAL);
  const groups = useMemoryGroups(hub);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<MemoryFilters>({});
  const [active, setActive] = useState(0);
  const [reading, setReading] = useState<MemoryHit | null>(null);
  const { found, busy, problem } = useMemorySearch(hub, q, filters);
  const hits = found?.hits ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const listId = useId();
  const onKeyDown = useModal(ref, () => (reading ? back() : onClose()));
  useEffect(() => setActive(0), [found]);
  const back = () => {
    setReading(null);
    requestAnimationFrame(() => field.current?.focus());
  };
  const notice = searchNotice(found);
  const short = q.trim().length < MIN_QUERY;

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKeyDown}>
      <div ref={ref} className="quick-ask memory-palette" role="dialog" aria-modal="true" aria-label="Search what Desk remembers" tabIndex={-1}>
        {reading ? (
          <ReadHit hit={reading} hub={hub} onBack={back} onOpened={onClose} />
        ) : (
          <>
            <input
              ref={field}
              data-autofocus
              value={q}
              placeholder="Search what Desk remembers"
              aria-label="Search what Desk remembers"
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls={listId}
              aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") return;
                listboxKey(e, hits.length, active, { move: setActive, choose: (i) => setReading(hits[i]!), close: onClose }, { typing: true });
              }}
            />
            <SearchFilters groups={groups} filters={filters} onChange={setFilters} />
            {notice && (
              <p className="small faint" role="status">
                {notice}
              </p>
            )}
            {problem && (
              <p className="small state-blocked" role="alert">
                {problem}
              </p>
            )}
            {short ? (
              <p className="small faint">What sessions said and decided, the to-dos they left, and facts Desk noted.</p>
            ) : found && hits.length === 0 ? (
              <p className="small faint">Nothing found.</p>
            ) : (
              !found && busy && <p className="small faint">Searching…</p>
            )}
            {hits.length > 0 && (
              <ul className="memory-results" role="listbox" id={listId} aria-label="What Desk remembers">
                {hits.map((h, i) => (
                  <li
                    key={`${h.session}:${h.at}:${i}`}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className="memory-result"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => setReading(h)}
                  >
                    <HitRow hit={h} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** A hit read in full: the whole exchange where Desk still lists it, the
 *  note as found otherwise, and its session to go to. */
function ReadHit({ hit, hub, onBack, onOpened }: { hit: MemoryHit; hub: DeskHub | null; onBack: () => void; onOpened: () => void }) {
  const [exchange, setExchange] = useState<KeptExchange | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const key = sessionKey({ id: hit.session });
  const here = useDesk((s) => !!s.sessions[key]);
  const conversation = hit.kind === "exchange" || hit.kind === "compaction";
  useEffect(() => {
    if (!hub || !conversation) return;
    let live = true;
    hub.sessionMemory(hit.session).then(
      (m) => live && setExchange(m?.exchanges.find((x) => x.at === hit.at) ?? null),
      (e: unknown) => live && setProblem(plainError(e)),
    );
    return () => {
      live = false;
    };
  }, [hub, hit, conversation]);
  const ask = exchange?.ask ?? hit.ask;
  const answer = exchange?.answer ?? hit.answer;
  return (
    <article className="memory-read" aria-label={`${HIT_KIND[hit.kind]} from ${sessionOf(hit)}`}>
      <header className="memory-read-head">
        <button type="button" className="link small" autoFocus onClick={onBack}>
          ← Back to results
        </button>
      </header>
      <p className="small faint">
        {[HIT_KIND[hit.kind], sessionOf(hit), hit.groupName, whenOf(hit.at)].filter(Boolean).join(" · ")}
        {hit.notedByDesk && !hit.confirmed && " · noted by Desk, may be wrong"}
        {hit.confirmed && " · confirmed"}
        {hit.superseded && " · replaced by a later one"}
      </p>
      {conversation ? (
        <dl className="memory-read-body">
          {ask && (
            <>
              <dt className="field-label">Asked</dt>
              <dd className="selectable">{ask}</dd>
            </>
          )}
          <dt className="field-label">{hit.compaction ? "Summary" : "Answered"}</dt>
          <dd className="selectable">{answer}</dd>
          {exchange && exchange.files.length > 0 && (
            <>
              <dt className="field-label">Files</dt>
              <dd className="small mono">{exchange.files.map(shortFile).join(", ")}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="selectable memory-read-body">{hit.answer}</p>
      )}
      {problem && <p className="small faint">{problem}</p>}
      <footer className="memory-read-foot">
        {here ? (
          <button
            type="button"
            className="btn btn-signal btn-sm"
            onClick={() => {
              openTarget({ kind: "session", sessionId: key });
              onOpened();
            }}
          >
            Open {hit.name ?? "its session"}
          </button>
        ) : (
          <span className="small faint">Desk no longer has this session; this is what it kept.</span>
        )}
      </footer>
    </article>
  );
}
