import type {
  PlanKind,
  WorkShare,
  WorkSpan,
  WorkUsage,
  WorkUsageKind,
} from "../hub/types";

const PLAN: Record<PlanKind, string> = { claude: "Claude", chatgpt: "ChatGPT" };

/** "weekly", "five-hour", else "3-hour" or "2-day". */
export const windowWord = (minutes: number): string =>
  minutes === 10_080
    ? "weekly"
    : minutes === 300
      ? "five-hour"
      : minutes % 1440 === 0
        ? `${minutes / 1440}-day`
        : minutes % 60 === 0
          ? `${minutes / 60}-hour`
          : `${minutes}-minute`;

/** "4.2%", or "under 0.1%" (as the hub says it). */
export const percent = (share: number): string =>
  share < 0.1 ? "under 0.1%" : `${Math.round(share * 10) / 10}%`;

/** The share of the longest window, if any reported. */
export const longest = (shares: readonly WorkShare[]): WorkShare | null =>
  shares.reduce<WorkShare | null>(
    (a, s) => (a === null || s.windowMinutes > a.windowMinutes ? s : a),
    null,
  );

const turns = (n: number): string => `${n} ${n === 1 ? "turn" : "turns"}`;

/** "4.2% of your weekly Claude plan this week · 0.8% today · 80 turns", or
 *  with no share, only the turns: "12 turns today · 80 this week". */
export const planUse = (w: Pick<WorkUsage, "day" | "week">): string => {
  const week = longest(w.week.shares);
  if (!week) return `${turns(w.day.turns)} today · ${w.week.turns} this week`;
  const same = longest(
    w.day.shares.filter(
      (s) => s.plan === week.plan && s.windowMinutes === week.windowMinutes,
    ),
  );
  const today = same && same.share > 0 ? percent(same.share) : "none";
  return `${percent(week.share)} of your ${windowWord(week.windowMinutes)} ${PLAN[week.plan]} plan this week · ${today} today · ${turns(w.week.turns)}`;
};

export const KIND: Record<WorkUsageKind, string> = {
  job: "job",
  monitor: "monitor",
  // Its label already says it: "Atlas's own turns".
  boss: "",
  heartbeat: "heartbeat",
  other: "other",
};

/** The works that did anything this week: a turn, or a share of a plan. */
export const inWeek = (works: readonly WorkUsage[]): WorkUsage[] =>
  works.filter(
    (w: { week: WorkSpan }) =>
      w.week.turns > 0 || w.week.shares.some((s) => s.share > 0),
  );
