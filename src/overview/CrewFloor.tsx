import { RichMarkdown } from "@workforce/rich";
import { useState } from "react";
import { useAgentConfigs } from "../crew/agentBrain";
import { setAgentOversight } from "../crew/oversight";
import { useDesk } from "../hub/store";
import type { Brief, Overview } from "../hub/types";
import { RestoreBanner } from "../floor/RestoreBanner";
import { Mark } from "../ui/Mark";
import { plainError } from "../ui/plainError";
import { ActivityRail } from "./ActivityRail";
import { ItemTile } from "./ItemTile";
import { clock, group } from "./overview";
import { localKey, openLocalDm, useLocalAgent } from "./people";
import { useOverview } from "./store";

/** The Floor as the crew's overview: the overseer's brief, then who needs
 *  you, who's working and what's done today, beside what's happening. */
export function CrewFloor({ overview, onNewSession }: { overview: Overview; onNewSession: () => void }) {
  const sessions = useDesk((s) => s.sessions);
  const activitySupport = useOverview((s) => s.activitySupport);
  const manager = useOverview((s) => s.manager);
  const managerAgent = useLocalAgent(manager?.agentId);
  const managerName = manager?.agentId ? (managerAgent?.name ?? overview.brief?.by.name ?? manager.agentId) : null;
  const [paused, setPaused] = useState<{ id: string; name: string } | null>(null);
  const g = group(overview.items, sessions);
  const nothing = g.needsYou.length + g.working.length + g.done.length === 0;

  return (
    <main className="crew-floor" aria-label="Floor">
      <header className="crew-floor-head">
        <h1 className="display">Floor</h1>
        <span className="crew-floor-counts">
          {g.working.length} working ·{" "}
          <span className={g.needsYou.length ? "state-blocked strong" : undefined}>
            {g.needsYou.length} need{g.needsYou.length === 1 ? "s" : ""} you
          </span>{" "}
          · {g.done.length} done today
        </span>
        <button type="button" className="btn btn-signal" onClick={onNewSession}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M7 2v10M2 7h10" />
          </svg>
          New session
        </button>
      </header>
      <div className="crew-floor-body">
        <div className="crew-floor-main">
          <RestoreBanner />
          {overview.brief && manager?.agentId ? (
            <BriefCard brief={overview.brief} managerId={manager.agentId} name={managerName ?? overview.brief.by.name} onPaused={setPaused} />
          ) : (
            paused && <PausedNote who={paused} onResumed={() => setPaused(null)} />
          )}
          {nothing && (
            <p className="empty muted">
              Nothing’s happening on the crew right now. Start a session, or message someone from Crew, and it shows here.
            </p>
          )}
          <Group title="Needs you" tone="blocked" items={g.needsYou} wide />
          <Group title="Working" tone="working" items={g.working} />
          <Group title="Done today" tone="done" items={g.done} />
        </div>
        {activitySupport !== "no" && <ActivityRail managerName={managerName} />}
      </div>
    </main>
  );
}

function Group({ title, tone, items, wide = false }: { title: string; tone: string; items: Overview["items"]; wide?: boolean }) {
  if (!items.length) return null;
  return (
    <section className="floor-group" aria-label={title}>
      <h2 className={`ov-label state-${tone}`}>{title}</h2>
      <div className={wide ? "ov-tiles ov-tiles-wide" : "ov-tiles"}>
        {items.map((i) => (
          <ItemTile key={`${i.kind}:${i.id}`} item={i} />
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
