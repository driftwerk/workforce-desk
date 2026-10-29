import { RichMarkdown } from "@workforce/rich";
import { useState } from "react";
import { useAgentConfigs } from "../crew/agentBrain";
import { setAgentOversight } from "../crew/oversight";
import { sortedSessions, useDesk } from "../hub/store";
import type { Brief, Overview, OverviewItem, Session } from "../hub/types";
import { RestoreBanner } from "../floor/RestoreBanner";
import { GROUPS, Tile } from "../floor/SessionTile";
import { Mark } from "../ui/Mark";
import { plainError } from "../ui/plainError";
import { ActivityRail } from "./ActivityRail";
import { ItemTile } from "./ItemTile";
import { clock } from "./overview";
import { localKey, openLocalDm, useLocalAgent } from "./people";
import { useOverview } from "./store";
import { useSavedScroll } from "../restore/scroll";

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

/** Every session Desk knows, grouped as the Floor always has, with the crew's
 *  agents beside them in the matching group. */
export const floorGroups = (overview: Overview, all: Session[]): FloorGroup[] => {
  const groups = new Map<string, FloorGroup>(ORDER.map((title) => [title, { title, agents: [], sessions: [] }]));
  const seen = new Set<string>();
  for (const g of GROUPS) {
    for (const s of all) {
      if (seen.has(s.id) || !g.match(s)) continue;
      seen.add(s.id);
      groups.get(g.title)?.sessions.push(s);
    }
  }
  for (const item of overview.items) {
    if (item.kind === "agent") groups.get(AGENT_GROUP[item.state] ?? "Recently done and idle")?.agents.push(item);
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
  const groups = floorGroups(overview, sortedSessions(sessions));
  const count = (title: string) => {
    const g = groups.find((x) => x.title === title);
    return (g?.agents.length ?? 0) + (g?.sessions.length ?? 0);
  };
  const working = count("Working");
  const needsYou = count("Needs you");
  const scroller = useSavedScroll<HTMLDivElement>("floor");

  return (
    <main className="crew-floor" aria-label="Floor">
      <header className="crew-floor-head">
        <h1 className="display">Floor</h1>
        <span className="crew-floor-counts">
          {working} working ·{" "}
          <span className={needsYou ? "state-blocked strong" : undefined}>
            {needsYou} need{needsYou === 1 ? "s" : ""} you
          </span>{" "}
          · {overview.counts.doneToday} done today
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
          {overview.brief && manager?.agentId ? (
            <BriefCard brief={overview.brief} managerId={manager.agentId} name={managerName ?? overview.brief.by.name} onPaused={setPaused} />
          ) : (
            paused && <PausedNote who={paused} onResumed={() => setPaused(null)} />
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
        {activitySupport !== "no" && <ActivityRail managerName={managerName} />}
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
function BriefCard({
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
    <section className="brief" aria-label={`${name}’s brief`}>
      <Mark name={name} />
      <div className="brief-body">
        <span className="brief-head">
          <b>{name}</b>
          <span className="faint small">overseeing your crew · updated {clock(brief.at)}</span>
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
          {problem && <span className="small state-blocked">{problem}</span>}
        </div>
      </div>
    </section>
  );
}

function PausedNote({ who, onResumed }: { who: { id: string; name: string }; onResumed: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="brief brief-paused" aria-label="Oversight paused">
      <span className="brief-text">
        {who.name} has stopped overseeing the crew. Turn it back on here or in {who.name}’s Settings.
      </span>
      <button
        type="button"
        className="btn"
        onClick={() =>
          setOverseeing(who.id, true).then(onResumed, (e: unknown) => setProblem(plainError(e)))
        }
      >
        Turn back on
      </button>
      {problem && <span className="small state-blocked">{problem}</span>}
    </section>
  );
}
