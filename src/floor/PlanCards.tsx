import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { useAccounts } from "../engines/accounts";
import type { PlanKind, PlanWindow } from "../hub/types";
import { CLI_NAME, CopyInstall, PlanLoginAction, ReopenLink, usePlanLogin } from "../settings/PlanLogin";
import type { AccountCard, Unmatched, UsedOn } from "./accountCards";
import { forgetPlace, hidePlace, linkPlace, linkToOther, setFolded, usePlansUi } from "./planLinks";
import { ask, useBoard } from "./store";
import { clock, dayClock, durationOf } from "./time";
import { fullness, nextChange, pace, projection, windowNow, type PlanCard } from "./usage";
import { useSubHeading } from "./FloorShell";

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

/** The window a card shows: the weekly one, else the longest. */
export const shownWindow = (windows: readonly PlanWindow[]): PlanWindow | null =>
  windows.find((w) => w.minutes === 10_080) ?? [...windows].sort((a, b) => b.minutes - a.minutes)[0] ?? null;

/** "21:11" today, else "yesterday 05:18", "Sat 05:18". */
const saidAt = (iso: string, now: number): string => {
  const d = dayClock(iso, now);
  return d === clock(iso) ? `at ${d}` : d;
};

const sessionsOn = (n: number): string => (n === 0 ? "no sessions now" : n === 1 ? "1 session" : `${n} sessions`);

const hubName = (label: string): string => (/\bhub$/i.test(label) ? label : `${label} hub`);

/** A card's name, as its region and the pickers say it. */
const useTitle = (): ((c: AccountCard) => string) => {
  // This computer's own sign-in, none of the accounts: by who Claude Code
  // says it is.
  const who = useAccounts((s) => (s.claudeSignIn?.state === "in" ? s.claudeSignIn.who : null));
  const ownKey = useAccounts((s) => s.ownPlanKey);
  return (c) =>
    c.name ??
    (ownKey !== null && c.key === `claude:${ownKey}`
      ? (who ?? "This computer’s sign-in")
      : c.state === "signed-out"
        ? `${NAME[c.kind]} on this computer · not signed in`
        : `${NAME[c.kind]} on this computer`);
};

/** One card per real account, each saying where it is used, and the hubs'
 *  places not matched to one yet. */
export function PlanCards() {
  const { cards, unmatched } = useBoard();
  const now = useNow(cards);
  const title = useTitle();
  if (cards.length === 0 && unmatched.length === 0) return null;
  return (
    <>
      {cards.length > 0 && (
        <div className="plan-cards">
          {cards.map((c) => (
            <Card key={c.key} card={c} title={title(c)} now={now} />
          ))}
        </div>
      )}
      <NotMatched rows={unmatched} cards={cards} title={title} now={now} />
    </>
  );
}

function Card({ card, title, now }: { card: AccountCard; title: string; now: number }) {
  const H = useSubHeading();
  const sub = [NAME[card.kind], card.plan && capitalised(card.plan), card.isDefault && "default"].filter(Boolean).join(" · ");
  const w = card.reading && shownWindow(card.reading.windows);
  const many = card.usedOn.length > 1;
  const asOf = card.reading && `${many ? "newest reading" : "as of"} ${dayClock(card.reading.observedAt, now)}`;
  return (
    <section className="floor-card plan-card" aria-label={`${title} usage`}>
      <div className="floor-card-head">
        <H className="display floor-card-title">{title}</H>
        <span className="muted small plan-card-sub">{sub}</span>
      </div>
      {card.state === "reading" && card.reading && w ? (
        <Window w={w} observedAt={card.reading.observedAt} asOf={asOf} now={now} />
      ) : card.state === "reading" ? null : card.state === "no-reading" ? (
        <p className="muted small">No reading yet. It shows after {CLI_NAME[card.kind]} next answers on this plan.</p>
      ) : (
        <SignIn kind={card.kind} />
      )}
      {card.usedOn.length > 0 && (
        <div className="plan-used-on">
          <span className="plan-used-on-label">Used on</span>
          <ul>
            {card.usedOn.map((u) => (
              <Place key={u.key} u={u} newest={u.reading === card.reading} read={many} now={now} />
            ))}
          </ul>
        </div>
      )}
      {card.conflict && (
        <p className="plan-mismatch" role="note">
          <b>Doesn’t add up</b>
          <span>These readings can’t all be the same account at once. Check the links, or unlink the one that’s wrong.</span>
        </p>
      )}
    </section>
  );
}

