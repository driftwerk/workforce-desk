// The Dashboard: what the main area shows from the sidebar's first row. It
// is a list of sections, each a widget with its own heading; for now the
// Floor is the only one. A widget is added by adding it to `SECTIONS`.

import { useId, type ComponentType, type ReactNode } from "react";
import { Floor } from "../floor/Floor";
import { useNeeds } from "../floor/store";
import { useMinute } from "../floor/RightNow";
import { localSessions, useDesk } from "../hub/store";
import { needsYou } from "../ui/Badge";

/** What a section's widget is given: its heading, for it to put at the
 *  head of its own header (beside its counts and actions), and what the
 *  Dashboard was handed. */
export interface WidgetProps {
  heading: ReactNode;
  onNewSession: () => void;
}

export interface DashboardSection {
  id: string;
  title: string;
  Widget: ComponentType<WidgetProps>;
}

/** The Dashboard's sections, in order. */
export const SECTIONS: readonly DashboardSection[] = [{ id: "floor", title: "Floor", Widget: ({ heading, onNewSession }) => <Floor heading={heading} onNewSession={onNewSession} /> }];

/** "Friday afternoon", for the moment `now`. */
export const dayPart = (now: number): string => {
  const d = new Date(now);
  const h = d.getHours();
  const part = h < 5 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return `${d.toLocaleDateString("en-GB", { weekday: "long" })} ${part}`;
};

/** "7 sessions working, 2 need you": what the Dashboard's line says. */
export const dashboardLine = (working: number, needs: number): string =>
  [working ? `${working} ${working === 1 ? "session" : "sessions"} working` : "nothing working", needs ? needsYou(needs) : ""].filter(Boolean).join(", ");

/** The Dashboard's line under its title: the time of day, what works and
 *  what waits on you. Read on its own, so the sections don't draw again
 *  for it. */
function Summary() {
  const now = useMinute();
  const working = useDesk((s) => Object.values(localSessions(s.sessions)).filter((x) => x.state === "working" || x.state === "starting").length);
  const needs = useNeeds().length;
  return (
    <p className="muted dash-line">
      {dayPart(now)} · {dashboardLine(working, needs)}
    </p>
  );
}

function Section({ section, onNewSession }: { section: DashboardSection; onNewSession: () => void }) {
  const titleId = useId();
  const { Widget } = section;
  return (
    <section className="dash-section" aria-labelledby={titleId} data-section={section.id}>
      <Widget
        onNewSession={onNewSession}
        heading={
          <h2 id={titleId} className="display-md dash-section-title">
            {section.title}
          </h2>
        }
      />
    </section>
  );
}

export function Dashboard({ onNewSession }: { onNewSession: () => void }) {
  return (
    <main className="dashboard" aria-label="Dashboard">
      <header className="dash-head">
        <div className="dash-title">
          <h1 className="display-lg">Dashboard</h1>
          <Summary />
        </div>
        <button type="button" className="btn btn-ghost dash-add" disabled title="Widgets are coming soon">
          + Add a widget · soon
        </button>
      </header>
      {SECTIONS.map((s) => (
        <Section key={s.id} section={s} onNewSession={onNewSession} />
      ))}
    </main>
  );
}
