import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useMainHidden } from "../panels/Stage";
import { badgeOfFloor } from "../unread/badges";
import { Marks } from "../unread/Marks";
import { useSeen } from "../unread/seen";
import { useUnread } from "../unread/summary";
import { useChat } from "../chat/store";
import type { FloorNeed } from "../floor/merge";
import { NeedRow } from "../floor/NeedRow";
import { useMinute } from "../floor/RightNow";
import { useWhoName } from "../floor/Row";
import { useFloor, useLocalFloor, useNeeds, type Answered } from "../floor/store";
import { clock, dayName } from "../floor/time";
import { useSessionNames } from "../groups/names";
import type { ActivityEvent, ActivityFilter } from "../hub/types";
import { radioKeys } from "../ui/Dialog";
import { lineOf, needStates, toneOf, type NeedState } from "./activity";
import { useOverview } from "./store";

/** "allowed by you 16:31", "no longer waiting". */
const resolvedText = (state: Extract<NeedState, { open: false }>): string => (state.at ? `${state.how} ${clock(state.at)}` : state.how);

export function ActivityRow({ event, need }: { event: ActivityEvent; need?: NeedState }) {
  const line = lineOf(event, useSessionNames());
  return (
    <li className={`ev ${need?.open ? "ev-open" : need ? "ev-resolved" : ""}`} data-message-id={event.id}>
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
  const local = useChat((s) => s.hubs.some((h) => h.id === answered.hubId && h.local));
  const name = useWhoName({ who: answered.need.who, local });
  return (
    <div className="floor-need floor-answered" role="listitem">
      <span className="floor-item-what">
        <b>{name}</b> · {answered.need.ask}
      </span>
      <span className="small faint">Already answered</span>
    </div>
  );
}

/** What still needs you, on every hub, answered in place; focus left by a
 *  row that goes lands on the list. */
function OpenNeeds({ needs, now }: { needs: readonly FloorNeed[]; now: number }) {
  const answered = useFloor((s) => s.answered);
  const elsewhere = Object.keys(answered).length;
  return (
    <>
      <div className="activity-needs" role="list" aria-label="Still waiting on you" tabIndex={-1}>
        {needs.map((n) => (
          <div key={n.key} role="listitem">
            <NeedRow need={n} now={now} actions />
          </div>
        ))}
        {Object.entries(answered).map(([key, a]) => (
          <AnsweredRow key={key} answered={a} />
        ))}
      </div>
      <span className="sr-only" role="status">
        {elsewhere ? `${elsewhere} already answered elsewhere` : ""}
      </span>
    </>
  );
}

/** What happened on the crew, newest first, as it happens: everything, what
 *  still needs you, or what the overseer did. Where a hub has a floor, "Needs
 *  you" is what's still waiting on you on every hub, and everything shows it
 *  above what happened, each past request marked with what became of it.
 *  Closing it docks it as a tab. */
export function ActivityRail({
  managerName,
  onClose,
  closeRef,
}: {
  managerName: string | null;
  onClose: () => void;
  closeRef?: Ref<HTMLButtonElement>;
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const shown: ActivityFilter = filter === "manager" && !managerName ? "all" : filter;
  const feed = useOverview((s) => s.feeds[shown]);
  const loadActivity = useOverview((s) => s.loadActivity);
  const loadEarlier = useOverview((s) => s.loadEarlier);
  const floorOn = useLocalFloor();
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
  // What happened is read as its rows show; the newest row seen is the point.
  const scroller = useRef<HTMLDivElement>(null);
  const seenItems = useMemo(() => [...events].reverse().map((e) => ({ id: e.id, at: e.at })), [events]);
  useSeen(shown === "all" ? { kind: "activity" } : null, scroller, seenItems, { enabled: !useMainHidden() });
  const activity = useUnread((s) => s.local?.activity);
  const brief = useUnread((s) => s.local?.brief);
  const floorBadge = badgeOfFloor(needs, activity, brief);
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
            const day = dayName(e.at);
            const heading = day !== "Today" && day !== (i > 0 ? dayName(events[i - 1]!.at) : "Today");
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
        <div className="activity-title">
          <h2 id="activity-head" className="display">
            Activity
          </h2>
          <Marks badge={floorBadge} />
          <button ref={closeRef} type="button" className="icon-btn-sm" aria-label="Close Activity" title="Close (it waits on the right)" onClick={onClose}>
            <svg width="13" height="13" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>
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
        ref={scroller}
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
