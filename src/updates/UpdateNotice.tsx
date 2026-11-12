import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { advance } from "../unread/reads";
import { useSeenWhole } from "../unread/seen";
import { useSessionNames } from "../groups/names";
import { useDesk, localSessions } from "../hub/store";
import { inApp, openUrl } from "../platform";
import { useMachines } from "../hub/engines";
import { CHECK_EVERY_MS, cantResume, isLive, isPostponed, isWorking, useUpdates } from "./store";
import { lastInputAt } from "./away";
import { isRunning, useChat } from "../chat/store";
import { useVoiceStore } from "../voice/store";
import type { Session } from "../hub/types";

/** Looks for a new version on launch and every few hours; downloads it in
 *  the background. Quiet when there's none, this computer is offline, or
 *  this is a development build (its native side never looks). */
export function useUpdateChecks() {
  const check = useUpdates((s) => s.check);
  useEffect(() => {
    if (!inApp) return;
    const run = () => void check().catch((e: unknown) => console.warn("update check:", e));
    run();
    const every = setInterval(run, CHECK_EVERY_MS);
    return () => clearInterval(every);
  }, [check]);
}

/** How long since the person last used any of Desk's windows before it
 *  may restart into an update by itself. */
export const AWAY_MS = 2 * 60 * 1000;

export { setLastInput } from "./away";

/** Nothing the person would lose to a restart now: no session of this
 *  computer's working (or that can't be told not to be), none at all
 *  unless they're kept through it, no voice call, and no agent's turn in a
 *  DM or a room on its way. */
export const restartsQuietly = (o: { live: Session[]; kept: boolean; voiceOff: boolean; turns: boolean }): boolean =>
  o.voiceOff && !o.turns && !o.live.some(isWorking) && (o.kept || o.live.length === 0);

/** Installs a ready update by itself once restarting would take nothing
 *  from the person (`restartsQuietly`) and they've stepped away from every
 *  Desk window for a couple of minutes, unless they put it off. Called
 *  once from the shell, so it runs whichever view is open (Settings
 *  included). Only this computer's sessions count: a machine's run on. */
export function useRestartWhenIdle() {
  const waiting = useUpdates((s) => s.waiting);
  const phase = useUpdates((s) => s.state.phase);
  const kept = useUpdates((s) => s.sessionsKept);
  const restart = useUpdates((s) => s.restart);
  const sessions = useDesk((s) => localSessions(s.sessions));
  const roomTurns = useDesk((s) => Object.values(s.roomDrafts).some((ds) => ds.some((d) => !["stopped", "interrupted", "failed"].includes(d.state))));
  const dmTurns = useChat((s) => Object.values(s.conversations).some((c) => isRunning(c)));
  const voiceOff = useVoiceStore((v) => v.status.state === "off" && Object.keys(v.waiting).length === 0);
  const fail = useDesk((s) => s.fail);
  const live = Object.values(sessions).filter(isLive);
  const quiet = restartsQuietly({ live, kept, voiceOff, turns: roomTurns || dmTurns });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!waiting || phase !== "ready") return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [waiting, phase]);
  useEffect(() => {
    if (!(waiting && phase === "ready" && quiet && Date.now() - lastInputAt() >= AWAY_MS)) return;
    const go = () =>
      void useUpdates
        .getState()
        .restart(Object.values(localSessions(useDesk.getState().sessions)).filter(isLive).map((s) => s.id))
        .catch((e: unknown) => fail(e, { what: "restarting into the update", retry: go }));
    go();
    // The sessions current at this render.
  }, [waiting, phase, quiet, tick, restart, fail]);
}

/** Says where the band ends (`--update-band-bottom` on the page), for the
 *  hub-down banner, which floats at the top, to sit below it however many
 *  lines it takes. */
function useBandBottom(band: RefObject<HTMLDivElement | null>, showing: string | null) {
  useLayoutEffect(() => {
    const el = band.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--update-band-bottom", `${Math.ceil(el.getBoundingClientRect().bottom)}px`);
    measure();
    window.addEventListener("resize", measure);
    const o = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    o?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      o?.disconnect();
      root.style.removeProperty("--update-band-bottom");
    };
  }, [band, showing]);
}

const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const sessionsWord = (n: number): string => (n === 1 ? "1 session" : `${n} sessions`);

/** What restarting into the update does to this computer's sessions, said
 *  before anything happens. Kept by the PTY holder, they run on; without
 *  it, each stops and is resumed after, unless its CLI can't be. */
export function whatHappens(live: Session[], kept: boolean): string {
  if (live.length === 0) return "Desk restarts to update.";
  if (kept) return "Desk restarts to update. Your sessions keep running and are picked up again.";
  const lost = live.filter(cantResume).length;
  const stop = `Desk restarts to update. ${sessionsWord(live.length)} ${live.length === 1 ? "stops" : "stop"} for the restart`;
  if (lost === 0) return `${stop} and ${live.length === 1 ? "picks" : "pick"} up where ${live.length === 1 ? "it" : "they"} left off after it.`;
  if (lost === live.length) return `${stop} and can’t be picked up again.`;
  return `${stop}: ${lost} of them can’t be picked up again, the rest pick up where they left off.`;
}

