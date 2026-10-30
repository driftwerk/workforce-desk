import { RichMarkdown } from "@workforce/rich";
import { useEffect, useState, type ReactNode } from "react";
import { useAgentConfigs } from "../crew/agentBrain";
import { setAgentOversight } from "../crew/oversight";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Brief } from "../hub/types";
import { localKey, openLocalDm } from "../overview/people";
import { useOverview } from "../overview/store";
import { openTarget } from "../shell/navigate";
import { AgentMark } from "../ui/Mark";
import { plainError } from "../ui/plainError";
import { backgroundLine } from "./background";
import type { FloorWork } from "./merge";
import { NeedRow } from "./NeedRow";
import { FloorRow } from "./Row";
import { useFloor, useMerged } from "./store";
import { sentence } from "./summary";
import { targetOf } from "./target";
import { clock, dayClock, durationOf, since } from "./time";

/** The clock the floor's times are said against, moving every minute. */
export const useMinute = (): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

/** When the floor was last read, from whichever hub answered last. */
const useReadAt = (): string | null =>
  useFloor((s) =>
    Object.values(s.hubs)
      .map((h) => h.at)
      .reduce<string | null>((latest, at) => (at && (!latest || at > latest) ? at : latest), null),
  );

/** What needs the person, what's running and what's done, with the
 *  overseer's brief (or, without one, Desk's own line) above. */
export function RightNow({ brief }: { brief: ReactNode | null }) {
  const m = useMerged();
  const now = useMinute();
  const day = useFloor((s) => s.day);
  const names = useSessionNames();
  const readAt = useReadAt();
  return (
    <section className="floor-card right-now" aria-label="Right now">
      <div className="floor-card-head">
        <h2 className="display floor-card-title">Right now</h2>
        {!brief && readAt && <span className="floor-time">summary by Desk · {clock(readAt)}</span>}
      </div>
      {brief ?? <p className="right-now-summary">{sentence(m, day, names)}</p>}
      <div className="right-now-cols">
        <Column
          label={`Needs you · ${m.needs.length}`}
          tone="blocked"
          empty="Nothing is waiting on you."
          rows={m.needs.map((n) => (
            <NeedRow key={n.key} need={n} now={now} />
          ))}
        />
        <Column
          label={`Working · ${m.working.length}`}
          tone="working"
          empty="Nothing is running."
          rows={m.working.map((w) => (
            <WorkRow key={w.key} work={w} now={now} />
          ))}
        />
        <Column
          label="Done · last 24 hours"
          tone="done"
          empty="Nothing has finished since yesterday."
          rows={m.done.map((w) => (
            <WorkRow key={w.key} work={w} now={now} />
          ))}
          more={m.more.done}
        />
      </div>
    </section>
  );
}

function Column({ label, tone, empty, rows, more = 0 }: { label: string; tone: string; empty: string; rows: ReactNode[]; more?: number }) {
  return (
    <div className="right-now-col" role="group" aria-label={label}>
      <h3 className={`ov-label state-${tone}`}>{label}</h3>
      {rows.length ? rows : <p className="faint small">{empty}</p>}
      {more > 0 && <p className="faint small">and {more} more</p>}
    </div>
  );
}

/** A turn running ("38m · 1m ago": running for, last heard) or done
 *  ("16:20 · 48m": when it ended, how long it took). */
function WorkRow({ work, now }: { work: FloorWork; now: number }) {
  const rooms = useDesk((s) => s.rooms);
  const target = targetOf(work, rooms);
  const open = target ? () => openTarget(target) : undefined;
  if (work.endedAt === null) {
    const heard = since(work.heardAt, now);
    return (
      <FloorRow
        item={work}
        look={work.background ? "background" : "working"}
        time={[durationOf(work.since, now), heard === "just now" ? heard : `${heard} ago`].join(" · ")}
        onOpen={open}
      >
        {work.background ? backgroundLine(work.background, now) : work.what}
      </FloorRow>
    );
  }
  return (
    <FloorRow
      item={work}
      look={work.outcome === "finished" ? "done" : "failed"}
      time={`${dayClock(work.endedAt, now)} · ${durationOf(work.since, work.endedAt)}`}
      onOpen={open}
    >
      {work.what}
    </FloorRow>
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
export function BriefCard({
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
      <AgentMark agent={localKey(managerId) ?? ""} name={name} />
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
          {problem && (
            <span className="small state-blocked" role="alert">
              {problem}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

export function PausedNote({ who, onResumed }: { who: { id: string; name: string }; onResumed: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="brief brief-paused" aria-label="Oversight paused">
      <span className="brief-text">
        {who.name} has stopped overseeing the crew. Turn it back on here or in {who.name}’s Settings.
      </span>
      <button type="button" className="btn" onClick={() => setOverseeing(who.id, true).then(onResumed, (e: unknown) => setProblem(plainError(e)))}>
        Turn back on
      </button>
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </section>
  );
}
