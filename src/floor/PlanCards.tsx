import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import type { PlanKind, PlanWindow } from "../hub/types";
import { CLI_NAME, PlanLoginAction, ReopenLink, usePlanLogin } from "../settings/PlanLogin";
import { ask, usePlans } from "./store";
import { clock, dayClock, durationOf } from "./time";
import { fullness, nextChange, pace, projection, windowNow, type PlanCard } from "./usage";

const TITLE: Record<PlanKind, string> = { claude: "Claude plan", chatgpt: "ChatGPT plan" };
const NAME: Record<PlanKind, string> = { claude: "Claude", chatgpt: "ChatGPT" };

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

/** "5-hour window", "Weekly", else "3-hour" or "2-day". */
export const windowLabel = (minutes: number): string =>
  minutes === 300
    ? "5-hour window"
    : minutes === 10_080
      ? "Weekly"
      : minutes % DAY_MINUTES === 0
        ? `${minutes / DAY_MINUTES}-day`
        : minutes % 60 === 0
          ? `${minutes / 60}-hour`
          : `${minutes}-minute`;

const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "15 minutes", "1h 05m". */
const howLong = (ms: number): string => {
  const m = Math.round(ms / MINUTE);
  return m < 60 ? `${m} ${m === 1 ? "minute" : "minutes"}` : durationOf(0, ms);
};

/** Re-renders now and then: at the next reset, and every minute for the
 *  pace tick and the countdown. */
const useNow = (cards: readonly PlanCard[]): number => {
  const [now, setNow] = useState(Date.now);
  const next = nextChange(cards, now);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), MINUTE);
    const reset = next === null ? undefined : setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => {
      clearInterval(tick);
      clearTimeout(reset);
    };
  }, [next]);
  return now;
};

/** Each plan's limits, as the plans' own apps last reported them. */
export function PlanCards() {
  const cards = usePlans();
  const now = useNow(cards);
  if (cards.length === 0) return null;
  return (
    <div className="plan-cards">
      {cards.map((c) => (
        <Card key={c.key} card={c} now={now} />
      ))}
    </div>
  );
}

function Card({ card, now }: { card: PlanCard; now: number }) {
  const sub = [card.plan && capitalised(card.plan), card.where].filter(Boolean).join(" · ");
  return (
    <section className="floor-card plan-card" aria-label={`${TITLE[card.kind]} usage`}>
      <div className="floor-card-head">
        <h2 className="display floor-card-title">{TITLE[card.kind]}</h2>
        <span className="muted small">{sub}</span>
        {card.reading && <span className="floor-time">as of {clock(card.reading.observedAt)}</span>}
      </div>
      {card.state === "reading" && card.reading ? (
        card.reading.windows.map((w, i) => <Window key={`${w.minutes}:${i}`} w={w} observedAt={card.reading!.observedAt} now={now} />)
      ) : card.state === "no-reading" ? (
        <p className="muted small">No reading yet. It shows after {CLI_NAME[card.kind]} next answers on this plan.</p>
      ) : (
        <SignIn kind={card.kind} />
      )}
    </section>
  );
}

function Window({ w, observedAt, now }: { w: PlanWindow; observedAt: string; now: number }) {
  const label = windowLabel(w.minutes);
  const { used, resetAt, reset } = windowNow(w, observedAt, now);
  const tick = reset ? null : pace(w, now);
  const ahead = reset ? null : projection(w, now);
  const percent = Math.round(used);
  const level = fullness(percent);
  const resets = resetAt === null ? null : dayClock(resetAt, now);
  const line = reset
    ? `Reset at ${resets} · no use seen since.`
    : ahead && "atLimit" in ahead
      ? `At the limit. It resets at ${resets}.`
      : ahead && resetAt !== null
        ? `At this pace you reach the limit about ${clock(ahead.hitsAt)}, ${howLong(resetAt - ahead.hitsAt)} before it resets.`
        : null;
  const when = resetAt === null || reset ? null : w.minutes >= DAY_MINUTES ? `resets ${resets}` : `resets ${resets} · in ${durationOf(now, resetAt)}`;
  const spoken = [
    `${percent} percent of the ${label === "Weekly" ? "weekly limit" : label} used`,
    reset ? `reset at ${resets}` : resets && `resets ${resets}`,
    ahead && "hitsAt" in ahead && `at this pace it runs out about ${clock(ahead.hitsAt)}`,
  ]
    .filter(Boolean)
    .join("; ");
  return (
    <div className="plan-window">
      <div className="plan-window-head">
        <span>{label}</span>
        <b className={`plan-${level}`}>{percent}%</b>
        {when && <span className="floor-time">{when}</span>}
      </div>
      <div className="plan-bar" role="img" aria-label={spoken}>
        <span className={`plan-fill plan-fill-${level}`} style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
        {tick !== null && <span className="plan-pace" style={{ left: `${tick * 100}%` }} title="Where you’d be at an even pace" />}
      </div>
      {line && <span className="muted small">{line}</span>}
    </div>
  );
}

/** No plan of this kind signed in on this computer: sign in here. */
function SignIn({ kind }: { kind: PlanKind }) {
  const local = useChat((s) => s.hubs.find((h) => h.local)?.id);
  const login = usePlanLogin(kind, () => local && ask([local]));
  return (
    <div className="plan-signin">
      <p className="muted small">Not signed in on this computer, so there’s no usage to show.</p>
      <PlanLoginAction login={login} label={`Sign in to ${NAME[kind]}`} />
      {login.status && (
        <span className={`small ${login.failed ? "state-blocked" : "muted"}`} role="status">
          {login.status}
          <ReopenLink login={login} />
        </span>
      )}
    </div>
  );
}