/** A downloaded version, in the stage's flow (it covers nothing): it
 *  installs by itself once the sessions finish and the person has stepped
 *  away, said with what the restart does to the sessions. Update now
 *  (asking once, in place, when it would stop sessions that are working),
 *  or Not now (hidden for this version until a newer one is out, or the
 *  person checks). */
export function UpdateNotice() {
  const { state, waiting, restart, postpone, probe, later, sessionsKept } = useUpdates();
  // This computer's: a machine updates on its own.
  const sessions = useDesk((s) => localSessions(s.sessions));
  const names = useSessionNames();
  const fail = useDesk((s) => s.fail);
  // Update now would stop sessions that are working: said in the notice
  // itself, once, before it does.
  const [asking, setAsking] = useState(false);
  // The machines Desk drives follow it: each updates to match as it connects.
  const all = useMachines((m) => m.machines);
  const machines = all.filter((x) => x.state.kind !== "newer").map((x) => x.name);
  const live = Object.values(sessions).filter(isLive);
  const working = live.filter(isWorking);
  // The notice is read once it has shown, or acted on; a newer version is
  // new again.
  const version = state.phase === "ready" ? state.version : null;
  const point = useMemo(() => (version ? { at: new Date().toISOString(), message: version } : null), [version]);
  const notice = useRef<HTMLDivElement>(null);
  useSeenWhole({ kind: "update" }, point, notice, { enabled: true });
  const acted = () => point && void advance({ kind: "update" }, point);
  const go = () => {
    acted();
    setAsking(false);
    void restart(live.map((s) => s.id)).catch((e: unknown) => fail(e, { what: "restarting into the update", retry: go }));
  };

  const postponed = (state.phase === "ready" || state.phase === "available") && isPostponed(later, state.version);
  const showing =
    postponed || !["ready", "installing", "available"].includes(state.phase) ? null : `${state.phase} ${"version" in state ? state.version : ""}`;
  useBandBottom(notice, showing);
  if (postponed) return null;
  const laterButton = (
    <button
      type="button"
      className="link small"
      onClick={() => {
        acted();
        postpone();
      }}
    >
      Not now
    </button>
  );

  if (state.phase === "available")
    return (
      <div ref={notice} className="update-notice" role="status">
        <span className="update-notice-text">A new version of Desk is out: Desk {state.version}.</span>
        <span className="update-notice-actions">
          {laterButton}
          {state.download && (
            <button type="button" className="btn btn-sm btn-signal" onClick={() => openUrl(state.download!)}>
              Download
            </button>
          )}
        </span>
      </div>
    );
  if (state.phase !== "ready" && state.phase !== "installing") return null;
  const installing = state.phase === "installing";
  const stopping = working.map((s) => names[s.id] ?? s.name);
  return (
    <div ref={notice} className="update-notice" role="status">
      <span className="update-notice-text">
        {installing ? (
          `Updating to Desk ${state.version}…`
        ) : asking ? (
          <>
            <b>
              {stopping.length
                ? `${list(stopping)} ${stopping.length === 1 ? "is" : "are"} working right now.`
                : `${sessionsWord(live.length)} ${live.length === 1 ? "is" : "are"} open.`}
            </b>{" "}
            {whatHappens(live, sessionsKept)}
            {machines.length > 0 && ` Your machines’ sessions don’t stop. Each machine updates to ${state.version} when Desk reconnects to it.`}
          </>
        ) : (
          <>
            <b>
              {waiting
                ? `Desk ${state.version} installs by itself once your sessions finish and you’ve stepped away.`
                : `Desk ${state.version} is ready.`}
            </b>{" "}
            {whatHappens(live, sessionsKept)}
            {machines.length > 0 && ` ${list(machines)} ${machines.length === 1 ? "updates" : "update"} to match after.`}
          </>
        )}
      </span>
      {!installing && (
        <span className="update-notice-actions">
          {asking ? (
            <button type="button" className="link small" onClick={() => setAsking(false)}>
              {stopping.length ? "Wait for them" : "Not now"}
            </button>
          ) : (
            laterButton
          )}
          <button
            type="button"
            className="btn btn-sm btn-signal"
            onClick={() =>
              asking
                ? go()
                : // Whether the holder keeps them now, not as of the last check.
                  // Sessions not kept through it stop: asked first, working or not.
                  void probe().then((kept) => (!kept && live.length > 0 ? setAsking(true) : go()))
            }
          >
            {asking ? "Restart now" : "Update now"}
          </button>
        </span>
      )}
    </div>
  );
}
