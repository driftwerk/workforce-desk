import { useEffect, useMemo, useState } from "react";
import { useChat } from "../chat/store";
import { hasFloor, type FloorNeed } from "../floor/merge";
import { NeedRow } from "../floor/NeedRow";
import { useMinute } from "../floor/RightNow";
import { useWhoName } from "../floor/Row";
import { useFloor, useNeeds, type Answered } from "../floor/store";
import { clock } from "../floor/time";
import { useSessionNames } from "../groups/names";
import type { ActivityEvent, ActivityFilter } from "../hub/types";
import { radioKeys } from "../ui/Dialog";
import { lineOf, needStates, toneOf, type NeedState } from "./activity";
import { useOverview } from "./store";

const dayOf = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};

/** "allowed by you 16:31", "no longer waiting". */
const resolvedText = (state: Extract<NeedState, { open: false }>): string => (state.at ? `${state.how} ${clock(state.at)}` : state.how);

export function ActivityRow({ event, need }: { event: ActivityEvent; need?: NeedState }) {
  const line = lineOf(event, useSessionNames());
  return (
    <li className={`ev ${need?.open ? "ev-open" : need ? "ev-resolved" : ""}`}>
      <time className="ev-time" dateTime={event.at}>
        {clock(event.at)}
      </time>
      <span className={`ev-dot ev-${toneOf(event)}`} aria-hidden="true" />
      <span className="ev-text">
        {line.lead && (line.lead.session ? <span className="mono ev-who">{line.lead.name}</span> : <b>{line.lead.name}</b>)}{" "}
        {line.parts.map((p, i) =>
          p.name ? (
            p.session ? (
              <span key={i} className="mono">
                {p.text}
              </span>
            ) : (
              <b key={i}>{p.text}</b>
            )
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {event.reason && <span className="ev-reason">{event.reason}</span>}
        {need && <span className="ev-reason">{need.open ? "Still waiting on you" : `Resolved · ${resolvedText(need)}`}</span>}
      </span>
    </li>
  );
}

const NO_EVENTS: ActivityEvent[] = [];

const EMPTY: Record<ActivityFilter, string> = {
  all: "Nothing has happened yet. What the crew does shows here as it happens.",
  needs_you: "Nothing is waiting on you.",
  manager: "Nothing done on its own yet.",
};

/** A need answered elsewhere before Desk's answer got there. */
function AnsweredRow({ answered }: { answered: Answered }) {
  const name = useWhoName(answered.need.who);
  return (
    <div className="floor-need floor-answered" role="status">
      <span className="floor-item-what">
        <b>{name}</b> · {answered.need.ask}
      </span>
      <span className="small faint">Already answered</span>
    </div>
  );
}

/** What still needs you, on every hub, answered in place. */
function OpenNeeds({ needs, now }: { needs: readonly FloorNeed[]; now: number }) {
  const answered = useFloor((s) => s.answered);
  return (
    <div className="activity-needs" role="list" aria-label="Still waiting on you">
      {needs.map((n) => (
        <div key={n.key} role="listitem">
          <NeedRow need={n} now={now} actions />
        </div>
      ))}
      {Object.entries(answered).map(([key, a]) => (
        <AnsweredRow key={key} answered={a} />
      ))}
    </div>
  );
}

/** What happened on the crew, newest first, as it happens: everything, what
 *  still needs you, or what the overseer did. Where a hub has a floor, "Needs
 *  you" is what's still waiting on you on every hub, and everything shows it
 *  above what happened, each past request marked with what became of it. */
export function ActivityRail({ managerName }: { managerName: string | null }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const feed = useOverview((s) => s.feeds[filter]);
  const { loadActivity, loadEarlier } = useOverview();
  const shown: ActivityFilter = filter === "manager" && !managerName ? "all" : filter;
  const floorOn = hasFloor(
    useFloor((s) => s.hubs),
    useChat((s) => s.hubs),
  );
  const needs = useNeeds();
  const localId = useChat((s) => s.hubs.find((h) => h.local)?.id);
  const now = useMinute();
  const answered = useFloor((s) => Object.keys(s.answered).length);
  const fromLog = !(floorOn && shown === "needs_you");

  useEffect(() => {
    if (fromLog && !useOverview.getState().feeds[shown]) void loadActivity(shown);
  }, [fromLog, shown, loadActivity]);

  const options: { id: ActivityFilter; label: string; count?: number }[] = [
    { id: "all", label: "All" },
    { id: "needs_you", label: "Needs you", count: floorOn ? needs.length : undefined },
    ...(managerName ? [{ id: "manager" as const, label: `${managerName}’s actions` }] : []),
  ];
  const current = options.findIndex((o) => o.id === shown);
  const events = feed?.events ?? NO_EVENTS;
  const earlier = () => void loadEarlier(shown);
  const states = useMemo(
    () =>
      floorOn && shown === "all"
        ? needStates(
            events,
            needs.filter((n) => n.hubId === localId),
          )
        : new Map<string, NeedState>(),
    [floorOn, shown, events, needs, localId],
  );

  const log = (
    <>
      {!feed || (feed.state === "loading" && events.length === 0) ? (
        <p className="faint small activity-note">Loading…</p>
      ) : feed.state === "failed" && events.length === 0 ? (
        <p className="faint small activity-note">
          Couldn’t load what’s happened.{" "}
          <button type="button" className="link small" onClick={() => void loadActivity(shown)}>
            Try again
          </button>
        </p>
      ) : events.length === 0 ? (
        <p className="faint small activity-note">{EMPTY[shown]}</p>
      ) : (
        <ol className="ev-list" aria-label={`Activity: ${options[current]?.label ?? "All"}`}>
          {events.map((e, i) => {
            const day = dayOf(e.at);
            const heading = day !== "Today" && day !== (i > 0 ? dayOf(events[i - 1]!.at) : "Today");
            return [
              heading && (
                <li key={`day-${e.id}`} className="ev-day">
                  {day}
                </li>
              ),
              <ActivityRow key={e.id} event={e} need={states.get(e.id)} />,
            ];
          })}
        </ol>
      )}
      {feed?.more && (
        <p className="activity-note">
          {feed.earlier === "failed" ? (
            <span className="faint small">
              Couldn’t load earlier activity.{" "}
              <button type="button" className="link small" onClick={earlier}>
                Try again
              </button>
            </span>
          ) : (
            <button type="button" className="link small" disabled={feed.earlier === "loading"} onClick={earlier}>
              {feed.earlier === "loading" ? "Loading earlier activity…" : "Show earlier"}
            </button>
          )}
        </p>
      )}
    </>
  );

  return (
    <aside className="activity" aria-labelledby="activity-head">
      <div className="activity-head">
        <h2 id="activity-head" className="display">
          Activity
        </h2>
        <div className="seg activity-filter" role="radiogroup" aria-label="Show">
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={shown === o.id}
              tabIndex={i === current ? 0 : -1}
              onClick={() => setFilter(o.id)}
              onKeyDown={(e) => radioKeys(e, options, current, (next) => setFilter(next.id))}
            >
              {o.label}
              {!!o.count && (
                <>
                  {" "}
                  <span className="badge">{o.count}</span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
      <div
        className="activity-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (fromLog && el.scrollHeight - el.scrollTop - el.clientHeight < 120 && feed?.more && feed.earlier === "idle") earlier();
        }}
      >
        {!fromLog ? (
          <>
            {needs.length === 0 && answered === 0 ? (
              <p className="faint small activity-note">{EMPTY.needs_you}</p>
            ) : (
              <OpenNeeds needs={needs} now={now} />
            )}
            <p className="faint small activity-note">Only what’s still waiting on you. Answered or expired items leave this list.</p>
          </>
        ) : (
          <>
            {floorOn && shown === "all" && needs.length > 0 && <OpenNeeds needs={needs} now={now} />}
            {log}
          </>
        )}
      </div>
    </aside>
  );
}
