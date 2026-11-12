import { useEffect } from "react";
import { LocalSetupCard } from "../setup/LocalSetupCard";
import { SetupFloor } from "../setup/slot";
import { sortedSessions, useDesk, localSessions } from "../hub/store";
import type { Session } from "../hub/types";
import { CrewFloor } from "../overview/CrewFloor";
import { useOverview } from "../overview/store";
import { waitsOnYou } from "./background";
import { TICK_MS, tickFloor } from "./store";
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
 *  40 min" and "6 min" stay true between events; and the overview, the
 *  overseer and the activity asked again of a hub that had none, as a hub
 *  starting up answers 404 for a moment. */
const REFRESH_MS = 60_000;

/** The one reading of what the Floor shows, however many show it (the
 *  Floor view, and each grid pane of the Floor), for one hub. */
let shared: { hub: object | null; readers: number; stop: () => void } | null = null;

/** Reads the overview and the overseer now and every minute, and the floor
 *  every minute, until the last reader leaves. */
const startReads = (hub: object | null): (() => void) => {
  const tick = setInterval(tickFloor, TICK_MS);
  if (!hub) return () => clearInterval(tick);
  const { loadOverview, loadManager } = useOverview.getState();
  void loadOverview();
  void loadManager();
  const t = setInterval(() => {
    const s = useOverview.getState();
    void s.loadOverview();
    if (s.managerSupport === "no") void s.loadManager();
    if (s.activitySupport === "no") void s.loadActivity("all");
  }, REFRESH_MS);
  return () => {
    clearInterval(t);
    clearInterval(tick);
  };
};

const joinReads = (hub: object | null): (() => void) => {
  if (shared?.hub === hub) shared.readers += 1;
  else {
    shared?.stop();
    shared = { hub, readers: 1, stop: startReads(hub) };
  }
  const mine = shared;
  return () => {
    if (shared !== mine) return;
    mine.readers -= 1;
    if (mine.readers > 0) return;
    mine.stop();
    shared = null;
  };
};

/** Keeps what the Floor shows read while it's shown (in the Floor view, or
 *  a grid's pane): the overview and the overseer, again every minute, and
 *  the floor of the hubs whose links don't keep it. However many show it,
 *  it's read once. */
export function useFloorReads(): void {
  const hub = useDesk((s) => s.hub);
  useEffect(() => joinReads(hub), [hub]);
}

/** The crew's overview where the hub has one; the sessions as they were
 *  shown before, where it doesn't (or until it answers). */
export function Floor({ onNewSession }: { onNewSession: () => void }) {
  const overview = useOverview((s) => s.overview);
  useFloorReads();
  return overview ? <CrewFloor overview={overview} onNewSession={onNewSession} /> : <SessionsFloor />;
}

/** Today's sessions, grouped by what they're doing. */
export function SessionsFloor() {
  const sessions = sortedSessions(useDesk((s) => localSessions(s.sessions)));
  const blocked = sessions.filter(waitsOnYou).length;
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
      <SetupFloor />
      <LocalSetupCard />
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
