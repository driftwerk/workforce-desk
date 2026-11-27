import { memo } from "react";
import { useSessionName } from "../groups/names";
import { backgroundLine, backgroundOf, bossHandles, failedLine, handledText, lookOf, restartedLine, shownState, STATE_WORDS, waitsLine, waitsOnYou } from "./background";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { Approval } from "../session/Approval";
import { Mark } from "../ui/Mark";
import { SessionTicketChip } from "../board/TicketChip";
import { plain } from "../ui/plain";
import { modelTitle } from "../engines/engines";

export interface Group {
  title: string;
  match: (s: Session) => boolean;
}

/** How sessions are grouped on the Floor, first match wins. */
export const GROUPS: Group[] = [
  { title: "Needs you", match: waitsOnYou },
  // What its boss deals with is shown working, calm: the boss is on it.
  { title: "Working", match: (s) => ["working", "starting"].includes(shownState(s)) || bossHandles(s) },
  { title: "Recently done and idle", match: (s) => ["done", "idle"].includes(shownState(s)) && s.live },
  { title: "In other terminals", match: (s) => s.origin === "external" && s.live === false && s.state !== "closed" },
  { title: "Not running", match: (s) => !s.live && s.origin === "desk" },
];

const home = (s: Session): string => (s.origin === "external" ? "other terminal" : "local");

const task = (s: Session): string => s.goal || (s.lastPrompt && plain(s.lastPrompt)) || "No goal yet";

/** How close two times are said as one. */
const ONE_TIME_MS = 60_000;

const log = (s: Session, now: number): string | null => {
  const said = restartedLine(s) ?? failedLine(s);
  if (said) return said;
  const background = backgroundOf(s);
  const waits = s.waits ? waitsLine(s.waits, now) : null;
  if (background) {
    const said = s.waits && Math.abs(Date.parse(s.waits.since) - Date.parse(background.since)) < ONE_TIME_MS ? s.waits.words : waits;
    return [backgroundLine(background, now), said].filter(Boolean).join(" · ");
  }
  if (s.currentTool) return [`● ${s.currentTool}`, waits].filter(Boolean).join(" · ");
  if (waits) return `● ${waits}`;
  return s.lastReply ? plain(s.lastReply).split("\n").slice(0, 3).join("\n") : null;
};

/** A session's tile; `now`, the minute it's drawn in, moves its times on. */
export const Tile = memo(function Tile({ session, now }: { session: Session; now: number }) {
  const open = useDesk((s) => s.open);
  const name = useSessionName(session.id, session.name);
  const text = log(session, now);
  const state = shownState(session);
  return (
    <article className={`tile tile-${lookOf(session)}`}>
      <span className="tile-flow" aria-hidden="true" />
      <button type="button" className="tile-open" onClick={() => open(session.id)}>
        <Mark name={name} engine={session.engine} state={lookOf(session)} size="lg" />
        <span className="tile-name">
          <span className="mono tile-title">{name}</span>
          <span className={`tile-state state-${bossHandles(session) ? "handled" : state}`}>
            {bossHandles(session) ? handledText(session) : STATE_WORDS[state]} · {home(session)}
            {session.model ? ` · ${modelTitle(session.engine, session.model)}` : ""}
          </span>
        </span>
      </button>
      <span className="tile-task">
        <SessionTicketChip session={session.id} className="tile-ticket" />
        {task(session)}
      </span>
      {text && <pre className="tile-log">{text}</pre>}
      {session.pending && <Approval session={session} compact />}
    </article>
  );
});
