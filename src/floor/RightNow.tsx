import { RichMarkdown } from "@workforce/rich";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAgentConfigs } from "../crew/agentBrain";
import { setAgentOversight } from "../crew/oversight";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Brief } from "../hub/types";
import { localKey, openLocalDm } from "../overview/people";
import { useOverview } from "../overview/store";
import { openTarget } from "../shell/navigate";
import { AgentMark } from "../ui/Mark";
import { useMainHidden } from "../panels/Stage";
import { useSeenWhole } from "../unread/seen";
import { useUnread } from "../unread/summary";
import { plainError } from "../ui/plainError";
import { backgroundTasks } from "./background";
import { happening, type FloorEntry } from "./happening";
import type { Merged } from "./merge";
import { NeedRow } from "./NeedRow";
import { FloorRow, useSubject, useWho } from "./Row";
import { useMerged } from "./store";
import { needsLine, paragraphOf, refreshed, type Held } from "./summary";
import { besideOf } from "./target";
import { clock } from "./time";

/** The clock the floor's times are said against, moving every minute. */
export const useMinute = (): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

/** The paragraph above what's happening: the hubs' own, while anything is
 *  happening; else Desk's, which changes at most every ten minutes. */
const useParagraph = (m: Merged, entries: readonly FloorEntry[], names: Readonly<Record<string, string>>): Held => {
  const held = useRef<Held | null>(null);
  held.current = refreshed(held.current, paragraphOf(entries, names), Date.now());
  if (entries.length === 0 || m.summaries.length === 0) return held.current;
  return { text: m.summaries.map((s) => s.text).join(" "), at: Math.max(...m.summaries.map((s) => Date.parse(s.at))) };
};

/** What needs the person, then what each agent and session is doing, with
 *  the overseer's brief (or, without one, the floor's paragraph) above. */
export function RightNow({ brief }: { brief: ReactNode | null }) {
  const m = useMerged();
  const now = useMinute();
  const names = useSessionNames();
  const entries = happening(m, now, useWho(), useSubject());
  const paragraph = useParagraph(m, entries, names);
  return (
    <section className="floor-card right-now" aria-label="Right now">
      <div className="floor-card-head">
        <h2 className="display floor-card-title">Right now</h2>
        {!brief && <span className="floor-time">updated {clock(paragraph.at)}</span>}
      </div>
      {brief ?? (
        <p className="right-now-summary">
          {paragraph.text} {needsLine(m.needs.length)}
        </p>
      )}
      <Column
        label={`Needs you · ${m.needs.length}`}
        tone="blocked"
        empty="Nothing is waiting on you."
        list="Waiting on you"
        rows={m.needs.map((n) => (
          <div key={n.key} role="listitem">
            <NeedRow need={n} now={now} actions />
          </div>
        ))}
      />
      <Column
        label="What’s happening"
        tone="working"
        empty="Nothing is running, and nothing has finished in the last two hours."
        rows={entries.map((e) => (
          <EntryRow key={e.key} entry={e} />
        ))}
      />
    </section>
  );
}

/** One of Right now's lists; a long one scrolls in place, under its label,
 *  so what follows stays in view. With `list`, its rows are a list's items
 *  (named so), and the list stays, empty too, so focus left by a row that
 *  goes lands on it. */
function Column({ label, tone, empty, rows, list }: { label: string; tone: string; empty: string; rows: ReactNode[]; list?: string }) {
  return (
    <div className="right-now-col" role="group" aria-label={label}>
      <h3 className={`ov-label state-${tone}`}>{label}</h3>
      {list ? (
        <div className="right-now-list" role="list" aria-label={list} tabIndex={-1}>
          {rows}
        </div>
      ) : (
        rows.length > 0 && <div className="right-now-list">{rows}</div>
      )}
      {rows.length === 0 && <p className="faint small">{empty}</p>}
    </div>
  );
}

const STATE_WORD: Record<FloorEntry["state"], string> = { working: "working", waiting: "waiting", done: "done", failed: "failed" };

const LOOK = { working: "working", waiting: "background", done: "done", failed: "failed" } as const;

/** An agent or session as what's happening says it: its state, what it is
 *  for and what it is doing, and when that was written. It opens beside the
 *  Floor, as the Floor's tiles do, even when a grid shows it. */
function EntryRow({ entry }: { entry: FloorEntry }) {
  const target = besideOf(entry);
  const state = entry.state === "waiting" && entry.background ? `waiting on ${backgroundTasks(entry.background)}` : STATE_WORD[entry.state];
  return (
    <FloorRow
      item={entry}
      look={LOOK[entry.state]}
      time={`${state} · updated ${clock(entry.at)}`}
      onOpen={target ? () => openTarget(target, { beside: true }) : undefined}
    >
      {entry.purpose && <span className="floor-entry-purpose">{entry.purpose} </span>}
      {entry.now}
    </FloorRow>
  );
}

const reload = () => {
  const s = useOverview.getState();
  void s.loadManager();
  void s.loadOverview();
};

async function setOverseeing(id: string, enabled: boolean): Promise<void> {
  const hub = useDesk.getState().hub;
  if (!hub) return;
  const toml = await setAgentOversight(hub, id, (o) => ({ ...o, enabled }));
  const key = localKey(id);
  if (key) useAgentConfigs.getState().put(key, toml);
  reload();
}

/** The overseer's latest word on the crew. */
export function BriefCard({
  brief,
  managerId,
  name,
  onPaused,
}: {
  brief: Brief;
  managerId: string;
  name: string;
  onPaused: (who: { id: string; name: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Desk's report is read once half of it has shown; until then it's new.
  const card = useRef<HTMLElement>(null);
  const unread = useUnread((s) => !!s.local?.brief);
  useSeenWhole({ kind: "brief" }, unread ? { at: brief.at, message: null } : null, card, { enabled: !useMainHidden() });
  const pause = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await setOverseeing(managerId, false);
      onPaused({ id: managerId, name });
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  return (
    <section ref={card} className="brief" aria-label={`${name}’s brief`}>
      <AgentMark agent={localKey(managerId) ?? ""} name={name} />
      <div className="brief-body">
        <span className="brief-head">
          <b>{name}</b>
          <span className="faint small">overseeing your crew · updated {clock(brief.at)}</span>
          {unread && <span className="chip msg-delivery brief-new">New</span>}
        </span>
        <div className="brief-text rich">
          <RichMarkdown text={brief.text} />
        </div>
        <div className="brief-actions">
          <button type="button" className="btn" onClick={() => openLocalDm(managerId)}>
            Ask {name}…
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void pause()}>
            {busy ? "Pausing…" : "Pause oversight"}
          </button>
          {problem && (
            <span className="small state-blocked" role="alert">
              {problem}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

export function PausedNote({ who, onResumed }: { who: { id: string; name: string }; onResumed: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="brief brief-paused" aria-label="Oversight paused">
      <span className="brief-text">
        {who.name} has stopped overseeing the crew. Turn it back on here or in {who.name}’s Settings.
      </span>
      <button type="button" className="btn" onClick={() => setOverseeing(who.id, true).then(onResumed, (e: unknown) => setProblem(plainError(e)))}>
        Turn back on
      </button>
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </section>
  );
}
