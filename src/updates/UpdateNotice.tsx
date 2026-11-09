import { useEffect, useMemo, useRef, useState } from "react";
import { advance } from "../unread/reads";
import { useSeenWhole } from "../unread/seen";
import { useSessionNames } from "../groups/names";
import { useDesk, localSessions } from "../hub/store";
import { inApp, openUrl } from "../platform";
import { CloseButton, Dialog } from "../ui/Dialog";
import { useMachines } from "../hub/engines";
import { CHECK_EVERY_MS, cantResume, isLive, isPostponed, isWorking, useUpdates } from "./store";
import type { Session } from "../hub/types";

/** Looks for a new version on launch and every few hours; downloads it in
 *  the background. Quiet when there's none, this computer is offline, or
 *  this is a development build (its native side never looks). */
export function useUpdateChecks() {
  const check = useUpdates((s) => s.check);
  useEffect(() => {
    if (!inApp) return;
    const run = (launch: boolean) => void check({ launch }).catch((e: unknown) => console.warn("update check:", e));
    run(true);
    const every = setInterval(() => run(false), CHECK_EVERY_MS);
    return () => clearInterval(every);
  }, [check]);
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

/** "Desk … is ready" once a new version is downloaded, in the stage's
 *  flow (it covers nothing), with what the restart does to the sessions.
 *  Update now, When idle (once none is working), or Later (hidden for this
 *  version until the next check or start). */
export function UpdateNotice() {
  const { state, waiting, wait, restart, postpone, later, started, sessionsKept } = useUpdates();
  // This computer's: a machine updates on its own.
  const sessions = useDesk((s) => localSessions(s.sessions));
  const names = useSessionNames();
  const fail = useDesk((s) => s.fail);
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
    void restart(live.map((s) => s.id)).catch(fail);
  };

  useEffect(() => {
    if (waiting && state.phase === "ready" && working.length === 0) go();
    // `go` reads the sessions current at this render.
  }, [waiting, state.phase, working.length]);

  const postponed = (state.phase === "ready" || state.phase === "available") && isPostponed(later, state.version, started);
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
      Later
    </button>
  );

  if (state.phase === "available")
    return (
      <div className="update-notice" role="status">
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
  // Sessions the restart would stop while they work: asked first.
  const interrupts = !sessionsKept && working.length > 0;
  return (
    <>
      <div ref={notice} className="update-notice" role="status">
        <span className="update-notice-text">
          {installing ? (
            `Updating to Desk ${state.version}…`
          ) : (
            <>
              <b>{waiting ? `Desk ${state.version} installs when your sessions finish.` : `Desk ${state.version} is ready.`}</b>{" "}
              {whatHappens(live, sessionsKept)}
              {machines.length > 0 && ` ${list(machines)} ${machines.length === 1 ? "updates" : "update"} to match after.`}
            </>
          )}
        </span>
        {!installing && (
          <span className="update-notice-actions">
            {waiting ? (
              <button type="button" className="link small" onClick={() => wait(false)}>
                Don’t wait
              </button>
            ) : (
              laterButton
            )}
            {!waiting && working.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                title="Restarts once no session is working"
                onClick={() => {
                  acted();
                  wait(true);
                }}
              >
                When idle
              </button>
            )}
            <button type="button" className="btn btn-sm btn-signal" onClick={() => (interrupts ? setAsking(true) : go())}>
              Update now
            </button>
          </span>
        )}
      </div>
      {asking && (
        <Dialog
          onClose={() => setAsking(false)}
          title={(id) => (
            <header className="dialog-head">
              <span className="dialog-title">
                <h1 id={id} className="display-lg">
                  Update now
                </h1>
                <p>{`${list(working.map((s) => names[s.id] ?? s.name))} ${working.length === 1 ? "is" : "are"} working right now.`}</p>
              </span>
              <CloseButton onClose={() => setAsking(false)} />
            </header>
          )}
        >
          <div className="dialog-scroll">
            <p className="muted">{whatHappens(live, sessionsKept)}</p>
            <ul className="update-sessions">
              {live.map((s) => (
                <li key={s.id}>
                  <span className="mono">{names[s.id] ?? s.name}</span>
                  <span className="faint small">
                    {cantResume(s) ? "Can’t be picked up again. " : ""}
                    {s.goal || s.lastPrompt || s.cwd}
                  </span>
                </li>
              ))}
            </ul>
            {machines.length > 0 && (
              <p className="muted">Your machines’ sessions don’t stop. Each machine updates to {state.version} when Desk reconnects to it.</p>
            )}
          </div>
          <div className="dialog-foot">
            <span className="dialog-foot-note" />
            <button
              type="button"
              className="btn"
              data-autofocus
              onClick={() => {
                acted();
                wait(true);
                setAsking(false);
              }}
            >
              Restart when they finish
            </button>
            <button
              type="button"
              className="btn btn-signal"
              onClick={() => {
                setAsking(false);
                go();
              }}
            >
              Restart now
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
