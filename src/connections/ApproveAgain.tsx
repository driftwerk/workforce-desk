import { useState } from "react";
import { appOf, type ConnectionsApi, type Connector } from "../hub/connections";
import { openUrl } from "../platform";
import { useUi } from "../shell/ui";
import { AppForm, message, useFlow, useSetUpAgent, WaitingFor } from "./flow";

/** A connection whose sign-in lapsed, or was made on an earlier app: Desk
 *  is approved on it again, and nothing new is made. Where the person's app
 *  isn't kept, approving can't work, so the way to set the app up shows
 *  instead. */
export function ApproveAgain({
  api,
  connector: c,
  connection: x,
  onDone,
  agent: given,
  onAsk,
}: {
  api: ConnectionsApi;
  connector: Connector;
  connection: { id: string; name: string };
  onDone: () => void | Promise<void>;
  /** Who is asked to set the app up; Desk's own agent when not said. */
  agent?: { id: string; name: string };
  /** Asks `agent` to set the app up; whether it could be asked. */
  onAsk: (agent: { id: string; name: string }) => boolean;
}) {
  const manager = useSetUpAgent();
  const agent = given ?? manager;
  const { started, setStarted, said, setSaid, cancel } = useFlow(api, onDone);
  const [busy, setBusy] = useState(false);
  const [own, setOwn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setSaid(null);
    setProblem(null);
    try {
      const s = await api.approveAgain(c.id, x.id);
      setStarted(s);
      if (s.url) openUrl(s.url);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (started)
    return (
      <WaitingFor
        service={c.name}
        started={started}
        onCancel={() => void cancel()}
      />
    );

  if (appOf(c) !== "ready") {
    if (own || !agent)
      return (
        <AppForm
          api={api}
          connector={c}
          onKept={onDone}
          onCancel={agent ? () => setOwn(false) : undefined}
        />
      );
    return (
      <>
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        <div className="prov-actions">
          <span className="small">
            {appOf(c) === "moved"
              ? `Desk’s address changed, so ${x.name} can’t be approved again yet.`
              : `Your ${c.name} app isn’t kept, so ${x.name} can’t be approved again yet.`}
          </span>
          <button
            type="button"
            className="link small"
            onClick={() => setOwn(true)}
          >
            I have an app already
          </button>
          <button
            type="button"
            className="btn btn-sm btn-signal"
            onClick={() => {
              const asked = onAsk(agent);
              if (asked) useUi.getState().closeSettings();
              else
                setProblem(
                  `${agent.name} isn’t on this computer to ask. Use an app you have already.`,
                );
            }}
          >
            Ask {agent.name} to set it up
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {(problem ?? said) && (
        <p className="small state-blocked" role={problem ? "alert" : "status"}>
          {problem ?? said}
        </p>
      )}
      <div className="prov-actions">
        <span className="small">
          Approve Desk on {c.name} again to carry on with {x.name}.
        </span>
        <button
          type="button"
          className="btn btn-sm btn-signal"
          disabled={busy}
          onClick={() => void begin()}
        >
          {busy ? "Starting…" : "Approve again"}
        </button>
      </div>
    </>
  );
}
