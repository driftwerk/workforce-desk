import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { hubFor } from "../hub/store";
import type { DeskHub } from "../hub/client";
import type { MemoryHit, Session } from "../hub/types";
import { plainError } from "../ui/plainError";
import { listboxKey } from "../ui/listbox";
import { MIN_QUERY, hasRecall, putQuote, quoteOf, recallAt, searchNotice, useMemorySearch, type MemoryFilters } from "../memory/search";
import { HitRow, SearchFilters, useMemoryGroups } from "../memory/SearchMemory";
import { steerOf } from "./rows";
import { useLine } from "./store";
import { LOCAL, machineOf } from "../hub/machines";

/** Said when `/recall` is typed to a session on another machine. */
export const NO_MACHINE_RECALL = "Search on machines comes with group grants.";

/** Writing to a session on its line: Send waits for its turn to end (it
 *  goes in at its prompt, never over what it is doing); Send now, where its
 *  engine can take one, goes into the turn it is on. A line of the draft
 *  that is `/recall <words>` searches what Desk remembers instead, and a hit
 *  chosen takes that line's place as a quote. */
export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const placeCaret = useRef<number | null>(null);
  const name = session.displayName ?? session.name;
  const steer = steerOf(session);
  const working = session.state === "working" || session.state === "blocked";
  const recall = recallAt(text, caret);
  const recalling = hasRecall(text);
  // Its memory is on the machine it runs on. A machine's is searched only
  // once groups are granted there, as the hub refuses it until then.
  const onMachine = machineOf(session) !== LOCAL;
  const hub = hubFor(session);
  // Searched within its own group to begin with: the person widens it if
  // they mean to.
  const own = session.group?.id ?? "ungrouped";
  const [filters, setFilters] = useState<MemoryFilters>(() => ({ group: own }));
  const found = useMemorySearch(recall === null || onMachine ? null : hub, recall?.q ?? "", filters);
  const hits = found.found?.hits ?? [];
  useEffect(() => setActive(0), [found.found]);
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === null || !field.current) return;
    placeCaret.current = null;
    field.current.setSelectionRange(at, at);
  }, [text]);
  const edit = (next: string, at: number) => {
    placeCaret.current = at;
    setText(next);
    setCaret(at);
  };
  const quote = (h: MemoryHit) => {
    if (!recall) return;
    const put = putQuote(text, recall, quoteOf(h, new Date(), { otherGroup: (h.group ?? "ungrouped") !== own }));
    edit(put.text, put.caret);
  };
  const dropRecall = () => {
    if (!recall) return;
    const next = text.slice(0, recall.from) + text.slice(recall.to).replace(/^\n/, "");
    edit(next, recall.from);
  };
  const send = async (when: "queue" | "now") => {
    if (!hub || !text.trim() || busy || recalling) return;
    setBusy(true);
    setProblem(null);
    try {
      const m = await hub.postLine(session.id, text.trim(), when);
      useLine.getState().heard(m, false, machineOf(session));
      setText("");
      setCaret(0);
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  const follow = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);
  return (
    <>
      {recall !== null &&
        (onMachine ? (
          <p className="small faint memory-recall" role="status">
            {NO_MACHINE_RECALL}
          </p>
        ) : (
          <Recall
            hub={hub}
            session={session}
            q={recall.q}
            state={found}
            hits={hits}
            active={active}
            setActive={setActive}
            filters={filters}
            setFilters={setFilters}
            onPick={quote}
          />
        ))}
      <form
        className="line-composer"
        data-line-composer=""
        onSubmit={(e) => {
          e.preventDefault();
          void send("queue");
        }}
      >
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={onMachine ? `Message ${name}` : `Message ${name} — /recall to search what Desk remembers`}
          aria-label={`Message ${name}`}
          onChange={(e) => {
            setText(e.target.value);
            follow(e.currentTarget);
          }}
          onSelect={(e) => follow(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (recall !== null) {
              // Enter picks a hit, never sends `/recall …` to the session.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (hits[active] && !onMachine) quote(hits[active]);
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Escape") {
                listboxKey(e, hits.length, active, { move: setActive, choose: () => undefined, close: dropRecall }, { typing: true });
              }
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e.metaKey && steer ? "now" : "queue");
            }
          }}
        />
        <span className="line-composer-buttons">
          {steer && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !text.trim() || recalling}
              title={`Into ${name}’s turn now (⌘↩)`}
              onClick={() => void send("now")}
            >
              {steer.label}
            </button>
          )}
          <button
            type="submit"
            className="btn btn-signal btn-sm"
            disabled={busy || !text.trim() || recalling}
            title={recalling ? "Pick a hit for the /recall line, or take it out, to send" : working ? `It goes in once ${name}’s turn ends` : undefined}
          >
            {working ? "Send when done" : "Send"}
          </button>
        </span>
        {problem && (
          <span className="small state-blocked line-composer-problem" role="alert">
            {problem}
          </span>
        )}
      </form>
    </>
  );
}

/** `/recall`'s hits, just above the composer: ↑ ↓ choose, Enter or a click
 *  quotes one in place of the `/recall` line, Esc takes the line out. A hit
 *  from another group than the session's says so, and once the search
 *  reaches past its group, where a quote would go is said too. */
function Recall({
  hub,
  session,
  q,
  state,
  hits,
  active,
  setActive,
  filters,
  setFilters,
  onPick,
}: {
  hub: DeskHub | null;
  session: Session;
  q: string;
  state: ReturnType<typeof useMemorySearch>;
  hits: MemoryHit[];
  active: number;
  setActive: (i: number) => void;
  filters: MemoryFilters;
  setFilters: (f: MemoryFilters) => void;
  onPick: (h: MemoryHit) => void;
}) {
  const listId = useId();
  const known = useMemoryGroups(hub);
  // The session's own group is always there to pick, even before (or
  // without) the hub's list.
  const own = session.group;
  const ownId = own?.id ?? "ungrouped";
  const groups = own && !known.some((g) => g.id === own.id) ? [own, ...known] : known;
  const notice = searchNotice(state.found);
  const wider = filters.group !== ownId;
  return (
    <div className="memory-recall" role="group" aria-label="Recall from what Desk remembers">
      <div className="memory-recall-head">
        <span className="small faint">{q.length < MIN_QUERY ? "Type what to recall: /recall the cookie decision" : "Pick one to quote it in your message"}</span>
        <SearchFilters groups={groups} filters={filters} onChange={setFilters} />
      </div>
      {wider && (
        <p className="small muted">
          Quoting sends it to {session.displayName ?? session.name} in {own?.name ?? "Ungrouped"}.
        </p>
      )}
      {notice && (
        <p className="small faint" role="status">
          {notice}
        </p>
      )}
      {state.problem && (
        <p className="small state-blocked" role="alert">
          {state.problem}
        </p>
      )}
      {state.found && hits.length === 0 && <p className="small faint">Nothing found.</p>}
      {hits.length > 0 && (
        <ul className="memory-results" role="listbox" id={listId} aria-label="What Desk remembers">
          {hits.map((h, i) => (
            <li
              key={`${h.session}:${h.at}:${i}`}
              role="option"
              aria-selected={i === active}
              className="memory-result"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(h);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <HitRow hit={h} otherGroup={(h.group ?? "ungrouped") !== ownId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
