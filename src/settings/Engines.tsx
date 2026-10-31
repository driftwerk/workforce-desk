import { useEffect, useState } from "react";
import { defaultCaps, installedText, runsText, signInText } from "../engines/engines";
import { useDesk } from "../hub/store";
import type { EngineInfo } from "../hub/types";

/** The engines on the computer Desk's sessions run on: whether each is
 *  installed, its version, who it is signed in as, and what Desk does with
 *  it. */
export function Engines() {
  const hub = useDesk((s) => s.hub);
  const [engines, setEngines] = useState<EngineInfo[] | null | "failed">(null);
  useEffect(() => {
    let live = true;
    hub
      ?.engines()
      .then((e) => live && setEngines(e))
      .catch(() => live && setEngines("failed"));
    return () => {
      live = false;
    };
  }, [hub]);
  return (
    <section className="settings-pane" aria-label="Engines">
      <h1 className="display-lg">Engines</h1>
      <p className="muted small">
        The coding CLIs on the computer Desk’s sessions run on. Desk reads each one’s version and sign-in every hour.
      </p>
      {engines === "failed" ? (
        <p className="state-blocked small">Couldn’t ask the hub about its engines just now.</p>
      ) : engines === null ? (
        <p className="faint small">{hub ? "Reading…" : "Not connected to a hub."}</p>
      ) : (
        <ul className="engine-list">
          {engines.map((e) => (
            <li key={e.engine} className="engine-row">
              <span className="engine-head">
                <b>{e.title}</b>
                <span className="muted small">{installedText(e)}</span>
              </span>
              {e.installed && <span className="small">{signInText(e.signIn)}</span>}
              <span className="faint small">{runsText(e)}</span>
              {defaultCaps(e)?.notes.map((n) => (
                <span key={n} className="faint small">
                  {n}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
