import { useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { BriefCard, PausedNote, RightNow, useMinute } from "../floor/RightNow";
import { PlanCards } from "../floor/PlanCards";
import { RestoreBanner } from "../floor/RestoreBanner";
import { GROUPS, Tile } from "../floor/SessionTile";
import { useLocalFloor, useMerged, useNeedCounts } from "../floor/store";
import { Today } from "../floor/Today";
import { agentItem, sessionItem, type ItemKey } from "../groups/model";
import { sortedSessions, useDesk } from "../hub/store";
import type { Overview, OverviewItem, Session } from "../hub/types";
import { DockStrip, DockTab } from "../panels/DockTab";
import { useSavedScroll } from "../restore/scroll";
import { useUi } from "../shell/ui";
import { ActivityRail } from "./ActivityRail";
import { ItemTile } from "./ItemTile";
import { useLocalAgent } from "./people";
import { useOverview } from "./store";

/** Where an agent goes on the Floor, by what the overview says it's doing. */
const AGENT_GROUP: Record<OverviewItem["state"], string> = {
  needs_you: "Needs you",
  working: "Working",
  quiet: "Working",
  done: "Done today",
  idle: "Recently done and idle",
  failed: "Recently done and idle",
  stopped: "Recently done and idle",
};

const ORDER = ["Needs you", "Working", "Done today", "Recently done and idle", "In other terminals", "Not running"];

interface FloorGroup {
  title: string;
  agents: OverviewItem[];
  sessions: Session[];
}

/** Where the needs index puts it: in "Needs you" exactly when something of
 *  its waits on the person (the rail and the badges count the same), else
 *  where it would be were it not waiting. */
const NOT_WAITING: Partial<Record<OverviewItem["state"], OverviewItem["state"]>> = { needs_you: "idle" };

/** Every session Desk knows, grouped as the Floor always has, with the crew's
 *  agents beside them in the matching group. With `needs` (this computer's hub's
 *  floor), an item needs you iff it has an open need. */
export const floorGroups = (overview: Overview, all: Session[], needs: ReadonlyMap<ItemKey, number> | null = null, hubId: string | null = null): FloorGroup[] => {
  const groups = new Map<string, FloorGroup>(ORDER.map((title) => [title, { title, agents: [], sessions: [] }]));
  const sessionGroup = (s: Session): string | undefined => {
    if (!needs) return GROUPS.find((g) => g.match(s))?.title;
    if (needs.has(sessionItem(s.id))) return "Needs you";
    return GROUPS.find((g) => g.title !== "Needs you" && g.match(s))?.title ?? (s.state === "blocked" ? "Working" : undefined);
  };
  for (const s of all) {
    const title = sessionGroup(s);
    if (title) groups.get(title)?.sessions.push(s);
  }
  const agentState = (item: OverviewItem): OverviewItem["state"] =>
    !needs || !hubId ? item.state : needs.has(agentItem({ hubId, id: item.id })) ? "needs_you" : (NOT_WAITING[item.state] ?? item.state);
  for (const item of overview.items) {
    if (item.kind === "agent") groups.get(AGENT_GROUP[agentState(item)] ?? "Recently done and idle")?.agents.push(item);
  }
  return [...groups.values()].filter((g) => g.agents.length + g.sessions.length > 0);
};

/** The Floor as the crew's overview: the overseer's brief, then who needs
 *  you, who's working and what's done, beside what's happening. */
export function CrewFloor({ overview, onNewSession }: { overview: Overview; onNewSession: () => void }) {
  const sessions = useDesk((s) => s.sessions);
  const activitySupport = useOverview((s) => s.activitySupport);
  const manager = useOverview((s) => s.manager);
  const managerAgent = useLocalAgent(manager?.agentId);
  const managerName = manager?.agentId ? (managerAgent?.name ?? overview.brief?.by.name ?? manager.agentId) : null;
  const [paused, setPaused] = useState<{ id: string; name: string } | null>(null);
  const localId = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  const onFloor = useLocalFloor();
  const merged = useMerged();
  const needs = useNeedCounts();
  const now = useMinute();
  const groups = floorGroups(overview, sortedSessions(sessions), onFloor ? needs : null, localId);
  const count = (title: string) => {
    const g = groups.find((x) => x.title === title);
    return (g?.agents.length ?? 0) + (g?.sessions.length ?? 0);
  };
  const counts = onFloor ? merged.counts : { working: count("Working"), needsYou: count("Needs you"), doneToday: overview.counts.doneToday };
  const scroller = useSavedScroll<HTMLDivElement>("floor");
  const brief =
    overview.brief && manager?.agentId ? (
      <BriefCard brief={overview.brief} managerId={manager.agentId} name={managerName ?? overview.brief.by.name} onPaused={setPaused} />
    ) : (
      paused && <PausedNote who={paused} onResumed={() => setPaused(null)} />
    );
  const activityOpen = useUi((s) => s.activityOpen);
  const tab = useRef<HTMLButtonElement>(null);
  const railClose = useRef<HTMLButtonElement>(null);
  /** Where focus goes once Activity has opened or docked, when a key or
   *  click here did it. */
  const handOff = useRef(false);
  useEffect(() => {
    if (!handOff.current) return;
    handOff.current = false;
    (activityOpen ? railClose : tab).current?.focus();
  }, [activityOpen]);
  const showActivity = (open: boolean) => {
    handOff.current = true;
    useUi.getState().setActivityOpen(open);
  };

  return (
    <main className="crew-floor" aria-label="Floor">
      <header className="crew-floor-head">
        <h1 className="display">Floor</h1>
        <span className="crew-floor-counts">
          {counts.working} working ·{" "}
          <span className={counts.needsYou ? "state-blocked strong" : undefined}>
            {counts.needsYou} need{counts.needsYou === 1 ? "s" : ""} you
          </span>{" "}
          · {counts.doneToday} done today
        </span>
        <button type="button" className="btn btn-signal" onClick={onNewSession}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M7 2v10M2 7h10" />
          </svg>
          New session
        </button>
      </header>
      <div className="crew-floor-body">
        <div ref={scroller} className="crew-floor-main">
          <RestoreBanner />
          {onFloor ? (
            <>
              <RightNow brief={brief || null} />
              <PlanCards />
              <Today now={now} />
            </>
          ) : (
            brief
          )}
          {groups.length === 0 && (
            <p className="empty muted">
              Nothing’s happening on the crew right now. Start a session, or message someone from Crew, and it shows here.
            </p>
          )}
          {groups.map((g) => (
            <Group key={g.title} group={g} />
          ))}
        </div>
        {activitySupport !== "no" &&
          (activityOpen ? (
            <ActivityRail managerName={managerName} closeRef={railClose} onClose={() => showActivity(false)} />
          ) : (
            <DockStrip label="Docked">
              <DockTab
                buttonRef={tab}
                label="Activity"
                count={counts.needsYou}
                ariaLabel={
                  counts.needsYou ? `Open Activity, ${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you` : "Open Activity"
                }
                title="Open Activity"
                onClick={() => showActivity(true)}
              />
            </DockStrip>
          ))}
      </div>
    </main>
  );
}

const TONE: Record<string, string> = { "Needs you": "blocked", Working: "working", "Done today": "done" };

function Group({ group }: { group: FloorGroup }) {
  const tone = TONE[group.title] ?? "idle";
  return (
    <section className="floor-group" aria-label={group.title}>
      <h2 className={`ov-label state-${tone}`}>{group.title}</h2>
      <div className={group.title === "Needs you" ? "ov-tiles ov-tiles-wide" : "ov-tiles"}>
        {group.agents.map((i) => (
          <ItemTile key={`agent:${i.id}`} item={i} />
        ))}
        {group.sessions.map((s) => (
          <Tile key={s.id} session={s} />
        ))}
      </div>
    </section>
  );
}
