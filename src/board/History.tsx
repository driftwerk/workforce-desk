import { useEffect, useState } from "react";
import { deskListeners, useDesk } from "../hub/store";
import type { ActivityEvent, DeskEvent } from "../hub/types";
import { ActivityRow } from "../overview/ActivityRail";
import { plainError } from "../ui/plainError";

/** What a session or an agent did, and had done to it, newest first, as
 *  it happens; each row about a ticket carries its key (as Activity's do). */
export function SubjectHistory({ subject, label }: { subject: string; label: string }) {
  const hub = useDesk((s) => s.hub);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!hub) return;
    let live = true;
    hub
      .history(subject)
      .then((p) => {
        if (!live) return;
        setEvents(p.events);
        setMore(p.more);
      })
      .catch((e) => live && setProblem(plainError(e)));
    const listen = (e: DeskEvent) => {
      if (e.type !== "activity" || (e.event.actor.id !== subject && e.event.subject?.id !== subject)) return;
      setEvents((was) => (was && !was.some((x) => x.id === e.event.id) ? [e.event, ...was] : was));
    };
    deskListeners.add(listen);
    return () => {
      live = false;
      deskListeners.delete(listen);
    };
  }, [hub, subject]);
  const older = () => {
    const last = events?.at(-1);
    if (!hub || !last) return;
    hub
      .history(subject, last.id)
      .then((p) => {
        setEvents((was) => [...(was ?? []), ...p.events.filter((e) => !was?.some((w) => w.id === e.id))]);
        setMore(p.more);
      })
      .catch((e) => setProblem(plainError(e)));
  };
  return (
    <section className="subject-history" aria-label={label}>
      {problem ? (
        <p className="small state-blocked">{problem}</p>
      ) : events === null ? (
        <p className="faint small">Loading…</p>
      ) : events.length === 0 ? (
        <p className="faint small">Nothing yet.</p>
      ) : (
        <ol className="ev-list">
          {events.map((e) => (
            <ActivityRow key={e.id} event={e} />
          ))}
        </ol>
      )}
      {more && (
        <button type="button" className="link small" onClick={older}>
          Show older
        </button>
      )}
    </section>
  );
}
