import type { OverviewItem, OverviewState, Session, SessionState } from "../hub/types";
import { backgroundOf, shownState } from "../floor/background";
import { plain } from "../ui/plain";

/** What a session's live state says, in the overview's words. */
const FROM_LIVE: Record<SessionState, OverviewState> = {
  blocked: "needs_you",
  working: "working",
  starting: "working",
  done: "done",
  idle: "idle",
  interrupted: "stopped",
  stopped: "stopped",
  closed: "stopped",
};

const ACTIVE = new Set<OverviewState>(["needs_you", "working", "quiet"]);

/** An item's state now. The events socket tells Desk about a session before
 *  the overview is read again, so a session's live state wins where the two
 *  disagree about whether it's busy; the hub's word stands for the rest
 *  (quiet, done today). */
export const stateOf = (item: OverviewItem, live?: Session): OverviewState => {
  if (item.kind !== "session" || !live) return item.state;
  const now = FROM_LIVE[shownState(live)];
  if (now === "needs_you") return "needs_you";
  if (now === "working") return item.state === "quiet" ? "quiet" : "working";
  return ACTIVE.has(item.state) ? now : item.state;
};

/** A live session the overview doesn't list yet, as an item. */
export const itemOf = (s: Session): OverviewItem => ({
  kind: "session",
  id: s.id,
  name: s.name,
  engine: s.engine,
  origin: s.origin,
  state: FROM_LIVE[shownState(s)],
  task: s.goal || (s.lastPrompt ? plain(s.lastPrompt) : null),
  detail: s.currentTool ? `● ${s.currentTool}` : null,
  since: s.pending?.since ?? s.updatedAt,
  lastActivity: s.updatedAt,
  approval: s.pending ? { id: s.pending.id, summary: [s.pending.tool, s.pending.detail].filter(Boolean).join(" ") } : null,
  question: null,
  background: backgroundOf(s),
});

export interface Grouped {
  needsYou: OverviewItem[];
  working: OverviewItem[];
  done: OverviewItem[];
}

/** The overview's items in Floor's three groups, each item with its state
 *  now: needs you; working (quiet ones too); done today. Idle, stopped and
 *  failed ones aren't on the Floor (Activity and the sidebar have them). */
export const group = (items: readonly OverviewItem[], sessions: Record<string, Session>): Grouped => {
  const listed = new Set(items.filter((i) => i.kind === "session").map((i) => i.id));
  const extra = Object.values(sessions)
    .filter((s) => !listed.has(s.id) && ["blocked", "working", "starting"].includes(shownState(s)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(itemOf);
  const out: Grouped = { needsYou: [], working: [], done: [] };
  for (const item of [...items, ...extra]) {
    const state = stateOf(item, item.kind === "session" ? sessions[item.id] : undefined);
    const shown = state === item.state ? item : { ...item, state };
    if (state === "needs_you") out.needsYou.push(shown);
    else if (state === "working" || state === "quiet") out.working.push(shown);
    else if (state === "done") out.done.push(shown);
  }
  return out;
};
