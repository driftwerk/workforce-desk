const DAY_MS = 86_400_000;

const parsed = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** "6 min", "1h 12m", "2 days" since `iso`. */
export const since = (iso: string | null | undefined, now = Date.now()): string => {
  const t = parsed(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
};

/** "10:24", in this Mac's time. */
export const clock = (iso: string | number | Date): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The start of the day `at` is in, in this Mac's time. */
export const startOfLocalDay = (at: Date | number = Date.now()): Date => new Date(startOfDay(new Date(at).getTime()));

/** The next local midnight after `at`. */
export const nextLocalMidnight = (at: Date | number = Date.now()): Date => {
  const d = startOfLocalDay(at);
  d.setDate(d.getDate() + 1);
  return d;
};

/** When, said against today: "16:20", "yesterday 18:40", "tomorrow 09:00",
 *  "Mon 09:00" within the week either side, else "12 Oct 09:00". */
export const dayClock = (iso: string | number | Date, now = Date.now()): string => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
  const time = clock(t);
  if (days === 0) return time;
  if (days === -1) return `yesterday ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const d = new Date(t);
  const day = Math.abs(days) < 7 ? d.toLocaleDateString([], { weekday: "short" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day} ${time}`;
};

/** How long from `from` to `to`: "48m", "1h 05m"; never below none. */
export const durationOf = (from: string | number | Date, to: string | number | Date): string => {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  const m = Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
