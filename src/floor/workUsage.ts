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

/** "4.2%", or "under 0.1%". */
export const percent = (share: number): string => {
  const r = Math.round(share * 10) / 10;
  return r < 0.1 ? "under 0.1%" : `${r}%`;
};

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
  const today = same ? percent(same.share) : "under 0.1%";
  return `${percent(week.share)} of your ${windowWord(week.windowMinutes)} ${PLAN[week.plan]} plan this week · ${today} today · ${turns(w.week.turns)}`;
};

export const KIND: Record<WorkUsageKind, string> = {
  job: "job",
  monitor: "monitor",
  boss: "boss’s own turns",
  heartbeat: "heartbeat",
  other: "other",
};

export const inWeek = (works: readonly WorkUsage[]): WorkUsage[] =>
  works.filter((w: { week: WorkSpan }) => w.week.turns > 0);
