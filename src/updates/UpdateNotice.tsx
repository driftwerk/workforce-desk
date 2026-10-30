import { useEffect, useState } from "react";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import { inApp } from "../platform";
import { CloseButton, Dialog } from "../ui/Dialog";
import { CHECK_EVERY_MS, isLive, isWorking, useUpdates } from "./store";

/** Looks for a new version on launch and every few hours; downloads it in
 *  the background. Quiet when there's none or this computer is offline. */
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

const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** "Restart to update" once a new version is downloaded. Sessions that are
 *  running stop for the restart and are resumed right after it; the person
 *  can instead have Desk wait until none is working. */
export function UpdateNotice() {
  const { state, waiting, wait, restart } = useUpdates();
  const sessions = useDesk((s) => s.sessions);
  const names = useSessionNames();
  const fail = useDesk((s) => s.fail);
  const [asking, setAsking] = useState(false);
  const live = Object.values(sessions).filter(isLive);
  const working = live.filter(isWorking);
  const go = () => void restart(live.map((s) => s.id)).catch(fail);

  useEffect(() => {
    if (waiting && state.phase === "ready" && working.length === 0) go();
    // `go` reads the sessions current at this render.
  }, [waiting, state.phase, working.length]);

  if (state.phase !== "ready" && state.phase !== "installing") return null;
  const installing = state.phase === "installing";
  return (
    <>
      <div className="update-notice" role="status">
        <span>
          {installing
            ? `Updating to Desk ${state.version}…`
            : waiting
              ? `Desk ${state.version} installs when your sessions finish.`
              : `Desk ${state.version} is ready.`}
        </span>
        {!installing && waiting && (
          <button type="button" className="link small" onClick={() => wait(false)}>
            Don’t wait
          </button>
        )}
        {!installing && (
          <button type="button" className="btn btn-signal" onClick={() => (live.length ? setAsking(true) : go())}>
            Restart to update
          </button>
        )}
      </div>
      {asking && (
        <Dialog
          onClose={() => setAsking(false)}
          title={(id) => (
            <header className="dialog-head">
              <span className="dialog-title">
                <h1 id={id} className="display-lg">
                  Restart to update
                </h1>
                <p>
                  {working.length > 0
                    ? `${list(working.map((s) => names[s.id] ?? s.name))} ${working.length === 1 ? "is" : "are"} working right now.`
                    : "Your sessions are open but idle."}
                </p>
              </span>
              <CloseButton onClose={() => setAsking(false)} />
            </header>
          )}
        >
          <div className="dialog-scroll">
            <p className="muted">These stop for the restart and pick up where they left off as soon as Desk is back:</p>
            <ul className="update-sessions">
              {live.map((s) => (
                <li key={s.id}>
                  <span className="mono">{names[s.id] ?? s.name}</span>
                  <span className="faint small">{s.goal || s.lastPrompt || s.cwd}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="dialog-foot">
            <span className="dialog-foot-note" />
            {working.length > 0 && (
              <button
                type="button"
                className="btn"
                data-autofocus
                onClick={() => {
                  wait(true);
                  setAsking(false);
                }}
              >
                Restart when they finish
              </button>
            )}
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
