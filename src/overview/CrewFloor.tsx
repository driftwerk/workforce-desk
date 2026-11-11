import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { BriefCard, PausedNote, RightNow, useMinute } from "../floor/RightNow";
import { PlanCards } from "../floor/PlanCards";
import { SpendCard } from "../spend/SpendCard";
import { AccountNeeds } from "../floor/AccountNeeds";
import { OverseerCard } from "../floor/OverseerCard";
import { FloorSection, SealedNotes, useSections } from "../floor/FloorSection";
import { handedOn, totals, type DeskItem } from "../floor/sections";
import { plain } from "../ui/plain";
import { NeedsJump } from "../floor/NeedsJump";
import { RestoreBanner } from "../floor/RestoreBanner";
import { GROUPS, Tile } from "../floor/SessionTile";
import { isAgentTurn } from "../floor/needs";
import { useLocalFloor, useMerged, useNeedCounts } from "../floor/store";
import { Today } from "../floor/Today";
import { agentItem, sessionItem, type ItemKey } from "../groups/model";
import { sortedSessions, useDesk, localSessions } from "../hub/store";
import type { Overview, OverviewItem, Session } from "../hub/types";
import { DockStrip, DockTab } from "../panels/DockTab";
import { useSavedScroll } from "../restore/scroll";
import { useUi } from "../shell/ui";
import { ActivityRail } from "./ActivityRail";
import { ItemTile } from "./ItemTile";
import { useLocalAgent } from "./people";
import { useOverview } from "./store";
import { groupOfKey, useFloorScope } from "../floor/scope";
import { useLayout } from "../groups/store";
import type { Section } from "../floor/sections";

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

/** What the Floor in sections leaves to its sections: they say what needs
 *  you, what's working and what's done, each in its group. */
const IN_SECTIONS = new Set(["Needs you", "Working", "Done today"]);

interface FloorGroup {
  title: string;
  agents: OverviewItem[];
  sessions: Session[];
}

/** Where the needs index puts it: in "Needs you" exactly when something of
 *  its waits on the person (the rail and the badges count the same), else
 *  where it would be were it not waiting. */
const NOT_WAITING: Partial<Record<OverviewItem["state"], OverviewItem["state"]>> = { needs_you: "idle" };

/** Every session Desk knows but the ones a hub ran an agent's turn as,
 *  grouped as the Floor always has, with the crew's agents beside them in
 *  the matching group. With `needs` (this computer's hub's
 *  floor), an item needs you iff it has an open need. */