/** One place an account is used: what it is there, and, beside the others,
 *  what it last read. */
function Place({ u, newest, read, now }: { u: UsedOn; newest: boolean; read: boolean; now: number }) {
  const what =
    u.where === "computer"
      ? u.sessions === null
        ? null
        : sessionsOn(u.sessions)
      : u.where === "machine"
        ? u.sessions === null
          ? "picked when you added it"
          : sessionsOn(u.sessions)
        : null;
  const w = u.reading && shownWindow(u.reading.windows);
  const said =
    u.reading && w
      ? windowNow(w, u.reading.observedAt, now).reset
        ? `read before its reset, ${dayClock(u.reading.observedAt, now)}`
        : `${newest ? "reads" : "read"} ${Math.round(w.usedPercent)}% ${saidAt(u.reading.observedAt, now)}`
      : null;
  return (
    <li className="plan-place">
      <span>
        <b>{u.where === "hub" ? hubName(u.label) : u.label}</b>
        {what && ` · ${what}`}
      </span>
      {(read || u.picked) && (
        <span className="plan-place-reading">
          {read && said}
          {u.picked && (
            <>
              {read && said && " · "}
              <button type="button" className="link plan-unlink" onClick={() => forgetPlace(u.key)} aria-label={`Unlink ${hubName(u.label)}`}>
                Unlink
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}

/** A card a hub's place can be said to be: an account's, wherever it is
 *  used, never one standing in until this computer reads (`@none`) or
 *  offering sign-in. */
const pickable = (c: AccountCard): boolean => c.state !== "signed-out" && !c.key.endsWith("@none");

/** A hub's places that haven't said which account they are, to say. */
function NotMatched({ rows, cards, title, now }: { rows: Unmatched[]; cards: AccountCard[]; title: (c: AccountCard) => string; now: number }) {
  const H = useSubHeading();
  const ui = usePlansUi();
  if (rows.length === 0) return null;
  const n = rows.length;
  if (ui.folded)
    return (
      <p className="plan-unmatched-folded muted">
        {n} {n === 1 ? "place" : "places"} not matched ·{" "}
        <button type="button" className="link" aria-expanded={false} onClick={() => setFolded(false)}>
          Show
        </button>
      </p>
    );
  return (
    <section className="plan-unmatched" aria-label="Not matched to an account yet">
      <H className="plan-unmatched-head">
        <button type="button" className="plan-unmatched-fold" aria-expanded onClick={() => setFolded(true)}>
          <span aria-hidden="true">▾</span>
          Not matched to an account yet · {n}
        </button>
      </H>
      <p className="muted small">
        These hubs use a plan but haven’t said which account. Say which, and they join its card; or choose “Don’t ask” and they stay off the Floor.
      </p>
      <table className="plan-unmatched-table">
        <thead>
          <tr>
            <th scope="col">Where</th>
            <th scope="col">Its reading</th>
            <th scope="col">Which account is this?</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <UnmatchedRow key={r.key} row={r} cards={cards.filter((c) => c.kind === r.kind && pickable(c))} title={title} now={now} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Never a card key.
const OTHER = ":other";
const HIDE = ":hide";

function UnmatchedRow({ row, cards, title, now }: { row: Unmatched; cards: AccountCard[]; title: (c: AccountCard) => string; now: number }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const where = `${hubName(row.label)} · ${NAME[row.kind]}${row.plan ? `, ${capitalised(row.plan)}` : ""}`;
  const w = shownWindow(row.reading.windows);
  const reading = w ? readingText(w, row.reading.observedAt, now) : `read ${dayClock(row.reading.observedAt, now)}`;
  const label = `${hubName(row.label)} ${NAME[row.kind]} account`;
  const make = () => {
    const n = name.trim();
    if (n) linkToOther(row.key, row.kind, n);
  };
  return (
    <tr>
      <td>
        <b>{hubName(row.label)}</b> · {NAME[row.kind]}
        {row.plan && `, ${capitalised(row.plan)}`}
      </td>
      <td>{reading}</td>
      <td>
        {naming ? (
          <form
            className="plan-name-other"
            onSubmit={(e) => {
              e.preventDefault();
              make();
            }}
          >
            <input aria-label={`Name the account ${where} uses`} className="ability-select" placeholder="Its name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
              Make its card
            </button>
            <button type="button" className="link" onClick={() => setNaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <select
            aria-label={label}
            className="ability-select plan-pick"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v === OTHER) setNaming(true);
              else if (v === HIDE) hidePlace(row.key, where);
              else if (v) linkPlace(row.key, v);
            }}
          >
            <option value="">Choose…</option>
            {cards.map((c) => (
              <option key={c.key} value={c.key}>
                {title(c)}
              </option>
            ))}
            <option value={OTHER}>Another account</option>
            <option value={HIDE}>Don’t ask</option>
          </select>
        )}
      </td>
    </tr>
  );
}

/** "13% · resets Fri 16:00", or "0% · no use since Thu 07:00". */
const readingText = (w: PlanWindow, observedAt: string, now: number): string => {
  const { used, resetAt, reset } = windowNow(w, observedAt, now);
  const when = resetAt === null ? null : dayClock(resetAt, now);
  return reset ? `0%${when ? ` · no use since ${when}` : ""}` : `${Math.round(used)}%${when ? ` · resets ${when}` : ""}`;
};

function Window({ w, observedAt, asOf, now }: { w: PlanWindow; observedAt: string; asOf: string | null; now: number }) {
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
        ? `At this pace you reach the limit about ${dayClock(ahead.hitsAt, now)}, ${howLong(resetAt - ahead.hitsAt)} before it resets.`
        : null;
  const when = resetAt === null || reset ? null : w.minutes >= DAY_MINUTES ? `resets ${resets}` : `resets ${resets} · in ${durationOf(now, resetAt)}`;
  const spoken = [
    `${percent} percent of the ${label === "Weekly" ? "weekly limit" : label} used`,
    reset ? `reset at ${resets}` : resets && `resets ${resets}`,
    ahead && "hitsAt" in ahead && `at this pace it runs out about ${dayClock(ahead.hitsAt, now)}`,
  ]
    .filter(Boolean)
    .join("; ");
  return (
    <div className="plan-window">
      <div className="plan-window-head">
        <span>{label}</span>
        <b className={`plan-${level}`}>{percent}%</b>
        {(when || asOf) && <span className="floor-time">{[when, asOf].filter(Boolean).join(" · ")}</span>}
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
  return (
    <div className="plan-signin">
      <p className="muted small">Not signed in on this computer, so there’s no usage to show.</p>
      <PlanSignIn kind={kind} />
    </div>
  );
}

/** Signing in to a plan of this kind on this computer, and how it's going:
 *  the plan's usage is read again once it's done. */
export function PlanSignIn({ kind }: { kind: PlanKind }) {
  const local = useChat((s) => s.hubs.find((h) => h.local)?.id);
  const login = usePlanLogin(kind, () => local && ask([local]));
  return (
    <>
      <PlanLoginAction login={login} label={`Sign in to ${NAME[kind]}`} />
      {login.status && (
        <span className={`small ${login.failed ? "state-blocked" : "muted"}`} role="status">
          {login.status}
          <ReopenLink login={login} />
          <CopyInstall login={login} />
        </span>
      )}
    </>
  );
}
