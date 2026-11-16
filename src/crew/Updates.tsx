import { useEffect, useId, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import { agentKey, type Agent } from "../chat/types";
import { plainError } from "../ui/plainError";
import { useUi } from "../shell/ui";
import { useAgentConfigs } from "./agentBrain";
import { oversightOf } from "./oversight";
import {
  type Cadence,
  cadenceOf,
  DECIDED,
  EVERY,
  presetOf,
  PRESETS,
  ROUTES,
  ROWS,
  setAgentCadence,
  summaryOf,
  withPreset,
} from "./cadence";

// How and when the boss tells you what happened: the card beside its chat
// (what it does now, the next roundup, Roundup now) and the same settings in
// full under Settings. Both write its config's `[oversight.updates]`, which
// the hub reads at once; the boss changes them itself when you say so in
// its chat.

type Status =
  { state: "idle" | "saving" | "saved" } | { state: "failed"; problem: string };

/** The boss `agent`'s cadence as its config says, and a way to change it. */
function useCadence(agent: Agent) {
  const hub = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const config = useAgentConfigs((s) => s.configs[key]);
  const put = useAgentConfigs((s) => s.put);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [shown, setShown] = useState<Cadence | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (hub && config === undefined)
      void useAgentConfigs.getState().load(hub, agent);
  }, [hub, config, agent]);
  useEffect(() => {
    if (config !== undefined && status.state !== "saving")
      setShown(cadenceOf(config));
  }, [config, status.state]);
  const save = (change: (c: Cadence) => Cadence) => {
    if (!hub || !shown) return;
    setShown(change(shown));
    setStatus({ state: "saving" });
    const write = writes.current.then(() =>
      setAgentCadence(hub, agent.id, change),
    );
    writes.current = write.catch(() => {});
    write.then(
      (toml) => {
        put(key, toml);
        setStatus({ state: "saved" });
      },
      (e: unknown) => {
        setStatus({ state: "failed", problem: plainError(e) });
        const now = useAgentConfigs.getState().configs[key];
        if (now !== undefined) setShown(cadenceOf(now));
      },
    );
  };
  // Only an overseer has updates to tell.
  const oversees = config !== undefined && oversightOf(config).enabled;
  return {
    cadence: shown,
    save,
    status,
    ready: !!hub && shown !== null && oversees,
  };
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

/** When the boss's next roundup comes, as its hub says: read now and each
 *  minute; null while unknown, or on an older hub. */
function useNextRoundup(
  agent: Agent,
  cadence: Cadence | null,
): string | null | undefined {
  const hub = useDesk((s) => s.hub);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const said = cadence ? JSON.stringify(cadence) : "";
  useEffect(() => {
    if (!hub) return;
    let live = true;
    const read = () =>
      void hub.updatesOf(agent.id).then(
        (u) => live && setNext(u ? u.nextRoundup : undefined),
        () => live && setNext(undefined),
      );
    read();
    const every = window.setInterval(read, 60_000);
    return () => {
      live = false;
      window.clearInterval(every);
    };
  }, [hub, agent.id, said]);
  return next;
}

/** The card beside the boss's chat: its updates in a few lines, a preset,
 *  Roundup now, and the way to the settings in full. */
export function UpdatesCard({ agent }: { agent: Agent }) {
  const hub = useDesk((s) => s.hub);
  const setAgentTab = useUi((u) => u.setAgentTab);
  const { cadence, save, status, ready } = useCadence(agent);
  const next = useNextRoundup(agent, cadence);
  const [asked, setAsked] = useState<
    "idle" | "asking" | "asked" | { problem: string }
  >("idle");
  const head = useId();
  if (!ready || !cadence) return null;
  const preset = presetOf(cadence);
  const roundupNow = async () => {
    if (!hub) return;
    setAsked("asking");
    try {
      await hub.roundupNow(agent.id);
      setAsked("asked");
    } catch (e) {
      setAsked({ problem: plainError(e) });
    }
  };
  return (
    <aside className="upd-card" aria-labelledby={head}>
      <div className="upd-card-head">
        <h2 id={head}>Updates</h2>
        {next && (
          <span className="faint small">Next roundup {clock(next)}</span>
        )}
      </div>
      <div
        className="seg upd-presets"
        role="radiogroup"
        aria-label="How you hear from it"
      >
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={preset === p.key}
            onClick={() => save((c) => withPreset(c, p.key))}
          >
            {p.title}
          </button>
        ))}
      </div>
      {preset === null && <p className="faint small">Custom</p>}
      <ul className="upd-summary">
        {summaryOf(cadence).map((l) => (
          <li key={l.label}>
            <b>{l.label}</b>
            {l.text && ` ${l.text}`}
          </li>
        ))}
      </ul>
      <div className="upd-card-actions">
        {cadence.roundup !== "never" && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={asked === "asking"}
            onClick={() => void roundupNow()}
          >
            Roundup now
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setAgentTab(agentKey(agent), "settings")}
        >
          Change…
        </button>
      </div>
      {asked === "asked" && (
        <p className="faint small" role="status">
          It’s on its way.
        </p>
      )}
      {typeof asked === "object" && (
        <p className="small state-blocked" role="alert">
          {asked.problem}
        </p>
      )}
      {status.state === "failed" && (
        <p className="small state-blocked" role="alert">
          {status.problem}
        </p>
      )}
      <p className="faint small">
        You can also just say it in the chat: “only tell me when something’s
        finished”, “roundup every two hours”, “nothing overnight”. {agent.name}{" "}
        changes this and says what it changed.
      </p>
    </aside>
  );
}