export const floorGroups = (overview: Overview, all: Session[], needs: ReadonlyMap<ItemKey, number> | null = null, hubId: string | null = null): FloorGroup[] => {
  const groups = new Map<string, FloorGroup>(ORDER.map((title) => [title, { title, agents: [], sessions: [] }]));
  const sessionGroup = (s: Session): string | undefined => {
    if (!needs) return GROUPS.find((g) => g.match(s))?.title;
    if (needs.has(sessionItem(s.id))) return "Needs you";
    return GROUPS.find((g) => g.title !== "Needs you" && g.match(s))?.title ?? (s.state === "blocked" ? "Working" : s.state === "asking" ? "Recently done and idle" : undefined);
  };
  for (const s of all) {
    // An agent's turn is its agent's, on its tile; only one waiting on you
    // shows on its own.
    if (isAgentTurn(s) && !(needs ? needs.has(sessionItem(s.id)) : s.state === "blocked")) continue;
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

const LOOK: Record<string, DeskItem["look"]> = { "Needs you": "blocked", Working: "working", "Done today": "done" };

/** Desk's own Needs you, Working and Done today, as the Floor by group keeps
 *  them where no hub's floor has a turn for them. */
export const deskItems = (groups: readonly FloorGroup[], hubId: string | null): DeskItem[] =>
  groups.flatMap((g) => {
    const look = LOOK[g.title];
    if (!look) return [];
    return [
      ...g.sessions.map(
        (s): DeskItem => ({
          key: sessionItem(s.id),
          who: { kind: "session", id: s.id },
          name: s.name,
          engine: s.engine,
          text: s.goal || (s.lastPrompt ? plain(s.lastPrompt) : null),
          // Blocked with nothing on a hub's floor asking: said as it is.
          look: s.state === "blocked" || s.state === "asking" ? "blocked" : look,
        }),
      ),
      ...(hubId
        ? g.agents.map(
            (a): DeskItem => ({ key: agentItem({ hubId, id: a.id }), who: { kind: "agent", id: a.id }, name: a.name, engine: null, text: a.task ?? null, look: a.state === "needs_you" ? "blocked" : look }),
          )
        : []),
    ];
  });

/** What the Floor shows, worked out once for its header and its main
 *  column: Desk's groups of tiles, the sections (with a bossed group), and
 *  the counts. Under a pane showing one group's Floor (`FloorScope`), only
 *  that group's. */
export function useCrewFloor(overview: Overview) {
  const sessions = useDesk((s) => localSessions(s.sessions));
  const localId = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  const scope = useFloorScope();
  const layoutGroups = useLayout().groups;
  const onFloor = useLocalFloor();
  const merged = useMerged();
  const needs = useNeedCounts();
  // A session whose work went on in another is folded under that one's tile,
  // unless it waits on you: one left running that asks keeps its own.
  const folded = handedOn(merged);
  const waits = (s: Session) => needs.has(sessionItem(s.id)) || s.state === "blocked" || s.state === "asking";
  // One group's: its sessions and agents (of this computer) alone.
  const inScope = (key: ItemKey) => !scope || groupOfKey(layoutGroups, key) === scope;
  const all = floorGroups(
    scope ? { ...overview, items: overview.items.filter((i) => i.kind !== "agent" || (!!localId && inScope(agentItem({ hubId: localId, id: i.id })))) } : overview,
    sortedSessions(sessions).filter((s) => (!folded.has(s.id) || waits(s)) && inScope(sessionItem(s.id))),
    onFloor ? needs : null,
    localId,
  );
  // Desk's own lists, kept while they're the same, so the sections are.
  const deskKey = JSON.stringify(onFloor ? deskItems(all, localId) : null);
  const desk = useMemo(() => (JSON.parse(deskKey) as DeskItem[] | null) ?? undefined, [deskKey]);
  const sectioned = useSections(desk);
  const sections = onFloor && sectioned.kind === "sections" ? (scope ? sectionsOf(sectioned.sections, scope) : sectioned.sections) : null;
  const groups = sections ? all.filter((g) => !IN_SECTIONS.has(g.title)) : all;
  const count = (title: string) => {
    const g = all.find((x) => x.title === title);
    return (g?.agents.length ?? 0) + (g?.sessions.length ?? 0);
  };
  const counts = sections
    ? totals(sections)
    : onFloor
      ? merged.counts
      : { working: count("Working"), needsYou: count("Needs you"), doneToday: scope ? count("Done today") : overview.counts.doneToday };
  return { all, groups, sections, sectioned, counts, onFloor };
}

/** What `useCrewFloor` worked out: read once for a Floor's header and its
 *  column. */
export type CrewFloorRead = ReturnType<typeof useCrewFloor>;

/** The Floor's main column: what needs you and what's happening, the plans,
 *  Spend and Today, then the sections and Desk's own groups of tiles. The
 *  Floor view's, and a grid pane's (`scrollKey` null: its own scroll, not
 *  the Floor's kept one; one group's under `FloorScope`). */
export function FloorColumn({
  overview,
  read,
  scrollKey = "floor",
  className = "crew-floor-main",
}: {
  overview: Overview;
  read: CrewFloorRead;
  scrollKey?: string | null;
  className?: string;
}) {
  const manager = useOverview((s) => s.manager);
  const managerAgent = useLocalAgent(manager?.agentId);
  const managerName = manager?.agentId ? (managerAgent?.name ?? overview.brief?.by.name ?? manager.agentId) : null;
  const [paused, setPaused] = useState<{ id: string; name: string } | null>(null);
  const { groups, sections, sectioned, onFloor } = read;
  const now = useMinute();
  const scroller = useSavedScroll<HTMLDivElement>(scrollKey);
  const scope = useFloorScope();
  const brief =
    overview.brief && manager?.agentId ? (
      <BriefCard brief={overview.brief} managerId={manager.agentId} name={managerName ?? overview.brief.by.name} onPaused={setPaused} />
    ) : (
      paused && <PausedNote who={paused} onResumed={() => setPaused(null)} />
    );
  return (
    <div ref={scroller} className={className}>
      {sections && <NeedsJump sections={sections} />}
      <RestoreBanner />
      <AccountNeeds />
      {/* Who oversees everything is asked on the whole Floor only. */}
      {!scope && <OverseerCard />}
      {onFloor ? (
        <>
          {sectioned.kind === "flat" && <SealedNotes notes={scope ? sectioned.sealed.filter((n) => n.group.id === scope) : sectioned.sealed} />}
          {/* The overseer's brief is of everything: one group's Floor says its own. */}
          <RightNow brief={(!scope && brief) || null} needs={!sections} />
          <PlanCards />
          <SpendCard />
          <Today now={now} />
        </>
      ) : (
        !scope && brief
      )}
      {sections?.map((s) => (
        <FloorSection key={s.id} section={s} now={now} />
      ))}
      {!sections && groups.length === 0 && (
        <p className="empty muted">
          {scope
            ? "Nothing’s happening in this group right now."
            : "Nothing’s happening on the crew right now. Start a session, or message someone from Crew, and it shows here."}
        </p>
      )}
      {groups.map((g) => (
        <Group key={g.title} group={g} />
      ))}
    </div>
  );
}

/** One group's sections: its own (a bossed or sealed group's), or, for a
 *  group with no boss of its own, the main boss's, holding just its items. */
const sectionsOf = (sections: readonly Section[], group: string): Section[] =>
  sections
    .map((s) => ({ ...s, plans: s.plans.filter((p) => p.group === group), unbossed: s.unbossed.filter((g) => g.id === group) }))
    .filter((s) => s.group?.id === group || s.needs.length + s.working.length + s.done.length + s.desk.length + s.plans.length > 0);

/** The Floor as the crew's overview: the overseer's brief, then who needs
 *  you, who's working and what's done, beside what's happening. */
export function CrewFloor({ overview, onNewSession }: { overview: Overview; onNewSession: () => void }) {
  const activitySupport = useOverview((s) => s.activitySupport);
  const manager = useOverview((s) => s.manager);
  const managerAgent = useLocalAgent(manager?.agentId);
  const managerName = manager?.agentId ? (managerAgent?.name ?? overview.brief?.by.name ?? manager.agentId) : null;
  const read = useCrewFloor(overview);
  const { sections, counts } = read;
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
        <FloorColumn overview={overview} read={read} />
        {activitySupport !== "no" &&
          (activityOpen ? (
            <ActivityRail managerName={managerName} sections={sections} closeRef={railClose} onClose={() => showActivity(false)} />
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
