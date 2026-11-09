import { useEffect, useId, useState } from "react";
import { hubFor } from "../hub/store";
import type { DeskHub } from "../hub/client";
import type { MemoryHit, Session } from "../hub/types";
import { plainError } from "../ui/plainError";
import { listboxKey } from "../ui/listbox";
import { MIN_QUERY, quoteOf, recallQuery, searchNotice, useMemorySearch, type MemoryFilters } from "../memory/search";
import { HitRow, SearchFilters, useMemoryGroups } from "../memory/SearchMemory";
import { steerOf } from "./rows";
import { useLine } from "./store";
import { machineOf } from "../hub/machines";

/** Writing to a session on its line: Send waits for its turn to end (it
 *  goes in at its prompt, never over what it is doing); Send now, where its
 *  engine can take one, goes into the turn it is on. `/recall <words>`
 *  searches what Desk remembers instead, and a hit chosen goes into the
 *  message as a quote. */
export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const name = session.displayName ?? session.name;
  const steer = steerOf(session);
  const working = session.state === "working" || session.state === "blocked";
  const recall = recallQuery(text);
  // Its memory is on the machine it runs on, searched within its own group
  // to begin with: the person widens it if they mean to.
  const hub = hubFor(session);
  const [filters, setFilters] = useState<MemoryFilters>(() => ({ group: session.group?.id ?? "ungrouped" }));
  const found = useMemorySearch(recall === null ? null : hub, recall ?? "", filters);
  const hits = found.found?.hits ?? [];
  useEffect(() => setActive(0), [found.found]);
  const quote = (h: MemoryHit) => {
    setText(`${quoteOf(h)}\n\n`);
  };
  const send = async (when: "queue" | "now") => {
    if (!hub || !text.trim() || busy || recall !== null) return;
    setBusy(true);
    setProblem(null);
    try {
      const m = await hub.postLine(session.id, text.trim(), when);
      useLine.getState().heard(m, false, machineOf(session));
      setText("");
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  return (
    <form
      className="line-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send("queue");
      }}
    >
      {recall !== null && <Recall hub={hub} q={recall} state={found} hits={hits} active={active} setActive={setActive} filters={filters} setFilters={setFilters} onPick={quote} />}
      <textarea
        rows={1}
        value={text}
        placeholder={`Message ${name} — /recall to search what Desk remembers`}
        aria-label={`Message ${name}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (recall !== null) {
            // Enter picks a hit, never sends `/recall …` to the session.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (hits[active]) quote(hits[active]);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Escape") {
              listboxKey(e, hits.length, active, { move: setActive, choose: () => undefined, close: () => setText("") }, { typing: true });
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
          <button type="button" className="btn btn-sm" disabled={busy || !text.trim() || recall !== null} title={`Into ${name}’s turn now (⌘↩)`} onClick={() => void send("now")}>
            {steer.label}
          </button>
        )}
        <button type="submit" className="btn btn-signal btn-sm" disabled={busy || !text.trim() || recall !== null} title={working ? `It goes in once ${name}’s turn ends` : undefined}>
          {working ? "Send when done" : "Send"}
        </button>
      </span>
      {problem && (
        <span className="small state-blocked line-composer-problem" role="alert">
          {problem}
        </span>
      )}
    </form>
  );
}

/** `/recall`'s hits, over the composer: ↑ ↓ choose, Enter or a click quotes
 *  one into the message, Esc clears it. */
function Recall({
  hub,
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
  const groups = useMemoryGroups(hub);
  const notice = searchNotice(state.found);
  return (
    <div className="mention-menu memory-recall" aria-label="Recall from what Desk remembers">
      <div className="memory-recall-head">
        <span className="small faint">{q.length < MIN_QUERY ? "Type what to recall: /recall the cookie decision" : "Pick one to quote it in your message"}</span>
        <SearchFilters groups={groups} filters={filters} onChange={setFilters} />
      </div>
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
              <HitRow hit={h} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
