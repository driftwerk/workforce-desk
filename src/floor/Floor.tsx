import { useEffect } from "react";
import { sortedSessions, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { CrewFloor } from "../overview/CrewFloor";
import { useOverview } from "../overview/store";
import { RestoreBanner } from "./RestoreBanner";
import { GROUPS, Tile } from "./SessionTile";
import { useSavedScroll } from "../restore/scroll";

export { Tile } from "./SessionTile";

const summary = (sessions: Session[]): string => {
  const n = (f: (s: Session) => boolean) => sessions.filter(f).length;
  return [
    `${n((s) => s.state === "working" || s.state === "starting")} working`,
    `${n((s) => s.state === "idle" || s.state === "done")} idle`,
  ].join(", ");
};

/** How often the overview is read again while it's shown, so "quiet for
 *  40 min" and "6 min" stay true between events. */
const REFRESH_MS = 60_000;

/** The crew's overview where the hub has one; the sessions as they were
 *  shown before, where it doesn't (or until it answers). */
export function Floor({ onNewSession }: { onNewSession: () => void }) {
  const hub = useDesk((s) => s.hub);
  const overview = useOverview((s) => s.overview);
  useEffect(() => {
    if (!hub) return;
    const { loadOverview, loadManager } = useOverview.getState();
    void loadOverview();
    void loadManager();
    const t = setInterval(() => {
      if (useOverview.getState().overviewSupport !== "no") void useOverview.getState().loadOverview();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [hub]);
  return overview ? <CrewFloor overview={overview} onNewSession={onNewSession} /> : <SessionsFloor />;
}

/** Today's sessions, grouped by what they're doing. */
export function SessionsFloor() {
  const sessions = sortedSessions(useDesk((s) => s.sessions));
  const blocked = sessions.filter((s) => s.state === "blocked").length;
  const seen = new Set<string>();
  const groups = GROUPS.map((g) => {
    const tiles = sessions.filter((s) => !seen.has(s.id) && g.match(s));
    tiles.forEach((s) => seen.add(s.id));
    return { ...g, tiles };
  }).filter((g) => g.tiles.length);
  const scroller = useSavedScroll<HTMLElement>("floor");
  return (
    <main ref={scroller} className="floor" aria-label="Floor">
      <header className="floor-head">
        <h1 className="display-xl">Floor</h1>
        <span className="floor-summary">
          {summary(sessions)}
          {blocked > 0 && <span className="state-blocked strong">, {blocked} needs you</span>}
        </span>
      </header>
      <RestoreBanner />
      {groups.length === 0 ? (
        <p className="empty muted">No sessions yet. Start one with “New session”, or open Claude Code in any terminal and it appears here.</p>
      ) : (
        groups.map((g) => (
          <section key={g.title} className="floor-group">
            <h2>{g.title}</h2>
            <div className="tiles">
              {g.tiles.map((s) => (
                <Tile key={s.id} session={s} />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
