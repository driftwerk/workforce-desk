import { useEffect, useMemo, useState } from "react";
import type { FileHome } from "../attachments/Attachments";
import { browserOf } from "../hub/browser";
import { connectionsOf, type ConnectionsApi, type Setup, type SetupStep } from "../hub/connections";
import { useUi } from "../shell/ui";
import { useLive } from "../ui/useLive";
import { useChat } from "./store";
import "../styles/connections.css";

/** How often a setup under way is asked about. */
const POLL_MS = 2000;
/** A setup counts as this message's when it started this long before it,
 *  at most: the clocks of Desk and its hub differ a little. */
const SKEW_MS = 5000;

/** Whether a setup has nothing left to show changing. */
const settled = (s: Setup): boolean =>
  (!!s.connected?.onFor || s.steps.every((x) => x.state === "done")) || s.steps.some((x) => x.state === "failed");

/** The setups an agent's message started (`count` of them, from `at`),
 *  as the hub keeps them: never what the agent wrote. Shown while they
 *  run, and once they are done. */
export function SetupCards({
  origin,
  at,
  count,
  api: given,
  showPage: givenShow,
}: {
  origin: FileHome;
  at: string;
  count: number;
  api?: ConnectionsApi;
  /** Brings the agent's page to the front; false when it can't. */
  showPage?: (agent: string) => Promise<boolean>;
}) {
  const hub = useChat((s) => s.hubs.find((h) => h.id === origin.hub));
  const api = useMemo(() => given ?? (hub?.local ? connectionsOf(hub) : null), [given, hub]);
  const showPage = useMemo(
    () => givenShow ?? (hub?.local ? (agent: string) => browserOf(hub).show(agent) : async () => false),
    [givenShow, hub],
  );
  const [setups, setSetups] = useState<Setup[] | null>(null);
  const live = useLive();

  useEffect(() => {
    if (!api) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const from = Date.parse(at) - SKEW_MS;
    const tick = async () => {
      try {
        const all = await api.setups(origin.agent);
        if (stop || !live.current) return;
        const mine = all
          .filter((s) => Date.parse(s.startedAt) >= from)
          .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
          .slice(0, count);
        setSetups(mine);
        if (mine.length > 0 && mine.every(settled)) return;
      } catch {
        // A hub without setups shows none; one that failed is asked again.
        if (stop) return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, origin.agent, at, count]);

  if (!api || !setups || setups.length === 0) return null;
  return (
    <>
      {setups.map((s) => (
        <SetupCard
          key={s.id}
          setup={s}
          api={api}
          origin={origin}
          showPage={showPage}
          onChange={(n) => setSetups((list) => list?.map((x) => (x.id === n.id ? n : x)) ?? null)}
        />
      ))}
    </>
  );
}

const ICON: Record<SetupStep["state"], string> = {
  done: "✓",
  failed: "!",
  current: "",
  waiting: "",
  todo: "",
};

/** One setup: its steps, done, under way, waiting on the person, to come;
 *  and, once it is on, what is connected. */
export function SetupCard({
  setup: s,
  api,
  origin,
  showPage,
  onChange,
}: {
  setup: Setup;
  api: ConnectionsApi;
  origin: FileHome;
  showPage: (agent: string) => Promise<boolean>;
  onChange: (s: Setup) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const title = `${s.serviceName} · ${s.name}`;
  const at = s.steps.findIndex((x) => x.state !== "done");
  const n = s.steps.length;

  /** Desk's browser to the front, on the sign-in page; where it isn't on
   *  screen, Settings → Browser, where it is turned on and its pages show. */
  const show = async () => {
    const shown = await showPage(origin.agent).catch(() => false);
    if (!shown) useUi.getState().openSettings("browser");
  };

  const signedIn = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onChange(await api.signedIn(s.id));
      useChat.getState().send(`${origin.hub}/${origin.agent}`, "I’m signed in.");
    } catch {
      setProblem("That setup has ended. Ask again to start over.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="setup-card" aria-label={`Setting up ${title}`}>
        <div className="setup-head">
          <b className="display">Setting up {title}</b>
          <span className="small faint">{at === -1 ? "done" : `step ${at + 1} of ${n}`}</span>
        </div>
        <ol className="setup-steps">
          {s.steps.map((x) =>
            x.state === "waiting" ? (
              <li key={x.id} className="setup-step setup-step-waiting">
                <span className="setup-mark" aria-hidden="true" />
                <span className="setup-waiting">
                  <b>{x.label}</b>
                  <span className="small muted">
                    {x.note ?? "Your password stays with you. The page is open in Desk’s browser; it carries on the moment you’re in."}
                  </span>
                  <span className="setup-actions">
                    <button type="button" className="btn btn-sm btn-blocked" onClick={() => void show()}>
                      Show the sign-in page
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void signedIn()}>
                      Already signed in
                    </button>
                  </span>
                  {problem && (
                    <span className="small state-blocked" role="alert">
                      {problem}
                    </span>
                  )}
                </span>
              </li>
            ) : (
              <li key={x.id} className={`setup-step setup-step-${x.state}`}>
                <span className="setup-mark" aria-hidden="true">
                  {ICON[x.state]}
                </span>
                <span>
                  {x.label}
                  {x.note && x.state !== "todo" && <span className={`small ${x.state === "failed" ? "state-blocked" : "muted"}`}> · {x.note}</span>}
                </span>
              </li>
            ),
          )}
        </ol>
        {s.steps.some((x) => x.state === "failed") && (
          <p className="small state-blocked">Nothing was kept. Ask the agent to try again, or connect it yourself in Settings → Connections.</p>
        )}
      </section>
      {s.connected?.onFor && (
        <section className="setup-done" aria-label={`${title} is connected`}>
          <div className="setup-head">
            <span className="conn-dot conn-dot-on" aria-hidden="true" />
            <b>{title} is connected</b>
            <span className="small faint">
              {s.connected.onFor} uses it · {s.connected.write ? "read and write" : "read only"}
            </span>
          </div>
          <p className="small muted">
            Signed in as {s.connected.account}. Saved in the vault on this computer, never in a file.{" "}
            <button type="button" className="link small" onClick={() => useUi.getState().openSettings("connections")}>
              Open in Connections
            </button>
          </p>
        </section>
      )}
    </>
  );
}

/** How many setups a turn's tools started. */
export const setupsStarted = (tools: readonly { name?: string; tool?: string }[] | undefined): number =>
  (tools ?? []).filter((t) => (t.name ?? t.tool) === "connections.setup").length;
