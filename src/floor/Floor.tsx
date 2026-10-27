import { sortedSessions, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { Approval } from "../session/Approval";
import { Mark } from "../ui/Mark";
import { plain } from "../ui/plain";
import { RestoreBanner } from "./RestoreBanner";

const LABEL: Record<Session["state"], string> = {
  starting: "starting",
  working: "working",
  blocked: "needs you",
  done: "done",
  idle: "idle",
  interrupted: "interrupted",
  stopped: "stopped",
  closed: "closed",
};

interface Group {
  title: string;
  match: (s: Session) => boolean;
}

const GROUPS: Group[] = [
  { title: "Needs you", match: (s) => s.state === "blocked" },
  { title: "Working", match: (s) => s.state === "working" || s.state === "starting" },
  { title: "Recently done and idle", match: (s) => (s.state === "done" || s.state === "idle") && s.live },
  { title: "In other terminals", match: (s) => s.origin === "external" && s.live === false && s.state !== "closed" },
  { title: "Not running", match: (s) => !s.live && s.origin === "desk" },
];

const home = (s: Session): string => (s.origin === "external" ? "other terminal" : "local");

const task = (s: Session): string => s.goal || (s.lastPrompt && plain(s.lastPrompt)) || "No goal yet";

const log = (s: Session): string | null =>
  s.currentTool ? `● ${s.currentTool}` : s.lastReply ? plain(s.lastReply).split("\n").slice(0, 3).join("\n") : null;

export function Tile({ session }: { session: Session }) {
  const open = useDesk((s) => s.open);
  const text = log(session);
  return (
    <article className={`tile tile-${session.state}`}>
      <button type="button" className="tile-open" onClick={() => open(session.id)}>
        <Mark name={session.name} engine={session.engine} state={session.state} size="lg" />
        <span className="tile-name">
          <span className="mono tile-title">{session.name}</span>
          <span className={`tile-state state-${session.state}`}>
            {LABEL[session.state]} · {home(session)}
          </span>
        </span>
      </button>
      <span className="tile-task">{task(session)}</span>
      {text && <pre className="tile-log">{text}</pre>}
      {session.pending && <Approval session={session} compact />}
    </article>
  );
}

const summary = (sessions: Session[]): string => {
  const n = (f: (s: Session) => boolean) => sessions.filter(f).length;
  return [
    `${n((s) => s.state === "working" || s.state === "starting")} working`,
    `${n((s) => s.state === "idle" || s.state === "done")} idle`,
  ].join(", ");
};

export function Floor() {
  const sessions = sortedSessions(useDesk((s) => s.sessions));
  const blocked = sessions.filter((s) => s.state === "blocked").length;
  const seen = new Set<string>();
  const groups = GROUPS.map((g) => {
    const tiles = sessions.filter((s) => !seen.has(s.id) && g.match(s));
    tiles.forEach((s) => seen.add(s.id));
    return { ...g, tiles };
  }).filter((g) => g.tiles.length);
  return (
    <main className="floor" aria-label="Floor">
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
