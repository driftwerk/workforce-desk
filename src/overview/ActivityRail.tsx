import { useEffect, useState } from "react";
import type { ActivityEvent, ActivityFilter } from "../hub/types";
import { radioKeys } from "../ui/Dialog";
import { lineOf, toneOf } from "./activity";
import { clock } from "./overview";
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

export function ActivityRow({ event }: { event: ActivityEvent }) {
  const line = lineOf(event);
  return (
    <li className="ev">
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
      </span>
    </li>
  );
}

const EMPTY: Record<ActivityFilter, string> = {
  all: "Nothing has happened yet. What the crew does shows here as it happens.",
  needs_you: "Nothing is waiting on you.",
  manager: "Nothing done on its own yet.",
};

/** What happened on the crew, newest first, as it happens: everything, what
 *  needed you, or what the overseer did. */
export function ActivityRail({ managerName }: { managerName: string | null }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const feed = useOverview((s) => s.feeds[filter]);
  const { loadActivity, loadEarlier } = useOverview();
  const shown: ActivityFilter = filter === "manager" && !managerName ? "all" : filter;

  useEffect(() => {
    if (!useOverview.getState().feeds[shown]) void loadActivity(shown);
  }, [shown, loadActivity]);

  const options: { id: ActivityFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "needs_you", label: "Needs you" },
    ...(managerName ? [{ id: "manager" as const, label: `${managerName}’s actions` }] : []),
  ];
  const current = options.findIndex((o) => o.id === shown);
  const events = feed?.events ?? [];
  const earlier = () => void loadEarlier(shown);

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
            </button>
          ))}
        </div>
      </div>
      <div
        className="activity-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 120 && feed?.more && feed.earlier === "idle") earlier();
        }}
      >
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
                <ActivityRow key={e.id} event={e} />,
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
      </div>
    </aside>
  );
}
