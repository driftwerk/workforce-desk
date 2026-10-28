import type { OverviewItem, OverviewState, Session, SessionState } from "../hub/types";
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
  const now = FROM_LIVE[live.state];
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
  state: FROM_LIVE[s.state],
  task: s.goal || (s.lastPrompt ? plain(s.lastPrompt) : null),
  detail: s.currentTool ? `● ${s.currentTool}` : null,
  since: s.pending?.since ?? s.updatedAt,
  lastActivity: s.updatedAt,
  approval: s.pending ? { id: s.pending.id, summary: [s.pending.tool, s.pending.detail].filter(Boolean).join(" ") } : null,
  question: null,
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
    .filter((s) => !listed.has(s.id) && ["blocked", "working", "starting"].includes(s.state))
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

/** "6 min", "1h 12m", "2 days" since `iso`. */
export const since = (iso: string | null | undefined, now = Date.now()): string => {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
};

/** "10:24" */
export const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