/** Settings › Updates: the same, in full. */
export function UpdatesSettings({ agent }: { agent: Agent }) {
  const { cadence, save, status, ready } = useCadence(agent);
  const ids = useId();
  const [quiet, setQuiet] = useState<{ from: string; until: string } | null>(
    null,
  );
  useEffect(() => {
    if (cadence) setQuiet(cadence.quiet ?? { from: "22:00", until: "07:00" });
  }, [cadence?.quiet?.from, cadence?.quiet?.until, cadence === null]);
  if (!ready || !cadence || !quiet) return null;
  const preset = presetOf(cadence);
  return (
    <section
      className="oversee-part upd-settings"
      aria-labelledby={`${ids}-h`}
      id="updates-settings"
    >
      <h3 id={`${ids}-h`}>Updates</h3>
      <span className="oversee-sub">
        How and when {agent.name} tells you what happened. Every update is
        written the same way: sentences with context, numbers in brackets, a
        link to the session.
      </span>
      <div className="seg upd-presets" role="radiogroup" aria-label="Preset">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={preset === p.key}
            onClick={() => save((c) => withPreset(c, p.key))}
          >
            {p.title}
          </button>
        ))}
      </div>
      {preset === null && <span className="oversee-sub">Custom</span>}

      <div className="oversee-card">
        <table className="upd-table">
          <thead>
            <tr>
              <th scope="col">What happened</th>
              {ROUTES.map((r) => (
                <th scope="col" key={r.key}>
                  {r.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <b>{row.title}</b>
                  <span className="oversee-sub">{row.about}</span>
                </th>
                {ROUTES.map((r) => (
                  <td key={r.key}>
                    {row.key === "needs_you" && r.key === "ask" ? (
                      <span className="faint" aria-label="Not offered">
                        —
                      </span>
                    ) : (
                      <input
                        type="radio"
                        name={`${ids}-${row.key}`}
                        aria-label={`${row.title}: ${r.title}`}
                        checked={cadence[row.key] === r.key}
                        onChange={() =>
                          save((c) => ({ ...c, [row.key]: r.key }))
                        }
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset className="oversee-card upd-field">
        <legend>Roundup</legend>
        {EVERY.map((e) => (
          <label key={e.key} className="oversee-check">
            <input
              type="radio"
              name={`${ids}-every`}
              checked={cadence.roundup === e.key}
              onChange={() => save((c) => ({ ...c, roundup: e.key }))}
            />
            <span className="oversee-check-text">{e.title}</span>
          </label>
        ))}
        <span className="oversee-sub">
          Skipped when nothing happened. A roundup starts with one line saying
          what matters most.
        </span>
      </fieldset>

      <fieldset className="oversee-card upd-field">
        <legend>Quiet hours</legend>
        <label className="oversee-check">
          <input
            type="checkbox"
            checked={!!cadence.quiet}
            onChange={(e) =>
              save((c) => ({ ...c, quiet: e.target.checked ? quiet : null }))
            }
          />
          <span className="oversee-check-text">Hold updates overnight</span>
        </label>
        {cadence.quiet && (
          <div className="upd-quiet">
            <input
              type="time"
              aria-label="Quiet from"
              value={quiet.from}
              onChange={(e) => setQuiet({ ...quiet, from: e.target.value })}
              onBlur={() =>
                quiet.from &&
                quiet.from !== quiet.until &&
                save((c) => ({ ...c, quiet }))
              }
            />
            <span>to</span>
            <input
              type="time"
              aria-label="Quiet until"
              value={quiet.until}
              onChange={(e) => setQuiet({ ...quiet, until: e.target.value })}
              onBlur={() =>
                quiet.until &&
                quiet.from !== quiet.until &&
                save((c) => ({ ...c, quiet }))
              }
            />
          </div>
        )}
        {cadence.quiet && (
          <label className="oversee-check">
            <input
              type="checkbox"
              checked={cadence.quietNeedsYou}
              onChange={(e) =>
                save((c) => ({ ...c, quietNeedsYou: e.target.checked }))
              }
            />
            <span className="oversee-check-text">
              Still tell me at once if something needs me
            </span>
          </label>
        )}
      </fieldset>

      <fieldset className="oversee-card upd-field">
        <legend>Decisions {agent.name} made without you</legend>
        {DECIDED.map((d) => (
          <label key={d.key} className="oversee-check">
            <input
              type="radio"
              name={`${ids}-decided`}
              checked={cadence.decisions === d.key}
              onChange={() => save((c) => ({ ...c, decisions: d.key }))}
            />
            <span className="oversee-check-text">{d.title}</span>
          </label>
        ))}
        <span className="oversee-sub">
          Important = it merged, released, deleted, spent, overrode a session,
          or set something to happen later. Each comes with one line of why; ask
          “why?” or “what else did you decide?” for the rest.
        </span>
      </fieldset>

      {status.state === "saved" && (
        <span className="oversee-sub" role="status">
          Saved.
        </span>
      )}
      {status.state === "failed" && (
        <span className="small state-blocked" role="alert">
          {status.problem}
        </span>
      )}
    </section>
  );
}
